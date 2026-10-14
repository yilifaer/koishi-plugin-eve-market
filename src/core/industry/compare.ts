// 制造比价的排序：成本不完整的地点排在所有完整的后面，也不标「最低」。

import type { IndustryResult, LocationComparison } from '../types'

/** 成本不完整：有材料没价格，或者没算出安装费用（调整价一个都没有时 EIV 为 0，也当没算） */
export function costIncomplete(r: Pick<IndustryResult, 'missingPrices' | 'jobCost'>): boolean {
  return r.missingPrices > 0 || !(r.jobCost && r.jobCost.eiv > 0)
}

const costOf = (r: IndustryResult) => r.materialCost + (r.jobCost?.total ?? 0)

/** 完整的按总成本从低到高，不完整的排在后面（各自也按总成本）；最低只给完整的第一个，最快在所有地点里挑 */
export function rankRows(rows: LocationComparison['rows']): void {
  const incomplete = (row: LocationComparison['rows'][number]) => (costIncomplete(row.result) ? 1 : 0)
  rows.sort((a, b) => incomplete(a) - incomplete(b) || costOf(a.result) - costOf(b.result))
  for (const row of rows) {
    row.cheapest = false
    row.fastest = false
  }
  if (rows.length && !costIncomplete(rows[0].result)) rows[0].cheapest = true
  const fastest = rows.reduce((best, r) => (r.result.timeSeconds < best.result.timeSeconds ? r : best), rows[0])
  if (fastest) fastest.fastest = true
}
