// IndustryService（§2.6–§2.8、§6.7.9、§6.7.10）：制造、反应、制造比价、多买清单。
// plan 的三种模式：
//   base     基础参考：ME/TE 写了才算，无建筑、无改装件、不计星系成本指数和税；
//   advanced 有地点：缺的参数用默认值（地点的默认建筑和改装件、地点的 ME/TE、建筑的税），直接出结果；
//   steps    「高级」逐步：地点 → ME/TE（反应没有）→ 建筑（只有一座时跳过），缺哪一步返回哪一步（IndustryStep）。
// 地点和建筑按产品筛：造不了的地点、建筑不列（capabilities.ts）；没写建筑、能造的有 2 座以上时，
// 取一次价把每座都算一遍，预计总成本最低的胜出（pick.ts），结果标 autoPicked；制造比价每个地点同样处理，不多取价。
// 每个选项里都是完整的命令参数（无状态，按钮和编号回复都能用）；物品写的是 commandName，整条命令太长时由 bot 换成 #typeID。
// 定价：材料、成品按配置的市场和价格类型。整个市场不可用、或者单个材料没有价格时改用回退市场（标 †）；
// 没有回退市场就算「缺价格」，总成本标不完整，绝不当 0。安装费用要星系成本指数和调整价（indices.ts），取不到时写明。

import { COMPARE_ME_TE, DEADLINE_GUARD_MS, MAX_RUNS, QUERY_DEADLINE_MS, SHOW_MAX_SKILL_TIME, T2_ME_TE_CHOICES } from '../../constants'
import { DataNotReadyError } from '../data'
import { compactPrice, roundHalfAway } from '../format'
import { industryArgsText } from '../parse'
import type { IndustryArgsParts } from '../parse'
import type { Clock, Logger, Scheduler } from '../ports'
import type {
  Access, BlueprintActivity, CoreFailure, DataService, DataSet, FailureReason, IndustryActivity, IndustryLocationInfo,
  IndustryRequest, IndustryResult, IndustryRigState, IndustryService, IndustrySettings, IndustryStep, ItemInfo, ItemResolver,
  LocationComparison,
  MarketDef, MarketRegistry, MarketService, PriceQuote, PriceSide, Resolution, ServiceInfo, TypeId,
} from '../types'
import { isFailure } from '../types'
import { describeError, withDeadline } from '../util'
import { canBuild, locationCanBuild, needLabel } from './capabilities'
import { FORMULA_REVISION, facilityTaxPctFor, formulaConfig, jobsCost, planProduction, runsForQuantity } from './formulas'
import { costIndexOf } from './indices'
import type { AdjustedPrices, IndustryIndices, SystemIndices } from './indices'
import { findStructure, locationSupports, structuresFor } from './locations'
import type { BuildableLocations, IndustryLocation, IndustryLocations, IndustryStructure } from './locations'
import { NO_BONUS, SEC_LABEL, jobModifiers, structureMultipliers } from './modifiers'
import type { JobModifiers } from './modifiers'
import { multibuyBlocks } from './multibuy'
import { rankStructures, rankingCost } from './pick'
import type { Ranked } from './pick'

/** 第 1 步列地点时，星系成本指数最多等多久（拿不到就不写指数） */
export const STEP_INDICES_WAIT_MS = 1500
/** 反应写了「建筑:无」：重新问建筑时的说明 */
const REACTION_NEEDS_REFINERY = '反应只能在精炼厂里进行（不能用「建筑:无」），请选择建筑'

type Defaulted = IndustryResult['applied']['defaulted'][number]

export interface IndustryServiceOptions {
  data: Pick<DataService, 'current'>
  items: Pick<ItemResolver, 'byId' | 'commandName'>
  markets: Pick<MarketRegistry, 'configured'>
  prices: Pick<MarketService, 'getQuotes' | 'available' | 'touch'>
  locations: IndustryLocations
  indices: Pick<IndustryIndices, 'systemIndices' | 'adjustedPrices'>
  settings: IndustrySettings
  clock: Clock
  scheduler: Scheduler
  logger?: Logger
}

/** 候选建筑各算一遍的结果 */
type Candidate = Ranked<{ structure: IndustryStructure; result: IndustryResult }>

/** 一次计算里不随地点变的部分 */
interface Job {
  data: DataSet
  activity: IndustryActivity
  product: ItemInfo
  blueprint: ItemInfo
  bp: BlueprintActivity
  /** 每流程产出几个 */
  perRun: number
  runs: number
  t2: boolean
  access: Access
}

/** 在哪里、怎么做 */
interface Setup {
  location?: IndustryLocation
  structure: IndustryStructure | null
  rigs: 'default' | 'none'
  me: number
  te: number
  /** 命令里写的税 */
  tax?: number
  defaulted: Defaulted[]
  /** 自动选中的建筑是这个地点唯一的一座 */
  only?: boolean
}

interface UnitPrice {
  unit: number
  fallback: boolean
  dataTime: number | null
}

/** 一侧（材料或成品）的价格 */
interface SidePrices {
  market?: MarketDef
  side: PriceSide
  units: Map<TypeId, UnitPrice>
  /** 配置的市场整个不能用（或者根本没有可用的市场） */
  unavailable: boolean
  /** 用到的回退市场 */
  fallback?: MarketDef
}

interface PriceBook {
  material: SidePrices
  product: SidePrices
}

/** 安装费用要的两份全量列表；null = 取不到 */
interface CostInputs {
  indices: SystemIndices | null
  adjusted: AdjustedPrices | null
}

const ACTIVITY_LABEL: Record<IndustryActivity, string> = { manufacturing: '制造', reaction: '反应' }

function failure(code: CoreFailure['code'], extra: Omit<CoreFailure, 'ok' | 'code'> = {}): CoreFailure {
  return { ok: false, code, ...extra }
}

const nameOf = (x: { zh: string; en: string }) => x.zh || x.en

