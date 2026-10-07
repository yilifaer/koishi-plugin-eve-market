import { describe, expect, it } from 'vitest'
import { APPRAISAL_ID_ALPHABET } from '../../../src/constants'
import { DataNotReadyError } from '../../../src/core/data'
import { isFailure } from '../../../src/core/types'
import type { Access, AppraiseOptions, PriceQuote, TypeId } from '../../../src/core/types'
import {
  ALLIANCE, ALLOWED, AMARR, CML2, DC2, failure, HOBGOBLIN2, item, JITA, LSE2, MTU, NANITE, ok, PUBLIC, PYERITE, RAVEN,
  RAVEN_NAVY, route, SCOURGE_CRUISE, setup, summary, TRITANIUM,
} from './helpers'
import type { SetupOptions } from './helpers'

type Setup = ReturnType<typeof setup>

async function appraise(s: Setup, text: string, access: Access = ALLOWED, opts: Partial<AppraiseOptions> = {}) {
  const parsed = s.service.parse(text, access)
  if (isFailure(parsed)) return parsed
  return s.service.appraise(parsed, { access, ...opts })
}

function withPrices(opts: SetupOptions = {}) {
  const s = setup(opts)
  s.prices
    .set(ALLIANCE.key, RAVEN, { sell: 270e6, buy: 250e6 })
    .set(ALLIANCE.key, TRITANIUM, { sell: 5.4, buy: 5 })
    .set(ALLIANCE.key, PYERITE, { sell: 13.2, buy: 12 })
    .set(JITA.key, RAVEN, { sell: 258.4e6, buy: 240e6 })
    .set(JITA.key, TRITANIUM, { sell: 5, buy: 4.5 })
    .set(JITA.key, PYERITE, { sell: 12.8, buy: 11 })
  return s
}

const EXAMPLE = '联盟市场A sell -5%\nRaven*2\nTritanium*1000000\nPyerite*500000'

describe('appraise: the basic batch', () => {
  it('prices the documented example: sell -5%, paste order, totals and packaged volume', async () => {
    const s = withPrices()
    const r = ok(await appraise(s, EXAMPLE))
    expect(r.market).toBe(ALLIANCE)
    expect(r.side).toBe('sell')
    expect(r.modifierPct).toBe(-5)
    expect(r.rows.map((row) => [row.item.en, row.quantity, row.sourceLines, row.lang, row.approx, row.group])).toEqual([
      ['Raven', 2, [1], 'en', false, 'other'],
      ['Tritanium', 1_000_000, [2], 'en', false, 'other'],
      ['Pyerite', 500_000, [3], 'en', false, 'other'],
    ])
    expect(r.rows[0].unit).toBe(270e6)
    expect(r.rows[0].adjustedUnit).toBeCloseTo(256.5e6)
    expect(r.rows[0].total).toBeCloseTo(513e6)
    expect(r.rows[1].adjustedUnit).toBeCloseTo(5.13)
    expect(r.rows[2].adjustedUnit).toBeCloseTo(12.54)
    expect(r.totals.market).toBeCloseTo(552e6, 0)
    expect(r.totals.adjusted).toBeCloseTo(524.4e6, 0)
    expect(r.totals).toMatchObject({ pricedTypes: 3, units: 1_500_002, missing: 0 })
    expect(r.totals.packagedM3).toBeCloseTo(115_000)
    expect(r.rows[0].packagedM3).toBe(100_000)
    expect(r.noPrice).toEqual([])
    expect(r.unresolved).toEqual([])
    expect(r.id).toMatch(new RegExp(`^[${APPRAISAL_ID_ALPHABET}]{4}$`))
    expect(r.id).toMatch(/[A-Z]/)
  })

  it('compares with the base market on the same items and quantities (before the modifier)', async () => {
    const r = ok(await appraise(withPrices(), EXAMPLE))
    expect(r.vsBase?.marketKey).toBe(JITA.key)
    expect(r.vsBase?.side).toBe('sell')
    expect(r.vsBase?.total).toBeCloseTo(528.2e6, 0)
    expect(r.vsBase?.diffPct).toBeCloseTo((552 - 528.2) / 528.2 * 100, 6)
  })

  it('names follow the language of the line', async () => {
    const r = ok(await appraise(withPrices(), '联盟市场A\n乌鸦级*2\nTritanium*10'))
    expect(r.rows.map((row) => [row.item.en, row.lang])).toEqual([['Raven', 'zh'], ['Tritanium', 'en']])
  })

  it('uses the default market and price type when the header has none', async () => {
    const s = withPrices({ defaultSide: 'buy' })
    const r = ok(await appraise(s, 'Raven*2'))
    expect(r.market).toBe(JITA)
    expect(r.side).toBe('buy')
    expect(r.modifierPct).toBe(0)
    expect(r.rows[0].unit).toBe(240e6)
    expect(r.vsBase).toBeUndefined()
  })

  it('matches multi-word market names and aliases from the registry', async () => {
    const s = withPrices()
    expect(ok(await appraise(s, 'Jita 4-4 buy\nRaven')).market).toBe(JITA)
    expect(ok(await appraise(s, '吉他\nRaven')).market).toBe(JITA)
    expect(ok(await appraise(s, '前线 mid\nRaven')).market).toBe(ALLIANCE)
  })

  it('options override the header', async () => {
    const r = ok(await appraise(withPrices(), EXAMPLE, ALLOWED, { side: 'buy', modifierPct: 10, market: 'Jita' }))
    expect([r.market.key, r.side, r.modifierPct]).toEqual([JITA.key, 'buy', 10])
    expect(r.rows[0].adjustedUnit).toBeCloseTo(264e6)
  })

  it('a first line with a market and an item keeps the market', async () => {
    const r = ok(await appraise(withPrices(), 'Jita Raven*2\nTritanium*100'))
    expect(r.market).toBe(JITA)
    expect(summary(r).map(([en, qty]) => [en, qty])).toEqual([['Raven', 2], ['Tritanium', 100]])
  })
})

