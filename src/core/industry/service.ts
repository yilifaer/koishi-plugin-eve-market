// IndustryService（§2.6–§2.8、§6.7.9、§6.7.10）：制造、反应、制造比价、多买清单。
// plan 的三种模式：
//   base     基础参考：ME/TE 写了才算，无建筑、无改装件、不计系统指数和税；
//   advanced 有地点：缺的参数用默认值（地点的默认建筑和改装件、地点的 ME/TE、建筑的税），直接出结果；
//   steps    「高级」逐步：地点 → ME/TE（反应没有）→ 建筑（只有一座时跳过），缺哪一步返回哪一步（IndustryStep）。
// 每个选项里都是完整的命令参数（无状态，按钮和编号回复都能用）；物品写的是 commandName，整条命令太长时由 bot 换成 #typeID。
// 定价：材料、成品按配置的市场和价格类型。整个市场不可用、或者单个材料没有价格时改用回退市场（标 †）；
// 没有回退市场就算「缺价格」，总成本标不完整，绝不当 0。安装费用要系统指数和调整价（indices.ts），取不到时写明。

import { COMPARE_ME_TE, DEADLINE_GUARD_MS, MAX_RUNS, QUERY_DEADLINE_MS, SHOW_MAX_SKILL_TIME, T2_ME_TE_CHOICES } from '../../constants'
import { DataNotReadyError } from '../data'
import { roundHalfAway } from '../format'
import { industryArgsText } from '../parse'
import type { IndustryArgsParts } from '../parse'
import type { Clock, Logger, Scheduler } from '../ports'
import type {
  Access, BlueprintActivity, CoreFailure, DataService, DataSet, FailureReason, IndustryActivity, IndustryLocationInfo,
  IndustryRequest, IndustryResult, IndustryRigState, IndustryService, IndustrySettings, IndustryStep, ItemInfo, ItemResolver,
  LocationComparison,
  MarketDef, MarketRegistry, MarketService, PriceQuote, PriceSide, Resolution, TypeId,
} from '../types'
import { isFailure } from '../types'
import { describeError, withDeadline } from '../util'
import { FORMULA_REVISION, facilityTaxPctFor, formulaConfig, jobsCost, planProduction, runsForQuantity } from './formulas'
import { costIndexOf } from './indices'
import type { AdjustedPrices, IndustryIndices, SystemIndices } from './indices'
import { defaultStructure, findStructure, locationSupports, structuresFor } from './locations'
import type { IndustryLocation, IndustryLocations, IndustryStructure } from './locations'
import { NO_BONUS, SEC_LABEL, jobModifiers, structureMultipliers } from './modifiers'
import type { JobModifiers } from './modifiers'
import { multibuyBlocks } from './multibuy'

/** 第 1 步列地点时，系统指数最多等多久（拿不到就不写指数） */
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

