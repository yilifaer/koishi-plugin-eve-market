import { afterEach, describe, expect, it } from 'vitest'
import { ADJUSTED_PRICES_CACHE_MIN, COMPATIBILITY_DATE, ESI_PAGE_CONCURRENCY, INDUSTRY_STALE_HOURS } from '../../../src/constants'
import { ESI_META_KEY, EsiError } from '../../../src/core/esi'
import type { EsiCacheEntry, EsiCacheStore } from '../../../src/core/esi'
import { NetworkError, createModuleStore } from '../../../src/core/ports'
import { rawOrder } from '../../fakes/fake-esi'
import { MemoryBlobCache, RAVEN, STRUCTURE, THE_FORGE, TRITANIUM, authFrom, closeAll, makeEnv, settle, until } from './helpers'

afterEach(closeAll)

const ORDERS_PATH = /^\/markets\/10000002\/orders$/

async function rejection(promise: Promise<unknown>): Promise<EsiError> {
  try {
    await promise
  } catch (e) {
    expect(e).toBeInstanceOf(EsiError)
    return e as EsiError
  }
  throw new Error('应该失败，结果成功了')
}

function forgeOrders(n: number) {
  return Array.from({ length: n }, (_, i) => rawOrder({ price: 1000 + i }))
}

describe('EsiClient: request headers', () => {
  it('sends the compatibility date, a descriptive User-Agent and no version prefix or datasource', async () => {
    const env = await makeEnv({ contact: 'pilot@example.com' }, (f) => f.regionOrders.set(THE_FORGE, [rawOrder()]))
    await env.api.regionOrders(THE_FORGE, RAVEN)
    const [req] = env.fake.requests
    expect(req.path).toBe('/markets/10000002/orders')
    expect(Object.fromEntries(req.query)).toEqual({ order_type: 'all', type_id: '638', page: '1' })
    expect(req.headers['x-compatibility-date']).toBe(COMPATIBILITY_DATE)
    expect(req.headers['user-agent']).toBe('koishi-plugin-eve-market/0.0.1 (+https://github.com/yilifaer/koishi-plugin-eve-market; pilot@example.com)')
    expect(req.headers.accept).toBe('application/json')
    expect(req.headers['if-none-match']).toBeUndefined()
    expect(req.headers.authorization).toBeUndefined()
    expect(env.http.requests[0].url.startsWith(`${env.fake.base}/markets/`)).toBe(true)
    expect(env.http.requests[0].timeoutMs).toBe(10_000)
  })

  it('uses the longer timeout for background requests', async () => {
    const env = await makeEnv()
    await env.api.serverStatus({ lane: 'background' })
    expect(env.http.requests[0].timeoutMs).toBe(30_000)
  })
})