describe('appraise: sell, mid, buy', () => {
  it('takes the best order of the side, or the same-market mid', async () => {
    const s = setup()
    s.prices.set(JITA.key, RAVEN, { sell: 100, buy: 80 }).set(JITA.key, TRITANIUM, { sell: 5 })
    const units = async (side: string) => ok(await appraise(s, `Jita ${side}\nRaven\nTritanium`)).rows.map((r) => r.unit)
    expect(await units('sell')).toEqual([100, 5])
    expect(await units('buy')).toEqual([80, null])
    expect(await units('mid')).toEqual([90, null])
  })

  it('a missing side is never priced as 0', async () => {
    const s = setup()
    s.prices.set(JITA.key, TRITANIUM, { sell: 5 })
    const r = ok(await appraise(s, 'buy\nTritanium*10'))
    expect(r.rows[0]).toMatchObject({ unit: null, adjustedUnit: null, total: null, status: 'ok' })
    expect(r.noPrice).toEqual([{ item: item(TRITANIUM), reason: 'no-orders' }])
    expect(r.totals).toMatchObject({ market: 0, adjusted: 0, pricedTypes: 0, units: 0, missing: 1 })
  })

  it('rejects an out-of-range modifier passed as an option', async () => {
    const r = failure(await appraise(withPrices(), 'Raven', ALLOWED, { modifierPct: -95 }))
    expect(r).toMatchObject({ code: 'BAD_ARGUMENT', reason: 'modifier-range' })
  })
})

