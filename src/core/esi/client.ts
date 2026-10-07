// ESI 的 HTTP 层：请求头、缓存和条件请求、分页一致性、限流和错误额度、重试、两个并发池、
// 同一请求合并（single-flight）、时限。不懂业务，路由的类型化封装在 routes.ts。

import {
  BACKGROUND_POOL,
  COMPATIBILITY_DATE,
  ESI_BACKGROUND_TIMEOUT_MS,
  ESI_BASE,
  ESI_PAGE_CONCURRENCY,
  ESI_RETRY_DELAY_MS,
  ESI_TIMEOUT_MS,
  INTERACTIVE_POOL,
  PROJECT_URL,
  USER_AGENT_PRODUCT,
} from '../../constants'
import { NetworkError } from '../ports'
import type { CorePorts, HttpResponse } from '../ports'
import type { EsiStatus } from '../types'
import { Pool, describeError, mapLimit, randomBetween, redact, sleep } from '../util'
import type { Random } from '../util'
import { MemoryResponseCache } from './cache'
import type { EsiCacheEntry, EsiCacheStore } from './cache'
import { EsiError } from './errors'
import type { EsiErrorKind } from './errors'
import { freshUntil, parseCount, parseHttpDate } from './headers'
import { EsiLimits, createLimitState } from './ratelimit'
import type { EsiLane, LimitState } from './ratelimit'

export type EsiPorts = Pick<CorePorts, 'http' | 'clock' | 'scheduler' | 'logger' | 'cache' | 'store' | 'version'>

/** ESI 响应的内存缓存上限，按响应体字节数估算 */
export const ESI_CACHE_MAX_BYTES = 32 * 1024 * 1024
/** 单个响应体的上限（/industry/systems、/markets/prices 约 1–2 MB） */
export const ESI_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
/** 分页最多取几页；X-Pages 更大时当作异常响应 */
export const ESI_MAX_PAGES = 200
/** 模块级存储的键：响应缓存和限流状态，控制台保存配置后还在 */
export const ESI_STORE_KEY = 'esi'
/** BlobCache 里的暂停窗口（重启后还记得） */
export const ESI_META_KEY = 'esi-meta.json'
/** 这些状态码重试一次 */
const RETRY_STATUS = new Set([500, 502, 503, 504])

export type EsiLanguage = 'en' | 'zh'

export interface EsiRequest<T> {
  method?: 'GET' | 'POST'
  /** 路由模板，日志和限流分组用，例如 'GET /markets/{region_id}/orders' */
  route: string
  /** 实际路径，例如 '/markets/10000002/orders' */
  path: string
  query?: Record<string, string | number | undefined>
  /** POST 的请求体，按 JSON 发送 */
  body?: unknown
  /** OpenAPI 里声明的限流组；不写时从响应头学 */
  group?: string
  /** 响应头里没有缓存时间时用（§9.1） */
  ttlSec: number
  language?: EsiLanguage
  /** JSON → 类型化的值；格式不对时抛错 */
  parse(json: unknown): T
}

/** 带授权的请求：access token 由 SSO 那边给，收到 401 时 force = true 先刷新再试一次 */
export interface EsiAuth {
  /** 授权档案名，区分缓存（不同档案看到的建筑市场可能不一样） */
  profile: string
  token(force: boolean): Promise<string>
}

export interface EsiCallOptions {
  /** 交互请求和后台任务各用一个并发池；默认交互 */
  lane?: EsiLane
  /** 调用方不再等了：请求本身照样做完，结果写进缓存 */
  signal?: AbortSignal
  /** 最多等多久（毫秒），到时间抛 deadline 错误；请求同样在后台做完 */
  deadlineMs?: number
  /** 单次请求的超时；默认交互 10 秒、后台 30 秒 */
  timeoutMs?: number
  /** 请求失败（包括限流暂停）时，最多用多久以前确认过的缓存；0 = 不用 */
  staleIfErrorMs?: number
  auth?: EsiAuth
  /** 换一个缓存存放处（默认是内存） */
  store?: EsiCacheStore
}

