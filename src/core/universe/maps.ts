// 势力图、联盟势力图（§2.10、§6.9）：控制台里配置的两个图片地址，经 HttpClient 端口下载，原样缓存在 BlobCache（maps/）里。
// - 60 分钟内直接用缓存；过期后带 If-None-Match / If-Modified-Since 再请求，没变（304）就只记下检查时间；
// - 启动时先读本地缓存，过一会儿（错开启动时的数据加载）预取，之后每 60 分钟左右在后台更新一次；
// - 更新失败时继续发旧图并标出；连旧图都没有才算失败。失败后几分钟内群友再要也不重试，直接回答；
// - 只收 PNG、JPEG（按文件头判断，不信 Content-Type），超过 MAP_MAX_BYTES 的不收，不转码。

import { MAP_CACHE_MIN, MAP_MAX_BYTES, MAP_TIMEOUT_MS } from '../../constants'
import { parseHttpDate, userAgent } from '../esi'
import { NetworkError } from '../ports'
import type { BlobCache, Clock, HttpClient, Logger, Scheduler } from '../ports'
import type { CoreFailure, ImageMime, InfluenceMap, InfluenceMapKind, InfluenceMapService } from '../types'
import { SingleFlight, describeError, sniffImage, withDeadline } from '../util'
import type { Random } from '../util'

export const MAP_KINDS: readonly InfluenceMapKind[] = ['influence', 'coalition']
/** 启动后多久预取（本地缓存还新鲜时等它过期再更新） */
export const MAP_WARM_DELAY_MS = 15_000
/** 更新失败后，群友的请求至少隔这么久才再试一次（这期间直接发旧图或回答取不到） */
export const MAP_RETRY_MS = 5 * 60_000
/** 缓存过期、手上有旧图时最多等新图多久；等不到先发旧图，下载在后台继续 */
export const MAP_REVALIDATE_WAIT_MS = 2000
/** 后台更新时间再往后随机推迟最多这么久，两张图、多个实例不挤在同一时刻 */
const SPREAD_MS = 60_000
const TTL_MS = MAP_CACHE_MIN * 60_000
const ACCEPT = 'image/png,image/jpeg;q=0.9,*/*;q=0.1'
const META_VERSION = 1

const LABELS: Record<InfluenceMapKind, string> = { influence: '势力图', coalition: '联盟势力图' }
/** BlobCache 的键 */
export function mapCacheKey(kind: InfluenceMapKind): string {
  return `maps/${kind}`
}

interface Entry {
  url: string
  body: Buffer
  mime: ImageMime
  etag?: string
  /** 原样的 Last-Modified，条件请求时带回去 */
  lastModified?: string
  updatedAt: number
  checkedAt: number
}

interface Slot {
  kind: InfluenceMapKind
  url: string
  entry: Entry | null
  loaded?: Promise<void>
  /** 最近一次更新失败的时间；成功后清空 */
  failedAt: number | null
  lastError: string
  tooLarge: boolean
  /** 连续失败时只在第一次写 warn */
  warned: boolean
  cancel?: () => void
}

const optString = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 本地缓存 → Entry；地址变了、文件头不对、太大、字段坏了都不要 */
function entryFrom(body: Buffer, meta: Record<string, unknown>, url: string, now: number): Entry | null {
  if (meta.v !== META_VERSION || meta.url !== url || body.length > MAP_MAX_BYTES) return null
  const mime = sniffImage(body)
  const updatedAt = finite(meta.updatedAt)
  const checkedAt = finite(meta.checkedAt)
  if (!mime || updatedAt === null || checkedAt === null) return null
  // body 是读出来的整个缓存文件里的一段：Buffer 交给机器人时只按这一段编码，不用复制
  const entry: Entry = { url, body, mime, updatedAt: Math.min(updatedAt, now), checkedAt: Math.min(checkedAt, now) }
  const etag = optString(meta.etag)
  const lastModified = optString(meta.lastModified)
  if (etag) entry.etag = etag
  if (lastModified) entry.lastModified = lastModified
  return entry
}

export interface InfluenceMapsOptions {
  http: HttpClient
  cache: BlobCache
  clock: Clock
  scheduler: Scheduler
  logger: Logger
  /** 控制台「图片与截图」里的两个地址；空字符串 = 不提供这张图 */
  urls: Record<InfluenceMapKind, string>
  /** 插件版本，写进 User-Agent */
  version: string
  random?: Random
}

