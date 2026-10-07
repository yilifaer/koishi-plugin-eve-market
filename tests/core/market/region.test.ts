import { describe, expect, it } from 'vitest'
import { EsiError } from '../../../src/core/esi'
import type { EsiPagedResult, EsiRegionOrder } from '../../../src/core/esi'
import { RegionSource } from '../../../src/core/market'
import { createModuleStore } from '../../../src/core/ports'
import { FakeTime } from '../../fakes/fake-time'
import { FakeOrdersApi, RAVEN, THE_FORGE, TRITANIUM, deferred, httpError, order } from './helpers'

const MIN = 60_000

function setup() {
  const time = new FakeTime()
  const api = new FakeOrdersApi(() => time.now())
  const source = new RegionSource({ api, clock: time, scheduler: time })
  return { time, api, source }
}

describe('RegionSource', () => {
  it('asks ESI once for many simultaneous readers of the same (region, type)', async () => {
    const { api, source } = setup()
    const wait = deferred<EsiPagedResult<EsiRegionOrder>>()
    api.set(THE_FORGE, RAVEN, { wait })
    const reads = Array.from({ length: 10 }, () => source.read(THE_FORGE, RAVEN, 5000))
    wait.resolve(api.result([order()]))
    const results = await Promise.all(reads)
    expect(api.count(THE_FORGE, RAVEN)).toBe(1)
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(['ok']))
    expect(api.calls[0].opts).toEqual({ lane: 'interactive', staleIfErrorMs: 60 * MIN })
  })

  it('never asks again before the data expires', async () => {
    const { time, api, source } = setup()
    api.set(THE_FORGE, RAVEN, { orders: [order()], expiresAt: time.now() + 5 * MIN })
    expect(source.fresh(THE_FORGE, RAVEN)).toBe(false)
    await source.read(THE_FORGE, RAVEN, 5000)
    expect(source.fresh(THE_FORGE, RAVEN)).toBe(true)
    await time.advance(4 * MIN)
    expect((await source.read(THE_FORGE, RAVEN, 5000)).status).toBe('ok')
    expect(api.count(THE_FORGE, RAVEN)).toBe(1)
    await time.advance(2 * MIN)
    expect(source.fresh(THE_FORGE, RAVEN)).toBe(false)
    await source.read(THE_FORGE, RAVEN, 5000)
    expect(api.count(THE_FORGE, RAVEN)).toBe(2)
  })

  it('gives up waiting at the deadline but lets the request finish into the cache', async () => {
    const { time, api, source } = setup()
    const wait = deferred<EsiPagedResult<EsiRegionOrder>>()
    api.set(THE_FORGE, RAVEN, { wait })
    const read = source.read(THE_FORGE, RAVEN, 1000)
    await time.advance(1000)
    expect(await read).toEqual({ status: 'timeout' })

    wait.resolve(api.result([order({ price: 123 })]))
    await time.advance(0)
    const again = await source.read(THE_FORGE, RAVEN, 1000)
    expect(again.status).toBe('ok')
    expect(again.status === 'ok' && again.book.orders[0].price).toBe(123)
    expect(api.count(THE_FORGE, RAVEN)).toBe(1)
  })

  it('falls back to data up to 60 minutes old on timeout or error', async () => {
    const { time, api, source } = setup()
    const slow = deferred<EsiPagedResult<EsiRegionOrder>>()
    api.set(THE_FORGE, RAVEN, [
      { orders: [order({ price: 100 })], expiresAt: time.now() + 5 * MIN },
      { wait: slow },
      { fail: httpError(503) },
      { fail: httpError(503) },
    ])
    await source.read(THE_FORGE, RAVEN, 1000)
    await time.advance(10 * MIN)

    const timedOut = source.read(THE_FORGE, RAVEN, 1000)
    await time.advance(1000)
    const t = await timedOut
    expect(t.status).toBe('stale')
    expect(t.status === 'stale' && [t.book.orders[0].price, t.error]).toEqual([100, undefined])
    // 慢的那个请求后来失败了；下一次重新请求
    slow.reject(httpError(504))
    await time.advance(0)

    const failed = await source.read(THE_FORGE, RAVEN, 1000)
    expect(failed).toMatchObject({ status: 'stale', error: { status: 503, route: 'GET /markets/{region_id}/orders' } })

    await time.advance(60 * MIN)
    expect(await source.read(THE_FORGE, RAVEN, 1000)).toMatchObject({ status: 'unavailable', error: { status: 503 } })
  })

  it('uses the stale copy the ESI client fell back to, unless it already has a newer one', async () => {
    const { time, api, source } = setup()
    const error = new EsiError('http', 'HTTP 502', { route: 'GET /markets/{region_id}/orders', status: 502 })
    api.set(TRITANIUM, RAVEN, { orders: [order({ price: 7 })], stale: true, error, validatedAt: time.now() - 20 * MIN })
    const r = await source.read(TRITANIUM, RAVEN, 1000)
    expect(r).toMatchObject({ status: 'stale', error: { status: 502 } })
    expect(r.status === 'stale' && r.book.validatedAt).toBe(time.now() - 20 * MIN)

    api.set(THE_FORGE, RAVEN, [
      { orders: [order({ price: 9 })], expiresAt: time.now() + MIN },
      { orders: [order({ price: 8 })], stale: true, error, validatedAt: time.now() - 30 * MIN },
    ])
    await source.read(THE_FORGE, RAVEN, 1000)
    await time.advance(2 * MIN)
    const newer = await source.read(THE_FORGE, RAVEN, 1000)
    expect(newer.status === 'stale' && newer.book.orders[0].price).toBe(9)
  })

  it('a background read uses the background lane; an interactive reader joining it asks on its own so ESI can promote it', async () => {
    const { api, source } = setup()
    const wait = deferred<EsiPagedResult<EsiRegionOrder>>()
    api.set(THE_FORGE, RAVEN, [{ wait }, { orders: [order({ price: 5 })] }])
    const background = source.read(THE_FORGE, RAVEN, 5000, 'background')
    const again = source.read(THE_FORGE, RAVEN, 5000, 'background')
    const interactive = await source.read(THE_FORGE, RAVEN, 5000)
    expect(api.calls.map((c) => c.opts.lane)).toEqual(['background', 'interactive'])
    expect(interactive.status).toBe('ok')
    wait.resolve(api.result([order({ price: 5 })]))
    expect((await background).status).toBe('ok')
    expect((await again).status).toBe('ok')
  })

  it('keeps the last orders in the module store, so a reloaded source still has a fallback', async () => {
    const time = new FakeTime()
    const api = new FakeOrdersApi(() => time.now())
    const store = createModuleStore()
    const first = new RegionSource({ api, clock: time, scheduler: time, store })
    api.set(THE_FORGE, RAVEN, { orders: [order({ price: 100 })], expiresAt: time.now() + 5 * MIN })
    await first.read(THE_FORGE, RAVEN, 1000)
    await time.advance(10 * MIN)

    // 插件重载：新的 RegionSource，同一个模块级存储；ESI 卡住
    const reloaded = new RegionSource({ api, clock: time, scheduler: time, store })
    api.set(THE_FORGE, RAVEN, { wait: deferred<EsiPagedResult<EsiRegionOrder>>() })
    const read = reloaded.read(THE_FORGE, RAVEN, 1000)
    await time.advance(1000)
    const r = await read
    expect(r.status).toBe('stale')
    expect(r.status === 'stale' && r.book.orders[0].price).toBe(100)
    // 不给存储时各自一份
    const alone = new RegionSource({ api, clock: time, scheduler: time })
    expect(alone.fresh(THE_FORGE, RAVEN)).toBe(false)
  })

  it('reports errors that are not from ESI safely', async () => {
    const { api, source } = setup()
    api.regionOrders = async () => { throw new RangeError('regionId 应该是正整数：0') }
    expect(await source.read(0, RAVEN, 1000)).toEqual({ status: 'unavailable', error: { message: 'regionId 应该是正整数：0' } })
  })
})
