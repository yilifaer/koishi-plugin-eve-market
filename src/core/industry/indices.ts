// 星系成本指数（/industry/systems）和调整价（/markets/prices）（§6.7.7、§9.1、§9.4）。两份都是全量列表，经 core/esi 请求：
// - 没过期（约 1 小时，以 ESI 的过期头为准）直接用手上的；过期后请求，有旧数据时最多等一会儿，等不到或失败就先用旧的并标出；
// - 同一份同时只请求一次（后台预取进行中时群友来查，请求改走交互池）；失败后 FAILURE_MEMO_SEC 秒内不再请求；
// - 旧数据最多用 INDUSTRY_STALE_HOURS 小时；
// - 启动后过一会儿在后台预取，第一次工业计算不用等；
// - 转换好的表放在模块级存储里，控制台保存配置（插件重载）后还在。

import { FAILURE_MEMO_SEC, INDUSTRY_STALE_HOURS, QUERY_DEADLINE_MS } from '../../constants'
import { isEsiError } from '../esi'
import type { EsiApi, EsiCallOptions, EsiIndustrySystem, EsiLane, EsiMarketPrice, EsiResult } from '../esi'
import type { Clock, Logger, ModuleStore, Scheduler } from '../ports'
import type { CoreFailure, IndustryActivity, TypeId } from '../types'
import { SingleFlight, describeError, withDeadline } from '../util'
import type { Random } from '../util'

/** 启动后多久预取，再随机推迟最多 INDICES_WARM_SPREAD_MS（和数据加载、势力图预取错开） */
export const INDICES_WARM_DELAY_MS = 10_000
export const INDICES_WARM_SPREAD_MS = 10_000
/** 手上有旧数据、已经过期时，最多等新数据多久；等不到先用旧的，请求在后台做完 */
export const INDICES_REVALIDATE_WAIT_MS = 1500
/** 模块级存储的键（后面接 /indices、/prices） */
export const INDICES_STORE_KEY = 'industry/indices'

const STALE_MS = INDUSTRY_STALE_HOURS * 3600_000
const FAILURE_MS = FAILURE_MEMO_SEC * 1000
const ACTIVITIES: readonly IndustryActivity[] = ['manufacturing', 'reaction']

export type IndicesEsi = Pick<EsiApi, 'industrySystems' | 'prices'>

/** 星系 → 活动 → 星系成本指数（小数：0.0231 = 2.31%） */
export type CostIndices = ReadonlyMap<number, Readonly<Partial<Record<IndustryActivity, number>>>>

export interface SystemIndices {
  /** 不在列表里的星系没有（按 0 算并警告由调用方决定） */
  bySystem: CostIndices
  /** ESI 的 Last-Modified；没有这个头时是取到的时间 */
  dataTime: number
  /** 已经过期：更新失败或者等不到新的，用的是旧数据 */
  stale: boolean
}

export interface AdjustedPrices {
  /** typeID → 调整价；ESI 没给调整价的物品不在里面 */
  byType: ReadonlyMap<TypeId, number>
  dataTime: number
  stale: boolean
}

export interface IndexFetchOptions {
  /** 一份都没有时最多等多久（默认 QUERY_DEADLINE_MS）；等不到回答 UPSTREAM_UNAVAILABLE，请求在后台做完 */
  deadlineMs?: number
}

export interface IndustryIndices {
  /** 一份都没有、又取不到 → UPSTREAM_UNAVAILABLE */
  systemIndices(opts?: IndexFetchOptions): Promise<SystemIndices | CoreFailure>
  adjustedPrices(opts?: IndexFetchOptions): Promise<AdjustedPrices | CoreFailure>
  /** 「市场状态」：两份数据的时间（ESI 的 Last-Modified）；还没有时 null */
  status(): { indicesAt: number | null; adjustedPricesAt: number | null }
  /** 排上启动预取（重复调用没有影响） */
  start(): void
  /** 取消预取；进行中的请求由 ESI 客户端停用时中止 */
  stop(): void
}

export interface IndustryIndicesOptions {
  esi: IndicesEsi
  clock: Clock
  scheduler: Scheduler
  logger?: Logger
  /** 放转换好的表；不给时只在这个实例里 */
  store?: ModuleStore
  random?: Random
}

/** 某个星系某种活动的星系成本指数；星系不在列表里时 undefined */
export function costIndexOf(indices: Pick<SystemIndices, 'bySystem'>, systemId: number, activity: IndustryActivity): number | undefined {
  return indices.bySystem.get(systemId)?.[activity]
}

