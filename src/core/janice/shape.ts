// Janice 响应的读取：所有响应字段名只在这个文件里出现。宽松地读成 JaniceAppraisal——缺的字段给空值，
// 只有编号和三个总价读不到时才算响应不可用（返回 null）。不读 input（原始粘贴文字）和 comment（别人写的备注），
// 这两个字段不进任何结构。

type Loose = Record<string, unknown>

export interface JaniceRawPrices {
  sell: number
  buy: number
  split: number
}

export interface JaniceRawItem {
  typeId: number
  en: string
  amount: number
  /** 这一行的小计（接口已按估价比例算好） */
  totals: JaniceRawPrices
}

export interface JaniceAppraisal {
  code: string
  market: string | null
  pricing: string | null
  variant: string | null
  designation: string | null
  /** 响应里的原始值；缺失时 null（合不合法由 service 判断） */
  percentage: number | null
  /** 总价（接口已按估价比例算好） */
  totals: JaniceRawPrices
  items: JaniceRawItem[]
  packagedVolume: number | null
  datasetAt: number | null
  expiresAt: number | null
  failedLines: number
}

const asObject = (v: unknown): Loose | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Loose : null)
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

function asTime(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

function prices(v: unknown, keys: readonly [string, string, string]): JaniceRawPrices | null {
  const o = asObject(v)
  if (!o) return null
  const [sell, buy, split] = keys.map((k) => asNumber(o[k]))
  return sell === null || buy === null || split === null ? null : { sell, buy, split }
}

function readItem(raw: unknown): JaniceRawItem | null {
  const o = asObject(raw)
  const type = asObject(o?.itemType)
  if (!o || !type) return null
  const typeId = asNumber(type.eid)
  const en = asString(type.name)
  const amount = asNumber(o.amount)
  if (typeId === null || !Number.isInteger(typeId) || typeId <= 0 || !en || amount === null || amount <= 0) return null
  const totals = prices(o.effectivePrices, ['sellPriceTotal', 'buyPriceTotal', 'splitPriceTotal']) ?? { sell: 0, buy: 0, split: 0 }
  return { typeId, en, amount, totals }
}

/** failures：Janice 没认出来的行（一个字符串，一行一条）；只数个数 */
function failedLines(v: unknown): number {
  return typeof v === 'string' ? v.split(/\r?\n/).filter((l) => l.trim()).length : 0
}

/** 编号或总价读不到时 null */
export function readAppraisal(json: unknown): JaniceAppraisal | null {
  const o = asObject(json)
  if (!o) return null
  const code = asString(o.code)
  const totals = prices(o.effectivePrices, ['totalSellPrice', 'totalBuyPrice', 'totalSplitPrice'])
  if (!code || !totals) return null
  return {
    code,
    market: asString(asObject(o.market)?.name),
    pricing: asString(o.pricing),
    variant: asString(o.pricingVariant),
    designation: asString(o.designation),
    percentage: asNumber(o.pricePercentage),
    totals,
    items: Array.isArray(o.items) ? o.items.map(readItem).filter((i): i is JaniceRawItem => i !== null) : [],
    packagedVolume: asNumber(o.totalPackagedVolume),
    datasetAt: asTime(o.datasetTime),
    expiresAt: asTime(o.expires),
    failedLines: failedLines(o.failures),
  }
}
