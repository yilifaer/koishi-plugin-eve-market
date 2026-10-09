// 入侵卡片的显示小工具：被入侵星系连成一行（太长时截断）、影响力的写法、状态名。

import { describe, expect, it } from 'vitest'
import { formatInfluence, joinSystems } from '../../../src/bot/commands/incursion'
import { INCURSION } from '../../../src/bot/commands/text'

describe('joinSystems', () => {
  const names = ['安斯拉', '尤米', '伊卡', '扎米', '萨卡', '米希', '托里']

  it('lists every name when it fits', () => {
    expect(joinSystems(names)).toBe('安斯拉、尤米、伊卡、扎米、萨卡、米希、托里')
    expect(joinSystems([])).toBe('')
  })

  it('cuts at whole names and ends with 、…', () => {
    expect(joinSystems(names, 12)).toBe('安斯拉、尤米、伊卡、…')
    expect(joinSystems(['Roua', 'N-K4Q0', 'XX-1', 'XX-2'], 16)).toBe('Roua、N-K4Q0、…')
    for (let max = 1; max < 30; max++) expect(joinSystems(names, max).length <= Math.max(max, '安斯拉、…'.length)).toBe(true)
  })

  it('always keeps the first name', () => {
    expect(joinSystems(['Very-Long-Name', 'B'], 5)).toBe('Very-Long-Name、…')
  })
})

describe('display helpers', () => {
  it('influence as a percentage with one decimal, kept between 0 and 100', () => {
    expect([0.64, 0.125, 1, 0, 0.0004, 0.99951, 1.5, -1, Number.NaN].map(formatInfluence))
      .toEqual(['64.0%', '12.5%', '100.0%', '0.0%', '0.0%', '100.0%', '100.0%', '0.0%', '0.0%'])
  })

  it('state names', () => {
    expect(INCURSION.stateNames).toEqual({ established: '立足', mobilizing: '动员', withdrawing: '撤退' })
  })
})
