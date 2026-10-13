// 制造、制造比价、反应的卡片（§2.6–§2.8）：基础参考、高级结果、逐步选择、材料清单、地点比价。
// 主金额（材料成本、安装费用、设施税、SCC 附加费、其他费用、总成本、成品价值）跟 priceDisplayMode；
// 材料清单和比价的每一行跟 listPriceDisplayMode。没有价格的写「缺价格」，总成本标不完整，绝不写 0 ISK。
// 按钮由调用方算好传进来（卡片只管排版）。

import { MAX_SKILL_MANUFACTURING_MULT, MAX_SKILL_REACTION_MULT, SERVER_LABEL, TOP_MATERIALS } from '../../constants'
import { listPriceMode } from '../../core/format'
import type {
  DisplaySettings, EveCore, FormattedPrice, IndustryActivity, IndustryResult, IndustryRigState, IndustrySettings, IndustryStep,
  ItemInfo, LocationComparison, PriceSide,
} from '../../core/types'
import type { Action, Card, Choice, CommandRef, Line } from '../view/card'
import { escapeMarkdown, scrubUrls } from '../view/escape'
import { emptyCard } from './context'
import { IND, SIDE_NONE, SIDE_SHORT } from './industry-text'
import { amountText, itemName } from './names'
import { SEC_CLASS, SIDE_LABEL } from './text'

export interface IndustryEnv {
  core: Pick<EveCore, 'format' | 'markets'>
  display: Pick<DisplaySettings, 'priceDisplayMode' | 'listPriceDisplayMode'>
  industry: Pick<IndustrySettings, 'sellFeesPct'>
}

/** 舰船大类：数量单位写「艘」 */
const CATEGORY_SHIP = 6
/** 「以下材料没有价格」最多列几种 */
const MISSING_LISTED = 5

// ------------------------------------------------------------------ 小工具

const esc = escapeMarkdown
const nameOf = (item: ItemInfo) => esc(itemName(item))
const unitOf = (item: ItemInfo) => (item.categoryId === CATEGORY_SHIP ? '艘' : '个')
const qty = (env: IndustryEnv, n: number) => env.core.format.quantity(n)
const isk = (env: IndustryEnv, v: number) => env.core.format.isk(v)
/** 费用明细：完整价格不写 .00 */
const iskInt = (env: IndustryEnv, v: number) => env.core.format.isk(v, { integer: true })
const listIsk = (env: IndustryEnv, v: number) => env.core.format.isk(v, { mode: listPriceMode(env.display) })
const amount = (env: IndustryEnv, v: number) => amountText(env.core.format, v, env.display.priceDisplayMode)
const duration = (env: IndustryEnv, sec: number) => env.core.format.duration(sec)

/** 2.31%、1.00%（星系成本指数、设施税固定 2 位小数） */
const pctFixed = (p: number) => `${(Math.round(p * 100) / 100 || 0).toFixed(2)}%`
/** 4%、-5.04%、-50.4%（末尾的 0 去掉） */
const pctTrim = (p: number) => `${Math.round(p * 100) / 100 || 0}%`
/** 利润率：1 位小数 */
const marginText = (p: number) => `${Math.round(p * 10) / 10 || 0}%`

/** **乌鸦级** Raven · 后缀；没有中文名时只写英文名 */
export function productTitle(item: ItemInfo, suffix: string): string {
  if (!item.zh) return `**${esc(item.en)}** · ${suffix}`
  return `**${esc(item.zh)}** ${esc(item.en)} · ${suffix}`
}

function marketName(env: IndustryEnv, key: string | undefined): string {
  if (!key) return ''
  return esc(env.core.markets.get(key)?.name ?? key)
}

/** 材料按 Jita 4-4 出售价；没有材料市场时 '' */
function materialsAt(env: IndustryEnv, r: IndustryResult): string {
  const m = r.materialPrices
  return m ? IND.materialsAt(marketName(env, m.marketKey), SIDE_LABEL[m.side]) : ''
}

/** 「Jita 4-4 出售价」（材料清单、比价的元信息行） */
export function priceSource(env: IndustryEnv, key: string, side: PriceSide): string {
  return `${marketName(env, key)} ${SIDE_LABEL[side]}`
}

