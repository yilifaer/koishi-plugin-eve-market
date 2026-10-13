import { describe, expect, it } from 'vitest'
import { reprocessOut, scrapYield } from '../../../src/core/industry/reprocess'

describe('scrapYield', () => {
  it('0.5 × (1 + 0.02 × level)', () => {
    expect(scrapYield(0)).toBe(0.5)
    expect(scrapYield(5)).toBeCloseTo(0.55, 12)
  })
})

describe('reprocessOut (ferrofluid golden vector)', () => {
  const y5 = scrapYield(5)
  it('per unit at level 5 and 0', () => {
    expect(reprocessOut(73, 1, y5, 'per-unit')).toBe(40)
    expect(reprocessOut(73, 1, scrapYield(0), 'per-unit')).toBe(36)
    expect(reprocessOut(173, 1, y5, 'per-unit')).toBe(95)
  })
  it('25 units', () => {
    expect(reprocessOut(73, 25, y5, 'per-unit')).toBe(1000)
    expect(reprocessOut(173, 25, y5, 'per-unit')).toBe(2375)
  })
  it('batch rounds once for the whole batch', () => {
    expect(reprocessOut(73, 25, y5, 'batch')).toBe(1003)
  })
  it('no float error on exact products', () => {
    expect(reprocessOut(100, 1, y5, 'per-unit')).toBe(55)
    expect(reprocessOut(20, 1, y5, 'per-unit')).toBe(11)
  })
})
