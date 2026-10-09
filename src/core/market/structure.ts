// 建筑市场整站同步（§6.4）：有授权档案的玩家建筑由这里取订单，查价只读内存里的订单簿，不等 ESI。
// - 每个建筑一个后台循环（ESI 的后台并发池）：用档案的 access token 取全部页，每页带上次的 ETag；
//   X-Pages、各页 Last-Modified 一致（不一致时重取）由 EsiClient.pages 负责。订单按物品分开、按价格排好，整份替换旧的。
// - 每页的订单（ESI 的字段名）和 {etag, lastModified}、整份的 {页数, 过期时间, 状态…} 写进 BlobCache 的 structures/<id>/：
//   重载、重启后从缓存重建订单簿，ESI 过期之前不重新请求。控制台保存配置（重载）时订单簿留在模块级存储里，不用重读。
// - 下一次 = max(ESI 过期时间, 完成时间 + 5 分钟) + 0–30 秒随机；24 小时没人查就暂停，有人查（touch）时恢复。
// - 状态每个建筑分开记，和授权档案的状态也分开。同步出错（5xx、超时、限流）时旧数据最多显示 60 分钟；
//   授权异常（档案失效、401、403）时一律不显示；401、403 按 15、30、60 分钟退避（省错误额度），只影响这一个建筑。
// - 档案失效、删除或重新授权时，缓存的页一律作废：下一次同步必须带新的 token 发（带 ETag 的）请求，
//   不能拿上一个授权留下的、还没过期的页当成同步成功。
// - 日志只写市场名和脱敏后的错误（EsiError 里没有 token）。
// 同一个建筑 ID 只同步一份。ESI 的建筑订单是否只含挂在这个建筑里的订单待核实，价格服务汇总时按建筑 ID 过滤。

import {
  SHOW_STALE_ON_AUTH_ERROR, STRUCTURE_FORBIDDEN_BACKOFF_MIN, STRUCTURE_IDLE_PAUSE_HOURS, STRUCTURE_STALE_HIDE_HOURS,
  STRUCTURE_STALE_MIN, STRUCTURE_SYNC_JITTER_SEC, STRUCTURE_SYNC_MIN_INTERVAL_MIN,
} from '../../constants'
import { isEsiError, parseStructureOrders } from '../esi'
import type { EsiApi, EsiAuth, EsiCacheEntry, EsiCacheStore, EsiPagedResult, EsiStructureOrder } from '../esi'
import type { AuthStatus, BlobCache, Clock, Logger, ModuleStore, Scheduler } from '../ports'
import type { MarketAvailability, MarketDef, MarketSourceState, MarketSourceStatus, SafeErrorInfo, TypeId } from '../types'
import { describeError, randomBetween, withDeadline } from '../util'
import type { Random } from '../util'
import { errorDetail, errorInfo } from './errors'
import type { ManagedMarketRegistry } from './registry'
import type { StructureRead, StructureSource } from './structure-source'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const INTERVAL_MS = STRUCTURE_SYNC_MIN_INTERVAL_MIN * MINUTE
const STALE_MS = STRUCTURE_STALE_MIN * MINUTE
const HIDE_MS = STRUCTURE_STALE_HIDE_HOURS * HOUR
const IDLE_MS = STRUCTURE_IDLE_PAUSE_HOURS * HOUR
const JITTER_MS = STRUCTURE_SYNC_JITTER_SEC * 1000
/** 缓存格式的版本；对不上的缓存不用 */
const FORMAT = 1
const EMPTY = Buffer.alloc(0)

/** 模块级存储的键：订单簿和同步状态，控制台保存配置后还在 */
export const STRUCTURE_STORE_KEY = 'market/structures'

export interface ProfileChange {
  profile: string
  status: AuthStatus
  lastError?: string
}

/** 授权档案（ManagedAuthService 就满足） */
export interface StructureAuth {
  /** 给 ESI 客户端用；取不到 token 时 token() 抛 EsiError('auth')，code 是档案的状态（NEEDS_AUTH / DEGRADED / AUTH_ERROR） */
  esiAuth(profile: string): EsiAuth
  /** 档案状态变化（授权成功、恢复、失效、删除）时通知 */
  onChange?(listener: (change: ProfileChange) => void): () => void
  /** 档案现在的状态：还没同步过的建筑在档案不能用时直接按它显示，不用等第一次同步失败 */
  profile?(name: string): { status: AuthStatus } | undefined
}

