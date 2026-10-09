// EVE SSO v2 的协议部分（§7.3、§7.5）：授权网址、用授权码换 token、刷新、撤销，以及 access token（JWT）的解码和检查。
// 端点、JWT 的签发者和字段名都待核实，都在 constants.ts 里，核实后只改常量。
// access token 是插件自己经 TLS 从 token 端点拿到的，所以只解码、不验签（不取 JWKS，不引入 JWT 库）。
// 失败一律抛 SsoError：只留脱敏后的 { route, status, code, message }，不保留请求和响应对象。

import {
  ESI_TIMEOUT_MS, SSO_AUTHORIZE_PATH, SSO_BASE, SSO_JWT_AUDIENCE, SSO_JWT_ISSUERS, SSO_REVOKE_PATH, SSO_SCOPES, SSO_TOKEN_PATH,
} from '../../constants'
import { NetworkError } from '../ports'
import type { HttpClient, HttpResponse } from '../ports'
import type { SafeErrorInfo } from '../types'
import { describeError, redact } from '../util'

/** token 端点的响应很小，超过就是不对的响应 */
const MAX_RESPONSE_BYTES = 64 * 1024
/** 本机时钟和 SSO 差这么多以内不算过期 */
const CLOCK_SKEW_SEC = 300
const MAX_MESSAGE = 200

export const TOKEN_ROUTE = `POST ${SSO_TOKEN_PATH}`
export const REVOKE_ROUTE = `POST ${SSO_REVOKE_PATH}`

// ------------------------------------------------------------------ 错误

export type SsoErrorKind =
  /** 400 invalid_grant：授权码或刷新令牌无效、过期、已撤销 */
  | 'invalid_grant'
  /** Client ID 或 Secret Key 不对 */
  | 'invalid_client'
  /** 其他 4xx */
  | 'rejected'
  /** 网络错误、超时、429、5xx：过一会儿再试 */
  | 'unavailable'
  /** 响应不是预期的 JSON，或者缺字段 */
  | 'bad-response'
  /** access token 的内容不对（签发者、角色、过期时间） */
  | 'bad-token'

export class SsoError extends Error {
  readonly kind: SsoErrorKind
  readonly route: string
  readonly status?: number
  readonly code?: string

  constructor(kind: SsoErrorKind, message: string, init: { route: string; status?: number; code?: string }) {
    super(message)
    this.name = 'SsoError'
    this.kind = kind
    this.route = init.route
    if (init.status !== undefined) this.status = init.status
    if (init.code !== undefined) this.code = init.code
  }

  /** 网络、服务器的问题：退避后自动重试；其他的要等重新授权 */
  get transient(): boolean {
    return this.kind === 'unavailable' || this.kind === 'bad-response'
  }

  info(): SafeErrorInfo {
    const info: SafeErrorInfo = { route: this.route, message: this.message }
    if (this.status !== undefined) info.status = this.status
    info.code = this.code ?? this.kind
    return info
  }

  /** 给状态和日志看的短说明：「HTTP 400 invalid_grant」「timeout」 */
  get brief(): string {
    const parts: string[] = []
    if (this.status !== undefined) parts.push(`HTTP ${this.status}`)
    if (this.code) parts.push(this.code)
    return parts.length ? parts.join(' ') : this.message
  }
}

export function isSsoError(value: unknown): value is SsoError {
  return value instanceof SsoError
}

type Loose = Record<string, unknown>

function asObject(value: unknown): Loose | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Loose : undefined
}

/** SSO 的错误体 { error, error_description } */
function errorBody(body: Buffer): { error?: string; description?: string } {
  try {
    const o = asObject(JSON.parse(body.toString('utf8')))
    if (!o) return {}
    const out: { error?: string; description?: string } = {}
    if (typeof o.error === 'string' && o.error) out.error = o.error
    if (typeof o.error_description === 'string' && o.error_description) out.description = o.error_description
    return out
  } catch {
    return {}
  }
}