describe('appraise: lines and items', () => {
  it('merges the same item from several lines, keeping the first position', async () => {
    const r = ok(await appraise(withPrices(), 'Raven*2\nTritanium*100\n乌鸦级 3'))
    expect(r.rows.map((row) => [row.item.en, row.quantity, row.sourceLines, row.lang])).toEqual([
      ['Raven', 5, [1, 3], 'en'],
      ['Tritanium', 100, [2], 'en'],
    ])
    expect(r.rows[0].total).toBeCloseTo(5 * 258.4e6)
  })

  it('counts a unique-prefix line and marks it approximate unless another line names it in full', async () => {
    const s = setup()
    s.prices.set(JITA.key, RAVEN_NAVY, { sell: 500e6 })
    const approx = ok(await appraise(s, 'Raven Navy*2'))
    expect(approx.rows.map((r) => [r.item.en, r.approx, r.total])).toEqual([['Raven Navy Issue', true, 1e9]])
    const confirmed = ok(await appraise(s, 'Raven Navy\nRaven Navy Issue'))
    expect(confirmed.rows.map((r) => [r.item.en, r.quantity, r.approx])).toEqual([['Raven Navy Issue', 2, false]])
  })

  it('lists unrecognised lines with a suggestion and does not count them', async () => {
    const r = ok(await appraise(withPrices(), 'Raven*2\nRaven Navvy*3\nqwerty'))
    expect(summary(r)).toEqual([['Raven', 2, 2 * 258.4e6]])
    expect(r.unresolved.map((u) => [u.lineNo, u.raw, u.suggestion?.en, u.total])).toEqual([
      [2, 'Raven Navvy*3', 'Raven', 2],
      [3, 'qwerty', undefined, 0],
    ])
    expect(r.unresolved[0].candidates?.map((c) => c.en)).toEqual(['Raven', 'Raven Navy Issue'])
  })

  it('passes skipped lines and the truncated count through', async () => {
    const s = withPrices()
    const r = ok(await appraise(s, 'Raven Blueprint (Copy)\nRaven*0.5\nRaven'))
    expect(r.skipped.map((k) => [k.lineNo, k.reason])).toEqual([[1, 'bpc'], [2, 'quantity']])
    const long = ok(await appraise(s, Array.from({ length: 205 }, () => 'Tritanium*1').join('\n')))
    expect(long.truncated).toBe(5)
    expect(long.rows[0].quantity).toBe(200)
  })

  it('an empty list still gets an id', async () => {
    const r = ok(await appraise(withPrices(), 'Jita sell'))
    expect(r.rows).toEqual([])
    expect(r.id).toHaveLength(4)
    expect(r.freight).toEqual([])
  })

  it('returns DATA_NOT_READY while the item data is loading', async () => {
    const s = setup()
    s.items.broken = new DataNotReadyError()
    expect(failure(await appraise(s, 'Raven')).code).toBe('DATA_NOT_READY')
  })
})

describe('appraise: markets', () => {
  it('a hidden market in a public group is an unknown market; the list is saved for the buttons', async () => {
    const s = withPrices()
    const r = failure(await appraise(s, '联盟市场A sell -5%\nRaven*2', PUBLIC))
    expect(r).toMatchObject({ code: 'UNKNOWN_MARKET', token: '联盟市场A', markets: [JITA.key, AMARR.key, 'dodixie'] })
    expect(r.appraisalId).toMatch(/^[A-Z2-9]{4}$/)
    expect(s.prices.calls).toEqual([])
    // 「批量查价 #K7Q2 Jita」：原清单、原来的价格类型和调整
    const again = ok(await s.service.reprice(r.appraisalId!, { market: 'Jita', access: PUBLIC }))
    expect([again.id, again.market.key, again.side, again.modifierPct]).toEqual([r.appraisalId, JITA.key, 'sell', -5])
    expect(summary(again)[0][2]).toBeCloseTo(2 * 258.4e6 * 0.95)
  })

  it('a typo in the header market is an unknown market too', async () => {
    const r = failure(await appraise(withPrices(), 'Jtia sell\nRaven'))
    expect(r).toMatchObject({ code: 'UNKNOWN_MARKET', token: 'Jtia' })
    expect(r.markets).toContain(ALLIANCE.key)
  })

  it('two different markets in the header are a bad argument', async () => {
    const s = withPrices()
    expect(s.service.parse('Jita Amarr\nRaven', ALLOWED)).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'two-markets' })
  })

  it('a whole market that is unavailable stops before pricing and never switches market', async () => {
    const s = withPrices()
    s.prices.availability.set(ALLIANCE.key, { status: 'auth_error', reason: 'auth' })
    const r = failure(await appraise(s, EXAMPLE))
    expect(r).toMatchObject({ code: 'MARKET_UNAVAILABLE', marketKey: ALLIANCE.key, quoteReason: 'auth' })
    expect(r.markets).toEqual([JITA.key, AMARR.key, 'dodixie'])
    expect(s.prices.calls).toEqual([])
    expect(s.prices.touches).toEqual([{ marketKey: ALLIANCE.key, waitMs: 6000 }])
    const jita = ok(await s.service.reprice(r.appraisalId!, { market: 'Jita', access: ALLOWED }))
    expect([jita.market.key, jita.side, jita.modifierPct, jita.rows.length]).toEqual([JITA.key, 'sell', -5, 3])
  })

  it('not-ready and long sync errors are unavailable; recent sync errors (stale) still price', async () => {
    const s = withPrices()
    s.prices.availability.set(ALLIANCE.key, { status: 'not_ready', reason: 'first_sync' })
    expect(failure(await appraise(s, EXAMPLE))).toMatchObject({ code: 'MARKET_UNAVAILABLE', quoteReason: 'first_sync' })
    s.prices.availability.set(ALLIANCE.key, { status: 'unavailable', reason: 'sync_error' })
    expect(failure(await appraise(s, EXAMPLE))).toMatchObject({ code: 'MARKET_UNAVAILABLE', quoteReason: 'sync_error' })
    s.prices.availability.set(ALLIANCE.key, { status: 'stale', reason: 'sync_error' })
    expect(ok(await appraise(s, EXAMPLE)).totals.pricedTypes).toBe(3)
  })

  it('returns NOT_CONFIGURED when there is no market at all', async () => {
    const s = setup({ registry: { base: null } })
    expect(failure(await appraise(s, 'Raven')).code).toBe('NOT_CONFIGURED')
  })
})

