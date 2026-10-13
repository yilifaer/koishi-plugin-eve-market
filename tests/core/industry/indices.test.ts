// 星系成本指数和调整价：假的 ESI 路由（按调用编排回复）+ 假时钟。星系、物品是公共数据，数值是编造的。

import { afterEach, describe, expect, it } from 'vitest'
import { FAILURE_MEMO_SEC, INDUSTRY_STALE_HOURS, QUERY_DEADLINE_MS } from '../../../src/constants'
import { EsiError } from '../../../src/core/esi'
import type { EsiCallOptions, EsiIndustrySystem, EsiLane, EsiMarketPrice, EsiResult } from '../../../src/core/esi'
import {
  INDICES_REVALIDATE_WAIT_MS, INDICES_WARM_DELAY_MS, INDICES_WARM_SPREAD_MS, adjustedTable, costIndexOf, createIndustryIndices,
  indicesTable,
} from '../../../src/core/industry'
import type { IndicesEsi, IndustryIndices } from '../../../src/core/industry'
import { createModuleStore } from '../../../src/core/ports'
import type { ModuleStore } from '../../../src/core/ports'
import { isFailure } from '../../../src/core/types'
import type { CoreFailure } from '../../../src/core/types'
import { FakeTime, flush } from '../../fakes/fake-time'
import { MemoryLogger } from '../esi/helpers'

const JITA = 30000142
const NIH_02 = 30000900
const TRITANIUM = 34
const PYERITE = 35
const HOUR = 3600_000
const START = Date.UTC(2026, 9, 7, 6, 20)

const SYSTEMS: EsiIndustrySystem[] = [
  { systemId: JITA, costIndices: { manufacturing: 0.0231, reaction: 0.001, invention: 0.05 } },
  { systemId: NIH_02, costIndices: { manufacturing: 0.012 } },
]
const PRICES: EsiMarketPrice[] = [
  { typeId: TRITANIUM, adjustedPrice: 4.12, averagePrice: 4.5 },
  { typeId: PYERITE, adjustedPrice: null, averagePrice: 9 },
]

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  return { promise: new Promise<T>((a, b) => { resolve = a; reject = b }), resolve, reject }
}

type Reply<T> =
  | { value: T; lastModified?: number | null; maxAgeMs?: number; etag?: string; stale?: boolean; validatedAt?: number }
  | { fail: unknown }
  | { wait: Deferred<EsiResult<T>> }

/** 按调用顺序回复；回复用完以后一直用最后一个 */
class FakeApi implements IndicesEsi {
  readonly calls: Array<{ route: 'systems' | 'prices'; lane?: EsiLane }> = []
  systemReplies: Array<Reply<EsiIndustrySystem[]>> = [{ value: SYSTEMS, etag: '"s1"', lastModified: START - 10 * 60_000 }]
  priceReplies: Array<Reply<EsiMarketPrice[]>> = [{ value: PRICES, etag: '"p1"', lastModified: START - 20 * 60_000 }]

  constructor(private readonly now: () => number) {}

  industrySystems(opts: EsiCallOptions = {}) {
    this.calls.push({ route: 'systems', lane: opts.lane })
    return this.reply(this.systemReplies)
  }

  prices(opts: EsiCallOptions = {}) {
    this.calls.push({ route: 'prices', lane: opts.lane })
    return this.reply(this.priceReplies)
  }

  count(route: 'systems' | 'prices') {
    return this.calls.filter((c) => c.route === route).length
  }

  /** 一个可以手动完成的回复 */
  hold<T>(list: Array<Reply<T>>): Deferred<EsiResult<T>> {
    const d = deferred<EsiResult<T>>()
    list.unshift({ wait: d })
    return d
  }

  result<T>(r: Exclude<Reply<T>, { fail: unknown } | { wait: unknown }>): EsiResult<T> {
    const now = this.now()
    const out: EsiResult<T> = {
      value: r.value,
      lastModified: r.lastModified === undefined ? now : r.lastModified,
      expiresAt: (r.validatedAt ?? now) + (r.maxAgeMs ?? HOUR),
      validatedAt: r.validatedAt ?? now,
      cached: false,
      stale: !!r.stale,
    }
    if (r.etag) out.etag = r.etag
    if (r.stale) out.error = new EsiError('http', 'HTTP 503', { route: 'GET /industry/systems', status: 503 })
    return out
  }

  private async reply<T>(list: Array<Reply<T>>): Promise<EsiResult<T>> {
    const r = list.length > 1 ? list.shift()! : list[0]
    if ('fail' in r) throw r.fail
    if ('wait' in r) return r.wait.promise
    return this.result(r)
  }
}

/** 取到了数据（不是失败） */
function got<T>(value: T | CoreFailure): T {
  if (isFailure(value)) throw new Error(`应该取到数据：${value.message}`)
  return value
}

const http503 = () => new EsiError('http', 'HTTP 503', { route: 'GET /industry/systems', status: 503 })

