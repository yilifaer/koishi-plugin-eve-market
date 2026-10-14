import { describe, expect, it } from 'vitest'
import { costIncomplete, rankRows } from '../../../src/core/industry'
import type { IndustryResult, LocationComparison } from '../../../src/core/types'

type Row = LocationComparison['rows'][number]

/** 只带排序用到的字段的结果 */
function row(location: string, o: { material: number; missing?: number; job?: number | null; time?: number }): Row {
  const jobCost = o.job === null ? undefined : { eiv: 1000, total: o.job ?? 0 }
  const result = { materialCost: o.material, missingPrices: o.missing ?? 0, jobCost, timeSeconds: o.time ?? 3600 } as unknown as IndustryResult
  return { location, noRigs: false, result, cheapest: false, fastest: false }
}

describe('costIncomplete', () => {
  it('missing material prices or no job cost make the cost incomplete', () => {
    expect(costIncomplete({ missingPrices: 0, jobCost: { eiv: 5, total: 1 } as IndustryResult['jobCost'] })).toBe(false)
    expect(costIncomplete({ missingPrices: 1, jobCost: { eiv: 5, total: 1 } as IndustryResult['jobCost'] })).toBe(true)
    expect(costIncomplete({ missingPrices: 0, jobCost: undefined })).toBe(true)
    expect(costIncomplete({ missingPrices: 0, jobCost: { eiv: 0, total: 0 } as IndustryResult['jobCost'] })).toBe(true)
  })
})

describe('rankRows', () => {
  it('complete rows by total cost, then incomplete rows (also by cost); the cheapest mark only goes to a complete row', () => {
    const rows = [row('甲', { material: 10, missing: 1 }), row('乙', { material: 300 }), row('丙', { material: 100, job: null }), row('丁', { material: 200 })]
    rankRows(rows)
    expect(rows.map((r) => [r.location, r.cheapest])).toEqual([['丁', true], ['乙', false], ['甲', false], ['丙', false]])
  })

  it('when every row is incomplete nobody is the cheapest', () => {
    const rows = [row('甲', { material: 20, missing: 2 }), row('乙', { material: 10, missing: 1 })]
    rankRows(rows)
    expect(rows.map((r) => [r.location, r.cheapest])).toEqual([['乙', false], ['甲', false]])
  })

  it('the fastest mark ignores completeness', () => {
    const rows = [row('甲', { material: 20, time: 100, missing: 1 }), row('乙', { material: 10, time: 200 })]
    rankRows(rows)
    expect(rows.map((r) => [r.location, r.cheapest, r.fastest])).toEqual([['乙', true, false], ['甲', false, true]])
  })

  it('complete rows keep today\'s order', () => {
    const rows = [row('乙', { material: 20 }), row('甲', { material: 10 }), row('丙', { material: 30 })]
    rankRows(rows)
    expect(rows.map((r) => r.location)).toEqual(['甲', '乙', '丙'])
  })
})
