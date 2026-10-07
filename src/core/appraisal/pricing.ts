// 报价 → 估价的每一行、合计、和基准市场比较、押金（§6.5.4–§6.5.6）。纯函数，不发请求：
//   base     = 报价.[sell|buy].best 或 mid
//   adjusted = base × (1 + modifierPct / 100)
//   line     = adjusted × qty
// 回退市场替换的是整个报价（中间价不会由两个市场拼出来），只用于主市场没挂单的物品。

import type { AppraisalResult, AppraisalRow, ItemInfo, Lang, PriceQuote, PriceSide, QuoteStatus, TypeId } from '../types'
import { packagedM3 } from './freight'
import type { Entry, EntryRole, ItemLookup } from './lines'

export type RowGroup = AppraisalRow['group']
export type NoPriceReason = AppraisalResult['noPrice'][number]['reason']

/** 一个市场的一批报价：done = 在时限内回来了（缺的物品算超时）；late = 整批没赶上；error = 整批出错 */
export type QuoteBatch =
  | { kind: 'done'; quotes: ReadonlyMap<TypeId, PriceQuote> }
  | { kind: 'late' }
  | { kind: 'error' }

/** 同一种物品的几行合在一起，还没定价 */
export interface RowDraft {
  item: ItemInfo
  quantity: number
  /** 每一行都是唯一前缀命中时才算（有一行写了完整名字就不用 ≈） */
  approx: boolean
  lang: Lang
  sourceLines: number[]
  group: RowGroup
}

/** 弹药、无人机、铁骑舰载机 */
const DRONE_CHARGE_CATEGORIES: ReadonlySet<number> = new Set([8, 18, 87])

/** 装配估价的分类：装填的弹药和无人机舱里的东西按物品大类分，货柜里的其他东西算「其他」 */
export function groupOf(role: EntryRole | undefined, item: ItemInfo): RowGroup {
  switch (role) {
    case 'hull':
      return 'hull'
    case 'module':
      return 'module'
    case 'charge':
      return 'drone-charge'
    case 'cargo':
      return DRONE_CHARGE_CATEGORIES.has(item.categoryId) ? 'drone-charge' : 'other'
    default:
      return 'other'
  }
}

export interface Drafted {
  /** 按每种物品第一次出现的顺序 */
  drafts: RowDraft[]
  /** 认出的物品 */
  resolved: Array<{ entry: Entry; item: ItemInfo }>
  /** 未识别的，加上保存时认得、现在的数据里已经没有的 */
  unresolved: Entry[]
}

export function draftRows(entries: readonly Entry[], lookup: ItemLookup): Drafted {
  const byType = new Map<TypeId, RowDraft>()
  const resolved: Drafted['resolved'] = []
  const unresolved: Entry[] = []
  for (const entry of entries) {
    const item = entry.typeId === null ? undefined : lookup.byId(entry.typeId)
    if (!item) {
      unresolved.push(entry)
      continue
    }
    resolved.push({ entry, item })
    const draft = byType.get(item.typeId)
    if (!draft) {
      byType.set(item.typeId, {
        item, quantity: entry.quantity, approx: entry.approx, lang: entry.lang, sourceLines: [entry.lineNo], group: groupOf(entry.role, item),
      })
      continue
    }
    draft.quantity += entry.quantity
    draft.approx &&= entry.approx
    if (!draft.sourceLines.includes(entry.lineNo)) draft.sourceLines.push(entry.lineNo)
  }
  return { drafts: [...byType.values()], resolved, unresolved }
}

// ------------------------------------------------------------------ 定价

export type Outcome =
  | { kind: 'priced'; unit: number; quote: PriceQuote }
  | { kind: 'missing'; reason: NoPriceReason; status: QuoteStatus }

const TIMEOUT: Outcome = { kind: 'missing', reason: 'timeout', status: 'timeout' }