export interface StructureMarketsOptions {
  esi: Pick<EsiApi, 'structureOrders' | 'structure'>
  auth: StructureAuth
  /** all()：启动时恢复哪些建筑；locateStructure：从 /universe/structures 知道了建筑所在星系（控制台没填时） */
  registry: Pick<ManagedMarketRegistry, 'all'> & Partial<Pick<ManagedMarketRegistry, 'locateStructure'>>
  cache: BlobCache
  clock: Clock
  scheduler: Scheduler
  logger: Logger
  /** 给了就把订单簿放在这里，插件重载后还在 */
  store?: ModuleStore
  /** 同步时间的随机抖动（测试里固定） */
  random?: Random
}

export interface ManagedStructureSource extends StructureSource {
  /** 数据加载后调用：从缓存恢复市场表格里的建筑，按过期时间排好第一次同步；订阅授权档案的变化 */
  start(): Promise<void>
  /** 插件停用：取消所有定时器，进行中的同步回来后不再改状态 */
  stop(): void
  /** 等写缓存的任务都做完（测试、停用时用） */
  flush(): Promise<void>
}

// ------------------------------------------------------------------ 订单簿

interface Sides {
  /** 价格升序 */
  sell: EsiStructureOrder[]
  /** 价格降序 */
  buy: EsiStructureOrder[]
}

type Book = Map<TypeId, Sides>

function buildBook(pages: ReadonlyArray<readonly EsiStructureOrder[]>): { book: Book; orders: number } {
  const book: Book = new Map()
  const seen = new Set<number>()
  for (const page of pages) {
    for (const order of page) {
      // 翻页途中订单换了页时可能出现两次
      if (seen.has(order.orderId)) continue
      seen.add(order.orderId)
      let sides = book.get(order.typeId)
      if (!sides) {
        sides = { sell: [], buy: [] }
        book.set(order.typeId, sides)
      }
      if (order.isBuyOrder) sides.buy.push(order)
      else sides.sell.push(order)
    }
  }
  for (const sides of book.values()) {
    sides.sell.sort((a, b) => a.price - b.price)
    sides.buy.sort((a, b) => b.price - a.price)
  }
  return { book, orders: seen.size }
}

// ------------------------------------------------------------------ 分页缓存

type PageEntry = EsiCacheEntry<EsiStructureOrder[]>

/** EsiClient.keyOf 的键里取页号（「GET /markets/structures/1?page=3 profile=default」） */
function pageOf(key: string): number {
  const m = /[?&]page=(\d+)/.exec(key)
  return m ? Number(m[1]) : 1
}

/** 缓存完整性检查用：每页的 ETag（没有时用 Last-Modified） */
function tagOf(entry: EsiCacheEntry): string {
  return entry.etag ?? `lm:${entry.lastModified ?? ''}`
}

/** EsiClient 的缓存存放处：按页号放（条目里有 ETag 和过期时间），记下哪几页换了内容、要写进 BlobCache */
class PageStore implements EsiCacheStore {
  readonly entries = new Map<number, PageEntry>()
  readonly dirty = new Set<number>()

  get(key: string): EsiCacheEntry | undefined {
    return this.entries.get(pageOf(key))
  }

  set(key: string, entry: EsiCacheEntry) {
    const n = pageOf(key)
    const old = this.entries.get(n)
    this.entries.set(n, entry as PageEntry)
    // 304 只换过期时间，内容是同一个数组
    if (!old || old.value !== entry.value || tagOf(old) !== tagOf(entry)) this.dirty.add(n)
  }

  /** 授权变了：所有页按已过期处理（内容和 ETag 留着，下一次带 ETag 请求，304 很便宜） */
  expire() {
    for (const [n, entry] of this.entries) this.entries.set(n, { ...entry, expiresAt: 0 })
  }

  /** 页数变少了：丢掉多出来的 */
  trim(pages: number) {
    for (const n of [...this.entries.keys()]) {
      if (n <= pages) continue
      this.entries.delete(n)
      this.dirty.delete(n)
    }
  }
}

const pageKey = (id: number, n: number) => `structures/${id}/page-${n}`
const indexKey = (id: number) => `structures/${id}/state`

