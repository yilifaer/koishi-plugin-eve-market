// MarketService（§6.3）：按市场取报价。
// - NPC 空间站、星系、星域、授权档案留空的建筑：星域订单（region.ts）+ 本地按地点过滤；
// - 有授权档案的建筑：StructureSource（订单簿在内存里，structure.ts 实现；之前一律「需要授权」）；
// - PLEX 这类全宇宙统一交易的物品：不管问的是哪个市场，都取全局市场星域，不按地点过滤。
// 每个报价都带明确的状态；一个市场、一个物品失败不影响别的。时限到了先回去，请求在后台做完写进缓存。

import { BATCH_DEADLINE_MS, GLOBAL_MARKET_REGION, GLOBAL_MARKET_TYPES, QUERY_DEADLINE_MS } from '../../constants'
import type { EsiLane } from '../esi'
import type { Clock, Logger, ModuleStore, Scheduler } from '../ports'
import type {
  MarketAvailability, MarketDef, MarketService, MarketSourceStatus, PriceQuote, QuoteReason, QuoteStatus, SafeErrorInfo,
  TypeId,
} from '../types'
import { describeError, withDeadline } from '../util'
import { inDowntime } from './downtime'
import { errorDetail } from './errors'
import { RegionSource } from './region'
import type { RegionBook, RegionOrdersApi, RegionRead } from './region'
import type { ManagedMarketRegistry } from './registry'
import { pendingStructures } from './structure-source'
import type { StructureSource } from './structure-source'
import { summarize } from './summarize'
import type { OrderScope, Summary } from './summarize'

export interface ManagedMarketService extends MarketService {
  /** 这个物品在这个市场的价格已经在手上、没过期（批量查价判断要不要发慢提示） */
  cached(marketKey: string, typeId: TypeId): boolean
}

export interface MarketServiceOptions {
  registry: Pick<ManagedMarketRegistry, 'get' | 'all'>
  esi: RegionOrdersApi
  clock: Clock
  scheduler: Scheduler
  logger: Logger
  /** 不写 = 0.0.2 之前的占位：建筑市场一律「需要授权」 */
  structures?: StructureSource
  /** 出错时星域订单最多用多旧的（毫秒） */
  staleMs?: number
  /** 模块级存储：最近的星域订单放在这里，插件重载后还在 */
  store?: ModuleStore
}

type QuoteOptions = { deadlineMs?: number; lane?: EsiLane }

type Route =
  | { kind: 'region'; regionId: number; scope: OrderScope; source: 'region' | 'global' }
  | { kind: 'structure' }
  | { kind: 'none'; detail: string }

/** 和 MarketDef 对应：有授权档案的建筑走 StructureSource */
function usesStructureSource(market: MarketDef): boolean {
  return market.type === 'structure' && !!market.authProfile
}

function routeOf(market: MarketDef, typeId: TypeId): Route {
  if (GLOBAL_MARKET_TYPES.includes(typeId)) return { kind: 'region', regionId: GLOBAL_MARKET_REGION, scope: {}, source: 'global' }
  if (usesStructureSource(market)) return { kind: 'structure' }
  const { regionId, locationId, systemId } = market
  if (regionId === null) return { kind: 'none', detail: `不知道「${market.name}」在哪个星域` }
  // 少了地点就不能过滤，宁可不报价也不拿整个星域的价充数
  const lost: Route = { kind: 'none', detail: `「${market.name}」缺少空间站或星系` }
  const region = (scope: OrderScope): Route => ({ kind: 'region', regionId, scope, source: 'region' })
  switch (market.type) {
    case 'npc-station':
    case 'structure':
      return locationId === undefined ? lost : region({ locationId })
    case 'system':
      return systemId === undefined ? lost : region({ systemId })
    case 'region':
      return region({})
  }
}

function quantityOf(qty: number | undefined): number {
  return qty !== undefined && Number.isFinite(qty) && qty >= 1 ? Math.floor(qty) : 1
}

// ------------------------------------------------------------------ NPC 市场的状态（「市场状态」用）

interface RegionStat {
  lastRequestAt: number | null
  lastSuccessAt: number | null
  lastError: SafeErrorInfo | null
  lastErrorAt: number | null
  /** 最近一次完成的请求出错了，还没恢复 */
  failing: boolean
}

class RegionStats {
  private readonly stats = new Map<string, RegionStat>()

