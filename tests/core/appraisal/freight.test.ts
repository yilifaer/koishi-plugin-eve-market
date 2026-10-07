import { describe, expect, it } from 'vitest'
import { contractsFor, freightFor, packagedM3, visibleRoutes } from '../../../src/core/appraisal/freight'
import { ALLOWED, item, PUBLIC, RAVEN, route, TRITANIUM } from './helpers'

describe('freight', () => {
  it('matches the documented example', () => {
    const line = freightFor(route('联盟市场A', { iskPerM3: 800, collateralPct: 1 }), { volume: 50_328, collateral: 379_312_120, adjusted: 379_312_120 })
    expect(line.fee).toBeCloseTo(44_055_521.2)
    expect(line.landed).toBeCloseTo(379_312_120 + 44_055_521.2)
    expect(line).toMatchObject({ route: '联盟市场A', contracts: 1 })
  })

  it('splits into contracts by the maximum volume; 0 means no limit', () => {
    expect(contractsFor(350_000, 350_000)).toBe(1)
    expect(contractsFor(350_001, 350_000)).toBe(2)
    expect(contractsFor(0, 350_000)).toBe(1)
    expect(contractsFor(10_000_000, 0)).toBe(1)
  })

  it('lists at most two routes this group may see, in table order', () => {
    const routes = [route('A'), route('B', { visibility: 'public' }), route('C', { visibility: 'public' }), route('D', { visibility: 'public' })]
    expect(visibleRoutes(routes, ALLOWED).map((r) => r.name)).toEqual(['A', 'B'])
    expect(visibleRoutes(routes, PUBLIC).map((r) => r.name)).toEqual(['B', 'C'])
  })

  it('uses the packaged volume', () => {
    expect(packagedM3(item(RAVEN), 2)).toBe(100_000)
    expect(packagedM3(item(TRITANIUM), 1000)).toBeCloseTo(10)
  })
})