/** 星系成本指数、调整价用的是更新失败前的旧数据时写明（调整价只在这时写） */
function footer(env: IndustryEnv, r: IndustryResult, withIndices: boolean): string {
  const parts: string[] = [SERVER_LABEL]
  const clock = (ms: number) => env.core.format.clock(ms)
  if (r.pricesAt) parts.push(IND.footerPrices(clock(r.pricesAt)))
  if (withIndices && r.indicesAt) parts.push(`${IND.footerIndices(clock(r.indicesAt))}${r.indicesStale ? IND.cached : ''}`)
  if (withIndices && r.adjustedStale && r.adjustedPricesAt) parts.push(`${IND.footerAdjusted(clock(r.adjustedPricesAt))}${IND.cached}`)
  return parts.join(' · ')
}

/** 警告：结果自带的（已经是完整的句子），再加没有价格的材料 */
function warningsOf(r: IndustryResult): string[] {
  const out = r.warnings.map((w) => esc(scrubUrls(w)))
  const missing = r.materials.filter((m) => m.total === null)
  if (missing.length) {
    const names = missing.slice(0, MISSING_LISTED).map((m) => nameOf(m.item)).join('、')
    out.push(IND.missingPrices(names, missing.length, MISSING_LISTED))
  }
  return out
}

/** † 部分材料按 Amarr 出售价 */
function fallbackLine(env: IndustryEnv, r: IndustryResult): Line[] {
  const key = r.materialPrices?.fallbackKey
  if (!key || !r.materials.some((m) => m.fallback)) return []
  return [{ text: IND.fallbackNote(priceSource(env, key, r.materialPrices!.side)) }]
}

/** 算出来的安装费用；调整价一个都没有（EIV 为 0）时当作没算 */
function jobOf(r: IndustryResult): IndustryResult['jobCost'] {
  return r.jobCost && r.jobCost.eiv > 0 ? r.jobCost : undefined
}

function incompleteNote(r: IndustryResult): string {
  return r.missingPrices ? IND.incomplete(r.missingPrices) : ''
}

/** 改装件的情况：没给时按有没有生效的改装件算 */
function rigStateOf(r: IndustryResult): IndustryRigState {
  return r.applied.rigState ?? (r.applied.rigs.length ? 'applied' : 'impossible')
}

/** 改装件这一行（按 core 判断的情况）：生效的（已乘安等倍率）、不用、没装、装了但对这个产品不生效；没有建筑加成时不写 */
function rigsLine(r: IndustryResult): string | undefined {
  if (!r.applied.structure) return undefined
  switch (rigStateOf(r)) {
    case 'applied': {
      const list = r.applied.rigs.map((rig) => {
        const parts = ([['材料', rig.me], ['时间', rig.te], ['费用', rig.cost]] as const)
          .filter(([, p]) => p !== 0)
          .map(([label, p]) => `${label} ${pctTrim(p)}`)
        return parts.length ? IND.rigEffect(nameOf(rig.item), parts.join('，')) : nameOf(rig.item)
      })
      return IND.rigsApplied(list.join('、'))
    }
    case 'disabled':
      return IND.rigsNone
    case 'not-installed':
      return IND.rigsNotInstalled
    case 'not-applicable':
      return IND.rigsNoMatch(nameOf(r.product))
    case 'impossible':
      return undefined
  }
}

/** XX-1 · 大厂（默认建筑） · 00 */
function placeLine(r: IndustryResult): string {
  const { applied } = r
  const d = new Set(applied.defaulted)
  const parts: string[] = []
  if (applied.location) parts.push(`${esc(applied.location)}${d.has('location') ? (applied.locationFiltered ? IND.defaulted.locationFiltered : IND.defaulted.location) : ''}`)
  const mark = !d.has('structure') ? '' : applied.structureOnly ? (applied.structureFiltered ? IND.defaulted.structureFiltered : IND.defaulted.structureOnly) : IND.defaulted.structure
  // 自动挑的写「自动选择：名称」；地点只有一座时仍是「该地点唯一」
  if (applied.structure && applied.autoPicked) parts.push(IND.autoPicked(esc(applied.structure)))
  else parts.push(applied.structure ? `${esc(applied.structure)}${mark}` : IND.noStructure)
  if (applied.secClass) parts.push(SEC_CLASS[applied.secClass])
  return parts.join(' · ')
}