describe('EsiClient: cache and conditional requests', () => {
  it('never requests again before the cache expires, then revalidates with If-None-Match', async () => {
    const env = await makeEnv()
    const first = await env.api.serverStatus()
    expect(first).toMatchObject({ cached: false, stale: false, expiresAt: env.clock.now() + 30_000 })
    expect(first.value.players).toBe(23456)
    expect(first.etag).toMatch(/^"/)

    env.clock.advance(29_999)
    expect((await env.api.serverStatus()).cached).toBe(true)
    expect(env.fake.requests).toHaveLength(1)

    env.clock.advance(1)
    const again = await env.api.serverStatus()
    expect(env.fake.requests).toHaveLength(2)
    expect(env.fake.requests[1].headers['if-none-match']).toBe(first.etag)
    expect(env.fake.requests[1].status).toBe(304)
    expect(again).toMatchObject({ cached: false, value: first.value, validatedAt: env.clock.now(), expiresAt: env.clock.now() + 30_000 })
    expect(again.lastModified).toBe(first.lastModified)

    env.fake.serverStatus.players = 30000
    env.fake.touch('status')
    env.clock.advance(30_000)
    const changed = await env.api.serverStatus()
    expect(env.fake.requests[2].status).toBe(200)
    expect(changed.value.players).toBe(30000)
    expect(changed.etag).not.toBe(first.etag)
    expect(changed.lastModified).toBeGreaterThan(first.lastModified!)
  })

  it('honours Expires relative to the server Date when there is no Cache-Control', async () => {
    const env = await makeEnv({}, (f) => {
      f.cacheMode = 'expires'
    })
    // 服务器的钟快了一小时，也不影响
    env.fake.clock = () => env.clock.now() + 3_600_000
    const res = await env.api.prices()
    expect(res.expiresAt).toBe(env.clock.now() + 3_600_000)
  })

  it('falls back to the route default when ESI sends no cache headers', async () => {
    const env = await makeEnv({}, (f) => {
      f.cacheMode = 'none'
    })
    const res = await env.api.prices()
    expect(res.expiresAt).toBe(env.clock.now() + ADJUSTED_PRICES_CACHE_MIN * 60_000)
  })

  it('keeps the cache across a plugin reload (same module store) but not across a restart', async () => {
    const env = await makeEnv()
    await env.api.prices()
    const reloaded = env.another()
    expect((await reloaded.request({ route: 'GET /markets/prices', path: '/markets/prices', ttlSec: 60, parse: (j) => j })).cached).toBe(true)
    expect(env.fake.requests).toHaveLength(1)
    const restarted = env.another({ store: createModuleStore() })
    expect((await restarted.request({ route: 'GET /markets/prices', path: '/markets/prices', ttlSec: 60, parse: (j) => j })).cached).toBe(false)
    expect(env.fake.requests).toHaveLength(2)
  })

  it('can keep a route in a caller-provided store', async () => {
    const env = await makeEnv()
    const map = new Map<string, EsiCacheEntry>()
    const store: EsiCacheStore = { get: async (k) => map.get(k), set: async (k, e) => void map.set(k, e) }
    await env.api.serverStatus({ store })
    expect([...map.keys()]).toEqual(['GET /status'])
    expect((await env.api.serverStatus({ store })).cached).toBe(true)
    // 默认的内存缓存里没有
    expect((await env.api.serverStatus()).cached).toBe(false)
  })

  it('separates cache keys by auth profile and language, never by token', async () => {
    const env = await makeEnv()
    const auth = authFrom(() => 'secret-token-value')
    const req = { route: 'GET /x', path: '/x', query: { a: 1, b: undefined }, ttlSec: 1, parse: (j: unknown) => j }
    expect(env.client.keyOf(req)).toBe('GET /x?a=1')
    expect(env.client.keyOf({ ...req, language: 'zh' }, auth)).toBe('GET /x?a=1 lang=zh profile=main')
    expect(env.client.keyOf({ ...req, method: 'POST', body: ['Raven'] })).toBe('POST /x?a=1 body=["Raven"]')
  })
})

describe('EsiClient: single-flight', () => {
  it('ten concurrent identical requests send one request', async () => {
    const env = await makeEnv({}, (f) => f.history.set(`${THE_FORGE}:${RAVEN}`, [{ date: '2026-10-06', average: 1, highest: 2, lowest: 0.5, volume: 10, order_count: 3 }]))
    const results = await Promise.all(Array.from({ length: 10 }, () => env.api.history(THE_FORGE, RAVEN)))
    expect(env.fake.requests).toHaveLength(1)
    expect(new Set(results.map((r) => r.value)).size).toBe(1)
  })
})

describe('EsiClient: pagination', () => {
  it('reads X-Pages from page 1 and fetches the rest in parallel, in page order', async () => {
    const orders = forgeOrders(9)
    const env = await makeEnv({}, (f) => {
      f.pageSize = 1
      f.regionOrders.set(THE_FORGE, orders)
      f.beforeRespond = async (req) => {
        if (req.query.get('page') !== '1') await new Promise((r) => setTimeout(r, 20))
      }
    })
    const res = await env.api.regionOrders(THE_FORGE, RAVEN)
    expect(res.pages).toBe(9)
    expect(res.inconsistent).toBe(false)
    expect(res.value.map((o) => o.orderId)).toEqual(orders.map((o) => o.order_id))
    expect(env.fake.requests.map((r) => r.query.get('page'))).toContain('9')
    expect(env.fake.requests).toHaveLength(9)
    expect(env.fake.peakInFlight).toBeGreaterThan(1)
    expect(env.fake.peakInFlight).toBeLessThanOrEqual(ESI_PAGE_CONCURRENCY)

    // 全部页都在缓存里
    const again = await env.api.regionOrders(THE_FORGE, RAVEN)
    expect(again.cached).toBe(true)
    expect(env.fake.requests).toHaveLength(9)
  })

  it('starts over from page 1 when Last-Modified changes while paging', async () => {
    let bumped = false
    const env = await makeEnv({}, (f) => {
      f.pageSize = 2
      f.regionOrders.set(THE_FORGE, forgeOrders(5))
      f.beforeRespond = (req) => {
        if (req.query.get('page') === '2' && !bumped) {
          bumped = true
          f.touch(`orders:${THE_FORGE}`)
        }
      }
    })
    const res = await env.api.regionOrders(THE_FORGE, RAVEN)
    expect(res.inconsistent).toBe(false)
    expect(res.value).toHaveLength(5)
    const pageOne = env.fake.requests.filter((r) => r.query.get('page') === '1')
    expect(pageOne).toHaveLength(2)
    expect(pageOne[1].status).toBe(200)
    expect(env.logger.at('debug').some((l) => l.includes('从第 1 页重新取'))).toBe(true)
    expect(env.logger.at('warn')).toEqual([])
  })

  it('accepts the data but flags it when the pages still disagree after starting over', async () => {
    let pageOneSeen = 0
    let pageTwoSeen = 0
    const env = await makeEnv({}, (f) => {
      f.pageSize = 2
      f.regionOrders.set(THE_FORGE, forgeOrders(4))
      f.beforeRespond = (req) => {
        const page = req.query.get('page')
        if ((page === '1' && pageOneSeen++ > 0) || (page === '2' && pageTwoSeen++ === 0)) f.touch(`orders:${THE_FORGE}`)
      }
    })
    const res = await env.api.regionOrders(THE_FORGE, RAVEN)
    expect(res.inconsistent).toBe(true)
    expect(res.value).toHaveLength(4)
    expect(env.logger.at('warn').some((l) => l.includes('Last-Modified 还是不一样'))).toBe(true)
  })

  it('refuses an absurd X-Pages', async () => {
    const env = await makeEnv({ maxPages: 3 }, (f) => {
      f.pageSize = 1
      f.regionOrders.set(THE_FORGE, forgeOrders(4))
    })
    const error = await rejection(env.api.regionOrders(THE_FORGE, RAVEN, { staleIfErrorMs: 0 }))
    expect(error.kind).toBe('bad-response')
    expect(env.fake.requests).toHaveLength(1)
  })

  it('serves every cached page when a later refresh fails', async () => {
    const env = await makeEnv({}, (f) => {
      f.pageSize = 2
      f.regionOrders.set(THE_FORGE, forgeOrders(3))
    })
    const fresh = await env.api.regionOrders(THE_FORGE, RAVEN)
    env.clock.advance(10 * 60_000)
    env.fake.fault('GET', ORDERS_PATH, { status: 503 }, 2)
    const stale = await env.api.regionOrders(THE_FORGE, RAVEN)
    expect(stale).toMatchObject({ stale: true, cached: true, pages: 2, inconsistent: false })
    expect(stale.value).toEqual(fresh.value)
    expect(stale.error?.status).toBe(503)

    // 超过 60 分钟就不用了
    env.clock.advance(60 * 60_000)
    env.fake.fault('GET', ORDERS_PATH, { status: 503 }, 2)
    expect((await rejection(env.api.regionOrders(THE_FORGE, RAVEN))).status).toBe(503)
  })
})

describe('EsiClient: retries', () => {
  it('retries a 5xx once after a short random wait', async () => {
    const env = await makeEnv()
    env.fake.fault('GET', /^\/status$/, { status: 503, body: { error: 'Service unavailable' } })
    const res = await env.api.serverStatus()
    expect(res.value.players).toBe(23456)
    expect(env.fake.requests.map((r) => r.status)).toEqual([503, 200])
    expect(env.logger.at('debug').some((l) => l.includes('HTTP 503') && l.includes('重试一次'))).toBe(true)
  })

  it('gives up after the second 5xx', async () => {
    const env = await makeEnv()
    env.fake.fault('GET', /^\/status$/, { status: 502, body: { error: 'Bad gateway' } }, 2)
    const error = await rejection(env.api.serverStatus())
    expect(error).toMatchObject({ kind: 'http', status: 502, code: 'Bad gateway', route: 'GET /status' })
    expect(env.fake.requests).toHaveLength(2)
  })

  it('does not retry a 4xx', async () => {
    const env = await makeEnv()
    const error = await rejection(env.api.type(999_999_999))
    expect(error).toMatchObject({ kind: 'http', status: 404, message: 'HTTP 404: Type not found' })
    expect(env.fake.requests).toHaveLength(1)
  })

  it('retries a dropped connection once', async () => {
    const env = await makeEnv()
    env.fake.fault('GET', /^\/status$/, { destroy: true })
    expect((await env.api.serverStatus()).value.players).toBe(23456)
    expect(env.fake.requests).toHaveLength(2)
  })

  it('times out each attempt and retries once', async () => {
    const env = await makeEnv()
    env.fake.fault('GET', /^\/status$/, { delayMs: 300 }, 2)
    const error = await rejection(env.api.serverStatus({ timeoutMs: 40 }))
    expect(error.kind).toBe('timeout')
    expect(env.fake.requests).toHaveLength(2)
  })
})

describe('EsiClient: rate limit groups', () => {
  it('a 429 pauses the group for Retry-After without touching other groups, and remembers it on disk', async () => {
    const env = await makeEnv()
    env.fake.fault('GET', /^\/incursions$/, {
      status: 429,
      body: { error: 'Too many requests' },
      headers: { 'Retry-After': '30', 'X-Ratelimit-Group': 'incursion', 'X-Ratelimit-Limit': '150/15m', 'X-Ratelimit-Remaining': '0' },
    })
    const error = await rejection(env.api.incursions())
    expect(error).toMatchObject({ kind: 'rate-limited', status: 429, retryAt: env.clock.now() + 30_000 })
    expect(error.paused).toBe(true)

    const again = await rejection(env.api.incursions())
    expect(again).toMatchObject({ kind: 'rate-limited', retryAt: env.clock.now() + 30_000 })
    expect(env.fake.requests).toHaveLength(1)
    expect((await env.api.serverStatus()).value.players).toBe(23456)
    expect(env.client.status().groups.find((g) => g.group === 'incursion')!.pausedUntil).toBe(env.clock.now() + 30_000)
    await env.client.flush()
    expect(env.cache.json(ESI_META_KEY)).toMatchObject({ groups: { incursion: env.clock.now() + 30_000 } })
    expect(env.logger.at('warn').some((l) => l.includes('429'))).toBe(true)

    env.clock.advance(30_000)
    expect((await env.api.incursions()).value).toEqual([])
  })

  it('a paused group still serves recent cached data, marked stale', async () => {
    const env = await makeEnv()
    await env.api.incursions()
    env.clock.advance(6 * 60_000)
    env.fake.fault('GET', /^\/incursions$/, { status: 429, headers: { 'Retry-After': '60', 'X-Ratelimit-Group': 'incursion' } })
    const stale = await env.api.incursions()
    expect(stale).toMatchObject({ stale: true, cached: true, value: [] })
    expect(stale.error?.kind).toBe('rate-limited')
    // 暂停期间不再请求，仍然给旧数据
    expect((await env.api.incursions()).stale).toBe(true)
    expect(env.fake.requests).toHaveLength(2)
  })

  it('background requests stop when a group runs low; interactive ones carry on', async () => {
    const env = await makeEnv()
    env.fake.fault('GET', /^\/incursions$/, {
      status: 200,
      body: [],
      headers: { 'Cache-Control': 'max-age=0', 'X-Ratelimit-Group': 'incursion', 'X-Ratelimit-Limit': '150/15m', 'X-Ratelimit-Remaining': '10', 'X-Ratelimit-Used': '2' },
    })
    await env.api.incursions()
    const throttled = await rejection(env.api.incursions({ lane: 'background', staleIfErrorMs: 0 }))
    expect(throttled).toMatchObject({ kind: 'throttled', retryAt: env.clock.now() + 900_000 })
    expect(env.fake.requests).toHaveLength(1)
    await env.api.incursions()
    expect(env.fake.requests).toHaveLength(2)
    expect(env.client.status().groups.find((g) => g.group === 'incursion')!.remaining).toBeGreaterThan(140)
  })

  it('reports each group and the error limit', async () => {
    const env = await makeEnv({}, (f) => f.regionOrders.set(THE_FORGE, [rawOrder()]))
    await env.api.regionOrders(THE_FORGE, RAVEN)
    await env.api.prices()
    const status = env.client.status()
    expect(status.groups.find((g) => g.group === 'market-order')).toEqual({ group: 'market-order', limit: 12000, remaining: 11998, pausedUntil: null })
    expect(status.errorLimitRemain).toBe(100)
    expect(status.errorLimitResetAt).toBeGreaterThan(env.clock.now())
    expect(status.pausedUntil).toBeNull()
  })
})

describe('EsiClient: error limit', () => {
  it('a 420 stops every request until the reset, also after a restart', async () => {
    const env = await makeEnv({}, (f) => f.regionOrders.set(THE_FORGE, [rawOrder()]))
    env.fake.fault('GET', /^\/markets\/prices$/, {
      status: 420,
      body: { error: 'This software has exceeded the error limit for ESI.' },
      headers: { 'X-ESI-Error-Limit-Remain': '0', 'X-ESI-Error-Limit-Reset': '40' },
    })
    const error = await rejection(env.api.prices())
    expect(error).toMatchObject({ kind: 'error-limited', status: 420, retryAt: env.clock.now() + 40_000 })
    expect((await rejection(env.api.regionOrders(THE_FORGE, RAVEN))).kind).toBe('error-limited')
    expect((await rejection(env.api.serverStatus())).kind).toBe('error-limited')
    expect(env.fake.requests).toHaveLength(1)
    expect(env.client.status().pausedUntil).toBe(env.clock.now() + 40_000)

    await env.client.flush()
    expect(env.cache.json(ESI_META_KEY)).toMatchObject({ pausedUntil: env.clock.now() + 40_000 })

    // 重启：新的模块级存储，同一个 BlobCache
    const restarted = env.another({ store: createModuleStore() })
    await restarted.start()
    env.clock.advance(20_000)
    expect(restarted.status().pausedUntil).toBe(env.clock.now() + 20_000)
    const status = { route: 'GET /status', path: '/status', group: 'status', ttlSec: 30, parse: (j: unknown) => j }
    expect((await rejection(restarted.request(status))).kind).toBe('error-limited')
    expect(env.fake.requests).toHaveLength(1)

    env.clock.advance(20_000)
    await restarted.request(status)
    expect(env.fake.requests).toHaveLength(2)
  })

  it('a request still waiting for a pool slot when a 420 arrives is not sent', async () => {
    const env = await makeEnv({ pools: { interactive: 1 } })
    const release = env.fake.hold(/^\/status$/)
    const first = env.api.serverStatus()
    const queued = env.api.prices({ staleIfErrorMs: 0 })
    await until(() => env.fake.requests.length === 1)
    env.fake.fault('GET', /^\/incursions$/, { status: 420, headers: { 'X-ESI-Error-Limit-Remain': '0', 'X-ESI-Error-Limit-Reset': '30' } })
    expect((await rejection(env.api.incursions({ lane: 'background' }))).kind).toBe('error-limited')
    release()
    await first
    expect((await rejection(queued)).kind).toBe('error-limited')
    expect(env.fake.count(/^\/markets\/prices$/)).toBe(0)
  })

  it('background requests pause while the error limit is low; interactive ones do not', async () => {
    const env = await makeEnv({}, (f) => f.history.set(`${THE_FORGE}:${RAVEN}`, []))
    env.fake.fault('GET', /^\/markets\/prices$/, { status: 404, headers: { 'X-ESI-Error-Limit-Remain': '15', 'X-ESI-Error-Limit-Reset': '30' } })
    await rejection(env.api.prices())
    const throttled = await rejection(env.api.history(THE_FORGE, RAVEN, { lane: 'background' }))
    expect(throttled).toMatchObject({ kind: 'throttled', retryAt: env.clock.now() + 30_000 })
    expect(env.fake.requests).toHaveLength(1)
    await env.api.history(THE_FORGE, RAVEN)
    expect(env.fake.requests).toHaveLength(2)
  })

  it('a start() with nothing on disk, or junk on disk, changes nothing', async () => {
    const env = await makeEnv()
    await env.client.start()
    env.cache.entries.set(ESI_META_KEY, { body: Buffer.from('{not json'), meta: {} })
    const other = env.another({ store: createModuleStore() })
    await other.start()
    expect(other.status().pausedUntil).toBeNull()
    expect(env.logger.at('warn').some((l) => l.includes('读不了'))).toBe(true)
  })
})

describe('EsiClient: pools', () => {
  it('a busy background pool never holds up interactive requests', async () => {
    const env = await makeEnv({ pools: { background: 1 } })
    const release = env.fake.hold(/^\/industry\/systems$/)
    const slow = env.api.industrySystems({ lane: 'background' })
    const queued = env.api.prices({ lane: 'background' })
    await until(() => env.fake.count(/^\/industry\/systems$/) === 1)
    expect((await env.api.serverStatus()).value.players).toBe(23456)
    expect(env.fake.count(/^\/markets\/prices$/)).toBe(0)
    release()
    await Promise.all([slow, queued])
    expect(env.fake.count(/^\/markets\/prices$/)).toBe(1)
  })

  it('never runs more interactive requests at once than the pool allows', async () => {
    const env = await makeEnv({ pools: { interactive: 2 } }, (f) => {
      for (const type of [RAVEN, TRITANIUM, 35]) f.history.set(`${THE_FORGE}:${type}`, [])
    })
    const release = env.fake.hold(/\/history$/)
    const all = Promise.all([RAVEN, TRITANIUM, 35].map((t) => env.api.history(THE_FORGE, t)))
    await until(() => env.fake.requests.length === 2)
    await settle()
    expect(env.fake.requests).toHaveLength(2)
    release()
    await all
    expect(env.fake.requests).toHaveLength(3)
    expect(env.fake.peakInFlight).toBe(2)
  })

  it('an interactive caller joining a queued background request moves it to the interactive pool', async () => {
    const env = await makeEnv({ pools: { background: 1 } })
    const release = env.fake.hold(/^\/industry\/systems$/)
    const slow = env.api.industrySystems({ lane: 'background' })
    const background = env.api.prices({ lane: 'background' })
    await until(() => env.fake.count(/^\/industry\/systems$/) === 1)
    const interactive = await env.api.prices()
    expect(env.fake.count(/^\/markets\/prices$/)).toBe(1)
    expect((await background).value).toBe(interactive.value)
    release()
    await slow
    expect(env.fake.count(/^\/markets\/prices$/)).toBe(1)
  })
})

describe('EsiClient: deadlines, abort and stop', () => {
  it('a deadline gives up waiting but the request finishes in the background and fills the cache', async () => {
    const env = await makeEnv()
    const release = env.fake.hold(/^\/status$/)
    const error = await rejection(env.api.serverStatus({ deadlineMs: 30 }))
    expect(error.kind).toBe('deadline')
    release()
    // 第二次调用要么加入还没结束的请求，要么直接用缓存；都不会再发请求
    expect((await env.api.serverStatus()).value.players).toBe(23456)
    expect((await env.api.serverStatus()).cached).toBe(true)
    expect(env.fake.requests).toHaveLength(1)
  })

  it('an aborted caller does not cancel the shared request for the others', async () => {
    const env = await makeEnv()
    const release = env.fake.hold(/^\/status$/)
    const ctrl = new AbortController()
    const leaving = env.api.serverStatus({ signal: ctrl.signal })
    const staying = env.api.serverStatus()
    await until(() => env.fake.requests.length === 1)
    ctrl.abort()
    expect((await rejection(leaving)).kind).toBe('aborted')
    release()
    expect((await staying).value.players).toBe(23456)
    expect(env.fake.requests).toHaveLength(1)
    // 已经中止的 signal 直接失败
    expect((await rejection(env.api.serverStatus({ signal: ctrl.signal }))).kind).toBe('aborted')
  })

  it('stop() aborts what is in flight and refuses new requests', async () => {
    const env = await makeEnv()
    const release = env.fake.hold(/^\/status$/)
    const pending = env.api.serverStatus()
    await until(() => env.fake.requests.length === 1)
    env.client.stop()
    expect((await rejection(pending)).kind).toBe('aborted')
    expect((await rejection(env.api.prices())).kind).toBe('aborted')
    expect(env.fake.count(/^\/markets\/prices$/)).toBe(0)
    release()
  })
})

describe('EsiClient: stale data on errors', () => {
  it('uses data confirmed within staleIfErrorMs and says why', async () => {
    const env = await makeEnv()
    const fresh = await env.api.prices()
    env.clock.advance(2 * 3_600_000)
    env.fake.fault('GET', /^\/markets\/prices$/, { status: 500 }, 2)
    const stale = await env.api.prices()
    expect(stale).toMatchObject({ stale: true, cached: true, value: fresh.value, validatedAt: fresh.validatedAt })
    expect(stale.error).toBeInstanceOf(EsiError)
    expect(stale.error?.status).toBe(500)

    env.clock.advance(INDUSTRY_STALE_HOURS * 3_600_000)
    env.fake.fault('GET', /^\/markets\/prices$/, { status: 500 }, 2)
    expect((await rejection(env.api.prices())).status).toBe(500)
  })

  it('never answers a deadline with stale data', async () => {
    const env = await makeEnv()
    await env.api.prices()
    env.clock.advance(2 * 3_600_000)
    const release = env.fake.hold(/^\/markets\/prices$/)
    expect((await rejection(env.api.prices({ deadlineMs: 20 }))).kind).toBe('deadline')
    release()
  })
})

describe('EsiClient: responses that make no sense', () => {
  it('a body that is not JSON is a bad response, not retried', async () => {
    const env = await makeEnv()
    env.fake.fault('GET', /^\/status$/, { status: 200, raw: '<html>oops</html>' })
    const error = await rejection(env.api.serverStatus({ staleIfErrorMs: 0 }))
    expect(error).toMatchObject({ kind: 'bad-response', status: 200 })
    expect(env.fake.requests).toHaveLength(1)
  })

  it('a body with the wrong fields is a bad response that names the field', async () => {
    const env = await makeEnv()
    env.fake.fault('GET', ORDERS_PATH, { status: 200, body: [{ order_id: 1 }] })
    const error = await rejection(env.api.regionOrders(THE_FORGE, RAVEN, { staleIfErrorMs: 0 }))
    expect(error.kind).toBe('bad-response')
    expect(error.message).toContain('orders[0]')
  })

  it('a response over the size limit is refused', async () => {
    const env = await makeEnv({ maxResponseBytes: 64 }, (f) => f.regionOrders.set(THE_FORGE, forgeOrders(5)))
    const error = await rejection(env.api.regionOrders(THE_FORGE, RAVEN, { staleIfErrorMs: 0 }))
    expect(error).toMatchObject({ kind: 'bad-response', code: 'too-large' })
  })
})

describe('EsiClient: authorized routes and secrets', () => {
  it('sends the bearer token; on 401 refreshes once and retries', async () => {
    const env = await makeEnv({}, (f) => f.structureOrders.set(STRUCTURE, [rawOrder({ location_id: STRUCTURE })]))
    const old = env.fake.issueTokens().access
    env.fake.expire(old)
    const renewed = env.fake.issueTokens().access
    const auth = authFrom(() => (auth.calls.at(-1) ? renewed : old))
    const res = await env.api.structureOrders(STRUCTURE, { auth })
    expect(res.value).toHaveLength(1)
    expect(auth.calls).toEqual([false, true])
    expect(env.fake.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${old}`, `Bearer ${renewed}`])
    expect(env.fake.requests.map((r) => r.status)).toEqual([401, 200])
  })

  it('a second 401 is reported, without the token', async () => {
    const env = await makeEnv({}, (f) => f.structureOrders.set(STRUCTURE, []))
    const token = env.fake.issueTokens().access
    env.fake.expire(token)
    const error = await rejection(env.api.structureOrders(STRUCTURE, { auth: authFrom(() => token) }))
    expect(error).toMatchObject({ kind: 'http', status: 401 })
    expect(env.fake.requests).toHaveLength(2)
  })

  it('a failing token source becomes an auth error', async () => {
    const env = await makeEnv()
    const auth = { profile: 'main', token: async () => { throw new Error('invalid_grant: refresh_token=rt-abcdef123456 rejected') } }
    const error = await rejection(env.api.structureOrders(STRUCTURE, { auth }))
    expect(error.kind).toBe('auth')
    expect(error.message).not.toContain('rt-abcdef123456')
    expect(env.fake.requests).toHaveLength(0)
  })

  it('no token ever reaches an error message or the log', async () => {
    const env = await makeEnv({}, (f) => f.structureOrders.set(STRUCTURE, []))
    const token = env.fake.issueTokens().access
    const auth = authFrom(() => token)
    // ESI 把 token 写进了错误说明
    env.fake.fault('GET', /^\/markets\/structures\//, { status: 403, body: { error: `token ${token} lacks scope` } })
    const forbidden = await rejection(env.api.structureOrders(STRUCTURE, { auth }))
    // 端口的网络错误把请求头带了出来
    const original = env.http.request.bind(env.http)
    let leaky = true
    env.http.request = async (req) => {
      if (leaky && req.headers?.Authorization) {
        leaky = false
        throw new NetworkError('network', `socket hang up; headers: Authorization: ${req.headers.Authorization}`)
      }
      return original(req)
    }
    env.fake.fault('GET', /^\/markets\/structures\//, { status: 503 }, 1)
    const dropped = await rejection(env.api.structureOrders(STRUCTURE, { auth }))

    for (const error of [forbidden, dropped]) {
      expect(error.message).not.toContain(token)
      expect(JSON.stringify(error.info())).not.toContain(token)
      expect(String(error)).not.toContain(token)
    }
    expect(forbidden).toMatchObject({ kind: 'http', status: 403 })
    expect(dropped).toMatchObject({ kind: 'http', status: 503 })
    expect(env.logger.text()).not.toContain(token)
    expect(env.logger.text()).toContain('重试一次')
  })
})