export interface ManagedInfluenceMaps extends InfluenceMapService {
  /** 读本地缓存，排好预取和后台更新（重复调用没有影响） */
  start(): void
  /** 取消定时器，中止进行中的下载 */
  stop(): void
}

class InfluenceMaps implements ManagedInfluenceMaps {
  private readonly slots: Record<InfluenceMapKind, Slot>
  private readonly flights = new SingleFlight<InfluenceMapKind, Entry | null>()
  private readonly life = new AbortController()
  private readonly userAgent: string
  private readonly random: Random
  private started = false

  constructor(private readonly o: InfluenceMapsOptions) {
    const slot = (kind: InfluenceMapKind): Slot => ({
      kind, url: o.urls[kind].trim(), entry: null, failedAt: null, lastError: '', tooLarge: false, warned: false,
    })
    this.slots = { influence: slot('influence'), coalition: slot('coalition') }
    this.userAgent = userAgent(o.version)
    this.random = o.random ?? Math.random
  }

  private get stopped(): boolean {
    return this.life.signal.aborted
  }

  start() {
    if (this.started || this.stopped) return
    this.started = true
    for (const slot of Object.values(this.slots)) {
      if (!slot.url) continue
      void this.load(slot).then(() => {
        const fresh = slot.entry && !this.due(slot, this.o.clock.now())
        this.schedule(slot, fresh ? this.nextDelay(slot) : MAP_WARM_DELAY_MS + this.spread())
      })
    }
  }

  stop() {
    if (this.stopped) return
    this.life.abort(new NetworkError('aborted'))
    for (const slot of Object.values(this.slots)) {
      slot.cancel?.()
      slot.cancel = undefined
    }
  }

  cached(kind: InfluenceMapKind): boolean {
    const slot = this.slots[kind]
    return !!slot.url && slot.entry !== null
  }

  async get(kind: InfluenceMapKind): Promise<InfluenceMap | CoreFailure> {
    const slot = this.slots[kind]
    if (!slot.url) return { ok: false, code: 'NOT_CONFIGURED', message: `没有配置${LABELS[kind]}的地址` }
    await this.load(slot)
    const now = this.o.clock.now()
    const quiet = this.stopped || (slot.failedAt !== null && now - slot.failedAt < MAP_RETRY_MS)
    const old = slot.entry
    if (old) {
      if (!this.due(slot, now) || quiet) return this.view(slot, old)
      // refresh 不会失败（失败时返回旧图），这里只是最多等一会儿
      await withDeadline(this.refresh(slot), MAP_REVALIDATE_WAIT_MS, this.o.scheduler)
      return this.view(slot, slot.entry ?? old)
    }
    const got = quiet ? null : await this.refresh(slot)
    if (got) return this.view(slot, got)
    const failure: CoreFailure = { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: slot.lastError || `${LABELS[kind]}暂时取不到` }
    if (slot.tooLarge) failure.reason = 'too-large'
    return failure
  }

  // ---------------------------------------------------------------- 内部

  private view(slot: Slot, entry: Entry): InfluenceMap {
    return { kind: slot.kind, body: entry.body, mime: entry.mime, updatedAt: entry.updatedAt, checkedAt: entry.checkedAt, stale: slot.failedAt !== null }
  }

  /** 该重新请求了（没有图，或者上次检查超过 60 分钟） */
  private due(slot: Slot, now: number): boolean {
    return !slot.entry || now - slot.entry.checkedAt >= TTL_MS
  }

  private spread(): number {
    return Math.floor(SPREAD_MS * this.random())
  }

  /** 距离下一次后台更新：上次检查（或失败）满 60 分钟，再随机推迟一点 */
  private nextDelay(slot: Slot): number {
    const last = Math.max(slot.entry?.checkedAt ?? -Infinity, slot.failedAt ?? -Infinity)
    const wait = Number.isFinite(last) ? last + TTL_MS - this.o.clock.now() : 0
    return Math.max(0, wait) + this.spread()
  }

  private schedule(slot: Slot, delay: number) {
    if (this.stopped) return
    slot.cancel?.()
    slot.cancel = this.o.scheduler.timeout(() => void this.tick(slot), Math.max(0, delay))
  }

  private async tick(slot: Slot) {
    slot.cancel = undefined
    if (this.stopped) return
    if (this.due(slot, this.o.clock.now())) await this.refresh(slot)
    this.schedule(slot, this.nextDelay(slot))
  }