export interface EsiResult<T> {
  value: T
  /** Last-Modified；没有这个头时 null */
  lastModified: number | null
  expiresAt: number
  /** 最近一次 200 或 304 的时间 */
  validatedAt: number
  etag?: string
  /** 用的是缓存：没过期时没有发请求；stale 时是请求失败后退回的旧缓存 */
  cached: boolean
  /** 请求失败，用的是以前的缓存；error 是失败的原因 */
  stale: boolean
  error?: EsiError
}

export interface EsiPagedResult<T> extends EsiResult<T[]> {
  pages: number
  /** 重来一次后各页的 Last-Modified 还是不一样，结果可能混了新旧数据 */
  inconsistent: boolean
}

export interface EsiClientOptions {
  base?: string
  compatibilityDate?: string
  /** 控制台「高级」里的 esiContact，写进 User-Agent */
  contact?: string
  random?: Random
  retryDelayMs?: { min: number; max: number }
  pools?: { interactive?: number; background?: number }
  pageConcurrency?: number
  cacheMaxBytes?: number
  maxPages?: number
  maxResponseBytes?: number
}

interface EsiModuleState {
  cache: MemoryResponseCache
  limits: LimitState
}

/** 一个进行中的请求：后来的交互请求加入时，还在后台池排队的会改去交互池 */
interface FlightCtx {
  lane: EsiLane
  promote: Set<() => void>
}

interface Flight {
  promise: Promise<unknown>
  ctx: FlightCtx
}

interface Fetched<T> {
  entry: EsiCacheEntry<T>
  cached: boolean
}

export function userAgent(version: string, contact = ''): string {
  // 括号里是注释，联系方式里的括号会破坏格式
  const clean = contact.replace(/[^\x20-\x7e]|[()]/g, ' ').replace(/\s+/g, ' ').trim()
  return `${USER_AGENT_PRODUCT}/${version} (+${PROJECT_URL}${clean ? `; ${clean}` : ''})`
}

/** 几个 signal 任何一个中止就中止；用完要 dispose，免得在长期存在的 signal 上留下监听 */
function linkSignals(...signals: AbortSignal[]): { signal: AbortSignal; dispose(): void } {
  const ctrl = new AbortController()
  const listeners: Array<[AbortSignal, () => void]> = []
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason)
      break
    }
    const onAbort = () => ctrl.abort(s.reason)
    s.addEventListener('abort', onAbort, { once: true })
    listeners.push([s, onAbort])
  }
  return { signal: ctrl.signal, dispose: () => listeners.forEach(([s, fn]) => s.removeEventListener('abort', fn)) }
}

