// 建筑市场整站同步：真的 ESI 客户端 + 进程内的假 ESI（只有建筑市场的路由）+ 假时钟。
// 建筑 ID、星系 ID、名字都是编造的。

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { EsiApi, EsiClient, EsiError } from '../../../src/core/esi'
import type { EsiAuth } from '../../../src/core/esi'
import { createMarketService, createStructureMarkets } from '../../../src/core/market'
import type { ManagedStructureSource, ProfileChange, StructureAuth, StructureSource } from '../../../src/core/market'
import { createModuleStore } from '../../../src/core/ports'
import type { AuthStatus, HttpClient, HttpRequest, HttpResponse, ModuleStore } from '../../../src/core/ports'
import type { MarketDef } from '../../../src/core/types'
import { rawOrder } from '../../fakes/fake-esi'
import type { RawOrder } from '../../fakes/fake-esi'
import { FakeTime } from '../../fakes/fake-time'
import { MemoryBlobCache, MemoryLogger } from '../esi/helpers'
import { FakeOrdersApi, RAVEN, STRUCTURE_A, STRUCTURE_B, THE_FORGE, TRITANIUM, deferred, order } from './helpers'
import type { Deferred } from './helpers'

const MIN = 60_000
const HOUR = 60 * MIN
const TOKEN = 'structure-access-token-0123456789'
const ROTATED = 'structure-access-token-rotated-42'
const SYSTEM_XX1 = 30_000_201
const JITA_4_4 = 60003760

function marketDef(name: string, id: number, extra: Partial<MarketDef> = {}): MarketDef {
  return {
    key: name.toLowerCase(), name, aliases: [], shortAlias: name, type: 'structure', regionId: null, locationId: id,
    inDefaultList: true, sortOrder: 0, visibility: 'allowed', authProfile: 'default', ...extra,
  }
}

// 控制台里一般都填了建筑所在星系
const MARKET_A = marketDef('联盟市场A', STRUCTURE_A, { systemId: SYSTEM_XX1 })
const MARKET_B = marketDef('联盟市场B', STRUCTURE_B, { systemId: SYSTEM_XX1 })

const raw = (o: Partial<RawOrder> = {}) => rawOrder({ location_id: STRUCTURE_A, ...o })

// ------------------------------------------------------------------ 进程内的假 ESI

interface Logged {
  path: string
  page: number
  status: number
  ifNoneMatch?: string
}

function response(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { status, header: (name) => lower.get(name.toLowerCase()), body: Buffer.from(body) }
}

/**
 * 建筑市场的分页（X-Pages、ETag、304、Cache-Control）、授权（401）、403、故障和卡住的请求。
 * 和 ESI 一样：ETag 只看内容，Last-Modified 是这一轮缓存生成的时间（数据改了以后更晚）
 */
class StructureEsi implements HttpClient {
  readonly log: Logged[] = []
  pageSize = 2
  maxAge = 300
  readonly tokens = new Set<string>([TOKEN])
  readonly forbidden = new Set<number>()
  readonly info = new Map<number, { name: string; owner_id: number; solar_system_id: number }>()
  /** 在回复之前调用（可以在这里改数据，模拟翻页途中数据更新） */
  beforeRespond: ((id: number, page: number) => void) | null = null
  private readonly books = new Map<number, { orders: RawOrder[]; modified: number }>()
  private readonly faults = new Map<number, Array<{ status: number; body: string }>>()
  private readonly holds = new Map<number, Deferred<void>>()

  constructor(private readonly now: () => number) {}

  set(id: number, orders: RawOrder[]) {
    const old = this.books.get(id)?.modified ?? 0
    this.books.set(id, { orders, modified: Math.max(Math.floor(this.now() / 1000) * 1000, old + 1000) })
  }

  /** 接下来 times 次请求这个建筑都回 status */
  fail(id: number, status: number, times = 1, body = JSON.stringify({ error: 'Internal server error' })) {
    const list = this.faults.get(id) ?? []
    for (let i = 0; i < times; i++) list.push({ status, body })
    this.faults.set(id, list)
  }

  /** 这个建筑的请求一直等到 release() */
  hold(id: number): () => void {
    const gate = deferred<void>()
    this.holds.set(id, gate)
    return () => {
      this.holds.delete(id)
      gate.resolve()
    }
  }

  clearFaults() {
    this.faults.clear()
  }

  count(id: number) {
    return this.log.filter((l) => l.path === `/markets/structures/${id}`).length
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url)
    const page = Number(url.searchParams.get('page') ?? 1)
    const entry: Logged = { path: url.pathname, page, status: 0 }
    const etag = req.headers?.['If-None-Match']
    if (etag) entry.ifNoneMatch = etag
    this.log.push(entry)
    const bearer = req.headers?.Authorization?.replace(/^Bearer /, '')
    const reply = (status: number, body: string, headers?: Record<string, string>) => {
      entry.status = status
      return response(status, body, headers)
    }
    if (!bearer || !this.tokens.has(bearer)) return reply(401, JSON.stringify({ error: 'authentication failure' }))