/** 1 流程（1 艘） */
function runsText(env: IndustryEnv, r: IndustryResult): string {
  return IND.runs(qty(env, r.runs), qty(env, r.outputQuantity), unitOf(r.product))
}

/** 星系成本指数 2.31% · 设施税 1.00% · SCC 附加费 4% */
function ratesLine(r: IndustryResult): string | undefined {
  const { sci, facilityTaxPct, sccPct } = r.applied
  const parts: string[] = []
  if (sci !== undefined) parts.push(IND.sci(pctFixed(sci * 100)))
  if (facilityTaxPct !== undefined) parts.push(IND.facilityTax(pctFixed(facilityTaxPct)))
  if (sccPct !== undefined) parts.push(IND.scc(pctTrim(sccPct)))
  return parts.length ? parts.join(' · ') : undefined
}

function timeLine(env: IndustryEnv, r: IndustryResult, activity: IndustryActivity, base: boolean): Line {
  const max = r.timeSecondsMaxSkill === undefined ? undefined : duration(env, r.timeSecondsMaxSkill)
  const note = base ? IND.timeBase(max) : max ? IND.timeMax(max) : ''
  const line = `${IND.time(activity)} ${duration(env, r.timeSeconds)}${note}`
  return { text: r.runs > 1 ? `${line} · ${IND.timeLine}` : line }
}

/** 时间修正（像游戏里的「项目周期修正值」）：蓝图 TE、技能、改装件、建筑；乘数相乘，各行只列自己的 */
function timeModifierLines(r: IndustryResult, activity: IndustryActivity): Line[] {
  const out: string[] = []
  if (activity === 'manufacturing' && r.applied.te > 0) out.push(IND.timeBlueprint(r.applied.te, pctTrim(-r.applied.te)))
  const skillMult = activity === 'manufacturing' ? MAX_SKILL_MANUFACTURING_MULT : MAX_SKILL_REACTION_MULT
  out.push(IND.timeSkills(pctTrim((skillMult - 1) * 100)))
  const rigs = r.applied.rigs.reduce((sum, rig) => sum + rig.te, 0)
  if (rigs !== 0) out.push(IND.timeRigs(pctTrim(rigs)))
  const structure = r.applied.structureBonus?.te
  if (structure) out.push(IND.timeStructure(pctTrim(structure)))
  return out.map((text) => ({ text, indent: 1 as const }))
}

/** 结果卡片的时间：主数字是未计技能的，下面列修正和满技能时间 */
function resultTimeLines(env: IndustryEnv, r: IndustryResult, activity: IndustryActivity): Line[] {
  const total = duration(env, r.timeSeconds)
  const head = activity === 'manufacturing'
    ? `${IND.time(activity)} ${total}${IND.timeNoSkill}${r.runs > 1 ? ` · ${IND.timeLine}` : ''}`
    : `${IND.time(activity)} ${IND.reactionTime(duration(env, r.timeSeconds / Math.max(1, r.runs)), total)}${IND.timeNoSkill}`
  const lines: Line[] = [{ text: head }, ...timeModifierLines(r, activity)]
  if (r.timeSecondsMaxSkill !== undefined) lines.push({ text: IND.timeMaxSkill(duration(env, r.timeSecondsMaxSkill)), indent: 1 })
  return lines
}

/** 费用明细：基础物品成本、星系成本指数、设施税、SCC 附加费、其他费用（金额一律取整） */
function jobCostLines(env: IndustryEnv, r: IndustryResult, job: NonNullable<IndustryResult['jobCost']>): Line[] {
  const { sci, facilityTaxPct, sccPct } = r.applied
  const lines: Line[] = [{ label: IND.eivCost, price: iskInt(env, job.eiv) }]
  // 星系成本指数取不到时不写这一行（不能写成 0），原因见 warnings
  if (sci !== undefined) lines.push({ label: IND.sciCost(pctFixed(sci * 100)), price: iskInt(env, job.grossSci + job.bonuses) })
  lines.push(
    { label: IND.facilityCost(facilityTaxPct === undefined ? undefined : pctFixed(facilityTaxPct)), price: iskInt(env, job.facility) },
    { label: IND.sccCost(sccPct === undefined ? undefined : pctTrim(sccPct)), price: iskInt(env, job.scc) },
  )
  if (job.extra > 0) lines.push({ label: esc(job.extraLabel ?? IND.extraCost), price: iskInt(env, job.extra) })
  return lines
}

