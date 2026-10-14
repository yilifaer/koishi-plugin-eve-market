// Janice 的 HTTP 客户端，只做 GET /api/rest/v2/appraisal/{code}。密钥只放在 X-ApiKey 请求头里，
// 不进地址、日志、错误文字。别人的服务器，所以保守：全局同一时间只发 1 个请求、两次之间隔开一段时间；
// 429 按 Retry-After 暂停；密钥被拒绝时日志最多 10 分钟告警一次（只写状态码）。
// 暂停窗口和告警时间放在模块级存储里，插件重载后还在。解析响应字段不在这里（shape.ts），缓存也不在这里（service.ts）。

import {
  JANICE_API_BASE,
  JANICE_APPRAISAL_PATH,
  JANICE_BAD_KEY_WARN_MIN,
  JANICE_CODE_RE,
  JANICE_KEY_HEADER,
  JANICE_MAX_BYTES,
  JANICE_MAX_PAUSE_MS,
  JANICE_MAX_QUEUE,
  JANICE_MIN_INTERVAL_MS,
  JANICE_THROTTLE_DEFAULT_SEC,
  JANICE_TIMEOUT_MS,
} from '../../constants'
import { parseRetryAfter } from '../esi'
import { NetworkError } from '../ports'
import type { CorePorts } from '../ports'
import type { CoreFailure, FailureCode } from '../types'
import { describeError, registerSecret, sleep } from '../util'

export type JanicePorts = Pick<CorePorts, 'http' | 'clock' | 'scheduler' | 'logger' | 'store'>

export interface JaniceClientOptions {
  base?: string
  /** 控制台里填的密钥；空 = 没开通 */
  apiKey: string
  /** 和 ESI 用同一个（含插件版本、项目地址、控制台里填的联系方式） */
  userAgent: string
  minIntervalMs?: number
}

export type JaniceFetch = { ok: true; json: unknown } | CoreFailure

/** 模块级存储里的状态 */
interface JaniceState {
  pausedUntil: number
  /** 上一个请求结束的时间 */
  lastEnd: number
  /** 上一次写密钥被拒绝的告警的时间 */
  badKeyWarnedAt: number
  /** 这一轮故障已经写过告警 */
  warned: boolean
}

const STATE_KEY = 'janice'
const ACCEPT = 'application/json'

function failure(code: FailureCode, message: string, retryAt?: number): CoreFailure {
  return retryAt === undefined ? { ok: false, code, message } : { ok: false, code, message, retryAt }
}

export class JaniceClient {
  readonly base: string
  private readonly state: JaniceState
  private readonly minIntervalMs: number
  private readonly life = new AbortController()
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0

  constructor(private readonly ports: JanicePorts, private readonly options: JaniceClientOptions) {
    this.base = (options.base ?? JANICE_API_BASE).replace(/\/+$/, '')
    this.minIntervalMs = options.minIntervalMs ?? JANICE_MIN_INTERVAL_MS
    registerSecret(options.apiKey)
    // 状态按地址分，不带密钥
    this.state = ports.store.get<JaniceState>(`${STATE_KEY}:${this.base}`, () => ({
      pausedUntil: 0,
      lastEnd: 0,
      badKeyWarnedAt: -Infinity,
      warned: false,
    }))
  }

  get configured(): boolean {
    return this.options.apiKey.length > 0
  }

  get stopped(): boolean {
    return this.life.signal.aborted
  }

  /** 插件停用：中止进行中和排队的请求 */
  stop() {
    if (!this.stopped) this.life.abort(new NetworkError('aborted', 'Janice 客户端已停止'))
  }

  /** 取一份估价的 JSON；失败不抛，返回带 Janice 失败码的 CoreFailure。编号不合格时不发请求 */
  fetchAppraisal(code: string): Promise<JaniceFetch> {
    if (!this.configured) return Promise.resolve(failure('NOT_CONFIGURED', 'Janice 密钥没有填'))
    if (!JANICE_CODE_RE.test(code)) return Promise.resolve(failure('BAD_ARGUMENT', '估价编号格式不对'))
    if (this.stopped) return Promise.resolve(failure('JANICE_DOWN', '客户端已停止'))
    const paused = this.paused()
    if (paused) return Promise.resolve(paused)
    if (this.queued >= JANICE_MAX_QUEUE) return Promise.resolve(failure('JANICE_BUSY', 'Janice 排队已满，稍后再试'))
    this.queued++
    const run = this.tail.then(() => this.turn(code)).finally(() => { this.queued-- })
    this.tail = run.catch(() => undefined)
    return run
  }

  // ------------------------------------------------------------------ 排队和暂停

