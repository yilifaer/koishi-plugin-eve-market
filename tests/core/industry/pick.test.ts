import { describe, expect, it } from 'vitest'
import { rankingCost, rankStructures } from '../../../src/core/industry/pick'
import type { Ranked } from '../../../src/core/industry/pick'
import type { IndustryResult } from '../../../src/core/types'

const r = (name: string, cost: number, time: number, isDefault: boolean, row: number): Ranked<string> => ({ item: name, cost, time, isDefault, row })
const names = (list: Ranked<string>[]) => list.map((x) => x.item)

describe('rankStructures', () => {
  it('cost ascending first', () => {
    expect(names(rankStructures([r('a', 300, 1, true, 0), r('b', 100, 9, false, 1), r('c', 200, 5, false, 2)]))).toEqual(['b', 'c', 'a'])
  })
  it('costs within 1 ISK tie, then time', () => {
    expect(names(rankStructures([r('a', 100.9, 50, true, 0), r('b', 100, 60, false, 1), r('c', 100.2, 40, false, 2)]))).toEqual(['c', 'a', 'b'])
  })
  it('a difference of 1 ISK or more is not a tie', () => {
    expect(names(rankStructures([r('a', 101, 1, false, 0), r('b', 100, 9, false, 1)]))).toEqual(['b', 'a'])
  })
  it('then default first, then row', () => {
    expect(names(rankStructures([r('a', 100, 5, false, 2), r('b', 100, 5, true, 3), r('c', 100, 5, false, 1)]))).toEqual(['b', 'c', 'a'])
  })
  it('does not change the input', () => {
    const list = [r('a', 2, 1, false, 0), r('b', 1, 1, false, 1)]
    rankStructures(list)
    expect(names(list)).toEqual(['a', 'b'])
  })
})

describe('rankingCost', () => {
  const item = (typeId: number) => ({ typeId }) as never
  const result = {
    materials: [
      { item: item(1), quantity: 10, unit: 5 },
      { item: item(2), quantity: 4, unit: null },
      { item: item(3), quantity: 7, unit: null },
    ],
    jobCost: { total: 1000 },
  } as unknown as IndustryResult
  const adjusted = { byType: new Map([[2, 100]]), dataTime: 0, stale: false }

  it('market price, then adjusted price, then 0, plus job cost', () => {
    expect(rankingCost(result, adjusted)).toBe(10 * 5 + 4 * 100 + 0 + 1000)
  })
  it('works without adjusted prices or job cost', () => {
    expect(rankingCost({ ...result, jobCost: undefined } as IndustryResult, null)).toBe(50)
  })
})
