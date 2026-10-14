import { describe, expect, it } from 'vitest'
import { inDowntime } from '../../../src/core/market'

const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 14, h, m, s)

describe('inDowntime', () => {
  it('covers 11:00 up to (not including) 11:30 UTC, every day', () => {
    expect(inDowntime(at(10, 59, 59))).toBe(false)
    expect(inDowntime(at(11, 0))).toBe(true)
    expect(inDowntime(at(11, 15))).toBe(true)
    expect(inDowntime(at(11, 29, 59))).toBe(true)
    expect(inDowntime(at(11, 30))).toBe(false)
    expect(inDowntime(Date.UTC(2026, 0, 1, 11, 10))).toBe(true)
  })
})