/** 成品价值这一行：成品 Jita 4-4 出售 `…`；没有价格时「暂无卖单」 */
function productLine(env: IndustryEnv, r: IndustryResult): Line | undefined {
  const v = r.productValue
  if (!v) return undefined
  const label = IND.product(marketName(env, v.marketKey), SIDE_SHORT[v.side])
  if (v.total === null) return { text: IND.productNone(marketName(env, v.marketKey), SIDE_NONE[v.side]) }
  const mark = v.fallback ? IND.fallbackMark : ''
  const each = r.outputQuantity > 1 && v.unit !== null ? IND.productEach(qty(env, r.outputQuantity), unitOf(r.product), amount(env, v.unit)) : ''
  const extra = `${mark}${each}`
  return extra ? { label, price: isk(env, v.total), extra } : { label, price: isk(env, v.total) }
}

/** **预计利润 90.68M · 利润率 35.1%**（未计销售税和经纪费） */
function profitLine(env: IndustryEnv, r: IndustryResult): Line | undefined {
  if (!r.profit) return undefined
  const fees = env.industry.sellFeesPct > 0 ? IND.profitFees(pctTrim(env.industry.sellFeesPct)) : IND.profitNoFees
  const incomplete = r.missingPrices || !jobOf(r) ? IND.profitIncomplete : ''
  return { text: `${IND.profit(amount(env, r.profit.value), marginText(r.profit.marginPct))}${fees}${incomplete}` }
}

// ------------------------------------------------------------------ 基础参考

export function baseCard(env: IndustryEnv, r: IndustryResult, activity: IndustryActivity, actions: Action[][], materialsButton?: string): Card {
  return activity === 'reaction' ? reactionBaseCard(env, r, actions) : manufacturingBaseCard(env, r, actions, materialsButton)
}

function manufacturingBaseCard(env: IndustryEnv, r: IndustryResult, actions: Action[][], materialsButton?: string): Card {
  const card = emptyCard(productTitle(r.product, IND.baseTitle('manufacturing')))
  card.sections.push({ style: 'plain', lines: [{ text: `${IND.blueprint(r.applied.me, r.applied.te)} · ${IND.baseScope}` }] })
  const output = r.runs === 1 ? IND.perRunOutput(qty(env, r.outputQuantity), unitOf(r.product)) : runsText(env, r)
  card.sections.push({
    lines: [
      materialCostLine(env, r),
      timeLine(env, r, 'manufacturing', true),
      { text: [output, materialsAt(env, r)].filter(Boolean).join(' · ') },
    ],
  })
  const top = r.materials.slice(0, TOP_MATERIALS).map((m) => `${nameOf(m.item)} ×${qty(env, m.quantity)}`)
  if (top.length) {
    const lines: Line[] = [{ text: IND.topMaterials(top.join(' · ')) }]
    if (r.materials.length > TOP_MATERIALS && materialsButton) lines.push({ text: IND.allMaterials(r.materials.length, esc(materialsButton)) })
    card.sections.push({ style: 'plain', lines })
  }
  const product = productLine(env, r)
  card.sections.push({ style: 'plain', lines: [...fallbackLine(env, r), ...product ? [product] : []] })
  card.sections.push({ style: 'plain', lines: [{ text: IND.baseNote }] })
  card.warnings = warningsOf(r)
  card.footer = footer(env, r, false)
  card.actions = actions
  return card
}

function materialCostLine(env: IndustryEnv, r: IndustryResult): Line {
  const note = incompleteNote(r)
  const price = costPrice(env, r, r.materialCost)
  return note ? { label: IND.materialCost, price, extra: note } : { label: IND.materialCost, price }
}