describe('appraise: fallback market', () => {
  function fallbackSetup(fallback = true) {
    const s = setup(fallback ? { registry: { fallback: JITA } } : {})
    s.prices
      .set(AMARR.key, RAVEN, { sell: 100, buy: 90 })
      .set(AMARR.key, TRITANIUM, {})
      .set(AMARR.key, PYERITE, { status: 'timeout' })
      .set(AMARR.key, NANITE, { status: 'unavailable', reason: 'esi_error' })
      .set(JITA.key, RAVEN, { sell: 110 })
      .set(JITA.key, TRITANIUM, { sell: 5, buy: 4 })
      .set(JITA.key, PYERITE, { sell: 13 })
      .set(JITA.key, NANITE, { sell: 1 })
    return s
  }
  const LIST = 'Amarr -10%\nRaven*2\nTritanium*100\nPyerite*10\nNanite Repair Paste*5'

  it('only rows with no orders use the fallback, and they are marked', async () => {
    const s = fallbackSetup()
    const r = ok(await appraise(s, LIST))
    expect(r.rows.map((row) => [row.item.en, row.unit, row.fallback?.marketKey ?? null, row.status])).toEqual([
      ['Raven', 100, null, 'ok'],
      ['Tritanium', 5, JITA.key, 'ok'],
      ['Pyerite', null, null, 'timeout'],
      ['Nanite Repair Paste', null, null, 'unavailable'],
    ])
    expect(r.rows[1].fallback).toEqual({ marketKey: JITA.key, side: 'sell' })
    expect(r.rows[1].total).toBeCloseTo(100 * 5 * 0.9)
    expect(r.noPrice.map((n) => [n.item.en, n.reason])).toEqual([['Pyerite', 'timeout'], ['Nanite Repair Paste', 'market-unavailable']])
    expect(r.totals.market).toBeCloseTo(2 * 100 + 100 * 5)
    const fallbackCalls = s.prices.calls.filter((c) => c.marketKey === JITA.key && c.deadlineMs !== 1000)
    expect(fallbackCalls.map((c) => c.items.map((i) => i.typeId))).toEqual([[TRITANIUM]])
  })

  it('the comparison with the base market leaves out fallback rows', async () => {
    const r = ok(await appraise(fallbackSetup(), LIST))
    expect(r.vsBase).toMatchObject({ marketKey: JITA.key, total: 220 })
    expect(r.vsBase?.diffPct).toBeCloseTo((200 - 220) / 220 * 100)
  })

  it('without a fallback market the rows with no orders are listed and not counted', async () => {
    const r = ok(await appraise(fallbackSetup(false), LIST))
    expect(r.rows.every((row) => !row.fallback)).toBe(true)
    expect(r.noPrice.map((n) => [n.item.en, n.reason])).toEqual([
      ['Tritanium', 'no-orders'], ['Pyerite', 'timeout'], ['Nanite Repair Paste', 'market-unavailable'],
    ])
  })

  it('the fallback replaces the whole quote, so mid never mixes two markets', async () => {
    const s = fallbackSetup()
    s.prices.set(AMARR.key, TRITANIUM, { sell: 6 })
    const r = ok(await appraise(s, 'Amarr mid\nTritanium*10'))
    expect(r.rows[0]).toMatchObject({ unit: 4.5, fallback: { marketKey: JITA.key, side: 'mid' } })
  })

  it('a hidden fallback market silently becomes the base market', async () => {
    const s = setup({ registry: { fallback: ALLIANCE } })
    s.prices.set(AMARR.key, TRITANIUM, {}).set(JITA.key, TRITANIUM, { sell: 5 }).set(ALLIANCE.key, TRITANIUM, { sell: 4 })
    expect(ok(await appraise(s, 'Amarr\nTritanium', PUBLIC)).rows[0].fallback?.marketKey).toBe(JITA.key)
    expect(ok(await appraise(s, 'Amarr\nTritanium', ALLOWED)).rows[0].fallback?.marketKey).toBe(ALLIANCE.key)
  })

  it('the fallback is not asked when it is the appraisal market itself', async () => {
    const s = setup({ registry: { fallback: JITA } })
    const r = ok(await appraise(s, 'Tritanium'))
    expect(r.noPrice).toEqual([{ item: item(TRITANIUM), reason: 'no-orders' }])
    expect(s.prices.calls).toHaveLength(1)
  })
})