const services: IndustryIndices[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.stop()
})

function setup(opts: { store?: ModuleStore } = {}) {
  const time = new FakeTime(START)
  const api = new FakeApi(() => time.now())
  const logger = new MemoryLogger()
  const make = (store = opts.store) => {
    const service = createIndustryIndices({ esi: api, clock: time, scheduler: time, logger, store, random: () => 0.5 })
    services.push(service)
    return service
  }
  return { time, api, logger, service: make(), make }
}

describe('tables', () => {
  it('keeps manufacturing and reaction indices per system, and adjusted prices that exist', () => {
    const table = indicesTable(SYSTEMS)
    expect(table.get(JITA)).toEqual({ manufacturing: 0.0231, reaction: 0.001 })
    expect(table.get(NIH_02)).toEqual({ manufacturing: 0.012 })
    expect(costIndexOf({ bySystem: table }, JITA, 'reaction')).toBe(0.001)
    expect(costIndexOf({ bySystem: table }, NIH_02, 'reaction')).toBeUndefined()
    expect(costIndexOf({ bySystem: table }, 30000001, 'manufacturing')).toBeUndefined()
    expect([...adjustedTable(PRICES)]).toEqual([[TRITANIUM, 4.12]])
    expect(indicesTable([{ systemId: 1, costIndices: { manufacturing: -1, reaction: Number.NaN } }]).get(1)).toEqual({})
  })
})