// ------------------------------------------------------------------ 转换

export function indicesTable(rows: readonly EsiIndustrySystem[]): CostIndices {
  const out = new Map<number, Partial<Record<IndustryActivity, number>>>()
  for (const row of rows) {
    const entry: Partial<Record<IndustryActivity, number>> = {}
    for (const activity of ACTIVITIES) {
      const value = row.costIndices[activity]
      if (value !== undefined && Number.isFinite(value) && value >= 0) entry[activity] = value
    }
    out.set(row.systemId, entry)
  }
  return out
}

export function adjustedTable(rows: readonly EsiMarketPrice[]): ReadonlyMap<TypeId, number> {
  const out = new Map<TypeId, number>()
  for (const row of rows) {
    if (row.adjustedPrice !== null && Number.isFinite(row.adjustedPrice) && row.adjustedPrice >= 0) out.set(row.typeId, row.adjustedPrice)
  }
  return out
}

// ------------------------------------------------------------------ 一份数据

type Kind = 'indices' | 'prices'

const LABELS: Record<Kind, string> = { indices: '星系成本指数', prices: '调整价' }

interface Snapshot<T> {
  table: T
  dataTime: number
  validatedAt: number
  expiresAt: number
  etag?: string
}

/** 放在模块级存储里的部分：插件重载后还在 */
interface Box<T> {
  snap: Snapshot<T> | null
}

interface Source<Raw, T> {
  kind: Kind
  call(opts: EsiCallOptions): Promise<EsiResult<Raw>>
  convert(raw: Raw): T
}

class Slot<Raw, T> {
  private readonly flights = new SingleFlight<'one', Snapshot<T> | null>()
  private flightLane: EsiLane | null = null
  private failedAt: number | null = null
  private lastError = ''
  private warned = false

  private readonly box: Box<T>

  constructor(
    private readonly source: Source<Raw, T>,
    private readonly o: IndustryIndicesOptions,
    private readonly isStopped: () => boolean,
  ) {
    const create = (): Box<T> => ({ snap: null })
    this.box = o.store ? o.store.get(`${INDICES_STORE_KEY}/${source.kind}`, create) : create()
  }

  get snap(): Snapshot<T> | null {
    return this.box.snap
  }

  /** 没过期 */
  fresh(now: number): boolean {
    return !!this.snap && now < this.snap.expiresAt
  }