function httpError(res: HttpResponse, route: string, secrets: readonly string[]): SsoError {
  const { error, description } = errorBody(res.body)
  const status = res.status
  let kind: SsoErrorKind
  if (status < 400) kind = 'bad-response'
  else if (status === 408 || status === 429 || status >= 500) kind = 'unavailable'
  else if (error === 'invalid_grant') kind = 'invalid_grant'
  else if (error === 'invalid_client' || status === 401) kind = 'invalid_client'
  else kind = 'rejected'
  const detail = [error, description].filter(Boolean).join(': ')
  const message = redact(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`, secrets).replace(/\s+/g, ' ').slice(0, MAX_MESSAGE)
  return new SsoError(kind, message, { route, status, ...(error ? { code: redact(error, secrets).slice(0, 64) } : {}) })
}

function transportError(e: unknown, route: string, secrets: readonly string[]): SsoError {
  if (e instanceof SsoError) return e
  if (e instanceof NetworkError) {
    const kind: SsoErrorKind = e.kind === 'too-large' ? 'bad-response' : 'unavailable'
    return new SsoError(kind, redact(e.message, secrets).slice(0, MAX_MESSAGE), { route, code: e.kind })
  }
  return new SsoError('unavailable', describeError(e, undefined, secrets).slice(0, MAX_MESSAGE), { route, code: 'network' })
}

// ------------------------------------------------------------------ JWT

export interface AccessClaims {
  /** sub 里的角色 ID，存成字符串（不怕大数） */
  characterId: string
  /** name；没有时 '' */
  characterName: string
  /** owner：角色转手后会变；没有时 '' */
  ownerHash: string
  scopes: string[]
  /** exp（毫秒，按 SSO 的时钟） */
  expiresAt: number
}

export interface CheckOptions {
  clientId: string
  /** 本机时间（毫秒） */
  now: number
  issuers?: readonly string[]
}

function badToken(message: string, route = 'JWT'): SsoError {
  return new SsoError('bad-token', message, { route })
}

/** 只解码 payload，不验签 */
export function decodeJwt(token: string): Loose {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p)) || !parts[1]) throw badToken('access token 不是 JWT')
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw badToken('access token 的内容不是 JSON')
  }
  const o = asObject(payload)
  if (!o) throw badToken('access token 的内容不是对象')
  return o
}

/** scp 可能是字符串（只有一项时）、数组，或者没有 */
export function normalizeScopes(scp: unknown): string[] {
  const raw = typeof scp === 'string' ? scp.split(/\s+/) : Array.isArray(scp) ? scp : []
  return [...new Set(raw.filter((s): s is string => typeof s === 'string' && s.length > 0))]
}

/** sub = CHARACTER:EVE:<id> → '<id>'；不是角色时 null */
export function characterIdOf(sub: unknown): string | null {
  if (typeof sub !== 'string') return null
  const m = /^CHARACTER:EVE:(\d{1,20})$/.exec(sub)
  return m ? m[1] : null
}

function audiences(aud: unknown): string[] {
  if (typeof aud === 'string') return [aud]
  return Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : []
}

/** 检查签发者、受众、过期时间和角色；scp 只整理，够不够由调用方判断 */
export function checkAccessToken(token: string, opts: CheckOptions): AccessClaims {
  const p = decodeJwt(token)
  const issuers = opts.issuers ?? SSO_JWT_ISSUERS
  if (typeof p.iss !== 'string' || !issuers.includes(p.iss)) throw badToken('access token 的签发者不对')
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) throw badToken('access token 没有过期时间')
  if (p.exp * 1000 <= opts.now - CLOCK_SKEW_SEC * 1000) throw badToken('access token 已经过期（本机时间可能不准）')
  if (p.azp !== undefined && p.azp !== opts.clientId) throw badToken('access token 不是发给这个应用的')
  const aud = audiences(p.aud)
  if (aud.length && !aud.includes(opts.clientId) && !aud.includes(SSO_JWT_AUDIENCE)) throw badToken('access token 的受众不对')
  const characterId = characterIdOf(p.sub)
  if (!characterId) throw badToken('access token 里没有角色')
  return {
    characterId,
    characterName: typeof p.name === 'string' ? p.name : '',
    ownerHash: typeof p.owner === 'string' ? p.owner : '',
    scopes: normalizeScopes(p.scp),
    expiresAt: p.exp * 1000,
  }
}

/** required 里缺了哪些 */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  return required.filter((s) => !granted.includes(s))
}

// ------------------------------------------------------------------ 客户端

export interface TokenSet {
  accessToken: string
  /** 返回了新的 refresh token 就是它（按会轮换处理，一律保存最新的）；没返回时 null */
  refreshToken: string | null
  /** expires_in（秒）；没有时 null */
  expiresIn: number | null
}

export interface SsoClientOptions {
  http: HttpClient
  clientId: string
  clientSecret: string
  userAgent: string
  /** 测试指向假服务；默认 SSO_BASE */
  base?: string
  timeoutMs?: number
}

export function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`
}

function tokenSet(body: Buffer, route: string, secrets: readonly string[]): TokenSet {
  let json: unknown
  try {
    json = JSON.parse(body.toString('utf8'))
  } catch {
    throw new SsoError('bad-response', 'token 端点的响应不是 JSON', { route, status: 200 })
  }
  const o = asObject(json)
  const access = o?.access_token
  if (!o || typeof access !== 'string' || !access) throw new SsoError('bad-response', 'token 端点的响应里没有 access_token', { route, status: 200 })
  const refresh = typeof o.refresh_token === 'string' && o.refresh_token ? o.refresh_token : null
  const expires = typeof o.expires_in === 'number' && Number.isFinite(o.expires_in) && o.expires_in > 0 ? o.expires_in : null
  if (typeof o.token_type === 'string' && o.token_type.toLowerCase() !== 'bearer') {
    throw new SsoError('bad-response', redact(`token_type 是 ${o.token_type}`, [...secrets, access]).slice(0, MAX_MESSAGE), { route, status: 200 })
  }
  return { accessToken: access, refreshToken: refresh, expiresIn: expires }
}

/** 机密客户端（Web 应用）的授权码流程，客户端认证用 HTTP Basic，不做 PKCE */
export class SsoClient {
  readonly base: string

  constructor(private readonly o: SsoClientOptions) {
    this.base = (o.base ?? SSO_BASE).replace(/\/+$/, '')
  }

  /** 浏览器要打开的登录页；空格编码成 %20（不用 +） */
  authorizeUrl(redirectUri: string, state: string, scopes: readonly string[] = SSO_SCOPES): string {
    const query: Array<[string, string]> = [
      ['response_type', 'code'],
      ['redirect_uri', redirectUri],
      ['client_id', this.o.clientId],
      ['scope', scopes.join(' ')],
      ['state', state],
    ]
    return `${this.base}${SSO_AUTHORIZE_PATH}?${query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
  }

  async exchangeCode(code: string): Promise<TokenSet> {
    const secrets = [code]
    const res = await this.post(TOKEN_ROUTE, SSO_TOKEN_PATH, { grant_type: 'authorization_code', code }, secrets)
    return tokenSet(res.body, TOKEN_ROUTE, secrets)
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const secrets = [refreshToken]
    const res = await this.post(TOKEN_ROUTE, SSO_TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: refreshToken }, secrets)
    return tokenSet(res.body, TOKEN_ROUTE, secrets)
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.post(REVOKE_ROUTE, SSO_REVOKE_PATH, { token_type_hint: 'refresh_token', token: refreshToken }, [refreshToken])
  }

  /**
   * 不接调用方的中止信号，只按 timeoutMs 超时：刷新请求发出去以后，SSO 可能已经换了 refresh token，
   * 半路放弃就拿不到新的、旧的又作废了。插件停用也不能中止它，所以 Koishi 上传进来的是经根上下文发请求的
   * HttpClient（CorePorts.ssoHttp），不是插件自己的 ctx.http（停用时会中止进行中的请求）。
   */
  private async post(route: string, path: string, form: Record<string, string>, secrets: readonly string[]): Promise<HttpResponse> {
    const all = [...secrets, this.o.clientSecret]
    let res: HttpResponse
    try {
      res = await this.o.http.request({
        method: 'POST',
        url: this.base + path,
        headers: {
          Authorization: basicAuth(this.o.clientId, this.o.clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': this.o.userAgent,
        },
        body: new URLSearchParams(form).toString(),
        timeoutMs: this.o.timeoutMs ?? ESI_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
      })
    } catch (e) {
      throw transportError(e, route, all)
    }
    if (res.status < 200 || res.status >= 300) throw httpError(res, route, all)
    return res
  }
}