function errorBody(body: Buffer): string | undefined {
  try {
    const json: unknown = JSON.parse(body.toString('utf8'))
    if (json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string') return (json as { error: string }).error
  } catch {
    // 不是 JSON 的错误页
  }
  return undefined
}

function consistent(entries: ReadonlyArray<Fetched<unknown>>): boolean {
  const times = new Set(entries.map((f) => f.entry.lastModified).filter((t): t is number => t !== null))
  return times.size <= 1
}

function newestModified(entries: ReadonlyArray<Fetched<unknown>>): number | undefined {
  const times = entries.map((f) => f.entry.lastModified).filter((t): t is number => t !== null)
  return times.length ? Math.max(...times) : undefined
}

function toResult<T>(entry: EsiCacheEntry<T>, cached: boolean): EsiResult<T> {
  const result: EsiResult<T> = {
    value: entry.value,
    lastModified: entry.lastModified,
    expiresAt: entry.expiresAt,
    validatedAt: entry.validatedAt,
    cached,
    stale: false,
  }
  if (entry.etag !== undefined) result.etag = entry.etag
  return result
}

function combinePages<T>(pages: ReadonlyArray<Fetched<T[]>>, inconsistent: boolean): EsiPagedResult<T> {
  const modified = pages.map((p) => p.entry.lastModified).filter((t): t is number => t !== null)
  return {
    value: pages.flatMap((p) => p.entry.value),
    lastModified: modified.length ? Math.max(...modified) : null,
    expiresAt: Math.min(...pages.map((p) => p.entry.expiresAt)),
    validatedAt: Math.min(...pages.map((p) => p.entry.validatedAt)),
    cached: pages.every((p) => p.cached),
    stale: false,
    pages: pages.length,
    inconsistent,
  }
}

export class EsiClient {
  readonly base: string
  readonly userAgent: string
  readonly limits: EsiLimits
  private readonly compatibilityDate: string
  private readonly memory: MemoryResponseCache
  private readonly pools: Record<EsiLane, Pool>
  private readonly flights = new Map<string, Flight>()
  private readonly life = new AbortController()
  private persisting: Promise<void> = Promise.resolve()
  private persisted = ''

  constructor(private readonly ports: EsiPorts, private readonly options: EsiClientOptions = {}) {
    this.base = (options.base ?? ESI_BASE).replace(/\/+$/, '')
    this.compatibilityDate = options.compatibilityDate ?? COMPATIBILITY_DATE
    this.userAgent = userAgent(ports.version, options.contact)
    const state = ports.store.get<EsiModuleState>(`${ESI_STORE_KEY}:${this.base}`, () => ({
      cache: new MemoryResponseCache(options.cacheMaxBytes ?? ESI_CACHE_MAX_BYTES),
      limits: createLimitState(),
    }))
    this.memory = state.cache
    this.limits = new EsiLimits(state.limits)
    this.pools = {
      interactive: new Pool(options.pools?.interactive ?? INTERACTIVE_POOL),
      background: new Pool(options.pools?.background ?? BACKGROUND_POOL),
    }
  }

  get stopped(): boolean {
    return this.life.signal.aborted
  }

  /** 读回上次（重启前）记下的暂停窗口 */
  async start(): Promise<void> {
    try {
      const entry = await this.ports.cache.read(ESI_META_KEY)
      if (entry) this.limits.restore(JSON.parse(entry.body.toString('utf8')), this.ports.clock.now())
    } catch (e) {
      this.ports.logger.warn(`ESI 暂停窗口的记录读不了，忽略：${describeError(e)}`)
    }
  }

  /** 插件停用：中止所有进行中和排队的请求 */
  stop() {
    if (!this.stopped) this.life.abort(new EsiError('aborted', 'ESI 客户端已停止', { route: '*' }))
  }

  /** 等暂停窗口写完（测试和停用时用） */
  flush(): Promise<void> {
    return this.persisting
  }

  status(): EsiStatus {
    return this.limits.status(this.ports.clock.now())
  }

  /** 缓存和请求合并的键：方法 + 路径和参数 + 语言 + 授权档案 + 请求体，不含 token */
  keyOf(req: EsiRequest<unknown>, auth?: EsiAuth): string {
    let key = `${req.method ?? 'GET'} ${this.pathOf(req)}`
    if (req.language) key += ` lang=${req.language}`
    if (auth) key += ` profile=${auth.profile}`
    if (req.body !== undefined) key += ` body=${JSON.stringify(req.body)}`
    return key
  }

  async request<T>(req: EsiRequest<T>, opts: EsiCallOptions = {}): Promise<EsiResult<T>> {
    const store = opts.store ?? this.memory
    const key = this.keyOf(req, opts.auth)
    try {
      const got = await this.wait(this.entry(req, key, store, opts, this.ctx(opts)), opts, req.route)
      return toResult(got.entry, got.cached)
    } catch (e) {
      const error = this.asError(e, req.route)
      const entry = await store.get(key) as EsiCacheEntry<T> | undefined
      if (!entry || !this.staleUsable(error, [entry], opts)) throw error
      return { ...toResult(entry, true), stale: true, error }
    }
  }

  /** 分页路由：先取第 1 页读 X-Pages，再并发取其余页；各页 Last-Modified 不同时从第 1 页重来一次 */
  async pages<T>(req: EsiRequest<T[]>, opts: EsiCallOptions = {}): Promise<EsiPagedResult<T>> {
    const store = opts.store ?? this.memory
    const ctx = this.ctx(opts)
    const run = () => this.fetchPages(req, store, opts, ctx)
    try {
      return await this.wait(this.flight(`pages ${this.keyOf(req, opts.auth)}`, ctx, run), opts, req.route)
    } catch (e) {
      const error = this.asError(e, req.route)
      const entries = await this.cachedPages(req, store, opts)
      if (!entries || !this.staleUsable(error, entries.map((f) => f.entry), opts)) throw error
      return { ...combinePages(entries, !consistent(entries)), stale: true, error }
    }
  }

  // ------------------------------------------------------------------ 缓存和合并

  private ctx(opts: EsiCallOptions): FlightCtx {
    return { lane: opts.lane ?? 'interactive', promote: new Set() }
  }

  /**
   * 没过期的缓存直接用（过期之前绝不重新请求）。olderThan：翻页重来时，比最新一页旧的页即使没过期也重新取
   * ——服务器上已经有更新的数据，说明这些页在 ESI 那边已经过期了。
   */
  private async entry<T>(req: EsiRequest<T>, key: string, store: EsiCacheStore, opts: EsiCallOptions, ctx: FlightCtx, olderThan?: number): Promise<Fetched<T>> {
    if (this.stopped) throw this.stoppedError(req.route)
    const hit = await store.get(key) as EsiCacheEntry<T> | undefined
    const modified = hit?.lastModified
    const outdated = olderThan !== undefined && typeof modified === 'number' && modified < olderThan
    if (hit && this.ports.clock.now() < hit.expiresAt && !outdated) return { entry: hit, cached: true }
    const entry = await this.flight(key, ctx, () => this.fetch(req, key, store, opts, ctx))
    return { entry, cached: false }
  }

  private flight<V>(key: string, ctx: FlightCtx, run: () => Promise<V>): Promise<V> {
    const existing = this.flights.get(key)
    if (existing) {
      if (ctx.lane === 'interactive') this.promote(existing.ctx)
      return existing.promise as Promise<V>
    }
    const promise = run().finally(() => {
      if (this.flights.get(key)?.promise === promise) this.flights.delete(key)
    })
    // 所有调用方都不等了也不算未处理的拒绝
    promise.catch(() => {})
    this.flights.set(key, { promise, ctx })
    return promise
  }

  private promote(ctx: FlightCtx) {
    if (ctx.lane === 'interactive') return
    ctx.lane = 'interactive'
    for (const fn of ctx.promote) fn()
  }

  /** 调用方的 signal 和 deadlineMs 只影响自己等不等，不中止共享的请求 */
  private wait<R>(promise: Promise<R>, opts: EsiCallOptions, route: string): Promise<R> {
    const { signal, deadlineMs } = opts
    if (!signal && deadlineMs === undefined) return promise
    return new Promise<R>((resolve, reject) => {
      let done = false
      let cancel: (() => void) | undefined
      const finish = (fn: () => void) => {
        if (done) return
        done = true
        cancel?.()
        signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const onAbort = () => finish(() => reject(new EsiError('aborted', '调用方不再等这个请求', { route })))
      if (deadlineMs !== undefined) {
        cancel = this.ports.scheduler.timeout(() => {
          finish(() => reject(new EsiError('deadline', `${deadlineMs} 毫秒内没有结果`, { route })))
        }, deadlineMs)
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)))
    })
  }

  private staleUsable(error: EsiError, entries: ReadonlyArray<EsiCacheEntry<unknown>>, opts: EsiCallOptions): boolean {
    if (error.kind === 'aborted' || error.kind === 'deadline') return false
    const maxAge = opts.staleIfErrorMs ?? 0
    if (!(maxAge > 0) || !entries.length) return false
    const oldest = Math.min(...entries.map((e) => e.validatedAt))
    return this.ports.clock.now() - oldest <= maxAge
  }

  // ------------------------------------------------------------------ 分页

  private async fetchPages<T>(req: EsiRequest<T[]>, store: EsiCacheStore, opts: EsiCallOptions, ctx: FlightCtx): Promise<EsiPagedResult<T>> {
    const first = await this.collectPages(req, store, opts, ctx)
    if (consistent(first)) return combinePages(first, false)
    this.ports.logger.debug(`ESI ${req.route} 翻页途中数据更新了，从第 1 页重新取`)
    const second = await this.collectPages(req, store, opts, ctx, newestModified(first))
    if (consistent(second)) return combinePages(second, false)
    this.ports.logger.warn(`ESI ${req.route} 重取后各页的 Last-Modified 还是不一样，先用这份数据`)
    return combinePages(second, true)
  }

  private async collectPages<T>(req: EsiRequest<T[]>, store: EsiCacheStore, opts: EsiCallOptions, ctx: FlightCtx, olderThan?: number): Promise<Array<Fetched<T[]>>> {
    const page = (n: number) => {
      const pageReq = this.pageRequest(req, n)
      return this.entry(pageReq, this.keyOf(pageReq, opts.auth), store, opts, ctx, olderThan)
    }
    const first = await page(1)
    const total = this.pageCount(req, first.entry)
    const rest = await mapLimit(Array.from({ length: total - 1 }, (_, i) => i + 2), this.options.pageConcurrency ?? ESI_PAGE_CONCURRENCY, page)
    return [first, ...rest]
  }

  /** 出错时拼出缓存里的全部页；缺任何一页就不能用 */
  private async cachedPages<T>(req: EsiRequest<T[]>, store: EsiCacheStore, opts: EsiCallOptions): Promise<Array<Fetched<T[]>> | null> {
    const get = async (n: number) => {
      const pageReq = this.pageRequest(req, n)
      return await store.get(this.keyOf(pageReq, opts.auth)) as EsiCacheEntry<T[]> | undefined
    }
    const first = await get(1)
    if (!first) return null
    const out: Array<Fetched<T[]>> = [{ entry: first, cached: true }]
    const total = Math.min(first.pages ?? 1, this.options.maxPages ?? ESI_MAX_PAGES)
    for (let n = 2; n <= total; n++) {
      const entry = await get(n)
      if (!entry) return null
      out.push({ entry, cached: true })
    }
    return out
  }

  private pageRequest<T>(req: EsiRequest<T>, page: number): EsiRequest<T> {
    return { ...req, query: { ...req.query, page } }
  }

  private pageCount(req: EsiRequest<unknown>, first: EsiCacheEntry<unknown>): number {
    const total = first.pages ?? 1
    const max = this.options.maxPages ?? ESI_MAX_PAGES
    if (total < 1 || total > max) {
      throw new EsiError('bad-response', `X-Pages 是 ${total}，超出了 1–${max}`, { route: req.route })
    }
    return total
  }

  // ------------------------------------------------------------------ 单次请求

  private async fetch<T>(req: EsiRequest<T>, key: string, store: EsiCacheStore, opts: EsiCallOptions, ctx: FlightCtx): Promise<EsiCacheEntry<T>> {
    let retried = false
    let refreshed = false
    for (;;) {
      this.gate(req, ctx.lane)
      const cached = await store.get(key) as EsiCacheEntry<T> | undefined
      const token = opts.auth ? await this.accessToken(req, opts.auth, refreshed) : undefined
      let res: HttpResponse
      try {
        res = await this.acquire(ctx, () => {
          // 排队期间可能收到了别的请求的 420/429
          this.gate(req, ctx.lane)
          return this.send(req, cached?.etag, token, opts.timeoutMs ?? this.timeoutOf(ctx.lane))
        })
      } catch (e) {
        const error = this.transportError(e, req.route, token)
        if (retried || (error.kind !== 'network' && error.kind !== 'timeout')) throw error
        retried = true
        await this.retryDelay(req.route, error.message)
        continue
      }
      const now = this.ports.clock.now()
      if (this.limits.observe(req.route, req.group, res.status, res, now)) this.persist(now)
      const entry = this.toEntry(req, res, cached, now)
      if (entry) {
        await this.save(store, key, entry, req.route)
        return entry
      }
      if (res.status === 401 && opts.auth && !refreshed) {
        refreshed = true
        continue
      }
      if (RETRY_STATUS.has(res.status) && !retried) {
        retried = true
        await this.retryDelay(req.route, `HTTP ${res.status}`)
        continue
      }
      throw this.httpError(req, res, token)
    }
  }

  /** 暂停窗口内直接失败，不发请求 */
  private gate(req: EsiRequest<unknown>, lane: EsiLane) {
    if (this.stopped) throw this.stoppedError(req.route)
    const decision = this.limits.check(req.route, req.group, lane, this.ports.clock.now())
    if (decision) throw new EsiError(decision.kind, decision.reason, { route: req.route, retryAt: decision.retryAt })
  }

  private async accessToken(req: EsiRequest<unknown>, auth: EsiAuth, force: boolean): Promise<string> {
    try {
      return await auth.token(force)
    } catch (e) {
      if (e instanceof EsiError) throw e
      throw new EsiError('auth', `取不到授权档案 ${auth.profile} 的 access token：${describeError(e)}`, { route: req.route })
    }
  }

  /** 交互池直接排队；后台池排队时如果被交互请求合并了，改去交互池 */
  private async acquire<R>(ctx: FlightCtx, task: () => Promise<R>): Promise<R> {
    const life = this.life.signal
    if (ctx.lane === 'interactive') return this.pools.interactive.run(task, life)
    const promoted = new AbortController()
    const onPromote = () => promoted.abort()
    ctx.promote.add(onPromote)
    const link = linkSignals(life, promoted.signal)
    let started = false
    try {
      return await this.pools.background.run(() => {
        started = true
        ctx.promote.delete(onPromote)
        return task()
      }, link.signal)
    } catch (e) {
      if (!started && promoted.signal.aborted && !life.aborted) return this.pools.interactive.run(task, life)
      throw e
    } finally {
      ctx.promote.delete(onPromote)
      link.dispose()
    }
  }

  private async send(req: EsiRequest<unknown>, etag: string | undefined, token: string | undefined, timeoutMs: number): Promise<HttpResponse> {
    const method = req.method ?? 'GET'
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'X-Compatibility-Date': this.compatibilityDate,
      Accept: 'application/json',
    }
    if (etag && method === 'GET') headers['If-None-Match'] = etag
    if (token) headers.Authorization = `Bearer ${token}`
    if (req.language) headers['Accept-Language'] = req.language
    let body: string | undefined
    if (req.body !== undefined) {
      body = JSON.stringify(req.body)
      headers['Content-Type'] = 'application/json'
    }
    // 端口自己也按 timeoutMs 超时；这里再用 Scheduler 兜一层，停用时也能立刻中止
    const attempt = new AbortController()
    let timedOut = false
    const cancel = this.ports.scheduler.timeout(() => {
      timedOut = true
      attempt.abort()
    }, timeoutMs)
    const link = linkSignals(this.life.signal, attempt.signal)
    try {
      return await this.ports.http.request({
        method,
        url: this.base + this.pathOf(req),
        headers,
        body,
        timeoutMs,
        maxBytes: this.options.maxResponseBytes ?? ESI_MAX_RESPONSE_BYTES,
        signal: link.signal,
      })
    } catch (e) {
      if (timedOut && !this.stopped) throw new NetworkError('timeout', `${timeoutMs} 毫秒没有响应`)
      throw e
    } finally {
      cancel()
      link.dispose()
    }
  }

  /** 200 → 新条目；304 → 旧条目换上新的过期时间；其他返回 null */
  private toEntry<T>(req: EsiRequest<T>, res: HttpResponse, cached: EsiCacheEntry<T> | undefined, now: number): EsiCacheEntry<T> | null {
    if (res.status === 304) {
      if (!cached) throw new EsiError('bad-response', '收到 304，但本地没有可用的缓存', { route: req.route, status: 304 })
      const entry: EsiCacheEntry<T> = {
        ...cached,
        lastModified: parseHttpDate(res.header('last-modified')) ?? cached.lastModified,
        expiresAt: freshUntil(res, now, req.ttlSec),
        validatedAt: now,
      }
      const etag = res.header('etag')
      if (etag) entry.etag = etag
      const pages = parseCount(res.header('x-pages'))
      if (pages !== null) entry.pages = pages
      return entry
    }
    if (res.status < 200 || res.status >= 300) return null
    const entry: EsiCacheEntry<T> = {
      value: this.parseBody(req, res),
      lastModified: parseHttpDate(res.header('last-modified')),
      expiresAt: freshUntil(res, now, req.ttlSec),
      validatedAt: now,
      bytes: res.body.length,
    }
    const etag = res.header('etag')
    if (etag) entry.etag = etag
    const pages = parseCount(res.header('x-pages'))
    if (pages !== null) entry.pages = pages
    return entry
  }

  private parseBody<T>(req: EsiRequest<T>, res: HttpResponse): T {
    let json: unknown
    try {
      json = JSON.parse(res.body.toString('utf8'))
    } catch {
      throw new EsiError('bad-response', '响应不是 JSON', { route: req.route, status: res.status })
    }
    try {
      return req.parse(json)
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      throw new EsiError('bad-response', `响应格式不对：${redact(why).slice(0, 200)}`, { route: req.route, status: res.status })
    }
  }

  private async save(store: EsiCacheStore, key: string, entry: EsiCacheEntry<unknown>, route: string) {
    try {
      await store.set(key, entry)
    } catch (e) {
      this.ports.logger.warn(`ESI ${route} 的响应没写进缓存：${describeError(e)}`)
    }
  }

  private async retryDelay(route: string, why: string) {
    const { min, max } = this.options.retryDelayMs ?? ESI_RETRY_DELAY_MS
    const ms = Math.round(randomBetween(min, max, this.options.random))
    this.ports.logger.debug(`ESI ${route} ${why}，${ms} 毫秒后重试一次`)
    await sleep(this.ports.scheduler, ms, this.life.signal)
  }

  private timeoutOf(lane: EsiLane): number {
    return lane === 'interactive' ? ESI_TIMEOUT_MS : ESI_BACKGROUND_TIMEOUT_MS
  }

  private pathOf(req: EsiRequest<unknown>): string {
    const params = new URLSearchParams()
    for (const [name, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) params.set(name, String(value))
    }
    const query = params.toString()
    return query ? `${req.path}?${query}` : req.path
  }

  // ------------------------------------------------------------------ 错误

  private stoppedError(route: string): EsiError {
    return new EsiError('aborted', 'ESI 客户端已停止', { route })
  }

  private asError(e: unknown, route: string): EsiError {
    if (e instanceof EsiError) return e
    return this.transportError(e, route, undefined)
  }

  /** 发送时的异常 → EsiError；文字里去掉 token */
  private transportError(e: unknown, route: string, token: string | undefined): EsiError {
    if (e instanceof EsiError) return e
    if (this.stopped) return this.stoppedError(route)
    const secrets = token ? [token] : []
    if (e instanceof NetworkError) {
      const kind: EsiErrorKind = e.kind === 'too-large' ? 'bad-response' : e.kind
      return new EsiError(kind, redact(e.message, secrets).slice(0, 200), { route, code: e.kind })
    }
    return new EsiError('network', describeError(e, undefined, secrets), { route })
  }

  private httpError(req: EsiRequest<unknown>, res: HttpResponse, token: string | undefined): EsiError {
    const secrets = token ? [token] : []
    const detail = errorBody(res.body)
    const message = redact(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`, secrets).slice(0, 200)
    const init = { route: req.route, status: res.status, ...(detail ? { code: redact(detail, secrets).slice(0, 64) } : {}) }
    const state = this.limits.state
    if (res.status === 420) {
      this.ports.logger.warn(`ESI 错误额度用完（420），全部请求暂停`)
      return new EsiError('error-limited', message, { ...init, retryAt: state.pausedUntil ?? undefined })
    }
    if (res.status === 429) {
      const group = state.groups.get(this.limits.groupKey(req.route, req.group))
      this.ports.logger.warn(`ESI ${req.route} 被限流（429），这一组暂停`)
      return new EsiError('rate-limited', message, { ...init, retryAt: group?.pausedUntil ?? undefined })
    }
    return new EsiError('http', message, init)
  }

  /** 暂停窗口有变化时写进 BlobCache；按顺序写，写失败只记日志 */
  private persist(now: number) {
    const body = JSON.stringify(this.limits.snapshot(now))
    if (body === this.persisted) return
    this.persisted = body
    this.persisting = this.persisting
      .then(() => this.ports.cache.write(ESI_META_KEY, Buffer.from(body), {}))
      .catch((e) => this.ports.logger.warn(`ESI 暂停窗口没写进缓存：${describeError(e)}`))
  }
}
