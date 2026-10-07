// ESI 请求失败时统一抛 EsiError。不保留原始错误对象（里面可能有带授权头的请求配置），只留脱敏后的文字。

import type { SafeErrorInfo } from '../types'

export type EsiErrorKind =
  /** 服务器返回了非 2xx/304 */
  | 'http'
  /** 连接失败、连接被重置 */
  | 'network'
  /** 单个请求超时 */
  | 'timeout'
  /** 调用方的 deadlineMs 到了；请求本身还在后台继续，结果写进缓存 */
  | 'deadline'
  /** 调用方的 signal 中止了，或者客户端已经停止 */
  | 'aborted'
  /** 这个限流组收到 429 以后的暂停期 */
  | 'rate-limited'
  /** 收到 420 以后，所有请求暂停到错误额度重置 */
  | 'error-limited'
  /** 额度紧张，后台请求先停一停（交互请求不受影响） */
  | 'throttled'
  /** 响应不是预期的 JSON，或者字段不对 */
  | 'bad-response'
  /** 取不到 access token（授权档案的问题） */
  | 'auth'

export interface EsiErrorInit {
  route: string
  status?: number
  /** ESI 响应体里的 error 字段，或网络错误的种类 */
  code?: string
  /** 暂停类错误：什么时候可以再试 */
  retryAt?: number
}

export class EsiError extends Error {
  readonly kind: EsiErrorKind
  readonly route: string
  readonly status?: number
  readonly code?: string
  readonly retryAt?: number

  constructor(kind: EsiErrorKind, message: string, init: EsiErrorInit) {
    super(message)
    this.name = 'EsiError'
    this.kind = kind
    this.route = init.route
    if (init.status !== undefined) this.status = init.status
    if (init.code !== undefined) this.code = init.code
    if (init.retryAt !== undefined) this.retryAt = init.retryAt
  }

  /** 暂停、限流类的错误：不是 ESI 出了问题，而是我们自己在等 */
  get paused(): boolean {
    return this.kind === 'rate-limited' || this.kind === 'error-limited' || this.kind === 'throttled'
  }

  /** 写进日志和「市场状态」的结构 */
  info(): SafeErrorInfo {
    const info: SafeErrorInfo = { route: this.route, message: this.message }
    if (this.status !== undefined) info.status = this.status
    info.code = this.code ?? this.kind
    return info
  }
}

export function isEsiError(value: unknown): value is EsiError {
  return value instanceof EsiError
}