    let m = /^\/universe\/structures\/(\d+)$/.exec(url.pathname)
    if (m) {
      const info = this.info.get(Number(m[1]))
      return info ? reply(200, JSON.stringify(info), { 'Cache-Control': 'max-age=86400' }) : reply(403, JSON.stringify({ error: 'Forbidden' }))
    }
    m = /^\/markets\/structures\/(\d+)$/.exec(url.pathname)
    if (!m) return reply(404, JSON.stringify({ error: 'Not found' }))
    const id = Number(m[1])
    const gate = this.holds.get(id)
    if (gate) await gate.promise
    this.beforeRespond?.(id, page)
    const fault = this.faults.get(id)?.shift()
    if (fault) return reply(fault.status, fault.body)
    if (this.forbidden.has(id)) return reply(403, JSON.stringify({ error: 'Market access denied' }))
    const book = this.books.get(id) ?? { orders: [], modified: Math.floor(this.now() / 1000) * 1000 - MIN }
    const pages = Math.max(1, Math.ceil(book.orders.length / this.pageSize))
    if (page < 1 || page > pages) return reply(404, JSON.stringify({ error: 'Requested page does not exist!' }))
    const rows = book.orders.slice((page - 1) * this.pageSize, page * this.pageSize).map(({ system_id: _, ...o }) => o)
    const body = JSON.stringify(rows)
    const tag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`
    const window = this.maxAge * 1000
    const modified = Math.max(book.modified, Math.floor(this.now() / window) * window)
    const headers = {
      ETag: tag,
      'Last-Modified': new Date(modified).toUTCString(),
      'Cache-Control': `public, max-age=${this.maxAge}`,
      'X-Pages': String(pages),
    }
    return etag === tag ? reply(304, '', headers) : reply(200, body, headers)
  }
}

// ------------------------------------------------------------------ 假的授权档案

class FakeAuth implements StructureAuth {
  status: AuthStatus = 'OK'
  reason = '还没有授权'
  token = TOKEN
  /** 强制刷新（ESI 回了 401）时换成这个；null = 刷新后还是原来的 */
  refreshed: string | null = null
  readonly calls: boolean[] = []
  private readonly listeners = new Set<(change: ProfileChange) => void>()

  esiAuth(profile: string): EsiAuth {
    return {
      profile,
      token: async (force: boolean) => {
        this.calls.push(force)
        if (this.status !== 'OK') throw new EsiError('auth', `授权档案 ${profile}：${this.reason}`, { route: 'SSO', code: this.status })
        if (force && this.refreshed) this.token = this.refreshed
        return this.token
      },
    }
  }

  onChange(listener: (change: ProfileChange) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(change: ProfileChange) {
    for (const listener of this.listeners) listener(change)
  }
}

// ------------------------------------------------------------------ 环境

const clients: EsiClient[] = []
const sources: ManagedStructureSource[] = []

afterEach(() => {
  for (const s of sources.splice(0)) s.stop()
  for (const c of clients.splice(0)) c.stop()
})

interface BuildOptions {
  store?: ModuleStore
  random?: () => number
}

function world(markets: MarketDef[] = [MARKET_A, MARKET_B]) {
  const time = new FakeTime()
  const http = new StructureEsi(() => time.now())
  const logger = new MemoryLogger()
  const cache = new MemoryBlobCache()
  const auth = new FakeAuth()
  const located: Array<[string, number]> = []
  const registry = {
    all: () => markets,
    get: (key: string) => markets.find((m) => m.key === key),
    locateStructure: (key: string, systemId: number) => {
      located.push([key, systemId])
      return true
    },
  }
  /** 一个新的插件实例（新的 ESI 客户端）；store 相同 = 重载，不同 = 重启 */
  const build = (o: BuildOptions = {}) => {
    const store = o.store ?? createModuleStore()
    const client = new EsiClient(
      { http, clock: time, scheduler: time, logger, cache, store, version: '0.0.2' },
      { base: 'https://esi.test', retryDelayMs: { min: 0, max: 0 }, random: () => 0 },
    )
    clients.push(client)
    const source = createStructureMarkets({
      esi: new EsiApi(client), auth, registry, cache, clock: time, scheduler: time, logger, store: o.store, random: o.random ?? (() => 0),
    })
    sources.push(source)
    return source
  }
  /** 插件停用：停掉同步和它的 ESI 客户端 */
  const stop = (source: ManagedStructureSource) => {
    source.stop()
    clients.at(sources.indexOf(source))?.stop()
  }
  const service = (structures: StructureSource) =>
    createMarketService({ registry, esi: new FakeOrdersApi(() => time.now()), clock: time, scheduler: time, logger, structures })
  return { time, http, logger, cache, auth, located, registry, build, stop, service }
}

/** 一个建筑的价格，按订单簿里的顺序：卖单升序，买单降序 */
function prices(source: StructureSource, market: MarketDef, typeId: number) {
  const read = source.read(market, typeId)
  return 'orders' in read ? read.orders.map((o) => `${o.isBuyOrder ? 'buy' : 'sell'} ${o.price}`) : read.status
}

function standardBook() {
  return [
    raw({ price: 270 }),
    raw({ price: 260, volume_remain: 2 }),
    raw({ is_buy_order: true, price: 240, range: 'station' }),
    raw({ is_buy_order: true, price: 250, min_volume: 20, range: 'station' }),
    raw({ type_id: TRITANIUM, price: 4 }),
    // 不在这个建筑里的订单不算
    raw({ price: 100, location_id: JITA_4_4 }),
  ]
}

// ------------------------------------------------------------------ 测试

describe('structure sync: the order book', () => {
  it('reads every page with the profile token and indexes the orders by type, sorted', async () => {
    const w = world()
    w.http.set(STRUCTURE_A, standardBook())
    const source = w.build()
    await source.start()
    await w.time.advance(0)

    expect(w.http.log.map((l) => [l.path, l.page, l.status])).toEqual([
      ...[1, 2, 3].map((n) => [`/markets/structures/${STRUCTURE_A}`, n, 200]),
      [`/markets/structures/${STRUCTURE_B}`, 1, 200],
    ])
    expect(w.auth.calls.every((force) => !force)).toBe(true)
    expect(prices(source, MARKET_A, RAVEN)).toEqual(['sell 100', 'sell 260', 'sell 270', 'buy 250', 'buy 240'])
    expect(prices(source, MARKET_A, TRITANIUM)).toEqual(['sell 4'])
    expect(prices(source, MARKET_A, 35)).toEqual([])
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok', dataTime: Math.floor(w.time.now() / 1000) * 1000 })
    expect(source.available(MARKET_A)).toEqual({ status: 'ok' })
    expect(source.status(MARKET_A)).toEqual({
      marketKey: '联盟市场a', name: '联盟市场A', type: 'structure', source: 'structure', authProfile: 'default',
      state: 'OK', paused: false, lastRequestAt: null, lastSyncAt: w.time.now(), lastSuccessAt: w.time.now(),
      lastError: null, lastErrorAt: null, pages: 3, orders: 6,
    })
    expect(w.logger.at('info')).toContain('建筑市场「联盟市场A」第一次同步完成：3 页 6 单')
  })

  it('quotes through the market service: sell min and buy max located in the structure', async () => {
    const w = world()
    w.http.set(STRUCTURE_A, standardBook())
    const source = w.build()
    const service = w.service(source)
    await source.start()
    await w.time.advance(2 * MIN)

    expect(await service.getQuote('联盟市场a', RAVEN)).toEqual({
      marketKey: '联盟市场a', typeId: RAVEN, source: 'structure', status: 'ok',
      sell: { best: 260, volumeAtBest: 2, orders: 2, totalVolume: 5, volumeNear: 5 },
      buy: { best: 240, volumeAtBest: 3, orders: 1, totalVolume: 3, volumeNear: 3 },
      mid: 250,
      dataTime: Math.floor((w.time.now() - 2 * MIN) / 1000) * 1000,
      ageSec: 120,
    })
    expect((await service.getQuote('联盟市场a', RAVEN, { qty: 20 })).buy?.best).toBe(250)
    const quotes = await service.getQuotes('联盟市场a', [{ typeId: TRITANIUM, qty: 1 }, { typeId: 35, qty: 1 }])
    expect(quotes.get(TRITANIUM)).toMatchObject({ status: 'ok', sell: { best: 4 }, buy: null, mid: null })
    expect(quotes.get(35)).toMatchObject({ status: 'ok', sell: null, buy: null })
    expect(service.sources().find((s) => s.marketKey === '联盟市场a')).toMatchObject({ state: 'OK', pages: 3, orders: 6, lastRequestAt: w.time.now() })
    // 查价只读内存：没有多发请求
    expect(w.http.count(STRUCTURE_A)).toBe(3)
  })

  it('a structure market without an auth profile reads its public orders from the region instead', async () => {
    const open = marketDef('公开建筑', STRUCTURE_B, { authProfile: undefined, regionId: THE_FORGE })
    const w = world([open])
    const source = w.build()
    const api = new FakeOrdersApi(() => w.time.now())
    api.set(THE_FORGE, RAVEN, { orders: [order({ price: 245, locationId: STRUCTURE_B }), order({ price: 200 })] })
    const service = createMarketService({ registry: w.registry, esi: api, clock: w.time, scheduler: w.time, logger: w.logger, structures: source })
    expect(await service.getQuote('公开建筑', RAVEN)).toMatchObject({ source: 'region', status: 'ok', sell: { best: 245 } })
    await source.start()
    await w.time.advance(MIN)
    expect(w.http.log).toEqual([])
  })

  it('pages changing during the walk are fetched again from page 1, so the book is consistent', async () => {
    const w = world([MARKET_A])
    w.http.set(STRUCTURE_A, standardBook())
    let changed = false
    w.http.beforeRespond = (_id, page) => {
      if (page !== 2 || changed) return
      changed = true
      w.http.set(STRUCTURE_A, [...standardBook().slice(1), raw({ price: 255 })])
    }
    const source = w.build()
    await source.start()
    await w.time.advance(0)
    // 第 2、3 页已经是新数据，只有第 1 页要重取
    expect(w.http.log.map((l) => l.page)).toEqual([1, 2, 3, 1])
    expect(prices(source, MARKET_A, RAVEN)).toEqual(['sell 100', 'sell 255', 'sell 260', 'buy 250', 'buy 240'])
    expect(source.status(MARKET_A)).toMatchObject({ state: 'OK', pages: 3, orders: 6 })
  })

  it('learns the structure system once when the console left it empty, and remembers it', async () => {
    const lost = marketDef('联盟市场A', STRUCTURE_A)
    const w = world([lost, MARKET_B])
    w.http.info.set(STRUCTURE_A, { name: 'XX-1 - 联盟市场A', owner_id: 98_000_001, solar_system_id: SYSTEM_XX1 })
    w.http.set(STRUCTURE_A, standardBook())
    const source = w.build()
    await source.start()
    await w.time.advance(10 * MIN)
    expect(w.located).toEqual([['联盟市场a', SYSTEM_XX1]])
    const lookups = () => w.http.log.filter((l) => l.path.startsWith('/universe/structures/')).length
    expect(lookups()).toBe(1)
    await source.flush()
    w.stop(source)

    const again = w.build({ store: createModuleStore() })
    await again.start()
    expect(w.located).toEqual([['联盟市场a', SYSTEM_XX1], ['联盟市场a', SYSTEM_XX1]])
    await w.time.advance(10 * MIN)
    expect(lookups()).toBe(1)
  })
})

describe('structure sync: schedule and the ESI cache rules', () => {
  it('next sync = max(ESI expiry, finish + 5 minutes) + jitter, with ETags', async () => {
    const w = world([MARKET_A])
    w.http.set(STRUCTURE_A, standardBook())
    w.http.maxAge = 600
    const source = w.build()
    await source.start()
    await w.time.advance(0)
    expect(w.http.count(STRUCTURE_A)).toBe(3)
    await w.time.advance(10 * MIN - 1)
    expect(w.http.count(STRUCTURE_A)).toBe(3)
    await w.time.advance(1)
    expect(w.http.log.slice(3).map((l) => [l.status, !!l.ifNoneMatch])).toEqual([[304, true], [304, true], [304, true]])
    expect(source.status(MARKET_A)).toMatchObject({ state: 'OK', lastSuccessAt: w.time.now(), orders: 6 })

    // 过期时间比 5 分钟短：按完成后 5 分钟；随机抖动 0–30 秒
    const v = world([MARKET_A])
    v.http.set(STRUCTURE_A, standardBook())
    v.http.maxAge = 60
    const jittered = v.build({ random: () => 0.5 })
    await jittered.start()
    await v.time.advance(15_000)
    expect(v.http.count(STRUCTURE_A)).toBe(3)
    await v.time.advance(5 * MIN + 14_999)
    expect(v.http.count(STRUCTURE_A)).toBe(3)
    await v.time.advance(1)
    expect(v.http.count(STRUCTURE_A)).toBe(6)
  })

  it('pages go to the blob cache as ESI rows; a restart rebuilds the book and waits for the expiry', async () => {
    const w = world([MARKET_A])
    w.http.set(STRUCTURE_A, standardBook())
    const first = w.build()
    await first.start()
    await w.time.advance(MIN)
    await first.flush()
    expect([...w.cache.entries.keys()].filter((k) => k.startsWith('structures/')).sort()).toEqual([
      `structures/${STRUCTURE_A}/page-1`, `structures/${STRUCTURE_A}/page-2`, `structures/${STRUCTURE_A}/page-3`, `structures/${STRUCTURE_A}/state`,
    ])
    expect((w.cache.json(`structures/${STRUCTURE_A}/page-1`) as Array<Record<string, unknown>>)[0]).toMatchObject({ order_id: expect.any(Number), is_buy_order: false, price: 270 })
    w.stop(first)

    // 重启：新的模块级存储，只有文件缓存
    const second = w.build({ store: createModuleStore() })
    await second.start()
    expect(prices(second, MARKET_A, RAVEN)).toEqual(['sell 100', 'sell 260', 'sell 270', 'buy 250', 'buy 240'])
    expect(second.status(MARKET_A)).toMatchObject({ state: 'OK', pages: 3, orders: 6, lastSuccessAt: w.time.now() - MIN })
    const page1 = w.cache.entries.get(`structures/${STRUCTURE_A}/page-1`)
    const state = w.cache.entries.get(`structures/${STRUCTURE_A}/state`)
    await w.time.advance(4 * MIN - 1)
    expect(w.http.count(STRUCTURE_A)).toBe(3)
    await w.time.advance(1)
    // 过期了：带上次的 ETag，304 不重写分页，只更新整份的记录
    expect(w.http.log.slice(3).map((l) => [l.status, !!l.ifNoneMatch])).toEqual([[304, true], [304, true], [304, true]])
    await second.flush()
    expect(w.cache.entries.get(`structures/${STRUCTURE_A}/page-1`)).toBe(page1)
    expect(w.cache.entries.get(`structures/${STRUCTURE_A}/state`)).not.toBe(state)
    expect(second.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
  })

  it('a reload keeps the book in module memory and does not fetch before the expiry', async () => {
    const w = world([MARKET_A])
    w.http.set(STRUCTURE_A, standardBook())
    const store = createModuleStore()
    const first = w.build({ store })
    await first.start()
    await w.time.advance(2 * MIN)
    w.stop(first)
    const second = w.build({ store })
    // 不用等缓存：马上就能读
    expect(second.read(MARKET_A, TRITANIUM)).toMatchObject({ status: 'ok' })
    await second.start()
    await w.time.advance(3 * MIN - 1)
    expect(w.http.count(STRUCTURE_A)).toBe(3)
    await w.time.advance(1)
    expect(w.http.count(STRUCTURE_A)).toBe(6)
  })

  it('fewer pages remove the extra files; a broken cache is ignored and synced again', async () => {
    const w = world([MARKET_A])
    w.http.set(STRUCTURE_A, standardBook())
    const first = w.build()
    await first.start()
    await w.time.advance(0)
    w.http.set(STRUCTURE_A, standardBook().slice(0, 3))
    await w.time.advance(5 * MIN)
    await first.flush()
    expect(first.status(MARKET_A)).toMatchObject({ pages: 2, orders: 3 })
    expect(w.cache.entries.has(`structures/${STRUCTURE_A}/page-3`)).toBe(false)
    w.stop(first)

    const page2 = w.cache.entries.get(`structures/${STRUCTURE_A}/page-2`)!
    page2.meta.tag = '"not-the-same"'
    const second = w.build({ store: createModuleStore() })
    await second.start()
    expect(second.read(MARKET_A, RAVEN)).toEqual({ status: 'not_ready', reason: 'first_sync' })
    expect(w.logger.at('warn').some((t) => t.includes(`建筑 ${STRUCTURE_A} 的订单缓存不完整`))).toBe(true)
    await w.time.advance(0)
    expect(second.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
  })
})

describe('structure sync: pause after a day without queries, and touch()', () => {
  /** 同步一天没人查，暂停（从开始算，最后一次成功在 23:55，ESI 过期在 24:00），再过 afterMs */
  async function pausedWorld(afterMs = 6 * HOUR) {
    const w = world([MARKET_A])
    w.http.pageSize = 100
    w.http.set(STRUCTURE_A, standardBook())
    const source = w.build()
    const start = w.time.now()
    await source.start()
    await w.time.advance(24 * HOUR - 1)
    const before = w.http.count(STRUCTURE_A)
    expect(before).toBe(288)
    await w.time.advance(1)
    expect(source.status(MARKET_A)).toMatchObject({ paused: true, state: 'OK', lastSuccessAt: start + 24 * HOUR - 5 * MIN })
    expect(w.logger.at('info')).toContain('建筑市场「联盟市场A」24 小时没人查，同步暂停（有人查时自动恢复）')
    await w.time.advance(afterMs)
    expect(w.http.count(STRUCTURE_A)).toBe(before)
    return { ...w, source, start, before }
  }

  it('data up to 60 minutes old is used directly; the sync resumes in the background', async () => {
    const w = await pausedWorld(30 * MIN)
    const release = w.http.hold(STRUCTURE_A)
    // 卡住的同步也不等
    await w.source.touch(MARKET_A, 6000)
    expect(w.source.status(MARKET_A).paused).toBe(false)
    expect(w.source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
    await w.time.advance(0)
    expect(w.http.count(STRUCTURE_A)).toBe(w.before + 1)
    release()
    await w.time.advance(0)
    expect(w.source.status(MARKET_A)).toMatchObject({ state: 'OK', lastSuccessAt: w.time.now() })
  })

  it('older data: waits for the resumed sync', async () => {
    const w = await pausedWorld()
    const release = w.http.hold(STRUCTURE_A)
    let done = false
    const touched = w.source.touch(MARKET_A, 6000).then(() => {
      done = true
    })
    await w.time.advance(1000)
    expect(done).toBe(false)
    release()
    await touched
    expect(w.source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
    expect(w.http.count(STRUCTURE_A)).toBe(w.before + 1)
  })

  it('older data and the sync is slow: old prices marked refreshing, the quote does not wait longer', async () => {
    const w = await pausedWorld()
    const service = w.service(w.source)
    const release = w.http.hold(STRUCTURE_A)
    const pending = service.getQuote('联盟市场a', RAVEN)
    await w.time.advance(6000)
    expect(await pending).toMatchObject({ status: 'stale', reason: 'refreshing', sell: { best: 260 }, ageSec: 6 * 3600 + 5 * 60 + 6 })
    expect(w.source.available(MARKET_A)).toEqual({ status: 'stale', reason: 'refreshing' })
    release()
    await w.time.advance(0)
    expect(await service.getQuote('联盟市场a', RAVEN)).toMatchObject({ status: 'ok', sell: { best: 260 } })
  })

  it('more than 24 hours old: not shown, says it is syncing', async () => {
    const w = await pausedWorld()
    await w.time.advance(18 * HOUR)
    const release = w.http.hold(STRUCTURE_A)
    const touched = w.source.touch(MARKET_A, 6000)
    await w.time.advance(6000)
    await touched
    expect(w.source.read(MARKET_A, RAVEN)).toEqual({ status: 'not_ready', reason: 'resyncing' })
    expect(w.source.available(MARKET_A)).toEqual({ status: 'not_ready', reason: 'resyncing' })
    release()
    await w.time.advance(0)
    expect(w.source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
  })

  it('queries keep it running', async () => {
    const w = world([MARKET_A])
    w.http.pageSize = 100
    const source = w.build()
    await source.start()
    for (let i = 0; i < 6; i++) {
      await w.time.advance(5 * HOUR)
      await source.touch(MARKET_A, 6000)
    }
    expect(source.status(MARKET_A)).toMatchObject({ paused: false, state: 'OK', lastRequestAt: w.time.now() })
  })
})

describe('structure sync: states', () => {
  it('needs authorization until the profile is authorized, then syncs right away', async () => {
    const w = world()
    w.auth.status = 'NEEDS_AUTH'
    w.http.set(STRUCTURE_A, standardBook())
    const source = w.build()
    await source.start()
    await w.time.advance(0)
    expect(source.read(MARKET_A, RAVEN)).toEqual({ status: 'not_ready', reason: 'needs_auth', detail: 'SSO: 授权档案 default：还没有授权' })
    expect(source.available(MARKET_A)).toEqual({ status: 'not_ready', reason: 'needs_auth' })
    expect(source.status(MARKET_A)).toMatchObject({ state: 'NEEDS_AUTH', pages: null, orders: null, lastError: { route: 'SSO', code: 'NEEDS_AUTH' } })
    expect(w.http.log).toEqual([])
    expect(w.logger.at('warn')).toEqual([])

    w.auth.status = 'OK'
    w.auth.emit({ profile: 'other', status: 'OK' })
    await w.time.advance(0)
    expect(w.http.log).toEqual([])
    w.auth.emit({ profile: 'default', status: 'OK' })
    await w.time.advance(0)
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
    expect(source.status(MARKET_B)).toMatchObject({ state: 'OK', orders: 0, pages: 1 })
  })

  it('before the first sync, a profile that cannot be used shows its own state at once', async () => {
    const w = world([MARKET_A])
    w.http.set(STRUCTURE_A, standardBook())
    const profiles: Record<string, AuthStatus> = { default: 'NEEDS_AUTH' }
    Object.assign(w.auth, { profile: (name: string) => profiles[name] ? { status: profiles[name] } : undefined })
    w.auth.status = 'NEEDS_AUTH'
    const source = w.build()
    // 还没同步过：不用等第一次同步失败，直接按档案的状态
    expect(source.status(MARKET_A).state).toBe('NEEDS_AUTH')
    expect(source.read(MARKET_A, RAVEN)).toEqual({ status: 'not_ready', reason: 'needs_auth' })
    profiles.default = 'AUTH_ERROR'
    expect(source.available(MARKET_A)).toEqual({ status: 'auth_error', reason: 'auth' })
    // 只是暂时刷新不了：照常等第一次同步
    profiles.default = 'DEGRADED'
    expect(source.status(MARKET_A).state).toBe('FIRST_SYNC')

    profiles.default = 'OK'
    w.auth.status = 'OK'
    await source.start()
    await w.time.advance(0)
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
    // 有了订单簿以后由同步结果和档案的变化通知决定，不再看这里
    profiles.default = 'NEEDS_AUTH'
    expect(source.status(MARKET_A).state).toBe('OK')
  })

  it('401: the client refreshes the token once; still 401 is an auth error, and the book is never shown', async () => {
    const w = world([MARKET_A])
    w.http.set(STRUCTURE_A, standardBook())
    w.http.tokens.clear()
    w.http.tokens.add(ROTATED)
    w.auth.refreshed = ROTATED
    const source = w.build()
    await source.start()
    await w.time.advance(0)
    expect(w.auth.calls.slice(0, 2)).toEqual([false, true])
    expect(w.auth.calls.filter((force) => force)).toEqual([true])
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })

    // 档案给的 token 被拒、刷新后还是被拒
    w.http.tokens.clear()
    await w.time.advance(5 * MIN)
    expect(source.read(MARKET_A, RAVEN)).toEqual({ status: 'auth_error', reason: 'auth', detail: 'GET /markets/structures/{structure_id} HTTP 401: authentication failure' })
    expect(source.available(MARKET_A)).toEqual({ status: 'auth_error', reason: 'auth' })
    expect(source.status(MARKET_A)).toMatchObject({ state: 'AUTH_ERROR', lastError: { status: 401 }, orders: 6 })
    expect(w.logger.at('warn')).toEqual(['建筑市场「联盟市场A」授权或停靠权限异常，暂停显示价格：GET /markets/structures/{structure_id} HTTP 401: authentication failure'])
  })

  it('403 on one structure: only that one is affected, backing off 15, 30, 60 minutes', async () => {
    const w = world()
    w.http.set(STRUCTURE_A, standardBook())
    w.http.forbidden.add(STRUCTURE_B)
    const source = w.build()
    const service = w.service(source)
    await source.start()
    await w.time.advance(0)
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
    expect(await service.getQuote('联盟市场b', RAVEN)).toMatchObject({
      status: 'auth_error', reason: 'auth', sell: null, detail: 'GET /markets/structures/{structure_id} HTTP 403: Market access denied',
    })
    expect((await service.getQuote('联盟市场a', RAVEN)).status).toBe('ok')

    const attempts = async (ms: number) => {
      await w.time.advance(ms)
      return w.http.count(STRUCTURE_B)
    }
    expect(await attempts(15 * MIN - 1)).toBe(1)
    expect(await attempts(1)).toBe(2)
    expect(await attempts(30 * MIN - 1)).toBe(2)
    expect(await attempts(1)).toBe(3)
    expect(await attempts(60 * MIN - 1)).toBe(3)
    expect(await attempts(1)).toBe(4)
    expect(await attempts(60 * MIN)).toBe(5)
    expect(w.logger.at('warn')).toEqual(['建筑市场「联盟市场B」授权或停靠权限异常，暂停显示价格：GET /markets/structures/{structure_id} HTTP 403: Market access denied'])
    expect(source.status(MARKET_A)).toMatchObject({ state: 'OK', lastError: null })

    // 访问权限恢复：下一次退避到点时恢复正常
    w.http.forbidden.delete(STRUCTURE_B)
    await w.time.advance(60 * MIN)
    expect(source.status(MARKET_B)).toMatchObject({ state: 'OK', orders: 0 })
    expect(w.logger.at('info')).toContain('建筑市场「联盟市场B」同步恢复正常：1 页 0 单')
  })

  it('403 after a good sync hides the prices at once, however fresh they are', async () => {
    const w = world([MARKET_A])
    w.http.set(STRUCTURE_A, standardBook())
    w.http.maxAge = 60
    const source = w.build()
    await source.start()
    await w.time.advance(0)
    w.http.forbidden.add(STRUCTURE_A)
    await w.time.advance(5 * MIN)
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'auth_error', reason: 'auth' })
  })

  it('sync errors: old prices for up to 60 minutes, marked; then unavailable; then recovers', async () => {
    const w = world([MARKET_A])
    w.http.pageSize = 100
    w.http.set(STRUCTURE_A, standardBook())
    const source = w.build()
    const service = w.service(source)
    await source.start()
    await w.time.advance(0)
    const synced = w.time.now()
    w.http.fail(STRUCTURE_A, 503, 1000)
    await w.time.advance(5 * MIN)
    // 503 重试一次也失败
    expect(w.http.count(STRUCTURE_A)).toBe(3)
    expect(await service.getQuote('联盟市场a', RAVEN)).toMatchObject({
      status: 'stale', reason: 'sync_error', sell: { best: 260 }, detail: 'GET /markets/structures/{structure_id} HTTP 503: Internal server error',
    })
    expect(source.status(MARKET_A)).toMatchObject({ state: 'DEGRADED', lastSuccessAt: synced, lastSyncAt: w.time.now(), lastErrorAt: w.time.now() })
    await w.time.advance(55 * MIN)
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'stale', reason: 'sync_error' })
    await w.time.advance(1)
    expect(source.read(MARKET_A, RAVEN)).toEqual({ status: 'unavailable', reason: 'sync_error', detail: 'GET /markets/structures/{structure_id} HTTP 503: Internal server error' })
    expect(source.available(MARKET_A)).toEqual({ status: 'unavailable', reason: 'sync_error' })
    expect(w.logger.at('warn')).toEqual(['建筑市场「联盟市场A」同步出错：GET /markets/structures/{structure_id} HTTP 503: Internal server error'])

    w.http.clearFaults()
    await w.time.advance(5 * MIN)
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
    expect(w.logger.at('info')).toContain('建筑市场「联盟市场A」同步恢复正常：1 页 6 单')
  })

  it('a first sync that fails is unavailable, not still syncing', async () => {
    const w = world([MARKET_A])
    w.http.fail(STRUCTURE_A, 502, 2)
    const source = w.build()
    expect(source.read(MARKET_A, RAVEN)).toEqual({ status: 'not_ready', reason: 'first_sync' })
    await source.start()
    expect(source.status(MARKET_A).state).toBe('FIRST_SYNC')
    await w.time.advance(0)
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'unavailable', reason: 'sync_error' })
  })

  it('a profile that stops working hides its structures at once and keeps them hidden after a restart', async () => {
    const w = world()
    w.http.set(STRUCTURE_A, standardBook())
    const source = w.build()
    await source.start()
    await w.time.advance(0)
    w.auth.emit({ profile: 'default', status: 'AUTH_ERROR', lastError: '刷新令牌失效（被撤销、过期或已经换过），请重新授权' })
    expect(source.read(MARKET_A, RAVEN)).toEqual({
      status: 'auth_error', reason: 'auth', detail: 'SSO: 授权档案 default：刷新令牌失效（被撤销、过期或已经换过），请重新授权',
    })
    w.auth.status = 'AUTH_ERROR'
    w.auth.reason = '刷新令牌失效'
    await w.time.advance(5 * MIN)
    expect(source.status(MARKET_B).state).toBe('AUTH_ERROR')
    await source.flush()
    w.stop(source)

    const again = w.build({ store: createModuleStore() })
    await again.start()
    expect(again.read(MARKET_A, RAVEN)).toMatchObject({ status: 'auth_error', reason: 'auth' })
    expect(again.status(MARKET_A)).toMatchObject({ state: 'AUTH_ERROR', orders: 6 })
  })

  it('a profile that stops working while the pages are still fresh: queries, resync and a restart keep the prices hidden', async () => {
    for (const status of ['NEEDS_AUTH', 'AUTH_ERROR'] as const) {
      const w = world([MARKET_A])
      w.http.set(STRUCTURE_A, standardBook())
      const source = w.build()
      const service = w.service(source)
      await source.start()
      await w.time.advance(0)
      expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
      await w.time.advance(MIN)
      const requests = w.http.count(STRUCTURE_A)
      const calls = w.auth.calls.length

      // 档案删掉或失效（ESI 的缓存还有 4 分钟才过期）
      w.auth.status = status
      w.auth.emit({ profile: 'default', status })
      const hidden = status === 'NEEDS_AUTH' ? { status: 'not_ready', reason: 'needs_auth' } : { status: 'auth_error', reason: 'auth' }
      expect(source.read(MARKET_A, RAVEN)).toMatchObject(hidden)

      // 有人查价：不能拿缓存的页当成同步成功
      const quote = await service.getQuote('联盟市场a', RAVEN)
      expect(quote.status).not.toBe('ok')
      expect(quote.sell).toBeNull()
      await w.time.advance(0)
      expect(source.read(MARKET_A, RAVEN)).toMatchObject(hidden)
      expect(source.status(MARKET_A).state).toBe(status)

      // 「市场状态 刷新」
      await source.resync([MARKET_A])
      expect(source.read(MARKET_A, RAVEN)).toMatchObject(hidden)
      expect(source.status(MARKET_A).state).toBe(status)
      // 每次都要先拿 token；拿不到就不请求 ESI
      expect(w.auth.calls.length).toBeGreaterThan(calls)
      expect(w.http.count(STRUCTURE_A)).toBe(requests)

      // 缓存还没过期时重启
      await source.flush()
      w.stop(source)
      const again = w.build({ store: createModuleStore() })
      await again.start()
      await w.time.advance(0)
      expect(again.read(MARKET_A, RAVEN)).toMatchObject(hidden)
      expect(again.status(MARKET_A).state).toBe(status)
      expect(w.http.count(STRUCTURE_A)).toBe(requests)
    }
  })

  it('re-authorized with a character that cannot dock: the cached pages are checked again with the new token at once', async () => {
    const w = world([MARKET_A])
    w.http.set(STRUCTURE_A, standardBook())
    const source = w.build()
    await source.start()
    await w.time.advance(0)
    await w.time.advance(MIN)

    // 删掉以后用另一个角色重新授权
    w.auth.status = 'NEEDS_AUTH'
    w.auth.emit({ profile: 'default', status: 'NEEDS_AUTH' })
    w.http.forbidden.add(STRUCTURE_A)
    w.auth.status = 'OK'
    w.auth.emit({ profile: 'default', status: 'OK' })
    await w.time.advance(0)
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'auth_error', reason: 'auth' })
    expect(source.status(MARKET_A).state).toBe('AUTH_ERROR')

    // 没删、直接重新授权（状态一直是正常）：一样马上用新的 token 核对
    const w2 = world([MARKET_A])
    w2.http.set(STRUCTURE_A, standardBook())
    const s2 = w2.build()
    await s2.start()
    await w2.time.advance(0)
    await w2.time.advance(MIN)
    w2.http.forbidden.add(STRUCTURE_A)
    w2.auth.emit({ profile: 'default', status: 'OK' })
    await w2.time.advance(0)
    expect(s2.read(MARKET_A, RAVEN)).toMatchObject({ status: 'auth_error', reason: 'auth' })

    // 还是同一个能停靠的角色：带 ETag 核对一次，304，照常
    const w3 = world([MARKET_A])
    w3.http.set(STRUCTURE_A, standardBook())
    const s3 = w3.build()
    await s3.start()
    await w3.time.advance(0)
    await w3.time.advance(MIN)
    w3.auth.emit({ profile: 'default', status: 'OK' })
    await w3.time.advance(0)
    expect(s3.read(MARKET_A, RAVEN)).toMatchObject({ status: 'ok' })
    expect(w3.http.log.slice(3).map((l) => l.status)).toEqual([304, 304, 304])
  })

  it('never writes the access token into logs or the status', async () => {
    const w = world([MARKET_A])
    w.http.fail(STRUCTURE_A, 500, 2, JSON.stringify({ error: `bad header Authorization: Bearer ${TOKEN}` }))
    const source = w.build()
    await source.start()
    await w.time.advance(0)
    const status = source.status(MARKET_A)
    expect(status.state).toBe('DEGRADED')
    expect(w.logger.text()).not.toContain(TOKEN)
    expect(JSON.stringify(status)).not.toContain(TOKEN)
    expect(JSON.stringify(source.read(MARKET_A, RAVEN))).not.toContain(TOKEN)
    await source.flush()
    expect(JSON.stringify([...w.cache.entries.values()].map((e) => e.meta))).not.toContain(TOKEN)
  })
})

describe('structure sync: resync()', () => {
  it('only syncs markets that are expired or in error, ignoring the 403 back-off', async () => {
    const w = world()
    w.http.set(STRUCTURE_A, standardBook())
    // ESI 1 分钟过期，下一次同步排在 5 分钟后
    w.http.maxAge = 60
    w.http.forbidden.add(STRUCTURE_B)
    const source = w.build()
    const service = w.service(source)
    await source.start()
    await w.time.advance(30_000)
    expect([w.http.count(STRUCTURE_A), w.http.count(STRUCTURE_B)]).toEqual([3, 1])

    await service.resync()
    expect([w.http.count(STRUCTURE_A), w.http.count(STRUCTURE_B)]).toEqual([3, 2])
    w.http.forbidden.delete(STRUCTURE_B)
    await service.resync('联盟市场b')
    expect(source.status(MARKET_B).state).toBe('OK')
    await service.resync('jita 4-4')
    expect(w.http.count(STRUCTURE_B)).toBe(3)

    // 过期了才重拉（带 ETag）
    await w.time.advance(MIN)
    await source.resync([MARKET_A])
    expect(w.http.log.filter((l) => l.path === `/markets/structures/${STRUCTURE_A}`).slice(3).map((l) => l.status)).toEqual([304, 304, 304])
  })

  it('stop() cancels the loop; a sync that returns afterwards changes nothing', async () => {
    const w = world([MARKET_A])
    w.http.set(STRUCTURE_A, standardBook())
    const source = w.build()
    const release = w.http.hold(STRUCTURE_A)
    await source.start()
    await w.time.advance(0)
    source.stop()
    release()
    await w.time.advance(HOUR)
    expect(source.status(MARKET_A).state).toBe('FIRST_SYNC')
    expect(w.time.pending).toBe(0)
  })
})
