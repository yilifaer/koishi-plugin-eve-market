// zKill 的 HTTP 客户端，击杀转战报和 KB 人物卡共用。zKill 前面有 Cloudflare，所以按最保守的方式请求：
// 描述清楚来源和联系方式的 User-Agent；全局同一时间只发 1 个请求、两次之间隔开一段时间；同一地址的请求合并；
// 429 按 Retry-After 暂停；403 或验证页（HTML）暂停 5 分钟、日志只告警一次；成功和「没有数据」各有一份内存缓存，
// 失败也记 30 秒。暂停窗口和缓存放在模块级存储里，控制台保存配置（插件重载）后还在。
// 解析 zKill 的 JSON 不在这里（击杀在 killmail/zkill.ts）。

import {
  FAILURE_MEMO_SEC,
  ZKILL_API_BASE,
  ZKILL_BLOCKED_PAUSE_MIN,
  ZKILL_MAX_BYTES,
  ZKILL_MIN_INTERVAL_MS,
  ZKILL_THROTTLE_DEFAULT_SEC,
  ZKILL_TIMEOUT_MS,
} from '../../constants'
import { parseRetryAfter } from '../esi'
import { NetworkError } from '../ports'
import type { CorePorts } from '../ports'
import { LruCache, SingleFlight, describeError, sleep, withDeadline } from '../util'

export type ZkillPorts = Pick<CorePorts, 'http' | 'clock' | 'scheduler' | 'logger' | 'store'>

export type ZkillFailureKind =
  /** 连不上、超时、非 2xx、响应不是 JSON、太大 */
  | 'unavailable'
  /** 429：暂停到 retryAt */
  | 'throttled'
  /** 403 或 Cloudflare 验证页：暂停到 retryAt */
  | 'blocked'
  /** 调用方的 deadlineMs 到了；请求本身在后台继续，结果写进缓存 */
  | 'deadline'
  /** 客户端已停止 */
  | 'aborted'

export interface ZkillFailure {
  ok: false
  kind: ZkillFailureKind
  /** 给日志看的原因，不含网址参数以外的东西 */
  message: string
  /** throttled、blocked：什么时候可以再试 */
  retryAt?: number
}

export type ZkillResult = { ok: true; json: unknown; cached: boolean } | ZkillFailure

export interface ZkillGetOptions {
  timeoutMs?: number
  maxBytes?: number
  /** 成功结果在内存里放多久；不写 = 不缓存 */
  ttlMs?: number
  /** 结果是 `[]`、`{}` 或 null（zKill 上没有这条数据）时放多久；不写 = 不缓存 */
  emptyTtlMs?: number
  /** 调用方最多等多久（包括排队），到时间返回 deadline 失败 */
  deadlineMs?: number
}

export interface ZkillClientOptions {
  base?: string
  /** 和 ESI 用同一个（含插件版本、项目地址、控制台里填的联系方式） */
  userAgent: string
  minIntervalMs?: number
  /** 失败记多久，默认 FAILURE_MEMO_SEC */
  failureMemoMs?: number
}

/** 模块级存储里的状态 */
interface ZkillState {
  pausedUntil: number
  pausedKind: 'throttled' | 'blocked' | null
  /** 上一个请求结束的时间 */
  lastEnd: number
  /** 这一轮故障已经写过告警 */
  warned: boolean
  cache: LruCache<string, unknown>
  failures: LruCache<string, ZkillFailure>
}

const STATE_KEY = 'zkill'
const CACHE_MAX = 500
const FAILURES_MAX = 100
const ACCEPT = 'application/json'

function isEmpty(json: unknown): boolean {
  if (json === null || json === undefined) return true
  if (Array.isArray(json)) return json.length === 0
  return typeof json === 'object' && Object.keys(json).length === 0
}

function isChallenge(status: number, contentType: string | undefined, body: Buffer, mitigated: string | undefined): boolean {
  if (status === 403 || mitigated) return true
  if (contentType && /html/i.test(contentType)) return true
  return body.subarray(0, 64).toString('utf8').trimStart().startsWith('<')
}

export class ZkillClient {
  readonly base: string
  private readonly state: ZkillState
  private readonly minIntervalMs: number
  private readonly flights = new SingleFlight<string, ZkillResult>()
  private readonly life = new AbortController()
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0

  constructor(private readonly ports: ZkillPorts, private readonly options: ZkillClientOptions) {
    this.base = (options.base ?? ZKILL_API_BASE).replace(/\/+$/, '')
    this.minIntervalMs = options.minIntervalMs ?? ZKILL_MIN_INTERVAL_MS
    const memoMs = options.failureMemoMs ?? FAILURE_MEMO_SEC * 1000
    this.state = ports.store.get<ZkillState>(`${STATE_KEY}:${this.base}`, () => ({
      pausedUntil: 0,
      pausedKind: null,
      lastEnd: 0,
      warned: false,
      cache: new LruCache({ max: CACHE_MAX, now: () => ports.clock.now() }),
      failures: new LruCache({ max: FAILURES_MAX, ttlMs: memoMs, now: () => ports.clock.now() }),
    }))
  }

  get stopped(): boolean {
    return this.life.signal.aborted
  }

  /** 排队等着发的请求个数（包括正在发的） */
  get pending(): number {
    return this.queued
  }

  /** 插件停用：中止进行中和排队的请求 */
  stop() {
    if (!this.stopped) this.life.abort(new NetworkError('aborted', 'zKill 客户端已停止'))
  }