/** 一种材料的价格都没有时，成本写「—」（绝不写 0 ISK） */
function costPrice(env: IndustryEnv, r: IndustryResult, value: number, list = false): FormattedPrice {
  if (r.materials.length && r.missingPrices >= r.materials.length) return { na: true }
  return list ? listIsk(env, value) : isk(env, value)
}

function reactionBaseCard(env: IndustryEnv, r: IndustryResult, actions: Action[][]): Card {
  const card = emptyCard(productTitle(r.product, IND.baseTitle('reaction')))
  const perRunTime = duration(env, r.timeSeconds / Math.max(1, r.runs))
  const perRunQty = qty(env, Math.round(r.outputQuantity / Math.max(1, r.runs)))
  // 按数量换算成几个流程时，写明这些流程一共产出多少
  const recipe = IND.recipe(nameOf(r.blueprint), perRunTime, perRunQty)
  card.sections.push({
    style: 'plain',
    lines: [
      { text: r.runs > 1 ? `${recipe} · ${runsText(env, r)}` : recipe },
      { text: [IND.baseScope, materialsAt(env, r)].filter(Boolean).join(' · ') },
    ],
  })
  const head = materialCostLine(env, r)
  const lines: Line[] = ['label' in head ? { ...head, label: IND.outputMaterials(r.runs) } : head]
  for (const m of r.materials) {
    const price = m.total === null ? IND.missingPrice : `${amountText(env.core.format, m.total, listPriceMode(env.display))}${m.fallback ? IND.fallbackMark : ''}`
    lines.push({ text: `${nameOf(m.item)} ×${qty(env, m.quantity)} · ${price}`, indent: 1 })
  }
  const v = r.productValue
  if (v) {
    const market = marketName(env, v.marketKey)
    if (v.total === null || v.unit === null) {
      lines.push({ text: `${IND.outputValue(r.runs)} — · ${market} ${SIDE_NONE[v.side]}` })
    } else {
      const each = IND.perUnit(market, SIDE_SHORT[v.side], env.core.format.compact(v.unit))
      lines.push({ label: IND.outputValue(r.runs), price: isk(env, v.total), extra: `· ${each}${v.fallback ? IND.fallbackMark : ''}` })
    }
  }
  card.sections.push({ lines })
  const fallback = fallbackLine(env, r)
  if (fallback.length) card.sections.push({ style: 'plain', lines: fallback })
  card.warnings = warningsOf(r)
  card.footer = footer(env, r, false)
  card.actions = actions
  return card
}

// ------------------------------------------------------------------ 高级结果

export function resultCard(env: IndustryEnv, r: IndustryResult, activity: IndustryActivity, actions: Action[][]): Card {
  const card = emptyCard(productTitle(r.product, IND.resultTitle(activity)))
  const manufacturing = activity === 'manufacturing'
  const head: Line[] = []
  if (manufacturing) {
    head.push({ text: placeLine(r) })
    const d = new Set(r.applied.defaulted)
    const mark = d.has('me') || d.has('te') ? (r.product.techLevel === 2 ? IND.defaulted.meTeT2 : IND.defaulted.meTe) : ''
    head.push({ text: `${IND.blueprint(r.applied.me, r.applied.te)}${mark} · ${runsText(env, r)}` })
  } else {
    head.push({ text: `${placeLine(r)} · ${runsText(env, r)}` })
  }
  const rigs = rigsLine(r)
  if (rigs) head.push({ text: rigs })
  // 有费用明细时税率写在明细行里；没有时（取不到调整价）才单列
  const rates = jobOf(r) ? undefined : ratesLine(r)
  if (rates) head.push({ text: rates })
  card.sections.push({ style: 'plain', lines: head })

  const lines: Line[] = [materialCostLine(env, r)]
  const job = jobOf(r)
  if (job) lines.push(...jobCostLines(env, r, job))
  const total = costPrice(env, r, r.materialCost + (job?.total ?? 0))
  const note = `${incompleteNote(r)}${job ? '' : IND.noJobCost}`
  lines.push(note ? { label: IND.totalCost, price: total, extra: note } : { label: IND.totalCost, price: total })
  lines.push(...resultTimeLines(env, r, activity))
  card.sections.push({ lines })

  const tail: Line[] = [...fallbackLine(env, r)]
  const product = manufacturing ? productLine(env, r) : reactionOutputLine(env, r)
  if (product) tail.push(product)
  const profit = profitLine(env, r)
  if (profit) tail.push(profit)
  if (tail.length) card.sections.push({ style: 'plain', lines: tail })
  card.warnings = warningsOf(r)
  card.footer = footer(env, r, true)
  card.actions = actions
  return card
}

