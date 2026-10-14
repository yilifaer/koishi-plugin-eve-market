// 每日维护时间里取不到价格：查价、批量查价的卡片只写一句说明；时间窗外或价格都取到时什么都不写。

import { describe, expect, it } from 'vitest'
import { resultCards } from '../../../src/bot/commands/batch-card'
import type { BatchEnv } from '../../../src/bot/commands/batch-card'
import { downtimeWarnings } from '../../../src/bot/commands/downtime'
import { priceCard } from '../../../src/bot/commands/price-card'
import type { PriceCardInput } from '../../../src/bot/commands/price-card'
import { PRESET_MARKETS } from '../../../src/config/presets'
import { adjusted, appraisal, item, marketOf, md, quote, row, testCore } from './helpers'

const NOTICE = '⚠ EVE 每日维护中（北京时间 19:00 左右），价格暂时取不到，15 分钟后再试'
const IN_DT = Date.UTC(2026, 9, 14, 11, 10)
const AFTER_DT = Date.UTC(2026, 9, 14, 11, 30)

const core = testCore({ markets: PRESET_MARKETS })
const jita = marketOf(core, 'jita 4-4')
const count = (text: string) => text.split(NOTICE).length - 1

describe('downtimeWarnings', () => {
  it('only when prices are missing, inside the window, and the clock is known', () => {
    expect(downtimeWarnings(IN_DT, true)).toEqual([NOTICE.slice(2)])
    expect(downtimeWarnings(IN_DT, false)).toEqual([])
    expect(downtimeWarnings(AFTER_DT, true)).toEqual([])
    expect(downtimeWarnings(undefined, true)).toEqual([])
  })
})

describe('查价 card', () => {
  const input = (quotes: Array<ReturnType<typeof quote>>): PriceCardInput => ({
    item: item('Raven'), quantity: null, quotes: quotes.map((q) => ({ market: marketOf(core, q.marketKey), quote: q })),
    base: { market: jita, quote: null }, single: false, global: false, meta: [], notices: [], actions: [],
  })
  const down = (key: string) => ({ ...quote(key, 638, null, null), status: 'unavailable' as const, reason: 'esi_error' as const, downtime: true })

  it('one notice for the whole card, however many markets are missing', () => {
    const card = priceCard({ core, display: core.settings.display, now: IN_DT }, input([quote('jita 4-4', 638, 258_400_000, 249_000_000), down('amarr'), down('dodixie')]))
    expect(count(md(card))).toBe(1)
  })

  it('nothing outside the window, or when every price came back', () => {
    const missing = input([quote('jita 4-4', 638, 258_400_000, 249_000_000), down('amarr')])
    expect(md(priceCard({ core, display: core.settings.display, now: AFTER_DT }, missing))).not.toContain('每日维护')
    const fine = input([quote('jita 4-4', 638, 258_400_000, 249_000_000)])
    expect(md(priceCard({ core, display: core.settings.display, now: IN_DT }, fine))).not.toContain('每日维护')
  })
})

describe('批量查价 card', () => {
  const env = (now?: number): BatchEnv => ({ core, display: core.settings.display, routes: [], commandName: '批量查价', base: jita, ...now === undefined ? {} : { now } })
  const result = (reason: 'timeout' | 'no-orders' | 'market-unavailable') => appraisal(jita, [
    adjusted(row(item('Raven'), 1, 270e6, { sourceLines: [1] }), 0),
    row(item('Megathron'), 1, null, { sourceLines: [2] }),
  ], { noPrice: [{ item: item('Megathron'), reason }] })
  const out = (now: number | undefined, reason: 'timeout' | 'no-orders' | 'market-unavailable') =>
    resultCards(env(now), result(reason), { all: false, maxParts: 3, notices: [] }).map((c) => md(c)).join('\n')

  it('a timed-out or unavailable price in the window gets one notice', () => {
    expect(count(out(IN_DT, 'timeout'))).toBe(1)
    expect(count(out(IN_DT, 'market-unavailable'))).toBe(1)
  })

  it('an item that simply has no orders, or a time outside the window, gets none', () => {
    expect(out(IN_DT, 'no-orders')).not.toContain('每日维护')
    expect(out(AFTER_DT, 'timeout')).not.toContain('每日维护')
    expect(out(undefined, 'timeout')).not.toContain('每日维护')
  })
})
