import { describe, expect, it } from 'vitest'
import { ERROR_LIMIT_PAUSE_REMAIN } from '../../../src/constants'
import { EsiLimits, createLimitState, tokenCost } from '../../../src/core/esi'
import { DEFAULT_PAUSE_MS } from '../../../src/core/esi/ratelimit'

const NOW = Date.UTC(2026, 9, 7, 6, 20)
const WINDOW = 900_000
const ORDERS = 'GET /markets/{region_id}/orders'
const HISTORY = 'GET /markets/{region_id}/history'

function headers(h: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
  return { header: (name: string) => lower[name.toLowerCase()] }
}

function group(name: string, limit: number, remaining: number, used = 2, extra: Record<string, string> = {}) {
  return headers({ 'X-Ratelimit-Group': name, 'X-Ratelimit-Limit': `${limit}/15m`, 'X-Ratelimit-Remaining': String(remaining), 'X-Ratelimit-Used': String(used), ...extra })
}

describe('tokenCost', () => {
  it('follows the published table: 2xx 2, 3xx 1, 4xx 5, 5xx 0, 429 free', () => {
    expect([200, 204, 304, 400, 404, 420, 429, 500, 503].map(tokenCost)).toEqual([2, 2, 1, 5, 5, 5, 0, 0, 0])
  })
})

describe('EsiLimits: groups', () => {
  it('knows the documented groups before any response', () => {
    const limits = new EsiLimits(createLimitState())
    const status = limits.status(NOW)
    expect(status.groups.map((g) => [g.group, g.limit, g.remaining])).toEqual([
      ['market-order', 12000, null],
      ['industry', 150, null],
      ['incursion', 150, null],
      ['status', 600, null],
    ])
    expect(status).toMatchObject({ errorLimitRemain: null, errorLimitResetAt: null, pausedUntil: null })
  })

  it('tracks the remaining tokens and gives our own spending back after the window slides past', () => {
    const limits = new EsiLimits(createLimitState())
    limits.observe('GET /industry/systems', 'industry', 200, group('industry', 150, 148), NOW)
    limits.observe('GET /industry/systems', 'industry', 200, group('industry', 150, 146), NOW + 60_000)
    const state = limits.state.groups.get('industry')!
    expect(limits.estimate(state, NOW + 60_000)).toBe(146)
    expect(limits.estimate(state, NOW + WINDOW)).toBe(148)
    expect(limits.estimate(state, NOW + WINDOW + 60_000)).toBe(150)
    expect(limits.estimate(state, NOW + 10 * WINDOW)).toBe(150)
  })

  it('pauses only background requests when a group drops under 10%, until enough tokens come back', () => {
    const limits = new EsiLimits(createLimitState())
    // 150 的 10% 是 15：剩 13 时暂停后台
    limits.observe('GET /industry/systems', 'industry', 200, group('industry', 150, 20, 2), NOW)
    limits.observe('GET /industry/systems', 'industry', 200, group('industry', 150, 13, 2), NOW + 1_000)
    expect(limits.check('GET /industry/systems', 'industry', 'interactive', NOW + 2_000)).toBeNull()
    const decision = limits.check('GET /industry/systems', 'industry', 'background', NOW + 2_000)
    expect(decision).toMatchObject({ kind: 'throttled' })
    // 13 + 第一次的 2 = 15，在第一次请求滑出窗口时恢复
    expect(decision!.retryAt).toBe(NOW + WINDOW)
    expect(limits.check('GET /industry/systems', 'industry', 'background', NOW + WINDOW)).toBeNull()
    // 别的组不受影响
    expect(limits.check('GET /status', 'status', 'background', NOW + 2_000)).toBeNull()
  })

  it('waits a whole window when its own spending is not enough to recover', () => {
    const limits = new EsiLimits(createLimitState())
    limits.observe('GET /incursions', 'incursion', 200, group('incursion', 150, 3, 2), NOW)
    const decision = limits.check('GET /incursions', 'incursion', 'background', NOW + 1)
    expect(decision).toMatchObject({ kind: 'throttled', retryAt: NOW + WINDOW })
  })

  it('learns the group of an undeclared route from X-Ratelimit-Group', () => {
    const limits = new EsiLimits(createLimitState())
    limits.observe(HISTORY, undefined, 200, group('market-history', 300, 10), NOW)
    expect(limits.groupKey(HISTORY)).toBe('market-history')
    expect(limits.check(HISTORY, undefined, 'background', NOW + 1)).toMatchObject({ kind: 'throttled' })
    expect(limits.status(NOW).groups.find((g) => g.group === 'market-history')).toMatchObject({ limit: 300, remaining: 10 })
  })

  it('a 429 pauses the group for Retry-After, for every lane, and only that group', () => {
    const limits = new EsiLimits(createLimitState())
    const changed = limits.observe(ORDERS, 'market-order', 429, group('market-order', 12000, 0, 0, { 'Retry-After': '30' }), NOW)
    expect(changed).toBe(true)
    expect(limits.check(ORDERS, 'market-order', 'interactive', NOW + 29_999)).toMatchObject({ kind: 'rate-limited', retryAt: NOW + 30_000 })
    expect(limits.check(ORDERS, 'market-order', 'interactive', NOW + 30_000)).toBeNull()
    expect(limits.check('GET /status', 'status', 'interactive', NOW + 1)).toBeNull()
    expect(limits.status(NOW + 1).groups.find((g) => g.group === 'market-order')!.pausedUntil).toBe(NOW + 30_000)
    expect(limits.status(NOW + 30_001).groups.find((g) => g.group === 'market-order')!.pausedUntil).toBeNull()
  })

  it('a 429 without a group pauses just that route; without Retry-After it waits a default minute', () => {
    const limits = new EsiLimits(createLimitState())
    limits.observe(HISTORY, undefined, 429, headers({}), NOW)
    expect(limits.check(HISTORY, undefined, 'interactive', NOW + 1)).toMatchObject({ kind: 'rate-limited', retryAt: NOW + DEFAULT_PAUSE_MS })
    expect(limits.check('GET /markets/prices', undefined, 'interactive', NOW + 1)).toBeNull()
    expect(limits.status(NOW + 1).groups.map((g) => g.group)).toContain(HISTORY)
  })
})