describe('appraise: time limits', () => {
  it('rows that miss the 12 s deadline are left out of the totals', async () => {
    const s = setup()
    s.prices.set(JITA.key, RAVEN, { sell: 100 }).set(JITA.key, TRITANIUM, { sell: 5, delay: 15_000 })
    let done = false
    const pending = appraise(s, 'Raven\nTritanium*10').then((r) => {
      done = true
      return r
    })
    await s.time.advance(11_999)
    expect(done).toBe(false)
    await s.time.advance(1)
    expect(done).toBe(true)
    const r = ok(await pending)
    expect(s.prices.calls[0].deadlineMs).toBe(12_000)
    expect(r.rows.map((row) => [row.item.en, row.total, row.status])).toEqual([['Raven', 100, 'ok'], ['Tritanium', null, 'timeout']])
    expect(r.noPrice).toEqual([{ item: item(TRITANIUM), reason: 'timeout' }])
    expect(r.totals).toMatchObject({ market: 100, pricedTypes: 1, missing: 1 })
  })

  it('a price service that never answers cannot hold the reply past the deadline', async () => {
    const s = setup()
    s.prices.getQuotes = () => new Promise<Map<TypeId, PriceQuote>>(() => {})
    const pending = appraise(s, 'Raven\nTritanium')
    await s.time.advance(12_250)
    const r = ok(await pending)
    expect(r.noPrice.map((n) => n.reason)).toEqual(['timeout', 'timeout'])
    expect(s.time.pending).toBe(0)
  })

  it('a failing price service marks the rows unavailable and logs it', async () => {
    const s = setup()
    s.prices.failing.add(JITA.key)
    const r = ok(await appraise(s, 'Raven'))
    expect(r.noPrice).toEqual([{ item: item(RAVEN), reason: 'market-unavailable' }])
    expect(s.warnings.join('\n')).toContain('Jita 4-4')
  })

  it('the base comparison waits only 1 s and never delays the answer further', async () => {
    const s = setup()
    s.prices.set(AMARR.key, RAVEN, { sell: 100 }).set(JITA.key, RAVEN, { sell: 110, delay: 2000 })
    let done = false
    const pending = appraise(s, 'Amarr\nRaven').then((r) => {
      done = true
      return r
    })
    await s.time.advance(1000)
    expect(done).toBe(true)
    const r = ok(await pending)
    expect(r.totals.market).toBe(100)
    expect(r.vsBase).toBeUndefined()
    expect(s.prices.calls.find((c) => c.marketKey === JITA.key)?.deadlineMs).toBe(1000)
  })

  it('the main quotes are queued first; the base quotes go on the background lane at the same time', async () => {
    const s = setup()
    s.prices.set(AMARR.key, RAVEN, { sell: 100, delay: 800 }).set(JITA.key, RAVEN, { sell: 80, delay: 900 })
    let done = false
    const pending = appraise(s, 'Amarr\nRaven').then((r) => {
      done = true
      return r
    })
    await s.time.advance(900)
    expect(done).toBe(true)
    const r = ok(await pending)
    expect(r.vsBase).toMatchObject({ total: 80, diffPct: 25 })
    expect(s.prices.calls.map((c) => c.at)).toEqual([s.prices.calls[0].at, s.prices.calls[0].at])
    expect(s.prices.calls.map((c) => [c.marketKey, c.lane])).toEqual([[AMARR.key, 'interactive'], [JITA.key, 'background']])
  })

  it('an incomplete base comparison is left out; items the base market does not sell are skipped', async () => {
    const s = setup()
    s.prices
      .set(AMARR.key, RAVEN, { sell: 100 }).set(AMARR.key, TRITANIUM, { sell: 5 })
      .set(JITA.key, RAVEN, { sell: 110 })
    const skipped = ok(await appraise(s, 'Amarr\nRaven\nTritanium*10'))
    expect(skipped.vsBase).toMatchObject({ total: 110 })
    s.prices.set(JITA.key, TRITANIUM, { status: 'timeout' })
    expect(ok(await appraise(s, 'Amarr\nRaven\nTritanium*10')).vsBase).toBeUndefined()
  })

  it('stale quotes are counted and the oldest data time is reported', async () => {
    const s = setup()
    const now = s.time.now()
    s.prices.set(JITA.key, RAVEN, { sell: 100, status: 'stale', reason: 'cache', dataTime: now - 20 * 60_000 })
    s.prices.set(JITA.key, TRITANIUM, { sell: 5, dataTime: now - 60_000 })
    const r = ok(await appraise(s, 'Raven\nTritanium'))
    expect(r.rows.map((row) => row.status)).toEqual(['stale', 'ok'])
    expect(r.totals.pricedTypes).toBe(2)
    expect(r.dataTime).toBe(now - 20 * 60_000)
  })
})