/** 写进缓存的是 ESI 原样的字段，读回来时照样经过 parseStructureOrders 检查 */
function toRaw(o: EsiStructureOrder) {
  return {
    order_id: o.orderId,
    type_id: o.typeId,
    location_id: o.locationId,
    is_buy_order: o.isBuyOrder,
    price: o.price,
    volume_remain: o.volumeRemain,
    volume_total: o.volumeTotal,
    min_volume: o.minVolume,
    range: String(o.range),
    duration: o.duration,
    issued: new Date(o.issued).toISOString(),
  }
}

// ------------------------------------------------------------------ 每个建筑的状态

interface Synced {
  id: number
  /** 缓存恢复完了（read 不能等） */
  ready: boolean
  restored: Promise<void>
  pages: PageStore
  book: Book | null
  /** 订单簿是用这几页（PageStore 里的 value）建的；没变就不重建 */
  built: readonly unknown[]
  /** 订单簿每一页的 tagOf */
  tags: string[]
  orders: number
  pageCount: number
  lastModified: number | null
  expiresAt: number
  state: MarketSourceState
  lastSuccessAt: number | null
  /** 最近一次同步结束（不管成败） */
  lastSyncAt: number | null
  lastError: SafeErrorInfo | null
  lastErrorAt: number | null
  /** 出错以后，这之前不自动同步 */
  retryAt: number | null
  /** 连续被拒（401、403）几次，退避用 */
  rejected: number
  /** 暂停按它算：最近一次有人查，没人查过时是第一次见到这个建筑的时间 */
  lastQueryAt: number
  /** 真的有人查的时间（「市场状态」显示） */
  queriedAt: number | null
  paused: boolean
  systemId: number | null
  /** 缓存里存了几页 */
  saved: number
  persisting: Promise<void>
}

function freshState(id: number, now: number): Synced {
  return {
    id,
    ready: false,
    restored: Promise.resolve(),
    pages: new PageStore(),
    book: null,
    built: [],
    tags: [],
    orders: 0,
    pageCount: 0,
    lastModified: null,
    expiresAt: 0,
    state: 'FIRST_SYNC',
    lastSuccessAt: null,
    lastSyncAt: null,
    lastError: null,
    lastErrorAt: null,
    retryAt: null,
    rejected: 0,
    lastQueryAt: now,
    queriedAt: null,
    paused: false,
    systemId: null,
    saved: 0,
    persisting: Promise.resolve(),
  }
}

const STATES: readonly MarketSourceState[] = ['OK', 'FIRST_SYNC', 'NEEDS_AUTH', 'DEGRADED', 'AUTH_ERROR']

const numberOr = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function errorOf(value: unknown): SafeErrorInfo | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.message !== 'string') return null
  const info: SafeErrorInfo = { message: v.message }
  if (typeof v.route === 'string') info.route = v.route
  if (typeof v.status === 'number') info.status = v.status
  if (typeof v.code === 'string') info.code = v.code
  return info
}

/** 缓存里的整份记录（BlobCache 的 meta） */
function indexOf(s: Synced): Record<string, unknown> {
  return {
    v: FORMAT,
    pages: s.pageCount,
    tags: s.tags,
    lastModified: s.lastModified,
    expiresAt: s.expiresAt,
    lastSuccessAt: s.lastSuccessAt,
    lastSyncAt: s.lastSyncAt,
    lastQueryAt: s.lastQueryAt,
    queriedAt: s.queriedAt,
    state: s.state,
    lastError: s.lastError,
    lastErrorAt: s.lastErrorAt,
    retryAt: s.retryAt,
    rejected: s.rejected,
    systemId: s.systemId,
  }
}

type View =
  | { status: 'ok' | 'stale'; reason?: StructureRead['reason']; detail?: string }
  | Exclude<StructureRead, { orders: unknown }>

type DataView = Extract<View, { status: 'ok' | 'stale' }>

const hasData = (view: View): view is DataView => view.status === 'ok' || view.status === 'stale'

const NOT_SYNCED: View = { status: 'unavailable', reason: 'sync_error', detail: '这个市场没有建筑 ID 或授权档案' }

const STATE_TEXT: Partial<Record<MarketSourceState, string>> = {
  NEEDS_AUTH: '需要授权',
  DEGRADED: '同步出错',
  AUTH_ERROR: '授权或停靠权限异常，暂停显示价格',
}

function synced(market: MarketDef): boolean {
  return market.type === 'structure' && !!market.authProfile && market.locationId !== undefined
}

// ------------------------------------------------------------------ 服务