  /** 暂停期里：现成的失败；没有暂停时 null */
  private paused(): CoreFailure | null {
    const { pausedUntil } = this.state
    return this.ports.clock.now() < pausedUntil ? failure('JANICE_BUSY', 'Janice 限流，暂停中', pausedUntil) : null
  }

  /** 全局只有一个队列：前一个结束（并隔够时间）以后才发下一个 */
  private async turn(code: string): Promise<JaniceFetch> {
    const { clock, scheduler } = this.ports
    const { state } = this
    if (this.stopped) return failure('JANICE_DOWN', '客户端已停止')
    const early = this.paused()
    if (early) return early
    const wait = state.lastEnd + this.minIntervalMs - clock.now()
    if (wait > 0) {
      try {
        await sleep(scheduler, wait, this.life.signal)
      } catch {
        return failure('JANICE_DOWN', '客户端已停止')
      }
    }
    const late = this.paused()
    if (late) return late
    try {
      return await this.send(code)
    } finally {
      state.lastEnd = clock.now()
    }
  }

  // ------------------------------------------------------------------ 一次请求

  private async send(code: string): Promise<JaniceFetch> {
    const { http, clock, logger } = this.ports
    const { apiKey, userAgent } = this.options
    const url = `${this.base}${JANICE_APPRAISAL_PATH.replace('{code}', code)}`
    let res
    try {
      res = await http.request({
        method: 'GET',
        url,
        headers: { [JANICE_KEY_HEADER]: apiKey, Accept: ACCEPT, 'User-Agent': userAgent },
        timeoutMs: JANICE_TIMEOUT_MS,
        maxBytes: JANICE_MAX_BYTES,
        signal: this.life.signal,
        // 不跟随重定向，免得 X-ApiKey 被带到别的主机或明文 http
        redirect: 'manual',
      })
    } catch (e) {
      if (e instanceof NetworkError && e.kind === 'aborted') return failure('JANICE_DOWN', '请求被中止')
      if (e instanceof NetworkError && e.kind === 'too-large') return this.bad(`响应超过 ${JANICE_MAX_BYTES} 字节`)
      return this.down(describeError(e, undefined, [apiKey]))
    }
    const { status } = res
    if (status >= 300 && status < 400) return this.down('HTTP 3xx')
    if (status === 429) {
      const now = clock.now()
      const retryAt = parseRetryAfter(res.header('retry-after'), now) ?? now + JANICE_THROTTLE_DEFAULT_SEC * 1000
      // 上限 1 小时，免得异常的 Retry-After 让估价一直停到重启
      const until = Math.min(retryAt, now + JANICE_MAX_PAUSE_MS)
      this.state.pausedUntil = until
      this.warnOnce(`Janice 返回 429（请求太频繁），暂停约 ${Math.max(1, Math.round((until - now) / 60_000))} 分钟`)
      return failure('JANICE_BUSY', 'Janice 返回 429', until)
    }
    if (status === 401 || status === 403) {
      this.warnBadKey(status)
      return failure('JANICE_BAD_KEY', `Janice 拒绝了密钥（HTTP ${status}）`)
    }
    if (status === 404 || status === 400) return failure('JANICE_NOT_FOUND', `HTTP ${status}`)
    if (status < 200 || status >= 300) return this.down(`HTTP ${status}`)
    let json: unknown
    try {
      json = JSON.parse(res.body.toString('utf8'))
    } catch {
      return this.bad('响应不是 JSON')
    }
    if (this.state.warned) logger.info('Janice 恢复正常')
    this.state.warned = false
    logger.debug('Janice 估价 %s 读取成功', code)
    return { ok: true, json }
  }

  private down(why: string): CoreFailure {
    this.warnOnce(`Janice 请求失败：${why}`)
    return failure('JANICE_DOWN', why)
  }

  private bad(why: string): CoreFailure {
    this.warnOnce(`Janice 响应不可用：${why}`)
    return failure('JANICE_BAD_RESPONSE', why)
  }

  /** 一轮故障只告警一次，恢复以后才会再告警 */
  private warnOnce(text: string) {
    if (this.state.warned) this.ports.logger.debug(text)
    else {
      this.state.warned = true
      this.ports.logger.warn(text)
    }
  }

  /** 密钥被拒绝：最多每 10 分钟告警一次，只写状态码 */
  private warnBadKey(status: number) {
    const now = this.ports.clock.now()
    const text = `Janice 拒绝了密钥（HTTP ${status}），请在控制台检查 Janice 的 API 密钥`
    if (now - this.state.badKeyWarnedAt >= JANICE_BAD_KEY_WARN_MIN * 60_000) {
      this.state.badKeyWarnedAt = now
      this.ports.logger.warn(text)
    } else this.ports.logger.debug(text)
  }
}