describe('appraise: freight', () => {
  const ROUTES = [
    route('联盟市场A', { iskPerM3: 800, collateralPct: 1, maxVolume: 350_000 }),
    route('公开路线', { iskPerM3: 500, visibility: 'public', maxVolume: 60_000 }),
    route('第三条', { iskPerM3: 1 }),
  ]

  function freightSetup() {
    const s = setup({ routes: ROUTES })
    s.prices
      .set(JITA.key, RAVEN, { sell: 270e6, buy: 250e6 })
      .set(JITA.key, TRITANIUM, { sell: 5, buy: 4 })
      .set(JITA.key, PYERITE, { buy: 11 })
      .set(AMARR.key, RAVEN, { sell: 1 })
    return s
  }

  it('applies the formula with collateral on the base sell price, whatever the price type', async () => {
    const r = ok(await appraise(freightSetup(), 'buy -5%\nRaven*2\nTritanium*1000\nPyerite*100'))
    const volume = 100_000 + 10 + 1
    const collateral = 2 * 270e6 + 1000 * 5
    const adjusted = (2 * 250e6 + 1000 * 4 + 100 * 11) * 0.95
    expect(r.totals.packagedM3).toBeCloseTo(volume)
    expect(r.totals.adjusted).toBeCloseTo(adjusted)
    expect(r.freight).toHaveLength(2)
    expect(r.freight[0].route).toBe('联盟市场A')
    expect(r.freight[0].fee).toBeCloseTo(volume * 800 + collateral * 0.01)
    expect(r.freight[0].contracts).toBe(1)
    expect(r.freight[0].landed).toBeCloseTo(adjusted + r.freight[0].fee)
    expect(r.freight[1]).toMatchObject({ route: '公开路线', contracts: 2 })
    expect(r.freight[1].fee).toBeCloseTo(volume * 500)
    expect(r.freightMissing).toBe(1)
  })

  it('shows only the routes this group may see', async () => {
    const r = ok(await appraise(freightSetup(), 'Raven', PUBLIC))
    expect(r.freight.map((f) => f.route)).toEqual(['公开路线'])
  })

  it('is only shown when the appraisal market is the base market', async () => {
    const r = ok(await appraise(freightSetup(), 'Amarr\nRaven'))
    expect(r.freight).toEqual([])
    expect(r.freightMissing).toBe(0)
  })
})