/** 2.31 → 2.31%，-50.4 → -50.4%；signed：正数带 +（加成） */
function pctText(p: number, signed = false): string {
  const v = Math.round(p * 100) / 100 || 0
  return `${signed && v > 0 ? '+' : ''}${v}%`
}

/** 星系成本指数：固定 2 位小数（1.2 → 1.20%，和结果卡片一样） */
const pctFixed = (p: number) => `${(Math.round(p * 100) / 100 || 0).toFixed(2)}%`

/** 建筑自带的加成（百分比）；没有建筑或这种活动没有加成时 undefined */
function structureBonusOf(structure: IndustryStructure | null, activity: IndustryActivity): IndustryResult['applied']['structureBonus'] {
  const s = structureMultipliers(structure?.type, activity)
  if (s.me === 1 && s.te === 1 && s.cost === 1) return undefined
  const tidy = (mult: number) => Math.round(bonusPct(mult) * 1e6) / 1e6 || 0
  return { me: tidy(s.me), te: tidy(s.te), cost: tidy(s.cost) }
}

/** 改装件的情况（见 IndustryRigState） */
function rigStateOf(setup: Pick<Setup, 'structure' | 'rigs'>, applied: number): IndustryRigState {
  const { structure } = setup
  if (!structure?.type) return 'impossible'
  if (setup.rigs === 'none') return 'disabled'
  if (applied) return 'applied'
  return structure.rigs.length ? 'not-applicable' : 'not-installed'
}

/** 系数 → 百分比（0.95 → -5） */
const bonusPct = (mult: number) => (mult - 1) * 100

