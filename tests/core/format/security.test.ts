import { describe, expect, it } from 'vitest'
import { displaySec } from '../../../src/core/format'

describe('displaySec', () => {
  it('one decimal, rounded half away from zero', () => {
    expect(displaySec(0.945913)).toBe('0.9')
    expect(displaySec(0.45)).toBe('0.5')
    expect(displaySec(0.450343)).toBe('0.5')
    expect(displaySec(0.44779)).toBe('0.4')
    expect(displaySec(1)).toBe('1.0')
    expect(displaySec(-0.99)).toBe('-1.0')
    expect(displaySec(-0.05)).toBe('-0.1')
  })

  it('low-sec systems just above 0 show 0.1 like the game, never 0.0', () => {
    expect(displaySec(0.034555)).toBe('0.1')
    expect(displaySec(0.0001)).toBe('0.1')
    expect(displaySec(0.05)).toBe('0.1')
    expect(displaySec(0)).toBe('0.0')
    // 00 里接近 0 的照常四舍五入，不带负号
    expect(displaySec(-0.018441)).toBe('0.0')
    expect(displaySec(-0.044546)).toBe('0.0')
  })

  it('unknown security shows nothing', () => {
    expect(displaySec(Number.NaN)).toBe('')
    expect(displaySec(Number.POSITIVE_INFINITY)).toBe('')
  })
})