describe('appraise: fittings', () => {
  const FIT = [
    '[Raven, 刷怪乌鸦]',
    'Ballistic Control System II',
    'Ballistic Control System II',
    'Damage Control II /OFFLINE',
    '',
    'Large Shield Extender II',
    'Large Shield Extender II',
    'Entropic Radiation Sink II [1]',
    '',
    ...Array.from({ length: 6 }, () => 'Cruise Missile Launcher II, Scourge Cruise Missile'),
    '[Empty High slot]',
    '',
    'Hobgoblin II x5',
    'Scourge Cruise Missile x2000',
    'Nanite Repair Paste x100',
    'Mobile Tractor Unit x1',
    '',
    '[1] Entropic Radiation Sink II',
    '  Damage Modifier 1.1',
  ].join('\n')

  function fitSetup(mode?: SetupOptions['loadedCharges']) {
    const s = setup({ loadedCharges: mode })
    for (const id of [RAVEN, 22291, DC2, LSE2, 47911, CML2, SCOURGE_CRUISE, HOBGOBLIN2, NANITE, MTU]) s.prices.set(JITA.key, id, { sell: 1000 })
    return s
  }

  it('groups hull, modules, drones and charges; loaded charges are counted full', async () => {
    const r = ok(await appraise(fitSetup(), FIT))
    expect(r.rows.map((row) => [row.item.en, row.quantity, row.group])).toEqual([
      ['Raven', 1, 'hull'],
      ['Ballistic Control System II', 2, 'module'],
      ['Damage Control II', 1, 'module'],
      ['Large Shield Extender II', 2, 'module'],
      ['Entropic Radiation Sink II', 1, 'module'],
      ['Cruise Missile Launcher II', 6, 'module'],
      ['Scourge Cruise Missile', 6 * 27 + 2000, 'drone-charge'],
      ['Hobgoblin II', 5, 'drone-charge'],
      ['Nanite Repair Paste', 100, 'drone-charge'],
      ['Mobile Tractor Unit', 1, 'other'],
    ])
    expect(r.fitting).toEqual({ ship: item(RAVEN), name: '刷怪乌鸦', loadedCharges: [{ charge: item(SCOURGE_CRUISE), modules: 6, perModule: 27 }] })
    expect(r.mutated).toBe(1)
    expect(r.skipped.map((k) => k.reason)).toEqual(['slot', 'mutaplasmid', 'mutaplasmid'])
    expect(r.totals.packagedM3).toBeCloseTo(50_000 + 10 + 5 + 40 + 5 + 120 + 2162 * 0.05 + 25 + 1 + 100)
  })

  it('loaded charges can count once or not at all', async () => {
    const once = ok(await appraise(fitSetup('once'), FIT))
    expect(once.rows.find((row) => row.item.typeId === SCOURGE_CRUISE)?.quantity).toBe(2006)
    expect(once.fitting?.loadedCharges).toEqual([{ charge: item(SCOURGE_CRUISE), modules: 6, perModule: 1 }])
    const ignore = ok(await appraise(fitSetup('ignore'), FIT))
    expect(ignore.rows.find((row) => row.item.typeId === SCOURGE_CRUISE)?.quantity).toBe(2000)
    expect(ignore.fitting?.loadedCharges).toBeUndefined()
  })

  it('an unrecognised hull leaves the fitting out but keeps the groups', async () => {
    const r = ok(await appraise(fitSetup(), '[Ravn Nvy, x]\nLarge Shield Extender II'))
    expect(r.fitting).toBeUndefined()
    expect(r.unresolved.map((u) => u.raw)).toEqual(['[Ravn Nvy, x]'])
    expect(r.rows.map((row) => row.group)).toEqual(['module'])
  })
})

