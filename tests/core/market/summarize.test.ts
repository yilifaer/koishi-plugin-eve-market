import { describe, expect, it } from 'vitest'
import { summarize } from '../../../src/core/market'
import { JITA, JITA_4_4, JITA_OTHER_STATION, PERIMETER, PERIMETER_STATION, order } from './helpers'

const sell = (price: number, volumeRemain = 1, at = JITA_4_4, systemId = JITA) => order({ price, volumeRemain, locationId: at, systemId })
const buy = (price: number, o: { volumeRemain?: number; minVolume?: number; at?: number; systemId?: number; range?: 'station' | 'region' | 'solarsystem' | number } = {}) =>
  order({ isBuyOrder: true, price, volumeRemain: o.volumeRemain ?? 1, minVolume: o.minVolume ?? 1, locationId: o.at ?? JITA_4_4, systemId: o.systemId ?? JITA, range: o.range ?? 'station' })

describe('summarize', () => {
  it('sell = lowest, buy = highest, with volume at the best price, order count and total volume', () => {
    const s = summarize([sell(260), sell(258, 2), sell(258, 3), sell(270, 10), buy(249, { volumeRemain: 4 }), buy(249, { volumeRemain: 1 }), buy(240, { volumeRemain: 7 })])
    expect(s.sell).toEqual({ best: 258, volumeAtBest: 5, orders: 4, totalVolume: 16, volumeNear: 16 })
    expect(s.buy).toEqual({ best: 249, volumeAtBest: 5, orders: 3, totalVolume: 12, volumeNear: 12 })
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
    expect(s.buy).toEqual({ best: 200, volumeAtBest: 1, orders: 1, totalVolume: 1, volumeNear: 1 })
  })

  it('totalVolume is per market: other stations and systems do not add to it, the region market sums everything', () => {
    const orders = [
      sell(250, 10), sell(260, 5), sell(240, 700, JITA_OTHER_STATION), sell(230, 90, PERIMETER_STATION, PERIMETER),
      buy(200, { volumeRemain: 4 }), buy(210, { volumeRemain: 800, at: JITA_OTHER_STATION }), buy(220, { volumeRemain: 60, at: PERIMETER_STATION, systemId: PERIMETER }),
    ]
    const station = summarize(orders, { locationId: JITA_4_4 })
    expect([station.sell?.totalVolume, station.buy?.totalVolume]).toEqual([15, 4])
    const system = summarize(orders, { systemId: JITA })
    expect([system.sell?.totalVolume, system.buy?.totalVolume]).toEqual([715, 804])
    const region = summarize(orders, {})
    expect([region.sell?.totalVolume, region.buy?.totalVolume]).toEqual([805, 864])
  })

  describe('volumeNear: only orders close to the best price', () => {
    it('a junk 1.04 ISK buy order of 100000 does not count next to realistic buy orders', () => {
      const s = summarize([buy(1.04, { volumeRemain: 100_000 }), buy(139_600_000, { volumeRemain: 10 }), buy(130_000_000, { volumeRemain: 15 }), buy(100_000_000, { volumeRemain: 40 })])
      expect(s.buy).toMatchObject({ best: 139_600_000, orders: 4, totalVolume: 100_065, volumeNear: 25 })
    })

    it('sell orders far above the lowest price do not count', () => {
      const s = summarize([sell(100, 3), sell(105, 4), sell(5000, 900_000)])
      expect(s.sell).toMatchObject({ best: 100, totalVolume: 900_007, volumeNear: 7 })
    })

    it('exactly 10% is still near, anything beyond is not (both sides)', () => {
      const s = summarize([sell(100, 1), sell(110, 2), sell(110.01, 4), buy(200, { volumeRemain: 1 }), buy(180, { volumeRemain: 2 }), buy(179.99, { volumeRemain: 4 })])
      expect(s.sell?.volumeNear).toBe(3)
      expect(s.buy?.volumeNear).toBe(3)
    })

    it('a lower best price found later moves the cut-off (order of input does not matter)', () => {
      const orders = [sell(120, 5), sell(110, 6), sell(100, 7)]
      expect(summarize(orders).sell?.volumeNear).toBe(13)
      expect(summarize([...orders].reverse()).sell?.volumeNear).toBe(13)
    })

    it('cheap prices with decimals keep the 10% boundary', () => {
      expect(summarize([sell(3.9, 1), sell(4.29, 2), sell(4.3, 4)]).sell?.volumeNear).toBe(3)
    })

    it('structure orders (no system id) are scoped by location and cut the same way', () => {
      const STRUCTURE = 1_000_000_000_001
      const o = (price: number, volumeRemain: number, isBuyOrder = false) => ({ ...order({ isBuyOrder, price, volumeRemain, locationId: STRUCTURE, minVolume: 1 }), systemId: undefined })
      const s = summarize([o(100, 2), o(109, 3), o(500, 1000), o(90, 5, true), o(1, 100_000, true), sell(50, 77)], { locationId: STRUCTURE })
      expect(s.sell).toMatchObject({ best: 100, volumeNear: 5 })
      expect(s.buy).toMatchObject({ best: 90, volumeNear: 5 })
    })

    it('follows the same scope and min_volume rules as the price', () => {
      const orders = [
        buy(300, { minVolume: 100, volumeRemain: 50 }), buy(280, { minVolume: 100, volumeRemain: 20 }), buy(250, { volumeRemain: 7 }),
        buy(290, { at: JITA_OTHER_STATION, volumeRemain: 999 }),
      ]
      expect(summarize(orders, { locationId: JITA_4_4 }, 1).buy).toMatchObject({ best: 250, volumeNear: 7 })
      expect(summarize(orders, { locationId: JITA_4_4 }, 100).buy).toMatchObject({ best: 300, volumeNear: 70 })
    })
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
    expect(summarize(orders, {}, 100).buy).toEqual({ best: 300, volumeAtBest: 1, orders: 3, totalVolume: 3, volumeNear: 1 })
    // 卖单不看数量
    expect(summarize([sell(10, 1)], {}, 1000).sell?.best).toBe(10)
  })

  it('a missing side is null, never 0, and mid needs both sides', () => {
    expect(summarize([])).toEqual({ sell: null, buy: null, mid: null })
    expect(summarize([sell(100)])).toEqual({ sell: { best: 100, volumeAtBest: 1, orders: 1, totalVolume: 1, volumeNear: 1 }, buy: null, mid: null })
    expect(summarize([buy(90)])).toMatchObject({ sell: null, mid: null })
    // 坏数据不当成 0 ISK
    expect(summarize([sell(0), sell(-5), sell(Number.NaN), order({ price: 50, volumeRemain: 0 })])).toEqual({ sell: null, buy: null, mid: null })
  })

  it('works on structure orders, which have no system', () => {
    const { systemId: _, ...noSystem } = sell(123, 2, 1_000_000_000_001)
    expect(summarize([noSystem]).sell?.best).toBe(123)
  })
})