  /** GET <base><path>，返回解析后的 JSON；失败不抛，返回 ZkillFailure */
  async getJson(path: string, opts: ZkillGetOptions = {}): Promise<ZkillResult> {
    if (this.stopped) return this.fail('aborted', '客户端已停止')
    const url = `${this.base}${path}`
    const { state } = this
    if (state.cache.has(url)) return { ok: true, json: state.cache.get(url), cached: true }
    const remembered = state.failures.get(url)
    if (remembered) return remembered
    const paused = this.paused()
    if (paused) return paused
    const flight = this.flights.run(url, () => this.enqueue(url, opts))
    if (opts.deadlineMs === undefined) return flight
    const waited = await withDeadline(flight, opts.deadlineMs, this.ports.scheduler)
    return waited.done ? waited.value : this.fail('deadline', `${opts.deadlineMs} 毫秒内没有结果`)
  }

  /** 调用方发现缓存里的内容解析不了：丢掉它，并把这个地址当作失败记一小段时间 */
  markBad(path: string, why: string): ZkillFailure {
    const url = `${this.base}${path}`
    this.state.cache.delete(url)
    return this.unavailable(url, why)
  }

  // ------------------------------------------------------------------ 排队和暂停

  private fail(kind: ZkillFailureKind, message: string, retryAt?: number): ZkillFailure {
    return retryAt === undefined ? { ok: false, kind, message } : { ok: false, kind, message, retryAt }
  }

  /** 暂停期里：现成的失败；没有暂停时 null */
  private paused(): ZkillFailure | null {
    const { state } = this
    if (state.pausedKind && this.ports.clock.now() < state.pausedUntil) {
      const what = state.pausedKind === 'blocked' ? '被 zKill 拦截，暂停中' : 'zKill 限流，暂停中'
      return this.fail(state.pausedKind, what, state.pausedUntil)
    }
    return null
  }

  /** 全局只有一个队列：前一个结束（并隔够时间）以后才发下一个 */
  private enqueue(url: string, opts: ZkillGetOptions): Promise<ZkillResult> {
    this.queued++
    const run = this.tail.then(() => this.turn(url, opts)).finally(() => { this.queued-- })
    this.tail = run.catch(() => undefined)
    return run
  }

  private async turn(url: string, opts: ZkillGetOptions): Promise<ZkillResult> {
    const { clock, scheduler } = this.ports
    const { state } = this
    if (this.stopped) return this.fail('aborted', '客户端已停止')
    const early = this.paused()
    if (early) return early
    const wait = state.lastEnd + this.minIntervalMs - clock.now()
    if (wait > 0) {
      try {
        await sleep(scheduler, wait, this.life.signal)
      } catch {
        return this.fail('aborted', '客户端已停止')
      }
    }
    const late = this.paused()
    if (late) return late
    try {
      return await this.send(url, opts)
    } finally {
      state.lastEnd = clock.now()
    }
  }

  // ------------------------------------------------------------------ 一次请求

  private async send(url: string, opts: ZkillGetOptions): Promise<ZkillResult> {
    const { http, clock, logger } = this.ports
    let res
    try {
      res = await http.request({
        method: 'GET',
        url,
        headers: { 'User-Agent': this.options.userAgent, Accept: ACCEPT },
        timeoutMs: opts.timeoutMs ?? ZKILL_TIMEOUT_MS,
        maxBytes: opts.maxBytes ?? ZKILL_MAX_BYTES,
        signal: this.life.signal,
      })
    } catch (e) {
      if (e instanceof NetworkError && e.kind === 'aborted') return this.fail('aborted', '请求被中止')
      return this.unavailable(url, describeError(e))
    }
    const now = clock.now()
    if (res.status === 429) {
      const retryAt = parseRetryAfter(res.header('retry-after'), now) ?? now + ZKILL_THROTTLE_DEFAULT_SEC * 1000
      return this.pause('throttled', retryAt, 'zKill 返回 429（请求太频繁）')
    }
    if (isChallenge(res.status, res.header('content-type'), res.body, res.header('cf-mitigated'))) {
      return this.pause('blocked', now + ZKILL_BLOCKED_PAUSE_MIN * 60_000, `zKill 返回 ${res.status}（被拦截或验证页）`)
    }
    if (res.status < 200 || res.status >= 300) return this.unavailable(url, `HTTP ${res.status}`)
    let json: unknown
    try {
      json = JSON.parse(res.body.toString('utf8'))
    } catch {
      return this.unavailable(url, '响应不是 JSON')
    }
    logger.debug('zKill %s 成功', url.slice(this.base.length))
    return this.succeeded(url, json, opts)
  }

  private succeeded(url: string, json: unknown, opts: ZkillGetOptions): ZkillResult {
    const { state } = this
    if (state.warned) this.ports.logger.info('zKill 恢复正常')
    state.warned = false
    state.pausedKind = null
    state.pausedUntil = 0
    const ttl = isEmpty(json) ? opts.emptyTtlMs : opts.ttlMs
    if (ttl && ttl > 0) state.cache.set(url, json, ttl)
    return { ok: true, json, cached: false }
  }

  private pause(kind: 'throttled' | 'blocked', until: number, why: string): ZkillFailure {
    const { state } = this
    state.pausedKind = kind
    state.pausedUntil = until
    const minutes = Math.max(1, Math.round((until - this.ports.clock.now()) / 60_000))
    this.warnOnce(`${why}，暂停约 ${minutes} 分钟`)
    return this.fail(kind, why, until)
  }

  /** 连不上这一类：同一地址记 30 秒，期间直接返回 */
  private unavailable(url: string, why: string): ZkillFailure {
    const failure = this.fail('unavailable', why)
    this.state.failures.set(url, failure)
    this.warnOnce(`zKill 请求失败：${why}`)
    return failure
  }

  /** 一轮故障只告警一次，恢复以后才会再告警 */
  private warnOnce(text: string) {
    if (this.state.warned) this.ports.logger.debug(text)
    else {
      this.state.warned = true
      this.ports.logger.warn(text)
    }
  }
}