describe('appraisal ids and reprice', () => {
  it('reprices with the saved market, price type and modifier; explicit options win', async () => {
    const s = withPrices()
    const first = ok(await appraise(s, EXAMPLE))
    const buy = ok(await s.service.reprice(first.id, { side: 'buy', access: ALLOWED }))
    expect([buy.id, buy.market.key, buy.side, buy.modifierPct]).toEqual([first.id, ALLIANCE.key, 'buy', -5])
    expect(buy.rows[0].unit).toBe(250e6)
    // 下一次重算接着用上一次的参数
    const next = ok(await s.service.reprice(first.id.toLowerCase(), { modifierPct: 0, access: ALLOWED }))
    expect([next.market.key, next.side, next.modifierPct]).toEqual([ALLIANCE.key, 'buy', 0])
  })

  it('a saved market the group cannot see falls back to the default market', async () => {
    const s = withPrices()
    const first = ok(await appraise(s, EXAMPLE))
    const r = ok(await s.service.reprice(first.id, { access: PUBLIC }))
    expect([r.market.key, r.side, r.modifierPct]).toEqual([JITA.key, 'sell', -5])
  })

  it('a header with an appraisal id and no list reprices the saved list', async () => {
    const s = withPrices()
    const first = ok(await appraise(s, EXAMPLE))
    const r = ok(await appraise(s, `#${first.id} Jita buy`))
    expect([r.id, r.market.key, r.side, r.modifierPct]).toEqual([first.id, JITA.key, 'buy', -5])
    expect(summary(r).map(([en]) => en)).toEqual(['Raven', 'Tritanium', 'Pyerite'])
  })

  it('replaces an unrecognised line by line number and keeps the replacement', async () => {
    const s = withPrices()
    s.prices.set(JITA.key, RAVEN_NAVY, { sell: 500e6 })
    const first = ok(await appraise(s, 'Raven*2\nRaven Navvy*3'))
    expect(first.unresolved.map((u) => u.lineNo)).toEqual([2])
    const fixed = ok(await appraise(s, `#${first.id} 2=#${RAVEN_NAVY}`))
    expect(summary(fixed)).toEqual([['Raven', 2, 2 * 258.4e6], ['Raven Navy Issue', 3, 1.5e9]])
    expect(fixed.unresolved).toEqual([])
    const again = ok(await s.service.reprice(first.id, { side: 'sell', access: ALLOWED }))
    expect(again.rows.map((r) => r.item.en)).toEqual(['Raven', 'Raven Navy Issue'])
  })

  it('replacing a module recomputes the charges loaded in it', async () => {
    const s = setup()
    const first = ok(await appraise(s, '[Raven, x]\nCruise Missle Launcher II, Scourge Cruise Missile'))
    expect(first.rows.map((r) => [r.item.en, r.quantity])).toEqual([['Raven', 1], ['Scourge Cruise Missile', 1]])
    const fixed = ok(await s.service.reprice(first.id, { replace: { 2: CML2 }, access: ALLOWED }))
    expect(fixed.rows.map((r) => [r.item.en, r.quantity])).toEqual([['Raven', 1], ['Cruise Missile Launcher II', 1], ['Scourge Cruise Missile', 27]])
  })

  it('expires after 24 hours without use; every reprice restarts the clock', async () => {
    const s = withPrices()
    const first = ok(await appraise(s, EXAMPLE))
    await s.time.advance(23 * 3600_000)
    ok(await s.service.reprice(first.id, { access: ALLOWED }))
    await s.time.advance(23 * 3600_000)
    ok(await s.service.reprice(first.id, { access: ALLOWED }))
    await s.time.advance(24 * 3600_000)
    expect(failure(await s.service.reprice(first.id, { access: ALLOWED })).code).toBe('APPRAISAL_EXPIRED')
    expect(failure(await s.service.reprice('ZZZZ', { access: ALLOWED })).code).toBe('APPRAISAL_EXPIRED')
  })

  it('lives in the module store, so a reloaded service still finds it', async () => {
    const s = withPrices()
    const first = ok(await appraise(s, EXAMPLE))
    const reloaded = setup({ store: s.store, time: s.time })
    reloaded.prices.set(JITA.key, RAVEN, { sell: 1 })
    const r = ok(await reloaded.service.reprice(first.id, { market: 'Jita', access: ALLOWED }))
    expect(r.rows.map((row) => row.item.en)).toEqual(['Raven', 'Tritanium', 'Pyerite'])
  })

  it('keeps at most 200 lists, dropping the least recently used', async () => {
    const s = withPrices()
    const ids: string[] = []
    for (let i = 0; i < 201; i++) ids.push(ok(await appraise(s, 'Tritanium')).id)
    expect(new Set(ids).size).toBe(201)
    expect(failure(await s.service.reprice(ids[0], { access: ALLOWED })).code).toBe('APPRAISAL_EXPIRED')
    ok(await s.service.reprice(ids[1], { access: ALLOWED }))
  })
})