  get(key: string): RegionStat {
    let stat = this.stats.get(key)
    if (!stat) {
      stat = { lastRequestAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null, failing: false }
      this.stats.set(key, stat)
    }
    return stat
  }

  record(key: string, read: RegionRead, at: number) {
    const stat = this.get(key)
    if (read.status === 'ok') {
      stat.lastSuccessAt = at
      stat.failing = false
    } else if (read.status !== 'timeout' && read.error) {
      stat.lastError = read.error
      stat.lastErrorAt = at
      stat.failing = true
    }
  }
}

// ------------------------------------------------------------------ 报价

interface QuoteHead {
  marketKey: string
  typeId: TypeId
  source: PriceQuote['source']
}

function emptyQuote(head: QuoteHead, status: QuoteStatus, extra: Partial<PriceQuote> = {}): PriceQuote {
  return { ...head, sell: null, buy: null, mid: null, status, dataTime: null, ageSec: null, ...extra }
}

function filledQuote(head: QuoteHead, summary: Summary, status: QuoteStatus, dataTime: number | null, now: number): PriceQuote {
  return {
    ...head,
    ...summary,
    status,
    dataTime,
    ageSec: dataTime === null ? null : Math.max(0, Math.round((now - dataTime) / 1000)),
  }
}

function bookTime(book: RegionBook): number {
  return book.lastModified ?? book.validatedAt
}

class Service implements ManagedMarketService {
  private readonly regions: RegionSource
  private readonly structures: StructureSource
  private readonly stats = new RegionStats()

  constructor(private readonly options: MarketServiceOptions) {
    this.regions = new RegionSource({ api: options.esi, clock: options.clock, scheduler: options.scheduler, staleMs: options.staleMs, store: options.store })
    this.structures = options.structures ?? pendingStructures()
  }

  getQuote(marketKey: string, typeId: TypeId, opts: QuoteOptions & { qty?: number } = {}): Promise<PriceQuote> {
    const deadlineAt = this.now() + (opts.deadlineMs ?? QUERY_DEADLINE_MS)
    return this.quote(marketKey, typeId, quantityOf(opts.qty), { deadlineAt, touch: true, lane: opts.lane })
  }

  async getQuotes(marketKey: string, items: Array<{ typeId: TypeId; qty: number }>, opts: QuoteOptions = {}): Promise<Map<TypeId, PriceQuote>> {
    const deadlineAt = this.now() + (opts.deadlineMs ?? BATCH_DEADLINE_MS)
    // 同一种物品写了几行：按合计的数量算（买单的 min_volume 看的是一共卖多少）
    const wanted = new Map<TypeId, number>()
    for (const { typeId, qty } of items) wanted.set(typeId, (wanted.get(typeId) ?? 0) + quantityOf(qty))
    const market = this.options.registry.get(marketKey)
    if (market && usesStructureSource(market)) await this.touchUntil(market, deadlineAt)
    const quotes = await Promise.all([...wanted].map(([typeId, qty]) => this.quote(marketKey, typeId, qty, { deadlineAt, touch: false, lane: opts.lane })))
    return new Map(quotes.map((q) => [q.typeId, q]))
  }

  cached(marketKey: string, typeId: TypeId): boolean {
    const market = this.options.registry.get(marketKey)
    if (!market) return false
    const route = routeOf(market, typeId)
    if (route.kind === 'region') return this.regions.fresh(route.regionId, typeId)
    // 建筑市场读内存，不用等
    return route.kind === 'structure'
  }

  sources(): MarketSourceStatus[] {
    return this.options.registry.all().map((market) => {
      if (usesStructureSource(market)) return this.structures.status(market)
      const stat = this.stats.get(market.key)
      return {
        marketKey: market.key,
        name: market.name,
        type: market.type,
        source: 'region',
        state: stat.failing ? 'DEGRADED' : 'OK',
        paused: false,
        lastRequestAt: stat.lastRequestAt,
        lastSyncAt: null,
        lastSuccessAt: stat.lastSuccessAt,
        lastError: stat.lastError,
        lastErrorAt: stat.lastErrorAt,
        pages: null,
        orders: null,
      }
    })
  }

  async resync(marketKey?: string): Promise<void> {
    const markets = marketKey === undefined ? this.options.registry.all() : [this.options.registry.get(marketKey)]
    const targets = markets.filter((m): m is MarketDef => !!m && usesStructureSource(m))
    if (targets.length) await this.structures.resync(targets)
  }