/** 产出 60,000 个 · Jita 4-4 出售 `…` */
function reactionOutputLine(env: IndustryEnv, r: IndustryResult): Line | undefined {
  const v = r.productValue
  if (!v) return undefined
  const label = IND.output(qty(env, r.outputQuantity), marketName(env, v.marketKey), SIDE_SHORT[v.side])
  if (v.total === null) return { text: `${label} ${SIDE_NONE[v.side]}` }
  return v.fallback ? { label, price: isk(env, v.total), extra: IND.fallbackMark } : { label, price: isk(env, v.total) }
}

// ------------------------------------------------------------------ 材料清单

export function materialsCard(env: IndustryEnv, r: IndustryResult, activity: IndustryActivity, copies: string[], actions: Action[][]): Card {
  const card = emptyCard(IND.materialsTitle(nameOf(r.product)))
  const meta: string[] = []
  if (r.applied.location) meta.push(esc(r.applied.location), r.applied.structure ? esc(r.applied.structure) : IND.noStructure)
  if (activity === 'manufacturing') meta.push(`ME ${r.applied.me}`)
  meta.push(`${qty(env, r.runs)} 流程`)
  if (r.materialPrices) meta.push(priceSource(env, r.materialPrices.marketKey, r.materialPrices.side))
  card.meta = [meta.join(' · ')]
  card.sections.push({
    style: 'ordered',
    lines: r.materials.map((m): Line => {
      const label = `${nameOf(m.item)} ×${qty(env, m.quantity)} ·`
      if (m.total === null) return { text: `${label} ${IND.missingPrice}` }
      return m.fallback ? { label, price: listIsk(env, m.total), extra: IND.fallbackMark } : { label, price: listIsk(env, m.total) }
    }),
  })
  const volume = r.materials.reduce((sum, m) => sum + m.quantity * m.item.packagedVolume, 0)
  const extra = `${incompleteNote(r)}· ${env.core.format.volume(volume)}`
  const lines: Line[] = [{ label: IND.materialsTotal, price: costPrice(env, r, r.materialCost), extra }, ...fallbackLine(env, r)]
  if (copies.length) lines.push({ text: IND.pasteNext })
  card.sections.push({ style: 'plain', lines })
  card.warnings = warningsOf(r)
  card.footer = footer(env, r, false)
  card.actions = actions
  card.copyBlocks = copies
  return card
}

// ------------------------------------------------------------------ 逐步选择

const STEP_ORDER: Record<IndustryActivity, Array<IndustryStep['step']>> = {
  manufacturing: ['location', 'mete', 'structure'],
  reaction: ['location', 'structure'],
}

/** 地点 ✓ → **ME/TE** → 建筑 */
function progressText(activity: IndustryActivity, current: IndustryStep['step']): string {
  const order = STEP_ORDER[activity]
  const at = order.indexOf(current)
  return order.map((step, i) => {
    const label = IND.steps[step]
    if (i === at) return `**${label}**`
    return i < at ? `${label} ✓` : label
  }).join(' → ')
}

export interface StepActions {
  /** 选项的命令（命令名 + IndustryStep 里的参数） */
  option: (args: string) => CommandRef
  /** 「其余默认」「自定义」等动作按钮 */
  actions: Action[][]
}