describe('EsiLimits: error limit', () => {
  it('a 420 pauses everything until the error window resets', () => {
    const limits = new EsiLimits(createLimitState())
    limits.observe(HISTORY, undefined, 420, headers({ 'X-ESI-Error-Limit-Remain': '0', 'X-ESI-Error-Limit-Reset': '40' }), NOW)
    for (const [route, group] of [[ORDERS, 'market-order'], ['GET /status', 'status'], [HISTORY, undefined]] as const) {
      expect(limits.check(route, group, 'interactive', NOW + 39_000)).toMatchObject({ kind: 'error-limited', retryAt: NOW + 40_000 })
    }
    expect(limits.check(ORDERS, 'market-order', 'interactive', NOW + 40_000)).toBeNull()
    expect(limits.status(NOW + 1)).toMatchObject({ pausedUntil: NOW + 40_000, errorLimitRemain: 0, errorLimitResetAt: NOW + 40_000 })
  })

  it('a 420 without reset headers still pauses for a default window', () => {
    const limits = new EsiLimits(createLimitState())
    limits.observe(HISTORY, undefined, 420, headers({}), NOW)
    expect(limits.check(HISTORY, undefined, 'interactive', NOW + 1)).toMatchObject({ kind: 'error-limited', retryAt: NOW + DEFAULT_PAUSE_MS })
  })

  it(`stops background requests while fewer than ${ERROR_LIMIT_PAUSE_REMAIN} errors are left`, () => {
    const limits = new EsiLimits(createLimitState())
    limits.observe(HISTORY, undefined, 404, headers({ 'X-ESI-Error-Limit-Remain': String(ERROR_LIMIT_PAUSE_REMAIN), 'X-ESI-Error-Limit-Reset': '30' }), NOW)
    expect(limits.check(HISTORY, undefined, 'background', NOW + 1)).toBeNull()
    limits.observe(HISTORY, undefined, 404, headers({ 'X-ESI-Error-Limit-Remain': String(ERROR_LIMIT_PAUSE_REMAIN - 1), 'X-ESI-Error-Limit-Reset': '29' }), NOW + 1_000)
    expect(limits.check(HISTORY, undefined, 'background', NOW + 2_000)).toMatchObject({ kind: 'throttled', retryAt: NOW + 30_000 })
    expect(limits.check(ORDERS, 'market-order', 'background', NOW + 2_000)).toMatchObject({ kind: 'throttled' })
    expect(limits.check(HISTORY, undefined, 'interactive', NOW + 2_000)).toBeNull()
    // 窗口重置以后恢复
    expect(limits.check(HISTORY, undefined, 'background', NOW + 30_000)).toBeNull()
    expect(limits.status(NOW + 30_000)).toMatchObject({ errorLimitRemain: null, errorLimitResetAt: null })
  })
})

