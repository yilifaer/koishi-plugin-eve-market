// 制造比价的排序：材料价格不全的地点排在所有齐全的后面，也不标「最低」。

import type { IndustryResult, LocationComparison } from '../types'

/** 成本不完整（只用来标「（不完整）」）：有材料没价格，或者没算出安装费用（调整价一个都没有时 EIV 为 0，也当没算） */
export function costIncomplete(r: Pick<IndustryResult, 'missingPrices' | 'jobCost'>): boolean {
  return r.missingPrices > 0 || !(r.jobCost && r.jobCost.eiv > 0)
}

const costOf = (r: IndustryResult) => r.materialCost + (r.jobCost?.total ?? 0)

/** 材料价格齐全的按总成本从低到高，缺价格的排在后面（各自也按总成本）；没算出安装费不影响排序；最低只给价格齐全的第一个，最快在所有地点里挑 */
export function rankRows(rows: LocationComparison['rows']): void {
  const incomplete = (row: LocationComparison['rows'][number]) => (row.result.missingPrices > 0 ? 1 : 0)
  rows.sort((a, b) => incomplete(a) - incomplete(b) || costOf(a.result) - costOf(b.result))
  for (const row of rows) {
    row.cheapest = false
    row.fastest = false
  }
  if (rows.length && rows[0].result.missingPrices === 0) rows[0].cheapest = true
  const fastest = rows.reduce((best, r) => (r.result.timeSeconds < best.result.timeSeconds ? r : best), rows[0])
  if (fastest) fastest.fastest = true
}
