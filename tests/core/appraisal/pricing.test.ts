import { describe, expect, it } from 'vitest'
import {
  collateralOf, compareWithBase, draftRows, groupOf, outcomeOf, priceRows, sideValue,
} from '../../../src/core/appraisal/pricing'
import type { QuoteBatch, RowDraft } from '../../../src/core/appraisal/pricing'
import type { Entry } from '../../../src/core/appraisal/lines'
import type { PriceQuote, QuoteStatus, TypeId } from '../../../src/core/types'
import { fakeItems, HOBGOBLIN2, item, LSE2, MTU, NANITE, RAVEN, TRITANIUM } from './helpers'

function quote(typeId: TypeId, sell: number | null, buy: number | null, status: QuoteStatus = 'ok', dataTime: number | null = 1000): PriceQuote {
  const side = (best: number | null) => (best === null ? null : { best, volumeAtBest: 1, orders: 1, totalVolume: 1, volumeNear: 1 })
  return {
    marketKey: 'm', typeId, sell: side(sell), buy: side(buy), mid: sell !== null && buy !== null ? (sell + buy) / 2 : null,
    status, dataTime, ageSec: 0, source: 'region',
  }
}

const done = (...quotes: PriceQuote[]): QuoteBatch => ({ kind: 'done', quotes: new Map(quotes.map((q) => [q.typeId, q])) })

function draft(typeId: TypeId, quantity: number, extra: Partial<RowDraft> = {}): RowDraft {
  return { item: item(typeId), quantity, approx: false, lang: 'en', sourceLines: [1], group: 'other', ...extra }
}

describe('sideValue and outcomeOf', () => {
  it('reads the side, and treats zero, negative or missing prices as no price', () => {
    expect(sideValue(quote(RAVEN, 100, 80), 'sell')).toBe(100)
    expect(sideValue(quote(RAVEN, 100, 80), 'buy')).toBe(80)
    expect(sideValue(quote(RAVEN, 100, 80), 'mid')).toBe(90)
    expect(sideValue(quote(RAVEN, 0, null), 'sell')).toBeNull()
    expect(sideValue(quote(RAVEN, -1, null), 'sell')).toBeNull()
    expect(sideValue(quote(RAVEN, 100, null), 'mid')).toBeNull()
  })

  it('tells no orders, timeouts and unavailable markets apart', () => {
    expect(outcomeOf(done(quote(RAVEN, 100, null)), RAVEN, 'sell')).toMatchObject({ kind: 'priced', unit: 100 })
    expect(outcomeOf(done(quote(RAVEN, 100, null, 'stale')), RAVEN, 'sell')).toMatchObject({ kind: 'priced', unit: 100 })
    expect(outcomeOf(done(quote(RAVEN, 100, null)), RAVEN, 'buy')).toEqual({ kind: 'missing', reason: 'no-orders', status: 'ok' })
    expect(outcomeOf(done(quote(RAVEN, null, null, 'timeout')), RAVEN, 'sell')).toMatchObject({ reason: 'timeout' })
    expect(outcomeOf(done(), RAVEN, 'sell')).toMatchObject({ reason: 'timeout' })
    expect(outcomeOf({ kind: 'late' }, RAVEN, 'sell')).toMatchObject({ reason: 'timeout' })
    for (const status of ['unavailable', 'auth_error', 'not_ready'] as const) {
      expect(outcomeOf(done(quote(RAVEN, null, null, status)), RAVEN, 'sell')).toEqual({ kind: 'missing', reason: 'market-unavailable', status })
    }
    expect(outcomeOf({ kind: 'error' }, RAVEN, 'sell')).toMatchObject({ reason: 'market-unavailable', status: 'unavailable' })
  })
})

describe('groupOf and draftRows', () => {
  it('groups by role, and cargo by item category', () => {
    expect(groupOf('hull', item(RAVEN))).toBe('hull')
    expect(groupOf('module', item(LSE2))).toBe('module')
    expect(groupOf('charge', item(NANITE))).toBe('drone-charge')
    expect(groupOf('cargo', item(HOBGOBLIN2))).toBe('drone-charge')
    expect(groupOf('cargo', item(NANITE))).toBe('drone-charge')
    expect(groupOf('cargo', item(MTU))).toBe('other')
    expect(groupOf('cargo', item(LSE2))).toBe('other')
    expect(groupOf(undefined, item(LSE2))).toBe('other')
  })

  it('merges entries by type in first-seen order; ids missing from the data become unresolved', () => {
    const entry = (lineNo: number, typeId: TypeId | null, quantity: number, approx = false): Entry => ({ lineNo, raw: `l${lineNo}`, quantity, typeId, approx, lang: 'en' })
    const { drafts, unresolved, resolved } = draftRows([
      entry(1, TRITANIUM, 10, true), entry(2, RAVEN, 1), entry(3, TRITANIUM, 5, true), entry(3, null, 1), entry(4, 999_999, 1),
    ], fakeItems())
    expect(drafts.map((d) => [d.item.typeId, d.quantity, d.sourceLines, d.approx])).toEqual([[TRITANIUM, 15, [1, 3], true], [RAVEN, 1, [2], false]])
    expect(unresolved.map((e) => e.lineNo)).toEqual([3, 4])
    expect(resolved).toHaveLength(3)
  })
})