describe('EsiLimits: persistence', () => {
  it('snapshots only live pauses and restores them into a fresh state', () => {
    const a = new EsiLimits(createLimitState())
    a.observe(ORDERS, 'market-order', 429, group('market-order', 12000, 0, 0, { 'Retry-After': '120' }), NOW)
    a.observe(HISTORY, undefined, 420, headers({ 'X-ESI-Error-Limit-Remain': '0', 'X-ESI-Error-Limit-Reset': '50' }), NOW)
    const snap = a.snapshot(NOW)
    expect(snap).toEqual({ v: 1, pausedUntil: NOW + 50_000, errorRemain: 0, errorResetAt: NOW + 50_000, groups: { 'market-order': NOW + 120_000 } })

    const b = new EsiLimits(createLimitState())
    b.restore(JSON.parse(JSON.stringify(snap)), NOW + 10_000)
    expect(b.check(ORDERS, 'market-order', 'interactive', NOW + 10_000)).toMatchObject({ kind: 'error-limited', retryAt: NOW + 50_000 })
    expect(b.check(ORDERS, 'market-order', 'interactive', NOW + 60_000)).toMatchObject({ kind: 'rate-limited', retryAt: NOW + 120_000 })
    expect(b.check(ORDERS, 'market-order', 'interactive', NOW + 120_000)).toBeNull()

    // 已经结束的不恢复
    const c = new EsiLimits(createLimitState())
    c.restore(snap, NOW + 200_000)
    expect(c.snapshot(NOW + 200_000)).toEqual({ v: 1, pausedUntil: null, errorRemain: null, errorResetAt: null, groups: {} })
  })

  it('ignores anything that does not look like a snapshot', () => {
    const limits = new EsiLimits(createLimitState())
    for (const junk of [null, 'x', 1, {}, { v: 2 }, { v: 1, pausedUntil: 'soon', errorRemain: null, errorResetAt: null, groups: {} }, { v: 1, pausedUntil: null, errorRemain: null, errorResetAt: null, groups: { a: 'b' } }]) {
      limits.restore(junk, NOW)
    }
    expect(limits.snapshot(NOW)).toEqual({ v: 1, pausedUntil: null, errorRemain: null, errorResetAt: null, groups: {} })
  })

  it('reports a change only when a pause window moves', () => {
    const limits = new EsiLimits(createLimitState())
    expect(limits.observe(ORDERS, 'market-order', 200, group('market-order', 12000, 11998), NOW)).toBe(false)
    expect(limits.observe(HISTORY, undefined, 404, headers({ 'X-ESI-Error-Limit-Remain': '90', 'X-ESI-Error-Limit-Reset': '30' }), NOW)).toBe(false)
    expect(limits.observe(HISTORY, undefined, 404, headers({ 'X-ESI-Error-Limit-Remain': '10', 'X-ESI-Error-Limit-Reset': '30' }), NOW)).toBe(true)
    expect(limits.observe(ORDERS, 'market-order', 429, group('market-order', 12000, 0, 0, { 'Retry-After': '5' }), NOW)).toBe(true)
  })
})