class StructureMarkets implements ManagedStructureSource {
  private readonly states: Map<number, Synced>
  /** 每个建筑最近一次见到的市场定义（名字、授权档案） */
  private readonly markets = new Map<number, MarketDef>()
  private readonly adopted = new Set<number>()
  private readonly running = new Map<number, Promise<void>>()
  private readonly timers = new Map<number, () => void>()
  private readonly locating = new Set<number>()
  private readonly random: Random
  private unsubscribe: (() => void) | undefined
  private stopped = false

  constructor(private readonly o: StructureMarketsOptions) {
    const create = () => new Map<number, Synced>()
    this.states = o.store ? o.store.get(STRUCTURE_STORE_KEY, create) : create()
    this.random = o.random ?? Math.random
  }

  // ------------------------------------------------------------------ 生命周期

  async start(): Promise<void> {
    if (this.stopped) return
    this.unsubscribe ??= this.o.auth.onChange?.((change) => this.profileChanged(change))
    const all = this.o.registry.all()
    const markets = all.filter(synced)
    // 控制台删掉的建筑：订单簿不再留在内存里（市场表格还没建好时不动）
    if (all.length) {
      const keep = new Set(markets.map((m) => m.locationId))
      for (const id of [...this.states.keys()]) if (!keep.has(id)) this.states.delete(id)
    }
    await Promise.all(markets.map((m) => this.entry(m)?.restored))
  }