/** 这一侧的价格；没有、不是正数的都算没有（任何情况下都不当成 0） */
export function sideValue(quote: PriceQuote, side: PriceSide): number | null {
  const value = side === 'sell' ? quote.sell?.best : side === 'buy' ? quote.buy?.best : quote.mid
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function outcomeOf(batch: QuoteBatch, typeId: TypeId, side: PriceSide): Outcome {
  if (batch.kind === 'late') return TIMEOUT
  if (batch.kind === 'error') return { kind: 'missing', reason: 'market-unavailable', status: 'unavailable' }
  const quote = batch.quotes.get(typeId)
  if (!quote) return TIMEOUT
  switch (quote.status) {
    case 'ok':
    case 'stale': {
      const unit = sideValue(quote, side)
      return unit === null ? { kind: 'missing', reason: 'no-orders', status: quote.status } : { kind: 'priced', unit, quote }
    }
    case 'timeout':
      return TIMEOUT
    default:
      return { kind: 'missing', reason: 'market-unavailable', status: quote.status }
  }
}

export interface PricingInput {
  drafts: readonly RowDraft[]
  side: PriceSide
  modifierPct: number
  main: QuoteBatch
  /** 回退市场的报价（只请求了主市场没挂单的物品） */
  fallback?: { marketKey: string; batch: QuoteBatch }
}

export interface Priced {
  /** 粘贴顺序 */
  rows: AppraisalRow[]
  noPrice: AppraisalResult['noPrice']
  totals: AppraisalResult['totals']
  /** 计入合计的报价里最旧的数据时间 */
  dataTime: number | null
}

/** 主市场没挂单、回退市场有价时用回退市场的整个报价 */
function chooseOutcome(draft: RowDraft, input: PricingInput): { outcome: Outcome; fallback?: AppraisalRow['fallback'] } {
  const main = outcomeOf(input.main, draft.item.typeId, input.side)
  if (main.kind === 'priced' || main.reason !== 'no-orders' || !input.fallback) return { outcome: main }
  const other = outcomeOf(input.fallback.batch, draft.item.typeId, input.side)
  if (other.kind !== 'priced') return { outcome: main }
  return { outcome: other, fallback: { marketKey: input.fallback.marketKey, side: input.side } }
}

function rowOf(draft: RowDraft, outcome: Outcome, factor: number, fallback?: AppraisalRow['fallback']): AppraisalRow {
  const head = { ...draft, sourceLines: [...draft.sourceLines], packagedM3: packagedM3(draft.item, draft.quantity) }
  if (outcome.kind === 'missing') return { ...head, unit: null, adjustedUnit: null, total: null, status: outcome.status }
  const adjustedUnit = outcome.unit * factor
  const row: AppraisalRow = { ...head, unit: outcome.unit, adjustedUnit, total: adjustedUnit * draft.quantity, status: outcome.quote.status }
  if (fallback) row.fallback = fallback
  return row
}

export function priceRows(input: PricingInput): Priced {
  const factor = 1 + input.modifierPct / 100
  const rows: AppraisalRow[] = []
  const noPrice: Priced['noPrice'] = []
  const totals: Priced['totals'] = { market: 0, adjusted: 0, packagedM3: 0, pricedTypes: 0, units: 0, missing: 0 }
  let dataTime: number | null = null
  for (const draft of input.drafts) {
    const { outcome, fallback } = chooseOutcome(draft, input)
    const row = rowOf(draft, outcome, factor, fallback)
    rows.push(row)
    totals.packagedM3 += row.packagedM3
    if (outcome.kind === 'missing') {
      noPrice.push({ item: draft.item, reason: outcome.reason })
      continue
    }
    totals.market += outcome.unit * draft.quantity
    totals.adjusted += row.total ?? 0
    totals.pricedTypes++
    totals.units += draft.quantity
    const time = outcome.quote.dataTime
    if (time !== null && (dataTime === null || time < dataTime)) dataTime = time
  }
  totals.missing = noPrice.length
  return { rows, noPrice, totals, dataTime }
}

// ------------------------------------------------------------------ 和基准市场比较、押金

/**
 * 同样的物品和数量按基准市场同一价格类型再算一次，比较两边调整前的市场总价。只算两边都有价的物品
 * （回退市场定价的不算）；有一种物品的基准报价没拿到（超时、出错）就不比较
 */
export function compareWithBase(rows: readonly AppraisalRow[], batch: QuoteBatch, side: PriceSide, marketKey: string): AppraisalResult['vsBase'] {
  if (batch.kind !== 'done') return undefined
  let local = 0
  let base = 0
  let compared = 0
  for (const row of rows) {
    if (row.unit === null || row.fallback) continue
    const outcome = outcomeOf(batch, row.item.typeId, side)
    if (outcome.kind === 'missing') {
      if (outcome.reason === 'no-orders') continue
      return undefined
    }
    local += row.unit * row.quantity
    base += outcome.unit * row.quantity
    compared++
  }
  if (!compared || !(base > 0)) return undefined
  return { marketKey, side, total: base, diffPct: (local - base) / base * 100 }
}

/** 押金按基准市场的出售价合计；没有出售价的物品不计入，记个数 */
export function collateralOf(drafts: readonly RowDraft[], batch: QuoteBatch): { collateral: number; missing: number } {
  let collateral = 0
  let missing = 0
  for (const draft of drafts) {
    const outcome = outcomeOf(batch, draft.item.typeId, 'sell')
    if (outcome.kind === 'priced') collateral += outcome.unit * draft.quantity
    else missing++
  }
  return { collateral, missing }
}