/** 这一侧的价格；没有、不是正数的都算没有（任何情况下都不当成 0） */
function sideValue(quote: PriceQuote, side: PriceSide): number | null {
  if (quote.status !== 'ok' && quote.status !== 'stale') return null
  const value = side === 'sell' ? quote.sell?.best : side === 'buy' ? quote.buy?.best : quote.mid
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** 数据里有、物品表里没有的东西（不该发生）：拼一个最小的 ItemInfo，免得整个计算失败 */
function stubItem(typeId: TypeId, en: string, zh = '', groupId = 0): ItemInfo {
  return {
    typeId, en, zh, groupId, categoryId: 0, marketGroupId: null, metaGroupId: null, techLevel: null,
    volume: 0, packagedVolume: 0, portionSize: 1, capacity: null, variationParent: null,
  }
}

class Service implements IndustryService {
  constructor(private readonly o: IndustryServiceOptions) {}

  locations(access: Access, activity?: IndustryActivity): IndustryLocationInfo[] {
    return this.o.locations.visible(access, activity).map((l) => ({ name: l.name, isDefault: l.isDefault }))
  }

  locationsFor(access: Access, activity: IndustryActivity, typeId: TypeId): IndustryLocationInfo[] {
    const product = this.o.items.byId(typeId)
    const list = product ? this.o.locations.buildable(access, activity, product).usable : this.o.locations.visible(access, activity)
    return list.map((l) => ({ name: l.name, isDefault: l.isDefault }))
  }

  async plan(req: IndustryRequest): Promise<IndustryResult | IndustryStep | CoreFailure> {
    try {
      const job = this.job(req)
      if ('ok' in job) return job
      if (req.mode === 'base') return await this.base(job, req)
      return await this.located(job, req)
    } catch (e) {
      return this.caught(e)
    }
  }

  async compare(req: Omit<IndustryRequest, 'location' | 'structure' | 'mode'>): Promise<LocationComparison | CoreFailure> {
    try {
      const job = this.job(req)
      if ('ok' in job) return job
      const buildable = this.o.locations.buildable(req.access, req.activity, job.product)
      const list = buildable.usable
      if (list.length < 2) {
        const why = buildable.unable ? { reason: 'capability' as const, need: buildable.need } : {}
        return failure('NOT_CONFIGURED', { locations: list.map((l) => l.name), ...why, message: '本群可比较的工业地点不足 2 个' })
      }
      const fallback = job.t2 ? T2_ME_TE_CHOICES[0] : COMPARE_ME_TE
      const reaction = job.activity === 'reaction'
      const me = reaction ? 0 : req.me ?? fallback.me
      const te = reaction ? 0 : req.te ?? fallback.te
      const deadlineAt = this.now() + QUERY_DEADLINE_MS
      // 材料单价各地点相同，星系成本指数和调整价也只取一次；各地点挑建筑也用这一份
      const [book, costs] = await Promise.all([this.priceBook(job, this.baseWanted(job), deadlineAt), this.costInputs()])
      const rows: LocationComparison['rows'] = list.map((location) => {
        const base = { location, rigs: req.rigs ?? 'default', me, te, tax: req.facilityTaxPct } as const
        const candidates = this.capable(job, location)
        const auto = candidates.length > 1
        const structure = auto ? null : candidates[0] ?? null
        const picked = auto
          ? this.rankCandidates(job, { ...base, defaulted: this.defaultedOf(req, job, true, false) }, candidates, book, costs)[0].item
          : { structure, result: this.assemble(job, { ...base, structure, defaulted: this.defaultedOf(req, job, !!structure, true) }, book, costs) }
        const row: LocationComparison['rows'][number] = {
          location: location.name, noRigs: !picked.result.applied.rigs.length, result: picked.result, cheapest: false, fastest: false,
        }
        if (picked.structure) row.structure = picked.structure.name
        if (auto) Object.assign(row, { autoPicked: true, among: candidates.length })
        return row
      })
      const cost = (r: IndustryResult) => r.materialCost + (r.jobCost?.total ?? 0)
      rows.sort((a, b) => cost(a.result) - cost(b.result))
      rows[0].cheapest = true
      const fastest = rows.reduce((best, r) => (r.result.timeSeconds < best.result.timeSeconds ? r : best), rows[0])
      fastest.fastest = true
      const out: LocationComparison = {
        product: job.product, runs: job.runs, me, te, rows,
        materialMarketKey: book.material.market?.key ?? '', materialSide: book.material.side,
      }
      if (req.rigs === 'none') out.rigsOff = true
      if (req.facilityTaxPct !== undefined) out.facilityTaxPct = req.facilityTaxPct
      if (buildable.unable) out.unable = { count: buildable.unable, need: buildable.need ?? '' }
      return out
    } catch (e) {
      return this.caught(e)
    }
  }

  multibuy(result: IndustryResult): string[] {
    return multibuyBlocks(result, { lang: this.o.settings.multibuyLanguage })
  }

  // ------------------------------------------------------------------ 产品和蓝图

  private job(req: Pick<IndustryRequest, 'typeId' | 'activity' | 'quantity' | 'runs' | 'access'>): Job | CoreFailure {
    const data = this.o.data.current()
    const product = this.o.items.byId(req.typeId)
    if (!product) return failure('ITEM_NOT_FOUND', { resolution: { kind: 'none', suggestions: [] }, message: `物品 ${req.typeId} 不在数据里` })
    const manufacturing = req.activity === 'manufacturing'
    const bp = (manufacturing ? data.industry.manufacturing : data.industry.reactions).get(product.typeId)
    if (!bp) {
      const resolution: Resolution = { kind: 'out-of-scope', item: product, scope: manufacturing ? 'industry' : 'reaction' }
      if (manufacturing && data.industry.reactions.has(product.typeId)) return failure('IS_REACTION', { resolution })
      if (!manufacturing && data.industry.manufacturing.has(product.typeId)) return failure('OUT_OF_SCOPE', { resolution })
      return failure('NOT_MANUFACTURABLE', { resolution, message: `${product.en} 没有可用的${manufacturing ? '制造蓝图' : '反应配方'}` })
    }
    const perRun = bp.products.find((p) => p.typeId === product.typeId)?.quantity ?? 1
    const runs = req.runs ?? (req.quantity === undefined ? 1 : runsForQuantity(req.quantity, perRun))
    if (!(runs >= 1 && runs <= MAX_RUNS)) {
      return failure('BAD_ARGUMENT', { reason: 'runs-range', message: `${runs} 流程超过上限 ${MAX_RUNS}` })
    }
    const blueprint = this.o.items.byId(bp.blueprintId) ?? stubItem(bp.blueprintId, `#${bp.blueprintId}`)
    const t2 = manufacturing && product.techLevel === 2
    return { data, activity: req.activity, product, blueprint, bp, perRun, runs, t2, access: req.access }
  }

  // ------------------------------------------------------------------ 基础参考

  private async base(job: Job, req: IndustryRequest): Promise<IndustryResult> {
    const reaction = job.activity === 'reaction'
    const setup: Setup = { structure: null, rigs: 'none', me: reaction ? 0 : req.me ?? 0, te: reaction ? 0 : req.te ?? 0, defaulted: [] }
    const book = await this.priceBook(job, this.baseWanted(job), this.now() + QUERY_DEADLINE_MS)
    return this.assemble(job, setup, book, null)
  }

  // ------------------------------------------------------------------ 有地点：逐步或直接出结果

  private async located(job: Job, req: IndustryRequest): Promise<IndustryResult | IndustryStep | CoreFailure> {
    const defaulted: Defaulted[] = []
    let location: IndustryLocation | undefined
    let only = false
    let unable: Pick<BuildableLocations, 'unable' | 'need'> = { unable: 0 }
    if (req.location !== undefined) {
      const found = this.findLocation(job, req.location)
      if ('ok' in found) return found
      location = found
      const verdict = locationCanBuild(location, job.product, job.activity, job.data.industry)
      if (!verdict.ok) return this.cannotBuildHere(job, location, verdict.need)
    } else {
      const buildable = this.o.locations.buildable(req.access, job.activity, job.product)
      const list = buildable.usable
      unable = buildable
      if (list.length === 1) {
        location = list[0]
        only = true
      } else if (req.mode === 'advanced') {
        const fallback = this.o.locations.defaultLocation(req.access, job.activity)
        location = fallback && list.includes(fallback) ? fallback : undefined
      }
      if (!location) {
        if (!list.length) return this.noLocation(job, buildable)
        return this.locationStep(job, req, list, unable)
      }
      defaulted.push('location')
    }

    const manufacturing = job.activity === 'manufacturing'
    if (manufacturing && (req.meteMissing || (req.mode === 'steps' && req.me === undefined && req.te === undefined))) return this.meteStep(job, req, location, only)
    const { me, te } = this.meTe(job, req, location, defaulted)

    const candidates = this.capable(job, location)
    let structure: IndustryStructure | null = null
    let onlyStructure = false
    // 「建筑:?」和写错的建筑名：列出全部，包括「无建筑加成」（反应只能在精炼厂里做，不列）
    if (req.structure === '?') return this.structureStep(job, req, location, only, true)
    if (req.structure === 'none') {
      if (!manufacturing) return this.structureStep(job, req, location, only, true, REACTION_NEEDS_REFINERY)
      const verdict = canBuild(null, location, job.product, job.activity, job.data.industry)
      if (!verdict.ok) return this.structureStep(job, req, location, only, true, `「建筑:无」造不了${nameOf(job.product)}（需要${needLabel(verdict.need)}），请重新选择`)
      structure = null
    } else if (req.structure !== undefined) {
      const found = findStructure(location, req.structure, job.activity)
      if (!found) return this.structureStep(job, req, location, only, true, `${location.name} 没有叫「${req.structure}」的建筑，请重新选择`)
      const verdict = canBuild(found, location, job.product, job.activity, job.data.industry)
      if (!verdict.ok) return this.structureStep(job, req, location, only, true, `${found.name} 造不了${nameOf(job.product)}（需要${needLabel(verdict.need)}），请重新选择`)
      structure = found
    } else if (candidates.length) {
      // 「无建筑加成」不算一个选项：只有一座能造的建筑时直接用它
      if (req.mode === 'steps' && candidates.length > 1) return this.structureStep(job, req, location, only, false)
      if (candidates.length > 1) return this.autoPicked(job, req, location, candidates, me, te, defaulted)
      structure = candidates[0]
      defaulted.push('structure')
      onlyStructure = true
    }
    if (structure && req.rigs === undefined) defaulted.push('rigs')
    if (req.facilityTaxPct === undefined) defaulted.push('tax')

    const setup: Setup = { location, structure, rigs: req.rigs ?? 'default', me, te, tax: req.facilityTaxPct, defaulted }
    if (onlyStructure) setup.only = true
    const plan = this.production(job, setup, this.modifiers(job, setup))
    const wanted = plan.materials.map((m) => ({ typeId: m.typeId, qty: m.quantity }))
    const [book, costs] = await Promise.all([this.priceBook(job, wanted, this.now() + QUERY_DEADLINE_MS), this.costInputs()])
    return this.assemble(job, setup, book, costs)
  }

  /** 制造的 ME/TE：命令里写的，否则 T2 用常见值、其他用地点的默认；反应没有 */
  private meTe(job: Job, req: IndustryRequest, location: IndustryLocation, defaulted: Defaulted[]): { me: number; te: number } {
    if (job.activity !== 'manufacturing') return { me: 0, te: 0 }
    const fallback = job.t2 ? T2_ME_TE_CHOICES[0] : { me: location.defaultME, te: location.defaultTE }
    if (req.me === undefined) defaulted.push('me')
    if (req.te === undefined) defaulted.push('te')
    return { me: req.me ?? fallback.me, te: req.te ?? fallback.te }
  }

  /** 这个地点里造得了这个产品的建筑（能做这种活动的），按表格顺序 */
  private capable(job: Job, location: IndustryLocation): IndustryStructure[] {
    return structuresFor(location, job.activity).filter((s) => canBuild(s, location, job.product, job.activity, job.data.industry).ok)
  }

  /** 比价用：这一行的 defaulted（structure：有建筑；listed：建筑是默认的那座，不是自动挑的） */
  private defaultedOf(req: IndustryRequest | Omit<IndustryRequest, 'location' | 'structure' | 'mode'>, job: Job, structure: boolean, listed: boolean): Defaulted[] {
    const reaction = job.activity === 'reaction'
    const out: Defaulted[] = []
    if (req.me === undefined && !reaction) out.push('me')
    if (req.te === undefined && !reaction) out.push('te')
    if (structure && listed) out.push('structure')
    if (structure && req.rigs === undefined) out.push('rigs')
    if (req.facilityTaxPct === undefined) out.push('tax')
    return out
  }

  /** 候选建筑各算一遍（价格、指数共用同一份，不再取价），按预计总成本 → 时间 → 默认勾 → 表格顺序排好 */
  private rankCandidates(job: Job, base: Omit<Setup, 'structure'>, list: IndustryStructure[], book: PriceBook, costs: CostInputs): Candidate[] {
    return rankStructures(list.map((structure) => {
      const result = this.assemble(job, { ...base, structure, defaulted: [...base.defaulted] }, book, costs)
      result.applied.autoPicked = { among: list.length }
      return {
        item: { structure, result }, cost: rankingCost(result, costs.adjusted), time: result.timeSeconds, isDefault: structure.isDefault, row: structure.row,
      }
    }))
  }

  /** 没写建筑、能造的有 2 座以上：取一次价，各算一遍，用最合适的那座 */
  private async autoPicked(
    job: Job, req: IndustryRequest, location: IndustryLocation, list: IndustryStructure[], me: number, te: number, defaulted: Defaulted[],
  ): Promise<IndustryResult> {
    if (req.rigs === undefined) defaulted.push('rigs')
    if (req.facilityTaxPct === undefined) defaulted.push('tax')
    const [book, costs] = await Promise.all([this.priceBook(job, this.baseWanted(job), this.now() + QUERY_DEADLINE_MS), this.costInputs()])
    const base = { location, rigs: req.rigs ?? 'default', me, te, tax: req.facilityTaxPct, defaulted } as const
    return this.rankCandidates(job, base, list, book, costs)[0].item.result
  }

  /** 写的地点造不了这个产品：给能造的地点 */
  private cannotBuildHere(job: Job, location: IndustryLocation, need: readonly ServiceInfo[]): CoreFailure {
    const { usable } = this.o.locations.buildable(job.access, job.activity, job.product)
    const label = needLabel(need)
    const message = `${location.name} 造不了${nameOf(job.product)}（需要${label}）`
    return failure('UNKNOWN_LOCATION', { token: location.name, reason: 'capability', need: label, locations: usable.map((l) => l.name), message })
  }

  /** 本群没有能造这个产品的地点 */
  private noLocation(job: Job, buildable: BuildableLocations): CoreFailure {
    const what = ACTIVITY_LABEL[job.activity]
    if (!buildable.unable) return failure('NOT_CONFIGURED', { locations: [], message: `本群没有可以${what}的工业地点` })
    const message = `本群没有能${what}${nameOf(job.product)}的工业地点（需要${buildable.need}）`
    return failure('NOT_CONFIGURED', { locations: [], reason: 'capability', need: buildable.need, message })
  }

  /** 命令里写的地点：本群看不到和不存在一样；高安不能反应；没有能做这种活动的建筑 */
  private findLocation(job: Job, token: string): IndustryLocation | CoreFailure {
    const usable = () => this.o.locations.visible(job.access, job.activity).map((l) => l.name)
    const location = this.o.locations.match(token, job.access)
    if (!location) return failure('UNKNOWN_LOCATION', { token, locations: usable(), message: `${token} 尚未配置为工业地点` })
    if (job.activity === 'reaction' && location.system.secClass === 'high') {
      return failure('HIGHSEC_REACTION', { token: location.name, locations: usable(), message: '高安不能进行反应' })
    }
    if (!locationSupports(location, job.activity)) {
      const reason: FailureReason = 'activity'
      const message = `${location.name} 没有能${ACTIVITY_LABEL[job.activity]}的建筑`
      return failure('UNKNOWN_LOCATION', { token: location.name, reason, locations: usable(), message })
    }
    return location
  }

  // ------------------------------------------------------------------ 步骤

  private command(job: Job, parts: Omit<IndustryArgsParts, 'item'>): string {
    return industryArgsText({ item: this.o.items.commandName(job.product), ...parts }, this.o.settings.chain)
  }

  /** 每一步都原样带上的参数：数量、拆到原料、改装件、税、材料 */
  private carried(req: IndustryRequest): Omit<IndustryArgsParts, 'item'> {
    return { quantity: req.quantity, runs: req.runs, chain: req.chain, rigs: req.rigs, facilityTaxPct: req.facilityTaxPct, materials: req.materials }
  }

  /** 已选摘要：地点、ME/TE、建筑、数量和写了的参数；withStructure：问建筑的那一步不写（写的建筑可能找不到） */
  private summary(job: Job, req: IndustryRequest, location?: IndustryLocation, only = false, withStructure = true): string[] {
    const out: string[] = []
    if (location) out.push(only ? `${location.name}（本群唯一的地点）` : location.name)
    if (job.activity === 'manufacturing') {
      if (req.me !== undefined) out.push(`ME ${req.me}`)
      if (req.te !== undefined) out.push(`TE ${req.te}`)
    }
    if (withStructure && req.structure !== undefined && req.structure !== '?') {
      out.push(req.structure === 'none' ? '无建筑加成' : `建筑 ${req.structure}`)
    }
    if (req.runs !== undefined) out.push(`${req.runs} 流程`)
    else if (req.quantity !== undefined) out.push(`数量 ${req.quantity}`)
    if (req.rigs === 'none') out.push('不用改装件')
    if (req.facilityTaxPct !== undefined) out.push(`设施税 ${pctText(req.facilityTaxPct)}`)
    return out
  }

  private async locationStep(
    job: Job, req: IndustryRequest, list: IndustryLocation[], skipped: Pick<BuildableLocations, 'unable' | 'need'>,
  ): Promise<IndustryStep> {
    const indices = await this.quickIndices()
    // 写了的建筑带下去：选了地点以后用它，或者说明这个地点没有它
    const carry = { ...this.carried(req), me: req.me, te: req.te, meteMissing: req.meteMissing, structure: req.structure }
    const options = list.map((location) => {
      const usable = this.capable(job, location)
      // 2 座以上能造时会自动挑最便宜的，这里不替它写某一座
      const structureText = usable.length === 0 ? '无建筑加成' : usable.length === 1 ? usable[0].name : `${usable.length} 座可选，自动挑`
      const sci = indices ? costIndexOf(indices, location.system.id, job.activity) : undefined
      const detail = [
        SEC_LABEL[location.system.secClass],
        structureText,
        sci === undefined ? '' : `星系成本指数 ${pctFixed(sci * 100)}`,
      ].filter(Boolean).join(' · ')
      return { label: location.name, detail, command: this.command(job, { ...carry, location: location.name, steps: true }) }
    })
    const step: IndustryStep = { step: 'location', options, summary: this.summary(job, req) }
    if (skipped.unable) step.note = `另有 ${skipped.unable} 个地点造不了（需要${skipped.need}）`
    const fallback = this.o.locations.defaultLocation(job.access, job.activity)
    if (fallback && list.includes(fallback)) step.defaults = this.command(job, { ...carry, location: fallback.name })
    return step
  }

  private meteStep(job: Job, req: IndustryRequest, location: IndustryLocation, only: boolean): IndustryStep {
    const choices = job.t2 ? T2_ME_TE_CHOICES : this.o.settings.meTeChoices
    const carry = { ...this.carried(req), location: location.name, structure: req.structure }
    const step: IndustryStep = {
      step: 'mete',
      // 按钮写成 10/20（「ME10/TE20」放不进 8 个字的按钮；命令也认这种写法）
      options: choices.map((c) => ({
        label: `ME${c.me}/TE${c.te}`,
        button: `${c.me}/${c.te}`,
        command: this.command(job, { ...carry, me: c.me, te: c.te, steps: true }),
      })),
      summary: this.summary(job, req, location, only),
      defaults: this.command(job, carry),
      custom: `${this.command(job, { ...carry, steps: true })} ME`,
    }
    if (req.meteMissing) step.notice = `${req.meteMissing.toUpperCase()} 后面要写数字，例如 ME7 TE14`
    return step
  }

  /**
   * 建筑这一步：取一次价，造得了的建筑各算一遍，预计总成本最低的排第一并标推荐；造不了的不列，数量写在 note。
   * all：也列「无建筑加成」（放最后；反应只能在精炼厂里做，不列）
   */
  private async structureStep(
    job: Job, req: IndustryRequest, location: IndustryLocation, only: boolean, all: boolean, notice?: string,
  ): Promise<IndustryStep> {
    const carry = { ...this.carried(req), location: location.name, me: req.me, te: req.te }
    const rigs = req.rigs ?? 'default'
    const { me, te } = this.meTe(job, req, location, [])
    const [book, costs] = await Promise.all([this.priceBook(job, this.baseWanted(job), this.now() + QUERY_DEADLINE_MS), this.costInputs()])
    const base = { location, rigs, me, te, tax: req.facilityTaxPct, defaulted: [] }
    const ranked = this.rankCandidates(job, base, this.capable(job, location), book, costs)
    const options: IndustryStep['options'] = ranked.map(({ item: { structure, result }, cost }, i) => {
      const option: IndustryStep['options'][number] = {
        label: structure.name,
        detail: [this.costText(result, cost), this.structureDetail(job, location, structure, rigs)].join(' · '),
        command: this.command(job, { ...carry, structure: structure.name }),
      }
      if (i === 0) option.recommended = true
      if (!result.missingPrices) option.cost = cost
      return option
    })
    if (all && job.activity === 'manufacturing' && canBuild(null, location, job.product, job.activity, job.data.industry).ok) {
      const tax = req.facilityTaxPct ?? formulaConfig(this.o.settings).npcFacilityTaxPct
      const result = this.assemble(job, { ...base, structure: null }, book, costs)
      const command = this.command(job, { ...carry, structure: 'none' })
      const option: IndustryStep['options'][number] = {
        label: '无建筑加成',
        detail: [this.costText(result, rankingCost(result, costs.adjusted)), `按 NPC 空间站算 · 设施税 ${pctText(tax)}`].join(' · '),
        command,
      }
      if (!result.missingPrices) option.cost = rankingCost(result, costs.adjusted)
      options.push(option)
    }
    const step: IndustryStep = { step: 'structure', options, summary: this.summary(job, req, location, only, false), defaults: this.command(job, carry) }
    if (notice) step.notice = notice
    const skipped = this.skippedStructures(job, location)
    if (skipped) step.note = `另有 ${skipped.count} 座造不了（需要${skipped.need}）`
    return step
  }

  /** 预计总成本；有材料缺价格时不写数字（只用调整价顶上排序，不当成真实成本） */
  private costText(result: IndustryResult, cost: number): string {
    return `预计总成本 ${result.missingPrices ? '不完整' : compactPrice(cost, 2)}`
  }

  /** 这个地点能做这种活动、但造不了这个产品的建筑：数量和缺的服务 */
  private skippedStructures(job: Job, location: IndustryLocation): { count: number; need: string } | undefined {
    const need: ServiceInfo[] = []
    let count = 0
    for (const structure of structuresFor(location, job.activity)) {
      const verdict = canBuild(structure, location, job.product, job.activity, job.data.industry)
      if (verdict.ok) continue
      count++
      need.push(...verdict.need)
    }
    return count ? { count, need: needLabel(need) } : undefined
  }

  /** 材料 -1%，时间 -30%，费用 -5% · 改装件 屹立超大型舰船制造效率 II */
  private structureDetail(job: Job, location: IndustryLocation, structure: IndustryStructure, rigs: 'default' | 'none'): string {
    const s = structureMultipliers(structure.type, job.activity)
    const bonus = ([['材料', s.me], ['时间', s.te], ['费用', s.cost]] as const)
      .filter(([, mult]) => mult !== 1)
      .map(([label, mult]) => `${label} ${pctText(bonusPct(mult), true)}`)
    const parts = [bonus.length ? bonus.join('，') : '没有建筑加成']
    if (rigs === 'none') {
      parts.push('不用改装件')
    } else if (structure.rigs.length) {
      const mods = this.modifiers(job, { location, structure, rigs, me: 0, te: 0, defaulted: [] })
      const names = mods.applied.map((r) => nameOf(this.rigItem(job, r.rigId)))
      parts.push(names.length ? `改装件 ${names.join('、')}` : `没有对${nameOf(job.product)}生效的改装件`)
    } else if (structure.type) {
      parts.push('没有装改装件')
    }
    return parts.join(' · ')
  }

  // ------------------------------------------------------------------ 计算

  private modifiers(job: Job, setup: Setup): Pick<JobModifiers, 'structure' | 'rigs' | 'applied' | 'issues'> {
    const { location, structure } = setup
    if (!location) return { structure: NO_BONUS, rigs: NO_BONUS, applied: [], issues: [] }
    return jobModifiers({
      activity: job.activity,
      product: job.product,
      secClass: location.system.secClass,
      structure: structure?.type ?? null,
      rigs: setup.rigs === 'none' ? [] : structure?.rigs ?? [],
      filters: job.data.industry.filters,
    })
  }

  private production(job: Job, setup: Setup, mods: Pick<JobModifiers, 'structure' | 'rigs'>) {
    return planProduction({
      activity: job.activity,
      blueprint: job.bp,
      runs: job.runs,
      techLevel: job.product.techLevel,
      me: setup.me,
      te: setup.te,
      mods: { structure: mods.structure, rigs: mods.rigs },
    })
  }

  /** costs 为 null：基础模式，不算安装费用和利润 */
  private assemble(job: Job, setup: Setup, book: PriceBook, costs: CostInputs | null): IndustryResult {
    const { location, structure } = setup
    const mods = this.modifiers(job, setup)
    const plan = this.production(job, setup, mods)
    const warnings: string[] = []
    const { industry } = job.data

    let materialCost = 0
    let missingPrices = 0
    const materials: IndustryResult['materials'] = plan.materials.map((m) => {
      const price = book.material.units.get(m.typeId)
      const total = price ? roundHalfAway(price.unit * m.quantity, 2) : null
      if (total === null) missingPrices++
      else materialCost += total
      const row: IndustryResult['materials'][number] = {
        item: this.o.items.byId(m.typeId) ?? stubItem(m.typeId, `#${m.typeId}`),
        baseQuantity: m.baseQuantity,
        quantity: m.quantity,
        unit: price?.unit ?? null,
        total,
        manufacturable: industry.manufacturing.has(m.typeId) || industry.reactions.has(m.typeId),
      }
      if (price?.fallback) row.fallback = true
      return row
    })
    // 金额高的在前，没有价格的在最后（同样的保持数据里的顺序）
    const order = new Map(materials.map((m, i) => [m, i]))
    materials.sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || order.get(a)! - order.get(b)!)

    if (job.t2) warnings.push('T2 蓝图一般来自发明（常见 ME 2 / TE 4），发明成本暂不计入')
    else if (job.blueprint.marketGroupId === null) warnings.push('蓝图来自 LP 商店、发明或掉落，蓝图成本未计入')
    if (plan.jobs.length > 1) warnings.push(`单张蓝图最多 ${job.bp.maxRuns} 流程，按 ${plan.jobs.length} 个工作计算`)
    for (const issue of mods.issues) if (issue.code === 'rig-sec') warnings.push(issue.message)

    const result: IndustryResult = {
      product: job.product,
      blueprint: job.blueprint,
      runs: job.runs,
      jobs: plan.jobs,
      outputQuantity: job.runs * job.perRun,
      applied: {
        rigs: mods.applied.map((r) => ({ item: this.rigItem(job, r.rigId), me: r.me, te: r.te, cost: r.cost })),
        me: setup.me,
        te: setup.te,
        defaulted: setup.defaulted,
      },
      materials,
      materialCost,
      missingPrices,
      timeSeconds: plan.timeSeconds,
      formulaRevision: FORMULA_REVISION,
      warnings,
    }
    if (SHOW_MAX_SKILL_TIME) result.timeSecondsMaxSkill = plan.timeSecondsMaxSkill
    if (location) {
      Object.assign(result.applied, { location: location.name, systemId: location.system.id, secClass: location.system.secClass })
      if (structure) result.applied.structure = structure.name
      const bonus = structureBonusOf(structure, job.activity)
      if (bonus) result.applied.structureBonus = bonus
      if (structure && setup.only) result.applied.structureOnly = true
      result.applied.rigState = rigStateOf(setup, mods.applied.length)
    }
    if (location && costs) this.addJobCost(job, setup, mods, plan.jobs, costs, result)
    this.addPrices(book, result, !!costs)
    return result
  }

  private addJobCost(
    job: Job, setup: Setup, mods: Pick<JobModifiers, 'structure' | 'rigs'>, jobs: number[], costs: CostInputs, result: IndustryResult,
  ) {
    const location = setup.location!
    const { structure } = setup
    const config = formulaConfig(this.o.settings)
    const tax = facilityTaxPctFor({ override: setup.tax, activity: job.activity, structure }, config)
    Object.assign(result.applied, { facilityTaxPct: tax, sccPct: config.sccSurchargePct })
    let sci = 0
    if (!costs.indices) {
      result.warnings.push('星系成本指数暂时取不到，安装费用没有计入星系成本指数（偏低）')
    } else {
      const found = costIndexOf(costs.indices, location.system.id, job.activity)
      if (found === undefined) result.warnings.push(`${nameOf(location.system)} 不在星系成本指数列表里，安装费用按指数 0 计算`)
      sci = found ?? 0
      result.applied.sci = sci
      result.indicesAt = costs.indices.dataTime
      if (costs.indices.stale) result.indicesStale = true
    }
    if (!costs.adjusted) {
      result.warnings.push('调整价暂时取不到，安装费用、设施税和 SCC 附加费没有计入')
      return
    }
    result.adjustedPricesAt = costs.adjusted.dataTime
    if (costs.adjusted.stale) result.adjustedStale = true
    const adjusted = costs.adjusted.byType
    const cost = jobsCost(job.bp.materials, jobs, (id) => adjusted.get(id), {
      sci,
      mods: { structure: mods.structure, rigs: mods.rigs },
      sysCostBonusPct: location.sysCostBonusPct,
      facilityTaxPct: tax,
      sccSurchargePct: config.sccSurchargePct,
      extraFeePct: structure?.extraFeePct ?? 0,
      extraFeeIsk: structure?.extraFeeIsk ?? 0,
    })
    const jobCost: NonNullable<IndustryResult['jobCost']> = {
      eiv: cost.eiv, grossSci: cost.grossSci, bonuses: cost.bonuses, facility: cost.facility, scc: cost.scc, extra: cost.extra,
      total: cost.total, missingAdjusted: cost.missingAdjusted.length,
    }
    if (structure && (structure.extraFeePct > 0 || structure.extraFeeIsk > 0)) jobCost.extraLabel = structure.extraFeeLabel
    result.jobCost = jobCost
    if (cost.missingAdjusted.length) result.warnings.push('部分材料缺少调整价，安装费偏低')
  }

  /** 材料市场、成品价值、利润、数据时间；withProfit：基础模式不算利润 */
  private addPrices(book: PriceBook, result: IndustryResult, withProfit: boolean) {
    const { material, product } = book
    if (material.market) {
      const info: NonNullable<IndustryResult['materialPrices']> = { marketKey: material.market.key, side: material.side }
      if (material.unavailable) info.unavailable = true
      if (material.fallback) info.fallbackKey = material.fallback.key
      result.materialPrices = info
    }
    result.warnings.push(...this.marketWarnings('材料市场', material, '材料成本不完整'))
    result.warnings.push(...this.marketWarnings('成品市场', product, '没有算成品价值'))

    const market = product.market ?? product.fallback
    if (market) {
      const price = product.units.get(result.product.typeId)
      const value: NonNullable<IndustryResult['productValue']> = {
        marketKey: price?.fallback && product.fallback ? product.fallback.key : market.key,
        side: product.side,
        unit: price?.unit ?? null,
        total: price ? price.unit * result.outputQuantity : null,
      }
      if (price?.fallback) value.fallback = true
      result.productValue = value
    }
    if (withProfit) {
      const value = result.productValue?.total ?? null
      if (value === null || !(value > 0)) {
        result.profit = null
      } else {
        const fees = value * this.o.settings.sellFeesPct / 100
        const profit = value - (result.materialCost + (result.jobCost?.total ?? 0) + fees)
        result.profit = { value: profit, marginPct: profit / value * 100 }
      }
    }

    const used = [...material.units.values()]
    const productPrice = product.units.get(result.product.typeId)
    if (productPrice) used.push(productPrice)
    let oldest: number | null = null
    for (const { dataTime } of used) if (dataTime !== null && (oldest === null || dataTime < oldest)) oldest = dataTime
    result.pricesAt = oldest
  }

  private marketWarnings(label: string, prices: SidePrices, missing: string): string[] {
    if (!prices.unavailable) return []
    if (!prices.market) return [`没有可用的${label}，${missing}`]
    if (prices.fallback) return [`${label} ${prices.market.name} 暂时不可用，改用 ${prices.fallback.name}（标 †）`]
    return [`${label} ${prices.market.name} 暂时不可用，${missing}`]
  }

  private rigItem(job: Job, rigId: TypeId): ItemInfo {
    const found = this.o.items.byId(rigId)
    if (found) return found
    const rig = job.data.industry.rigs.get(rigId)
    return stubItem(rigId, rig?.en ?? `#${rigId}`, rig?.zh ?? '', rig?.group ?? 0)
  }

  // ------------------------------------------------------------------ 价格

  /** ME 0 的数量（比价时各地点的数量不同，报价只取一次） */
  private baseWanted(job: Job): Array<{ typeId: TypeId; qty: number }> {
    return job.bp.materials.map((m) => ({ typeId: m.typeId, qty: m.quantity * job.runs }))
  }

  private async priceBook(job: Job, wanted: Array<{ typeId: TypeId; qty: number }>, deadlineAt: number): Promise<PriceBook> {
    const { markets, settings } = this.o
    const fallback = markets.configured('industry.fallbackMarket', job.access)
    const [material, product] = await Promise.all([
      this.priceSide(markets.configured('industry.materialMarket', job.access), fallback, settings.materialPriceType, wanted, deadlineAt),
      this.priceSide(
        markets.configured('industry.productMarket', job.access), fallback, settings.productPriceType,
        [{ typeId: job.product.typeId, qty: job.runs * job.perRun }], deadlineAt,
      ),
    ])
    return { material, product }
  }

  /** 先用配置的市场；整个市场不能用、或者某种物品没有价格时，改用回退市场 */
  private async priceSide(
    market: MarketDef | undefined, fallbackMarket: MarketDef | undefined, side: PriceSide,
    wanted: Array<{ typeId: TypeId; qty: number }>, deadlineAt: number,
  ): Promise<SidePrices> {
    const out: SidePrices = { side, units: new Map(), unavailable: false }
    if (market) out.market = market
    if (!wanted.length) return out
    const main = market && (await this.usable(market, deadlineAt)) ? market : undefined
    if (!main) out.unavailable = true
    if (main) this.take(out, await this.quotes(main, wanted, deadlineAt), side, false)
    const missing = wanted.filter((w) => !out.units.has(w.typeId))
    const fallback = fallbackMarket && fallbackMarket.key !== market?.key ? fallbackMarket : undefined
    if (missing.length && fallback && (await this.usable(fallback, deadlineAt))) {
      const before = out.units.size
      this.take(out, await this.quotes(fallback, missing, deadlineAt), side, true)
      if (out.units.size > before) out.fallback = fallback
    }
    return out
  }

  private take(out: SidePrices, quotes: Map<TypeId, PriceQuote>, side: PriceSide, fallback: boolean) {
    for (const [typeId, quote] of quotes) {
      const unit = sideValue(quote, side)
      if (unit !== null && !out.units.has(typeId)) out.units.set(typeId, { unit, fallback, dataTime: quote.dataTime })
    }
  }

  /** 建筑市场先恢复暂停的同步（数据太旧时最多等到时限），再看整个市场能不能用 */
  private async usable(market: MarketDef, deadlineAt: number): Promise<boolean> {
    const waitMs = Math.max(0, Math.min(QUERY_DEADLINE_MS, deadlineAt - this.now()))
    try {
      await withDeadline(this.o.prices.touch(market.key, waitMs), waitMs + DEADLINE_GUARD_MS, this.o.scheduler)
    } catch (e) {
      this.o.logger?.warn(`工业：恢复「${market.name}」的同步失败：${describeError(e)}`)
    }
    const status = this.o.prices.available(market.key).status
    return status === 'ok' || status === 'stale'
  }

  /** 时限内拿到的报价；没赶上的物品不在里面（请求在后台做完，进缓存） */
  private async quotes(market: MarketDef, items: Array<{ typeId: TypeId; qty: number }>, deadlineAt: number): Promise<Map<TypeId, PriceQuote>> {
    const ms = deadlineAt - this.now()
    if (ms <= 0 || !items.length) return new Map()
    try {
      const pending = this.o.prices.getQuotes(market.key, items, { deadlineMs: ms })
      const got = await withDeadline(pending, ms + DEADLINE_GUARD_MS, this.o.scheduler)
      return got.done ? got.value : new Map()
    } catch (e) {
      this.o.logger?.warn(`工业：取「${market.name}」的报价失败：${describeError(e)}`)
      return new Map()
    }
  }

  /** 星系成本指数和调整价（各自有时限，取不到时是 null） */
  private async costInputs(): Promise<CostInputs> {
    const [indices, adjusted] = await Promise.all([
      this.safe(() => this.o.indices.systemIndices(), '星系成本指数'),
      this.safe(() => this.o.indices.adjustedPrices(), '调整价'),
    ])
    return { indices, adjusted }
  }

  /** 第 1 步列地点用：只等一小会儿 */
  private quickIndices(): Promise<SystemIndices | null> {
    return this.safe(() => this.o.indices.systemIndices({ deadlineMs: STEP_INDICES_WAIT_MS }), '星系成本指数')
  }

  private async safe<T>(task: () => Promise<T | CoreFailure>, what: string): Promise<T | null> {
    try {
      const got = await task()
      return isFailure(got) ? null : got
    } catch (e) {
      this.o.logger?.warn(`工业：取${what}失败：${describeError(e)}`)
      return null
    }
  }

  private caught(e: unknown): CoreFailure {
    if (e instanceof DataNotReadyError) return failure('DATA_NOT_READY', { message: e.message })
    throw e
  }

  private now(): number {
    return this.o.clock.now()
  }
}

export function createIndustryService(options: IndustryServiceOptions): IndustryService {
  return new Service(options)
}