describe('priceRows', () => {
  it('applies the modifier, sums totals and volume, and keeps the oldest data time', () => {
    const p = priceRows({
      drafts: [draft(RAVEN, 2), draft(TRITANIUM, 1000)],
      side: 'sell',
      modifierPct: 10,
      main: done(quote(RAVEN, 100, null, 'ok', 2000), quote(TRITANIUM, 5, null, 'stale', 500)),
    })
    expect(p.rows.map((r) => [r.unit, r.adjustedUnit, r.total, r.status])).toEqual([[100, 110.00000000000001, 220.00000000000003, 'ok'], [5, 5.5, 5500, 'stale']])
    expect(p.totals).toMatchObject({ market: 5200, pricedTypes: 2, units: 1002, missing: 0 })
    expect(p.totals.adjusted).toBeCloseTo(5720)
    expect(p.totals.packagedM3).toBeCloseTo(100_010)
    expect(p.dataTime).toBe(500)
  })

  it('uses the fallback quote only for rows without orders', () => {
    const p = priceRows({
      drafts: [draft(RAVEN, 1), draft(TRITANIUM, 1), draft(NANITE, 1)],
      side: 'buy',
      modifierPct: 0,
      main: done(quote(RAVEN, 100, null), quote(TRITANIUM, null, null, 'timeout')),
      fallback: { marketKey: 'jita', batch: done(quote(RAVEN, 1, 90), quote(TRITANIUM, 1, 4), quote(NANITE, 1, 2)) },
    })
    expect(p.rows.map((r) => [r.item.typeId, r.unit, r.fallback ?? null])).toEqual([
      [RAVEN, 90, { marketKey: 'jita', side: 'buy' }],
      [TRITANIUM, null, null],
      [NANITE, null, null],
    ])
    expect(p.noPrice.map((n) => n.reason)).toEqual(['timeout', 'timeout'])
  })

  it('a fallback without a price keeps the no-orders reason', () => {
    const p = priceRows({
      drafts: [draft(RAVEN, 1)], side: 'sell', modifierPct: 0, main: done(quote(RAVEN, null, null)), fallback: { marketKey: 'jita', batch: { kind: 'late' } },
    })
    expect(p.noPrice).toEqual([{ item: item(RAVEN), reason: 'no-orders' }])
    expect(p.dataTime).toBeNull()
  })
})

describe('compareWithBase and collateralOf', () => {
  const rows = priceRows({
    drafts: [draft(RAVEN, 2), draft(TRITANIUM, 10), draft(NANITE, 1)],
    side: 'sell',
    modifierPct: -50,
    main: done(quote(RAVEN, 100, null), quote(TRITANIUM, 5, null), quote(NANITE, null, null)),
  }).rows

  it('compares unadjusted totals over items priced on both sides', () => {
    expect(compareWithBase(rows, done(quote(RAVEN, 80, null), quote(TRITANIUM, null, null)), 'sell', 'jita')).toEqual({
      marketKey: 'jita', side: 'sell', total: 160, diffPct: 25,
    })
  })

  it('gives up when any base quote is missing for a priced item', () => {
    expect(compareWithBase(rows, done(quote(RAVEN, 80, null)), 'sell', 'jita')).toBeUndefined()
    expect(compareWithBase(rows, done(quote(RAVEN, 80, null), quote(TRITANIUM, null, null, 'unavailable')), 'sell', 'jita')).toBeUndefined()
    expect(compareWithBase(rows, { kind: 'late' }, 'sell', 'jita')).toBeUndefined()
    expect(compareWithBase(rows, done(quote(RAVEN, null, null), quote(TRITANIUM, null, null)), 'sell', 'jita')).toBeUndefined()
  })

  it('collateral uses the sell price of every item that has one', () => {
    const drafts = [draft(RAVEN, 2), draft(TRITANIUM, 10), draft(NANITE, 1)]
    expect(collateralOf(drafts, done(quote(RAVEN, 100, 1), quote(TRITANIUM, null, 4), quote(NANITE, 3, null, 'timeout')))).toEqual({ collateral: 200, missing: 2 })
  })
})