describe('IndustryIndices', () => {
  it('fetches both lists once and serves them from memory until they expire', async () => {
    const { time, api, service } = setup()
    expect(service.status()).toEqual({ indicesAt: null, adjustedPricesAt: null })
    const indices = got(await service.systemIndices())
    expect(indices).toMatchObject({ dataTime: START - 10 * 60_000, stale: false })
    expect(indices.bySystem.get(JITA)).toEqual({ manufacturing: 0.0231, reaction: 0.001 })
    const prices = got(await service.adjustedPrices())
    expect([...prices.byType]).toEqual([[TRITANIUM, 4.12]])
    expect(service.status()).toEqual({ indicesAt: START - 10 * 60_000, adjustedPricesAt: START - 20 * 60_000 })

    await time.advance(HOUR - 1)
    await service.systemIndices()
    await service.adjustedPrices()
    expect(api.calls).toEqual([{ route: 'systems', lane: 'interactive' }, { route: 'prices', lane: 'interactive' }])

    // 过期以后再请求；内容没变（同一个 ETag）时沿用转换好的表
    await time.advance(1)
    const again = got(await service.systemIndices())
    expect(api.count('systems')).toBe(2)
    expect(again.bySystem).toBe(indices.bySystem)
  })

  it('converts again when the content changed', async () => {
    const { time, api, service } = setup()
    api.systemReplies = [{ value: SYSTEMS, etag: '"s1"' }, { value: [{ systemId: JITA, costIndices: { manufacturing: 0.03 } }], etag: '"s2"' }]
    await service.systemIndices()
    await time.advance(HOUR)
    const changed = got(await service.systemIndices())
    expect(changed.bySystem.get(JITA)).toEqual({ manufacturing: 0.03 })
    expect(changed).toMatchObject({ dataTime: START + HOUR, stale: false })
  })

  it('asks ESI once for callers that come at the same time', async () => {
    const { api, service } = setup()
    const held = api.hold(api.systemReplies)
    const all = Promise.all([service.systemIndices(), service.systemIndices(), service.systemIndices()])
    await flush()
    held.resolve(api.result({ value: SYSTEMS, etag: '"s1"' }))
    const results = await all
    expect(api.count('systems')).toBe(1)
    expect(results.map((r) => got(r).bySystem.get(JITA)?.manufacturing)).toEqual([0.0231, 0.0231, 0.0231])
  })

  it('serves the old list (marked stale) when the refresh is slow, and the refresh finishes in the background', async () => {
    const { time, api, service } = setup()
    await service.systemIndices()
    await time.advance(HOUR)
    const held = api.hold(api.systemReplies)
    const pending = service.systemIndices()
    await time.advance(INDICES_REVALIDATE_WAIT_MS)
    expect(await pending).toMatchObject({ stale: true, dataTime: START - 10 * 60_000 })
    held.resolve(api.result({ value: SYSTEMS, etag: '"s2"', lastModified: START + HOUR }))
    await flush()
    expect(await service.systemIndices()).toMatchObject({ stale: false, dataTime: START + HOUR })
    expect(api.count('systems')).toBe(2)
  })

  it('falls back to the old list when ESI fails, warns once and does not retry for a while', async () => {
    const { time, api, service, logger } = setup()
    api.systemReplies = [{ value: SYSTEMS, etag: '"s1"' }, { fail: http503() }, { fail: http503() }, { value: SYSTEMS, etag: '"s1"' }]
    await service.systemIndices()
    await time.advance(HOUR)
    expect(await service.systemIndices()).toMatchObject({ stale: true })
    expect(await service.systemIndices()).toMatchObject({ stale: true })
    expect(api.count('systems')).toBe(2)
    await time.advance(FAILURE_MEMO_SEC * 1000)
    expect(await service.systemIndices()).toMatchObject({ stale: true })
    expect(api.count('systems')).toBe(3)
    expect(logger.at('warn')).toEqual(['星系成本指数更新失败，先用旧数据：HTTP 503'])
    await time.advance(FAILURE_MEMO_SEC * 1000)
    expect(await service.systemIndices()).toMatchObject({ stale: false })
    expect(logger.at('info')).toEqual(['星系成本指数恢复更新'])
  })

  it('answers UPSTREAM_UNAVAILABLE when it never had the list', async () => {
    const { time, api, service } = setup()
    api.priceReplies = [{ fail: http503() }]
    expect(await service.adjustedPrices()).toEqual({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: '调整价暂时取不到：HTTP 503' })
    // 刚失败过：不再请求
    expect(await service.adjustedPrices()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    expect(api.count('prices')).toBe(1)
    await time.advance(FAILURE_MEMO_SEC * 1000)
    await service.adjustedPrices()
    expect(api.count('prices')).toBe(2)
  })

  it('waits at most the deadline for the first list; a late answer is kept for the next caller', async () => {
    const { time, api, service } = setup()
    const held = api.hold(api.systemReplies)
    const first = service.systemIndices({ deadlineMs: 2000 })
    await time.advance(2000)
    expect(await first).toEqual({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: '星系成本指数暂时取不到：等不到 ESI 的回复' })
    // 默认的时限
    const second = service.systemIndices()
    await time.advance(QUERY_DEADLINE_MS)
    expect(await second).toMatchObject({ ok: false })
    held.resolve(api.result({ value: SYSTEMS, etag: '"s1"' }))
    await flush()
    expect(await service.systemIndices()).toMatchObject({ stale: false })
    expect(api.count('systems')).toBe(1)
  })

  it('takes a stale answer from the ESI client when it has nothing better, and still counts it as a failure', async () => {
    const { time, api, service } = setup()
    api.systemReplies = [{ value: SYSTEMS, stale: true, validatedAt: START - 2 * HOUR, lastModified: START - 2 * HOUR }]
    expect(await service.systemIndices()).toMatchObject({ stale: true, dataTime: START - 2 * HOUR })
    await time.advance(1000)
    await service.systemIndices()
    expect(api.count('systems')).toBe(1)
  })

  it(`does not use lists older than ${INDUSTRY_STALE_HOURS} hours`, async () => {
    const { time, api, service } = setup()
    api.systemReplies = [{ value: SYSTEMS, etag: '"s1"' }, { fail: http503() }]
    await service.systemIndices()
    await time.advance(INDUSTRY_STALE_HOURS * HOUR + 1)
    expect(await service.systemIndices()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: '星系成本指数暂时取不到：HTTP 503' })
  })

  it('warms both lists in the background a while after start, once', async () => {
    const { time, api, service } = setup()
    service.start()
    service.start()
    const delay = INDICES_WARM_DELAY_MS + INDICES_WARM_SPREAD_MS / 2
    await time.advance(delay - 1)
    expect(api.calls).toEqual([])
    await time.advance(1)
    expect(api.calls).toEqual([{ route: 'systems', lane: 'background' }, { route: 'prices', lane: 'background' }])
    expect(time.pending).toBe(0)
    expect(service.status().indicesAt).not.toBeNull()
  })

  it('an interactive caller joining a background refresh asks ESI again so the request moves to the interactive pool', async () => {
    const { time, api, service } = setup()
    const held = api.hold(api.systemReplies)
    service.start()
    await time.advance(INDICES_WARM_DELAY_MS + INDICES_WARM_SPREAD_MS)
    const pending = service.systemIndices()
    await flush()
    expect(api.calls.filter((c) => c.route === 'systems')).toEqual([{ route: 'systems', lane: 'background' }, { route: 'systems', lane: 'interactive' }])
    held.resolve(api.result({ value: SYSTEMS, etag: '"s1"' }))
    expect(await pending).toMatchObject({ stale: false })
  })

  it('stop cancels the warm-up; stopped services do not ask ESI', async () => {
    const { time, api, service } = setup()
    service.start()
    service.stop()
    expect(time.pending).toBe(0)
    expect(await service.systemIndices()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    expect(api.calls).toEqual([])
  })

  it('keeps the converted lists in the module store across plugin reloads', async () => {
    const store = createModuleStore()
    const { api, service, make } = setup({ store })
    await service.systemIndices()
    service.stop()
    const reloaded = make(store)
    expect(reloaded.status().indicesAt).toBe(START - 10 * 60_000)
    expect(await reloaded.systemIndices()).toMatchObject({ stale: false })
    // 已经有新鲜的：重载后的预取也不请求
    reloaded.start()
    expect(api.count('systems')).toBe(1)
  })
})
