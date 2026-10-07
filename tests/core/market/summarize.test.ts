import { describe, expect, it } from 'vitest'
import { summarize } from '../../../src/core/market'
import { JITA, JITA_4_4, JITA_OTHER_STATION, PERIMETER, PERIMETER_STATION, order } from './helpers'

const sell = (price: number, volumeRemain = 1, at = JITA_4_4, systemId = JITA) => order({ price, volumeRemain, locationId: at, systemId })
const buy = (price: number, o: { volumeRemain?: number; minVolume?: number; at?: number; systemId?: number; range?: 'station' | 'region' | 'solarsystem' | number } = {}) =>
  order({ isBuyOrder: true, price, volumeRemain: o.volumeRemain ?? 1, minVolume: o.minVolume ?? 1, locationId: o.at ?? JITA_4_4, systemId: o.systemId ?? JITA, range: o.range ?? 'station' })

describe('summarize', () => {
  it('sell = lowest, buy = highest, with volume at the best price, order count and total volume', () => {
    const s = summarize([sell(260), sell(258, 2), sell(258, 3), sell(270, 10), buy(249, { volumeRemain: 4 }), buy(249, { volumeRemain: 1 }), buy(240, { volumeRemain: 7 })])
    expect(s.sell).toEqual({ best: 258, volumeAtBest: 5, orders: 4, totalVolume: 16 })
    expect(s.buy).toEqual({ best: 249, volumeAtBest: 5, orders: 3, totalVolume: 12 })
    expect(s.mid).toBe(253.5)
  })

  it('an NPC station counts only orders located in that station, buy orders included whatever their range', () => {
    const orders = [
      sell(250), sell(240, 1, JITA_OTHER_STATION), sell(230, 1, PERIMETER_STATION, PERIMETER),
      buy(200), buy(210, { at: JITA_OTHER_STATION, range: 'region' }), buy(220, { at: PERIMETER_STATION, systemId: PERIMETER, range: 'region' }),
      buy(215, { at: JITA_OTHER_STATION, range: 'solarsystem' }), buy(212, { at: PERIMETER_STATION, systemId: PERIMETER, range: 5 }),
    ]
    const s = summarize(orders, { locationId: JITA_4_4 })
    expect(s.sell?.best).toBe(250)
    expect(s.buy).toEqual({ best: 200, volumeAtBest: 1, orders: 1, totalVolume: 1 })
  })

  it('a system market filters by system; a region market takes everything', () => {
    const orders = [sell(250), sell(240, 1, JITA_OTHER_STATION), sell(230, 1, PERIMETER_STATION, PERIMETER), buy(200), buy(220, { at: PERIMETER_STATION, systemId: PERIMETER })]
    expect(summarize(orders, { systemId: JITA })).toMatchObject({ sell: { best: 240, orders: 2 }, buy: { best: 200, orders: 1 } })
    expect(summarize(orders, {})).toMatchObject({ sell: { best: 230, orders: 3 }, buy: { best: 220, orders: 2 } })
  })

  it('buy orders count only when min_volume ≤ the quantity', () => {
    const orders = [buy(300, { minVolume: 100 }), buy(250, { minVolume: 10 }), buy(200)]
    expect(summarize(orders, {}, 1).buy?.best).toBe(200)
    expect(summarize(orders, {}, 10).buy?.best).toBe(250)
    expect(summarize(orders, {}, 100).buy).toEqual({ best: 300, volumeAtBest: 1, orders: 3, totalVolume: 3 })
    // 卖单不看数量
    expect(summarize([sell(10, 1)], {}, 1000).sell?.best).toBe(10)
  })

  it('a missing side is null, never 0, and mid needs both sides', () => {
    expect(summarize([])).toEqual({ sell: null, buy: null, mid: null })
    expect(summarize([sell(100)])).toEqual({ sell: { best: 100, volumeAtBest: 1, orders: 1, totalVolume: 1 }, buy: null, mid: null })
    expect(summarize([buy(90)])).toMatchObject({ sell: null, mid: null })
    // 坏数据不当成 0 ISK
    expect(summarize([sell(0), sell(-5), sell(Number.NaN), order({ price: 50, volumeRemain: 0 })])).toEqual({ sell: null, buy: null, mid: null })
  })

  it('works on structure orders, which have no system', () => {
    const { systemId: _, ...noSystem } = sell(123, 2, 1_000_000_000_001)
    expect(summarize([noSystem]).sell?.best).toBe(123)
  })
})