  async touch(marketKey: string, waitMs = QUERY_DEADLINE_MS): Promise<void> {
    const market = this.options.registry.get(marketKey)
    if (market && usesStructureSource(market)) await this.touchUntil(market, this.now() + waitMs)
  }

  available(marketKey: string): MarketAvailability {
    const market = this.options.registry.get(marketKey)
    if (!market) return { status: 'unavailable' }
    if (usesStructureSource(market)) return this.structures.available(market)
    // 不用授权的建筑要靠星域订单，必须知道星域；NPC 市场按物品逐个请求，整个市场总是可用
    return market.regionId === null ? { status: 'unavailable' } : { status: 'ok' }
  }

  // ------------------------------------------------------------------ 内部

  private now(): number {
    return this.options.clock.now()
  }

  private async quote(marketKey: string, typeId: TypeId, qty: number, how: { deadlineAt: number; touch: boolean; lane?: EsiLane }): Promise<PriceQuote> {
    const market = this.options.registry.get(marketKey)
    if (!market) return emptyQuote({ marketKey, typeId, source: 'region' }, 'unavailable', { detail: '没有这个市场' })
    const route = routeOf(market, typeId)
    switch (route.kind) {
      case 'region':
        return this.fromRegion({ marketKey, typeId, source: route.source }, route, qty, how)
      case 'structure':
        if (how.touch) await this.touchUntil(market, how.deadlineAt)
        return this.fromStructure(market, typeId, qty)
      case 'none':
        return emptyQuote({ marketKey, typeId, source: 'region' }, 'unavailable', { detail: route.detail })
    }
  }

  private async fromRegion(head: QuoteHead, route: Extract<Route, { kind: 'region' }>, qty: number, how: { deadlineAt: number; lane?: EsiLane }): Promise<PriceQuote> {
    this.stats.get(head.marketKey).lastRequestAt = this.now()
    const read = await this.regions.read(route.regionId, head.typeId, how.deadlineAt - this.now(), how.lane)
    const now = this.now()
    this.stats.record(head.marketKey, read, now)
    switch (read.status) {
      case 'ok':
        return filledQuote(head, summarize(read.book.orders, route.scope, qty), 'ok', bookTime(read.book), now)
      case 'stale':
        return this.degraded(filledQuote(head, summarize(read.book.orders, route.scope, qty), 'stale', bookTime(read.book), now), 'cache', now, read.error)
      case 'timeout':
        return this.degraded(emptyQuote(head, 'timeout'), undefined, now)
      case 'unavailable':
        return this.degraded(emptyQuote(head, 'unavailable'), 'esi_error', now, read.error)
    }
  }

  private degraded(quote: PriceQuote, reason: QuoteReason | undefined, now: number, error?: SafeErrorInfo): PriceQuote {
    if (reason) quote.reason = reason
    if (inDowntime(now)) quote.downtime = true
    if (error) quote.detail = errorDetail(error)
    return quote
  }

  private fromStructure(market: MarketDef, typeId: TypeId, qty: number): PriceQuote {
    const head: QuoteHead = { marketKey: market.key, typeId, source: 'structure' }
    const read = this.structures.read(market, typeId)
    const extra = (quote: PriceQuote) => {
      if (read.reason) quote.reason = read.reason
      if (read.detail) quote.detail = read.detail
      return quote
    }
    if (read.status !== 'ok' && read.status !== 'stale') return extra(emptyQuote(head, read.status))
    return extra(filledQuote(head, summarize(read.orders, {}, qty), read.status, read.dataTime, this.now()))
  }

  /** 建筑市场：恢复暂停的同步，数据太旧时最多等到 deadlineAt；出错不影响报价（报价看 read 的状态） */
  private async touchUntil(market: MarketDef, deadlineAt: number): Promise<void> {
    const waitMs = Math.max(0, deadlineAt - this.now())
    try {
      await withDeadline(this.structures.touch(market, waitMs), waitMs, this.options.scheduler)
    } catch (e) {
      this.options.logger.warn(`建筑市场「${market.name}」恢复同步失败：${describeError(e)}`)
    }
  }
}

export function createMarketService(options: MarketServiceOptions): ManagedMarketService {
  return new Service(options)
}