  stop() {
    this.stopped = true
    for (const cancel of this.timers.values()) cancel()
    this.timers.clear()
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  async flush(): Promise<void> {
    await Promise.all([...this.states.values()].map((s) => s.persisting))
  }

  // ------------------------------------------------------------------ StructureSource

  read(market: MarketDef, typeId: TypeId): StructureRead {
    const s = this.entry(market)
    const view = s ? this.view(s) : NOT_SYNCED
    if (!hasData(view)) return view
    const sides = s!.book!.get(typeId)
    return { ...view, orders: sides ? sides.sell.concat(sides.buy) : [], dataTime: s!.lastModified ?? s!.lastSuccessAt }
  }

  available(market: MarketDef): MarketAvailability {
    const s = this.entry(market)
    const { status, reason } = s ? this.view(s) : NOT_SYNCED
    return reason === undefined ? { status } : { status, reason }
  }

  async touch(market: MarketDef, waitMs: number): Promise<void> {
    const s = this.entry(market)
    if (!s || this.stopped) return
    const deadline = this.now() + Math.max(0, waitMs)
    if (!s.ready && !(await withDeadline(s.restored, Math.max(0, waitMs), this.o.scheduler)).done) return
    const now = this.now()
    s.lastQueryAt = now
    s.queriedAt = now
    const resumed = s.paused
    if (resumed) {
      s.paused = false
      this.o.logger.debug(`建筑市场「${market.name}」有人查，恢复同步`)
    }
    // 60 分钟以内的数据直接用；更旧的等这次同步，最多等到时限
    const usable = this.usable(s)
    const running = resumed || !usable ? this.kick(s.id) : null
    if (usable || !running) return
    await withDeadline(running, Math.max(0, deadline - this.now()), this.o.scheduler)
  }

  async resync(markets: readonly MarketDef[]): Promise<void> {
    await Promise.all(markets.map(async (market) => {
      const s = this.entry(market)
      if (!s) return
      await s.restored
      // 没过期的不重拉（ESI 的规则）；出错的不管退避，马上再试一次
      if (this.stopped || (s.state === 'OK' && this.now() < s.expiresAt)) return
      s.retryAt = null
      await this.sync(s.id)
    }))
  }

  status(market: MarketDef): MarketSourceStatus {
    const s = this.entry(market)
    const out: MarketSourceStatus = {
      marketKey: market.key,
      name: market.name,
      type: market.type,
      source: 'structure',
      state: s ? this.blockedBy(s) ?? s.state : 'NEEDS_AUTH',
      paused: !!s?.paused,
      lastRequestAt: s?.queriedAt ?? null,
      lastSyncAt: s?.lastSyncAt ?? null,
      lastSuccessAt: s?.lastSuccessAt ?? null,
      lastError: s?.lastError ?? null,
      lastErrorAt: s?.lastErrorAt ?? null,
      pages: s?.book ? s.pageCount : null,
      orders: s?.book ? s.orders : null,
    }
    if (market.authProfile) out.authProfile = market.authProfile
    return out
  }

  // ------------------------------------------------------------------ 状态

  private now(): number {
    return this.o.clock.now()
  }

  /** 第一次见到的建筑：建状态、从缓存恢复；每个实例第一次见到时排上同步 */
  private entry(market: MarketDef): Synced | null {
    if (!synced(market)) return null
    const id = market.locationId!
    this.markets.set(id, market)
    let s = this.states.get(id)
    if (!s) {
      s = freshState(id, this.now())
      s.restored = this.restore(s)
      this.states.set(id, s)
    }
    if (!this.adopted.has(id) && !this.stopped) {
      this.adopted.add(id)
      void s.restored.then(() => this.adopt(id))
    }
    return s
  }

  private adopt(id: number) {
    const s = this.states.get(id)
    const market = this.markets.get(id)
    if (this.stopped || !s || !market) return
    if (s.systemId !== null && market.systemId === undefined) this.o.registry.locateStructure?.(market.key, s.systemId)
    if (this.running.has(id) || this.timers.has(id) || this.pauseIfIdle(s)) return
    this.schedule(id, Math.max(this.dueAt(s), this.now()) + this.jitter())
  }

  /** 距离最近一次确认（200 或 304）多久；ESI 还没过期时算 0 */
  private age(s: Synced): number {
    if (s.lastSuccessAt === null) return Infinity
    const now = this.now()
    return now < s.expiresAt ? 0 : Math.max(0, now - s.lastSuccessAt)
  }

  private usable(s: Synced): boolean {
    return !!s.book && (s.state === 'OK' || s.state === 'DEGRADED') && this.age(s) <= STALE_MS
  }

  private view(s: Synced): View {
    const blocked = this.blockedBy(s)
    if (blocked === 'NEEDS_AUTH') return { status: 'not_ready', reason: 'needs_auth' }
    if (blocked === 'AUTH_ERROR') return { status: 'auth_error', reason: 'auth' }
    if (!s.ready) return { status: 'not_ready', reason: 'first_sync' }
    const detail = s.lastError ? errorDetail(s.lastError) : undefined
    const explain = <V extends View>(v: V): V => (detail === undefined ? v : { ...v, detail })
    const age = this.age(s)
    switch (s.state) {
      case 'FIRST_SYNC':
        return { status: 'not_ready', reason: 'first_sync' }
      case 'NEEDS_AUTH':
        return explain({ status: 'not_ready', reason: 'needs_auth' })
      case 'AUTH_ERROR':
        if (SHOW_STALE_ON_AUTH_ERROR && s.book && age <= STALE_MS) return explain({ status: 'stale', reason: 'sync_error' })
        return explain({ status: 'auth_error', reason: 'auth' })
    }
    if (!s.book) return s.state === 'DEGRADED' ? explain({ status: 'unavailable', reason: 'sync_error' }) : { status: 'not_ready', reason: 'first_sync' }
    if (age <= STALE_MS) return s.state === 'OK' ? { status: 'ok' } : explain({ status: 'stale', reason: 'sync_error' })
    if (s.state === 'DEGRADED') return explain({ status: 'unavailable', reason: 'sync_error' })
    // 暂停了一阵、正在恢复：24 小时以内的旧数据标「正在刷新」，更旧的不显示
    return age <= HIDE_MS ? { status: 'stale', reason: 'refreshing' } : { status: 'not_ready', reason: 'resyncing' }
  }

  /** 还没有订单簿、也还没同步出结果的建筑：档案本身是「需要授权」或「授权异常」时按档案的状态算 */
  private blockedBy(s: Synced): 'NEEDS_AUTH' | 'AUTH_ERROR' | null {
    if (s.book || s.state !== 'FIRST_SYNC') return null
    const profile = this.markets.get(s.id)?.authProfile
    const status = profile ? this.o.auth.profile?.(profile)?.status : undefined
    return status === 'NEEDS_AUTH' || status === 'AUTH_ERROR' ? status : null
  }

  /** 什么时候可以再同步：正常时按 max(过期, 完成 + 5 分钟)，出错时按退避 */
  private dueAt(s: Synced): number {
    if (s.state === 'OK') return Math.max(s.expiresAt, (s.lastSyncAt ?? 0) + INTERVAL_MS)
    return s.retryAt ?? 0
  }

  private idle(s: Synced): boolean {
    return this.now() - s.lastQueryAt >= IDLE_MS
  }

  /** 24 小时没人查：暂停，取消排着的同步 */
  private pauseIfIdle(s: Synced): boolean {
    if (!s.paused && !this.idle(s)) return false
    if (!s.paused) {
      s.paused = true
      const name = this.markets.get(s.id)?.name ?? String(s.id)
      this.o.logger.info(`建筑市场「${name}」${STRUCTURE_IDLE_PAUSE_HOURS} 小时没人查，同步暂停（有人查时自动恢复）`)
    }
    this.cancel(s.id)
    return true
  }

  // ------------------------------------------------------------------ 调度

  private jitter(): number {
    return Math.round(randomBetween(0, JITTER_MS, this.random))
  }

  private cancel(id: number) {
    this.timers.get(id)?.()
    this.timers.delete(id)
  }

  private schedule(id: number, at: number) {
    this.cancel(id)
    const cancel = this.o.scheduler.timeout(() => {
      if (this.timers.get(id) !== cancel) return
      this.timers.delete(id)
      const s = this.states.get(id)
      if (this.stopped || !s || this.pauseIfIdle(s)) return
      void this.sync(id)
    }, Math.max(0, at - this.now()))
    this.timers.set(id, cancel)
  }

  /** 进行中的同步；没有时到点了就马上开始，没到点就排上 */
  private kick(id: number): Promise<void> | null {
    const running = this.running.get(id)
    if (running) return running
    const s = this.states.get(id)
    if (this.stopped || !s) return null
    const at = this.dueAt(s)
    if (at <= this.now()) return this.sync(id)
    if (!this.timers.has(id)) this.schedule(id, at + this.jitter())
    return null
  }

  /** 同一个建筑同时只同步一次；结束后排下一次 */
  private sync(id: number): Promise<void> {
    const existing = this.running.get(id)
    if (existing) return existing
    this.cancel(id)
    const run = this.run(id).finally(() => {
      this.running.delete(id)
      this.next(id)
    })
    this.running.set(id, run)
    return run
  }

  private next(id: number) {
    const s = this.states.get(id)
    if (this.stopped || !s || this.pauseIfIdle(s)) return
    this.schedule(id, Math.max(this.dueAt(s), this.now()) + this.jitter())
  }

  // ------------------------------------------------------------------ 同步

  private async run(id: number): Promise<void> {
    const s = this.states.get(id)!
    await s.restored
    const market = this.markets.get(id)
    if (this.stopped || !market?.authProfile) return
    // 授权有问题（包括重启前就有问题）：缓存的页不算数，必须拿到 token、真的问一次 ESI
    if (s.state === 'NEEDS_AUTH' || s.state === 'AUTH_ERROR') this.expire(s)
    try {
      const result = await this.o.esi.structureOrders(id, {
        auth: this.o.auth.esiAuth(market.authProfile),
        lane: 'background',
        store: s.pages,
        staleIfErrorMs: 0,
      })
      if (!this.stopped) this.succeeded(s, market, result)
    } catch (e) {
      if (!this.stopped) this.failed(s, market, e)
    }
  }

  private succeeded(s: Synced, market: MarketDef, result: EsiPagedResult<EsiStructureOrder>) {
    const values: EsiStructureOrder[][] = []
    const tags: string[] = []
    for (let n = 1; n <= result.pages; n++) {
      const entry = s.pages.entries.get(n)
      if (!entry) throw new Error(`第 ${n} 页不在分页缓存里`)
      values.push(entry.value)
      tags.push(tagOf(entry))
    }
    s.pages.trim(result.pages)
    if (!s.book || values.length !== s.built.length || values.some((v, i) => v !== s.built[i])) {
      const built = buildBook(values)
      s.book = built.book
      s.orders = built.orders
      s.built = values
    }
    const now = this.now()
    s.tags = tags
    s.pageCount = result.pages
    s.lastModified = result.lastModified
    s.expiresAt = result.expiresAt
    s.lastSuccessAt = now
    s.lastSyncAt = now
    s.retryAt = null
    s.rejected = 0
    this.transition(s, market, 'OK')
    this.save(s, market, true)
    this.findSystem(s, market)
  }

  private failed(s: Synced, market: MarketDef, e: unknown) {
    const now = this.now()
    const { state, retryAt } = this.classify(s, e, now)
    s.lastError = errorInfo(e)
    s.lastErrorAt = now
    s.lastSyncAt = now
    s.retryAt = retryAt
    if (s.state === state) this.o.logger.debug(`建筑市场「${market.name}」同步仍然失败：${errorDetail(s.lastError)}`)
    this.transition(s, market, state)
    this.save(s, market, false)
  }

  private classify(s: Synced, e: unknown, now: number): { state: MarketSourceState; retryAt: number } {
    const regular = now + INTERVAL_MS
    if (!isEsiError(e)) return { state: 'DEGRADED', retryAt: regular }
    if (e.kind === 'auth') {
      // 取不到 access token，code 是档案的状态。这时不会请求 ESI，按平常的间隔再看
      const state: MarketSourceState = e.code === 'NEEDS_AUTH' ? 'NEEDS_AUTH' : e.code === 'DEGRADED' ? 'DEGRADED' : 'AUTH_ERROR'
      return { state, retryAt: regular }
    }
    if (e.paused) return { state: 'DEGRADED', retryAt: Math.max(regular, e.retryAt ?? 0) }
    if (e.status === 401 || e.status === 403) {
      // 401：ESI 客户端已经让档案刷新过一次还是被拒；403：没有停靠或市场访问权限、或者缺权限范围
      const steps = STRUCTURE_FORBIDDEN_BACKOFF_MIN
      const delay = steps[Math.min(s.rejected, steps.length - 1)] * MINUTE
      s.rejected++
      return { state: 'AUTH_ERROR', retryAt: now + delay }
    }
    return { state: 'DEGRADED', retryAt: regular }
  }

  /** 改状态；变了才写日志（持续出错期间不重复写） */
  private transition(s: Synced, market: MarketDef, state: MarketSourceState) {
    const before = s.state
    s.state = state
    if (before === state) return
    if (state === 'OK') {
      const size = `${s.pageCount} 页 ${s.orders} 单`
      this.o.logger.info(before === 'FIRST_SYNC' ? `建筑市场「${market.name}」第一次同步完成：${size}` : `建筑市场「${market.name}」同步恢复正常：${size}`)
      return
    }
    const text = `建筑市场「${market.name}」${STATE_TEXT[state] ?? state}${s.lastError ? `：${errorDetail(s.lastError)}` : ''}`
    if (state === 'NEEDS_AUTH') this.o.logger.info(text)
    else this.o.logger.warn(text)
  }

  /** 缓存的页和整份记录都按已过期处理 */
  private expire(s: Synced) {
    s.pages.expire()
    s.expiresAt = 0
  }

  /**
   * 授权档案变了：缓存的页作废（可能换了角色，新角色不一定能停靠）。
   * 授权成功或恢复时马上用新的 token 同步一次；失效时这个档案同步的价格马上停止显示
   */
  private profileChanged(change: ProfileChange) {
    if (this.stopped) return
    for (const [id, market] of this.markets) {
      const s = this.states.get(id)
      if (market.authProfile !== change.profile || !s?.ready) continue
      if (change.status === 'OK') {
        this.expire(s)
        s.retryAt = null
        s.rejected = 0
        if (!s.paused) void this.sync(id)
      } else if (change.status === 'NEEDS_AUTH' || change.status === 'AUTH_ERROR') {
        this.expire(s)
        if (s.state !== change.status) {
          const message = `授权档案 ${change.profile}：${change.lastError || STATE_TEXT[change.status]}`
          s.lastError = { route: 'SSO', code: change.status, message }
          s.lastErrorAt = this.now()
          this.transition(s, market, change.status)
        }
        this.save(s, market, false)
      }
    }
  }

  /** 控制台没填建筑所在星系：问一次 /universe/structures（走势这类按星域的功能要用） */
  private findSystem(s: Synced, market: MarketDef) {
    const locate = this.o.registry.locateStructure
    if (!locate || market.systemId !== undefined || s.systemId !== null || this.locating.has(s.id)) return
    this.locating.add(s.id)
    this.o.esi.structure(s.id, { auth: this.o.auth.esiAuth(market.authProfile!), lane: 'background' }).then((res) => {
      if (this.stopped) return
      s.systemId = res.value.solarSystemId
      locate.call(this.o.registry, market.key, s.systemId)
    }, (e) => {
      this.o.logger.debug(`建筑市场「${market.name}」所在星系查不到：${describeError(e)}`)
    })
  }

  // ------------------------------------------------------------------ 缓存

  /** 按顺序写：先写换了内容的页，再写整份的记录，最后删掉多出来的页。失败只记日志，下次成功时重写 */
  private save(s: Synced, market: MarketDef, withPages: boolean) {
    const { cache, logger } = this.o
    const id = s.id
    const writes: Array<[number, PageEntry]> = []
    const removes: number[] = []
    if (withPages) {
      for (const n of s.pages.dirty) {
        const entry = s.pages.entries.get(n)
        if (entry && n <= s.pageCount) writes.push([n, entry])
      }
      s.pages.dirty.clear()
      for (let n = s.pageCount + 1; n <= s.saved; n++) removes.push(n)
      s.saved = s.pageCount
    }
    const index = indexOf(s)
    s.persisting = s.persisting.then(async () => {
      for (const [n, entry] of writes) {
        const meta: Record<string, unknown> = { tag: tagOf(entry), lastModified: entry.lastModified }
        if (entry.etag !== undefined) meta.etag = entry.etag
        await cache.write(pageKey(id, n), Buffer.from(JSON.stringify(entry.value.map(toRaw))), meta)
      }
      await cache.write(indexKey(id), EMPTY, index)
      for (const n of removes) await cache.remove(pageKey(id, n))
    }).catch((e) => {
      for (const [n] of writes) s.pages.dirty.add(n)
      logger.warn(`建筑市场「${market.name}」的订单没写进缓存：${describeError(e)}`)
    })
  }

  /** 从缓存恢复；读不了或对不上就当没有缓存，等下一次同步 */
  private async restore(s: Synced): Promise<void> {
    try {
      const head = await this.o.cache.read(indexKey(s.id))
      if (head) await this.load(s, head.meta)
    } catch (e) {
      this.o.logger.warn(`建筑 ${s.id} 的订单缓存读不了，等下一次同步：${describeError(e)}`)
    } finally {
      s.ready = true
    }
  }

  private async load(s: Synced, meta: Record<string, unknown>) {
    if (meta.v !== FORMAT) return
    const pages = numberOr(meta.pages) ?? 0
    const tags = Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === 'string') : []
    const state = STATES.find((x) => x === meta.state) ?? 'FIRST_SYNC'
    s.lastSyncAt = numberOr(meta.lastSyncAt)
    s.lastError = errorOf(meta.lastError)
    s.lastErrorAt = numberOr(meta.lastErrorAt)
    s.retryAt = numberOr(meta.retryAt)
    s.rejected = numberOr(meta.rejected) ?? 0
    s.lastQueryAt = numberOr(meta.lastQueryAt) ?? s.lastQueryAt
    s.queriedAt = numberOr(meta.queriedAt)
    s.systemId = numberOr(meta.systemId)
    s.saved = Math.max(0, pages)
    s.state = state
    if (!Number.isInteger(pages) || pages < 1 || tags.length !== pages) {
      if (state === 'OK') s.state = 'FIRST_SYNC'
      return
    }
    const lastSuccessAt = numberOr(meta.lastSuccessAt)
    const expiresAt = numberOr(meta.expiresAt) ?? 0
    const entries: PageEntry[] = []
    try {
      for (let n = 1; n <= pages; n++) {
        const page = await this.o.cache.read(pageKey(s.id, n))
        if (!page || page.meta.tag !== tags[n - 1]) throw new Error(`第 ${n} 页和记录对不上`)
        const entry: PageEntry = {
          value: parseStructureOrders(JSON.parse(page.body.toString('utf8'))),
          lastModified: numberOr(page.meta.lastModified),
          expiresAt,
          validatedAt: lastSuccessAt ?? 0,
          pages,
          bytes: page.body.length,
        }
        if (typeof page.meta.etag === 'string') entry.etag = page.meta.etag
        entries.push(entry)
      }
    } catch (e) {
      this.o.logger.warn(`建筑 ${s.id} 的订单缓存不完整，等下一次同步：${describeError(e)}`)
      if (state === 'OK') s.state = 'FIRST_SYNC'
      return
    }
    entries.forEach((entry, i) => s.pages.entries.set(i + 1, entry))
    const values = entries.map((e) => e.value)
    const built = buildBook(values)
    s.book = built.book
    s.orders = built.orders
    s.built = values
    s.tags = tags
    s.pageCount = pages
    s.lastModified = numberOr(meta.lastModified)
    s.expiresAt = expiresAt
    s.lastSuccessAt = lastSuccessAt
  }
}

export function createStructureMarkets(options: StructureMarketsOptions): ManagedStructureSource {
  return new StructureMarkets(options)
}