  async get(deadlineMs: number): Promise<{ snap: Snapshot<T>; stale: boolean } | CoreFailure> {
    const { clock, scheduler } = this.o
    const now = clock.now()
    const old = this.usable(now)
    if (old && now < old.expiresAt) return { snap: old, stale: false }
    // 刚失败过：这段时间里不再请求
    const quiet = this.isStopped() || (this.failedAt !== null && now - this.failedAt < FAILURE_MS)
    if (!quiet) {
      try {
        await withDeadline(this.refresh('interactive'), old ? INDICES_REVALIDATE_WAIT_MS : deadlineMs, scheduler)
      } catch {
        // refresh 不会失败；这里只是保险
      }
    }
    const later = clock.now()
    const latest = this.usable(later)
    if (latest) return { snap: latest, stale: later >= latest.expiresAt }
    const why = this.lastError || (quiet ? '刚才取不到' : '等不到 ESI 的回复')
    return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: `${LABELS[this.source.kind]}暂时取不到：${why}` }
  }

  /** 同一份同时只请求一次；不会失败：失败时返回手上的（可能是 null） */
  refresh(lane: EsiLane): Promise<Snapshot<T> | null> {
    if (this.flights.has('one')) {
      // 后台预取还在排队：再以交互请求叫一次，ESI 客户端会把排队中的请求合并、改走交互池
      if (lane === 'interactive' && this.flightLane === 'background') {
        this.flightLane = 'interactive'
        this.source.call({ lane }).catch(() => undefined)
      }
    }
    return this.flights.run('one', () => {
      this.flightLane = lane
      return this.fetch(lane).finally(() => { this.flightLane = null })
    })
  }

  private usable(now: number): Snapshot<T> | null {
    const snap = this.snap
    return snap && now - snap.validatedAt <= STALE_MS ? snap : null
  }

  private async fetch(lane: EsiLane): Promise<Snapshot<T> | null> {
    let result: EsiResult<Raw>
    try {
      if (this.isStopped()) return this.snap
      result = await this.source.call({ lane })
    } catch (e) {
      return this.failed(e)
    }
    const old = this.snap
    if (result.stale) {
      // ESI 客户端退回的旧缓存：比手上的新才换上，仍然算失败
      if (!old || result.validatedAt > old.validatedAt) this.box.snap = this.toSnapshot(result, old)
      return this.failed(result.error ?? new Error('ESI 返回了旧数据'))
    }
    this.box.snap = this.toSnapshot(result, old)
    if (this.warned) this.o.logger?.info(`${LABELS[this.source.kind]}恢复更新`)
    this.failedAt = null
    this.lastError = ''
    this.warned = false
    return this.snap
  }

  /** 内容没变（同一个 ETag、同一个 Last-Modified）时沿用转换好的表 */
  private toSnapshot(result: EsiResult<Raw>, old: Snapshot<T> | null): Snapshot<T> {
    const dataTime = result.lastModified ?? result.validatedAt
    const same = old && result.etag !== undefined && old.etag === result.etag && old.dataTime === dataTime
    const snap: Snapshot<T> = {
      table: same ? old.table : this.source.convert(result.value),
      dataTime,
      validatedAt: result.validatedAt,
      expiresAt: result.expiresAt,
    }
    if (result.etag !== undefined) snap.etag = result.etag
    return snap
  }

  private failed(error: unknown): Snapshot<T> | null {
    // 停用、或者只是调用方不等了，不算失败
    if (this.isStopped() || (isEsiError(error) && error.abandoned)) return this.snap
    this.failedAt = this.o.clock.now()
    this.lastError = describeError(error)
    const text = `${LABELS[this.source.kind]}更新失败${this.snap ? '，先用旧数据' : ''}：${this.lastError}`
    if (this.warned) {
      this.o.logger?.debug(text)
    } else {
      this.warned = true
      this.o.logger?.warn(text)
    }
    return this.snap
  }
}

// ------------------------------------------------------------------ 服务

class Indices implements IndustryIndices {
  private readonly indices: Slot<readonly EsiIndustrySystem[], CostIndices>
  private readonly prices: Slot<readonly EsiMarketPrice[], ReadonlyMap<TypeId, number>>
  private started = false
  private stopped = false
  private cancelWarm?: () => void

  constructor(private readonly o: IndustryIndicesOptions) {
    const isStopped = () => this.stopped
    this.indices = new Slot({ kind: 'indices', call: (opts) => o.esi.industrySystems(opts), convert: indicesTable }, o, isStopped)
    this.prices = new Slot({ kind: 'prices', call: (opts) => o.esi.prices(opts), convert: adjustedTable }, o, isStopped)
  }

  async systemIndices(opts: IndexFetchOptions = {}): Promise<SystemIndices | CoreFailure> {
    const got = await this.indices.get(opts.deadlineMs ?? QUERY_DEADLINE_MS)
    if ('ok' in got) return got
    return { bySystem: got.snap.table, dataTime: got.snap.dataTime, stale: got.stale }
  }

  async adjustedPrices(opts: IndexFetchOptions = {}): Promise<AdjustedPrices | CoreFailure> {
    const got = await this.prices.get(opts.deadlineMs ?? QUERY_DEADLINE_MS)
    if ('ok' in got) return got
    return { byType: got.snap.table, dataTime: got.snap.dataTime, stale: got.stale }
  }

  status() {
    return { indicesAt: this.indices.snap?.dataTime ?? null, adjustedPricesAt: this.prices.snap?.dataTime ?? null }
  }

  start() {
    if (this.started || this.stopped) return
    this.started = true
    const random = this.o.random ?? Math.random
    const delay = INDICES_WARM_DELAY_MS + Math.floor(INDICES_WARM_SPREAD_MS * random())
    this.cancelWarm = this.o.scheduler.timeout(() => {
      this.cancelWarm = undefined
      if (this.stopped) return
      const now = this.o.clock.now()
      for (const slot of [this.indices, this.prices] as const) {
        if (!slot.fresh(now)) void slot.refresh('background')
      }
    }, delay)
  }

  stop() {
    this.stopped = true
    this.cancelWarm?.()
    this.cancelWarm = undefined
  }
}

export function createIndustryIndices(options: IndustryIndicesOptions): IndustryIndices {
  return new Indices(options)
}