  private load(slot: Slot): Promise<void> {
    slot.loaded ??= this.readDisk(slot)
    return slot.loaded
  }

  private async readDisk(slot: Slot): Promise<void> {
    try {
      const got = await this.o.cache.read(mapCacheKey(slot.kind))
      const entry = got && entryFrom(got.body, got.meta, slot.url, this.o.clock.now())
      // 读盘期间已经下载到新图时不覆盖
      if (entry && !slot.entry) slot.entry = entry
    } catch (e) {
      this.o.logger.warn(`${LABELS[slot.kind]}的本地缓存读不了，重新下载：${describeError(e)}`)
    }
  }

  /** 同一张图同时只下载一次；不会失败：失败时返回旧图（没有就是 null） */
  private refresh(slot: Slot): Promise<Entry | null> {
    return this.flights.run(slot.kind, () => this.download(slot))
  }

  private async download(slot: Slot): Promise<Entry | null> {
    const old = slot.entry
    const headers: Record<string, string> = { Accept: ACCEPT, 'User-Agent': this.userAgent }
    if (old?.etag) headers['If-None-Match'] = old.etag
    if (old?.lastModified) headers['If-Modified-Since'] = old.lastModified
    try {
      if (this.stopped) throw new NetworkError('aborted')
      const res = await this.o.http.request({
        method: 'GET', url: slot.url, headers, timeoutMs: MAP_TIMEOUT_MS, maxBytes: MAP_MAX_BYTES, signal: this.life.signal,
      })
      const now = this.o.clock.now()
      if (res.status === 304 && old) {
        old.checkedAt = now
        return this.succeeded(slot, old)
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      if (res.body.length > MAP_MAX_BYTES) throw new NetworkError('too-large', `超过 ${MAP_MAX_BYTES} 字节`)
      const mime = sniffImage(res.body)
      if (!mime) throw new Error(`不是 PNG 或 JPEG 图片（${res.body.length} 字节）`)
      const lastModified = optString(res.header('last-modified'))
      // 来源不给 Last-Modified 时，图片没变就沿用原来的更新时间
      const unchanged = old && old.body.equals(res.body) ? old : null
      const updatedAt = parseHttpDate(lastModified) ?? unchanged?.updatedAt ?? now
      const entry: Entry = { url: slot.url, body: res.body, mime, updatedAt: Math.min(updatedAt, now), checkedAt: now }
      const etag = optString(res.header('etag'))
      if (etag) entry.etag = etag
      if (lastModified) entry.lastModified = lastModified
      slot.entry = entry
      await this.save(slot, entry)
      return this.succeeded(slot, entry)
    } catch (e) {
      return this.failed(slot, e)
    }
  }

  private succeeded(slot: Slot, entry: Entry): Entry {
    if (slot.warned) this.o.logger.info(`${LABELS[slot.kind]}恢复更新`)
    slot.failedAt = null
    slot.lastError = ''
    slot.tooLarge = false
    slot.warned = false
    return entry
  }

  private failed(slot: Slot, error: unknown): Entry | null {
    if (this.stopped) return slot.entry
    slot.failedAt = this.o.clock.now()
    slot.lastError = describeError(error)
    slot.tooLarge = error instanceof NetworkError && error.kind === 'too-large'
    const text = `${LABELS[slot.kind]}更新失败${slot.entry ? '，先用旧图' : ''}：${slot.lastError}`
    if (slot.warned) {
      this.o.logger.debug(text)
    } else {
      slot.warned = true
      this.o.logger.warn(text)
    }
    return slot.entry
  }

  private async save(slot: Slot, entry: Entry) {
    const meta: Record<string, unknown> = { v: META_VERSION, url: entry.url, mime: entry.mime, updatedAt: entry.updatedAt, checkedAt: entry.checkedAt }
    if (entry.etag) meta.etag = entry.etag
    if (entry.lastModified) meta.lastModified = entry.lastModified
    try {
      await this.o.cache.write(mapCacheKey(slot.kind), entry.body, meta)
    } catch (e) {
      this.o.logger.warn(`${LABELS[slot.kind]}写不进本地缓存（这次照样能发）：${describeError(e)}`)
    }
  }
}

export function createInfluenceMaps(options: InfluenceMapsOptions): ManagedInfluenceMaps {
  return new InfluenceMaps(options)
}