/** 系统指数：固定 2 位小数（1.2 → 1.20%，和结果卡片一样） */
const pctFixed = (p: number) => `${(Math.round(p * 100) / 100 || 0).toFixed(2)}%`

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
      const list = this.o.locations.visible(req.access, req.activity)
      if (list.length < 2) {
        return failure('NOT_CONFIGURED', { locations: list.map((l) => l.name), message: '本群可比较的工业地点不足 2 个' })
      }
      const fallback = job.t2 ? T2_ME_TE_CHOICES[0] : COMPARE_ME_TE
      const reaction = job.activity === 'reaction'
      const me = reaction ? 0 : req.me ?? fallback.me
      const te = reaction ? 0 : req.te ?? fallback.te
      const deadlineAt = this.now() + QUERY_DEADLINE_MS
      // 材料单价各地点相同，系统指数和调整价也只取一次
      const [book, costs] = await Promise.all([this.priceBook(job, this.baseWanted(job), deadlineAt), this.costInputs()])
      const rows: LocationComparison['rows'] = list.map((location) => {
        const structure = defaultStructure(location, job.activity)
        const defaulted: Defaulted[] = []
        if (req.me === undefined && !reaction) defaulted.push('me')
        if (req.te === undefined && !reaction) defaulted.push('te')
        if (structure) defaulted.push('structure')
        if (structure && req.rigs === undefined) defaulted.push('rigs')
        if (req.facilityTaxPct === undefined) defaulted.push('tax')
        const setup: Setup = { location, structure, rigs: req.rigs ?? 'default', me, te, tax: req.facilityTaxPct, defaulted }
        const result = this.assemble(job, setup, book, costs)
        const row: LocationComparison['rows'][number] = {
          location: location.name, noRigs: !result.applied.rigs.length, result, cheapest: false, fastest: false,
        }
        if (structure) row.structure = structure.name
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
    if (req.location !== undefined) {
      const found = this.findLocation(job, req.location)
      if ('ok' in found) return found
      location = found
    } else {
      const list = this.o.locations.visible(req.access, job.activity)
      if (list.length === 1) {
        location = list[0]
        only = true
      } else if (req.mode === 'advanced') {
        location = this.o.locations.defaultLocation(req.access, job.activity)
      }
      if (!location) {
        if (!list.length) return failure('NOT_CONFIGURED', { locations: [], message: `本群没有可以${ACTIVITY_LABEL[job.activity]}的工业地点` })
        return this.locationStep(job, req, list)
      }
      defaulted.push('location')
    }

    const manufacturing = job.activity === 'manufacturing'
    if (req.mode === 'steps' && manufacturing && req.me === undefined && req.te === undefined) return this.meteStep(job, req, location, only)
    const fallback = job.t2 ? T2_ME_TE_CHOICES[0] : { me: location.defaultME, te: location.defaultTE }
    let me = 0
    let te = 0
    if (manufacturing) {
      me = req.me ?? fallback.me
      te = req.te ?? fallback.te
      if (req.me === undefined) defaulted.push('me')
      if (req.te === undefined) defaulted.push('te')
    }

    const list = structuresFor(location, job.activity)
    let structure: IndustryStructure | null = null
    let onlyStructure = false
    // 「建筑:?」和写错的建筑名：列出全部，包括「无建筑加成」（反应只能在精炼厂里做，不列）
    if (req.structure === '?') return this.structureStep(job, req, location, only, true)
    if (req.structure === 'none') {
      if (!manufacturing) return this.structureStep(job, req, location, only, true, REACTION_NEEDS_REFINERY)
      structure = null
    } else if (req.structure !== undefined) {
      const found = findStructure(location, req.structure, job.activity)
      if (!found) return this.structureStep(job, req, location, only, true, `${location.name} 没有叫「${req.structure}」的建筑，请重新选择`)
      structure = found
    } else if (list.length) {
      // 「无建筑加成」不算一个选项：只有一座建筑时直接用它
      if (req.mode === 'steps' && list.length > 1) return this.structureStep(job, req, location, only, false)
      structure = defaultStructure(location, job.activity)
      defaulted.push('structure')
      onlyStructure = list.length === 1
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
    return industryArgsText({ item: this.o.items.commandName(job.product), ...parts })
  }

  /** 每一步都原样带上的参数：数量、改装件、税、材料 */
  private carried(req: IndustryRequest): Omit<IndustryArgsParts, 'item'> {
    return { quantity: req.quantity, runs: req.runs, rigs: req.rigs, facilityTaxPct: req.facilityTaxPct, materials: req.materials }
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

  private async locationStep(job: Job, req: IndustryRequest, list: IndustryLocation[]): Promise<IndustryStep> {
    const indices = await this.quickIndices()
    // 写了的建筑带下去：选了地点以后用它，或者说明这个地点没有它
    const carry = { ...this.carried(req), me: req.me, te: req.te, structure: req.structure }
    const options = list.map((location) => {
      const structure = defaultStructure(location, job.activity)
      const sci = indices ? costIndexOf(indices, location.system.id, job.activity) : undefined
      const detail = [
        SEC_LABEL[location.system.secClass],
        structure?.name ?? '无建筑加成',
        sci === undefined ? '' : `系统指数 ${pctFixed(sci * 100)}`,
      ].filter(Boolean).join(' · ')
      return { label: location.name, detail, command: this.command(job, { ...carry, location: location.name, steps: true }) }
    })
    const step: IndustryStep = { step: 'location', options, summary: this.summary(job, req) }
    const fallback = this.o.locations.defaultLocation(job.access, job.activity)
    if (fallback) step.defaults = this.command(job, { ...carry, location: fallback.name })
    return step
  }

  private meteStep(job: Job, req: IndustryRequest, location: IndustryLocation, only: boolean): IndustryStep {
    const choices = job.t2 ? T2_ME_TE_CHOICES : this.o.settings.meTeChoices
    const carry = { ...this.carried(req), location: location.name, structure: req.structure }
    return {
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
  }

  /** all：也列「无建筑加成」（反应只能在精炼厂里做，不列） */
  private structureStep(job: Job, req: IndustryRequest, location: IndustryLocation, only: boolean, all: boolean, notice?: string): IndustryStep {
    const carry = { ...this.carried(req), location: location.name, me: req.me, te: req.te }
    const options: IndustryStep['options'] = structuresFor(location, job.activity).map((structure) => ({
      label: structure.name,
      detail: this.structureDetail(job, location, structure, req.rigs ?? 'default'),
      command: this.command(job, { ...carry, structure: structure.name }),
    }))
    if (all && job.activity === 'manufacturing') {
      const tax = req.facilityTaxPct ?? formulaConfig(this.o.settings).npcFacilityTaxPct
      const command = this.command(job, { ...carry, structure: 'none' })
      options.push({ label: '无建筑加成', detail: `按 NPC 空间站算 · 设施税 ${pctText(tax)}`, command })
    }
    const step: IndustryStep = { step: 'structure', options, summary: this.summary(job, req, location, only, false), defaults: this.command(job, carry) }
    if (notice) step.notice = notice
    return step
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
    const tax = facilityTaxPctFor({ override: setup.tax, structurePct: structure?.facilityTaxPct, hasStructure: !!structure }, config)
    Object.assign(result.applied, { facilityTaxPct: tax, sccPct: config.sccSurchargePct })
    let sci = 0
    if (!costs.indices) {
      result.warnings.push('系统指数暂时取不到，安装费用没有计入系统指数（偏低）')
    } else {
      const found = costIndexOf(costs.indices, location.system.id, job.activity)
      if (found === undefined) result.warnings.push(`${nameOf(location.system)} 不在系统指数列表里，安装费用按指数 0 计算`)
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

  /** 系统指数和调整价（各自有时限，取不到时是 null） */
  private async costInputs(): Promise<CostInputs> {
    const [indices, adjusted] = await Promise.all([
      this.safe(() => this.o.indices.systemIndices(), '系统指数'),
      this.safe(() => this.o.indices.adjustedPrices(), '调整价'),
    ])
    return { indices, adjusted }
  }

  /** 第 1 步列地点用：只等一小会儿 */
  private quickIndices(): Promise<SystemIndices | null> {
    return this.safe(() => this.o.indices.systemIndices({ deadlineMs: STEP_INDICES_WAIT_MS }), '系统指数')
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