export function stepCard(product: ItemInfo, activity: IndustryActivity, step: IndustryStep, how: StepActions): Card {
  const card = emptyCard(IND.stepTitle(nameOf(product), activity))
  card.meta.push(IND.progress(progressText(activity, step.step)))
  if (step.summary.length) card.meta.push(IND.selected(step.summary.map((s) => esc(s)).join(' · ')))
  const lines: Line[] = []
  if (step.notice) lines.push({ text: `⚠ ${esc(scrubUrls(step.notice))}` })
  if (step.step === 'location') lines.push({ text: IND.askLocation(activity) })
  else if (step.step === 'mete') lines.push({ text: IND.askMeTe })
  else lines.push({ text: IND.askStructure(activity) })
  if (step.step === 'mete' && step.custom) lines.push({ text: IND.customMeTe })
  if (step.note) lines.push({ text: esc(scrubUrls(step.note)) })
  card.sections.push({ style: 'plain', lines })
  // 按钮上写选项本身（地点名、10/20、建筑名），编号回复照样能用
  card.choices = step.options.map((o, i): Choice => {
    const choice: Choice = { no: i + 1, label: `${esc(o.label)}${o.recommended ? IND.recommended : ''}`, command: how.option(o.command), button: o.button ?? o.label }
    if (o.detail) choice.detail = esc(o.detail)
    return choice
  })
  card.actions = how.actions
  return card
}

// ------------------------------------------------------------------ 制造比价

export function compareCard(env: IndustryEnv, c: LocationComparison, actions: Action[][]): Card {
  const card = emptyCard(IND.compareTitle(nameOf(c.product)))
  const first = c.rows[0]?.result
  const materials = c.materialMarketKey ? IND.materialsAt(marketName(env, c.materialMarketKey), SIDE_LABEL[c.materialSide]) : ''
  // 命令里写的「改装:无」「税:」对每个地点都一样，写在这里
  const written = [c.rigsOff ? IND.compareRigsOff : '', c.facilityTaxPct === undefined ? '' : IND.facilityTax(pctFixed(c.facilityTaxPct)), c.chainIgnored ? IND.compareNoChain : '']
  card.meta = [[`ME ${c.me} / TE ${c.te}`, `${qty(env, c.runs)} 流程`, ...written, materials].filter(Boolean).join(' · ')]
  const lines: Line[] = []
  for (const row of c.rows) {
    const r = row.result
    const marks = [row.cheapest ? IND.cheapest : '', row.fastest ? IND.fastest : ''].filter(Boolean).join(' ')
    const where = row.structure ? `${esc(row.structure)}${row.autoPicked ? IND.autoMark : ''}` : IND.noStructure
    const state = row.structure ? rigStateOf(r) : 'impossible'
    const rigNote = state === 'not-installed' ? IND.noRigsInstalled : state === 'not-applicable' ? IND.noRigsMatch : ''
    lines.push({ text: `**${esc(row.location)}** · ${where}${rigNote}${marks ? ` ${marks}` : ''}` })
    const total = costPrice(env, r, r.materialCost + (jobOf(r)?.total ?? 0), true)
    const parts = [duration(env, r.timeSeconds)]
    if (r.profit) parts.push(IND.compareProfit(amount(env, r.profit.value), marginText(r.profit.marginPct)))
    const note = r.missingPrices || !jobOf(r) ? IND.compareIncomplete : ''
    lines.push({ label: IND.compareCost, price: total, extra: `${note}· ${parts.join(' · ')}`, indent: 1 })
  }
  card.sections.push({ style: 'ordered', lines })
  const tail: Line[] = []
  const v = first?.productValue
  if (v) {
    const value = v.total === null ? SIDE_NONE[v.side] : amount(env, v.total)
    const fees = env.industry.sellFeesPct > 0 ? IND.compareFees(pctTrim(env.industry.sellFeesPct)) : IND.compareNoFees
    tail.push({ text: `${IND.compareProduct(marketName(env, v.marketKey), SIDE_SHORT[v.side], value)} · ${fees}` })
  }
  if (c.unable) tail.push({ text: IND.compareUnable(c.unable.count, esc(c.unable.need)) })
  if (c.rows.length) tail.push({ text: IND.compareHint })
  card.sections.push({ style: 'plain', lines: tail })
  // 每个地点都一样的警告（T2 说明、市场不可用）只写一次
  const seen = new Set<string>()
  for (const row of c.rows) for (const w of warningsOf(row.result)) seen.add(w)
  card.warnings = [...seen]
  if (first) card.footer = footer(env, first, true)
  card.actions = actions
  return card
}
