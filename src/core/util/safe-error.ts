// 日志脱敏。ctx.http 抛出的错误对象里带着请求配置（Authorization: Bearer …、Basic 认证头），
// 直接 logger.warn(err) 就会把它们打出来（Janice 的 X-ApiKey 请求头同理）。SSO 和带授权的 ESI 请求的错误一律经过 safeError()：
// 只留 { route, status, code, message }，不碰 config、headers、request。

import { NetworkError } from '../ports'
import type { SafeErrorInfo } from '../types'

const MAX_MESSAGE = 200

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***'],
  // JWT（access token）
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***'],
  // SecretBox 的密文
  [/\bv1:[0-9a-f]{8}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g, 'v1:***'],
  // 查询参数、表单
  [/\b(refresh_token|access_token|id_token|client_secret|code|state|token|password|secret|key|apikey)=[^&\s"',;]+/gi, '$1=***'],
  // JSON 字段
  [/"(refresh_token|access_token|id_token|client_secret|token|password|secret|authorization|apikey|x-apikey)"\s*:\s*"[^"]*"/gi, '"$1":"***"'],
  // Janice 的请求头 X-ApiKey: …（错误文字里带出请求头时）
  [/\b(x-apikey)(\s*[:=]\s*)[^\s"',;}]+/gi, '$1$2***'],
]

/**
 * 去掉文字里像令牌、口令的部分。secrets：调用方知道的具体值（例如当前的 refresh token、Client Secret），
 * 不管出现在哪里都换成 ***（短于 6 个字符的不处理，免得误伤正常文字）。
 */
export function redact(value: string, secrets: readonly string[] = []): string {
  let out = value
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('***')
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

type Loose = Record<string, any>

function asObject(value: unknown): Loose | undefined {
  return value && typeof value === 'object' ? value as Loose : undefined
}

/** 从响应体里取错误码和说明（ESI：{ error }；SSO：{ error, error_description }；QQ：{ code, message }） */
function fromBody(data: unknown): { code?: string; message?: string } {
  let body: unknown = Buffer.isBuffer(data) ? data.toString('utf8') : data
  if (typeof body === 'string') {
    const raw = body
    try {
      body = JSON.parse(raw)
    } catch {
      return { message: raw.slice(0, MAX_MESSAGE) }
    }
  }
  const o = asObject(body)
  if (!o) return {}
  const code = typeof o.error === 'string' ? o.error : typeof o.code === 'string' || typeof o.code === 'number' ? String(o.code) : undefined
  const message = [o.error_description, o.message, typeof o.error === 'string' ? undefined : o.error]
    .find((m): m is string => typeof m === 'string' && m.length > 0)
  return { code, message }
}

/** 把任何错误变成可以写进日志和「市场状态」的结构，不含任何令牌 */
export function safeError(error: unknown, route?: string, secrets: readonly string[] = []): SafeErrorInfo {
  const info: SafeErrorInfo = { message: '' }
  if (route) info.route = redact(route, secrets)

  if (error instanceof NetworkError) {
    info.code = error.kind
    info.message = redact(error.message, secrets).slice(0, MAX_MESSAGE)
    return info
  }

  const e = asObject(error)
  if (!e) {
    info.message = redact(String(error), secrets).slice(0, MAX_MESSAGE)
    return info
  }

  const response = asObject(e.response)
  const status = typeof response?.status === 'number' ? response.status : typeof e.status === 'number' ? e.status : undefined
  if (status !== undefined) info.status = status

  const body = response ? fromBody(response.data ?? response.body) : {}
  const nodeCode = typeof e.code === 'string' ? e.code : typeof e.cause?.code === 'string' ? e.cause.code : undefined
  const code = body.code ?? (e.name === 'AbortError' ? 'aborted' : nodeCode)
  if (code) info.code = redact(code, secrets).slice(0, 64)

  // 「Request failed with status code 403」这类说明没有信息量
  const own = typeof e.message === 'string' && !/^Request failed with status code \d+$/i.test(e.message) ? e.message : ''
  info.message = redact(body.message ?? own, secrets).replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE)
  if (!info.message) info.message = info.code ?? (status !== undefined ? `HTTP ${status}` : typeof e.name === 'string' ? e.name : 'Error')
  return info
}

/** 一行日志：「GET /markets/structures/… HTTP 403 forbidden: …」 */
export function describeError(error: unknown, route?: string, secrets: readonly string[] = []): string {
  const info = safeError(error, route, secrets)
  const parts: string[] = []
  if (info.route) parts.push(info.route)
  if (info.status !== undefined) parts.push(`HTTP ${info.status}`)
  if (info.code) parts.push(info.code)
  const head = parts.join(' ')
  if (!head) return info.message
  const redundant = info.message === info.code || info.message === `HTTP ${info.status}`
  return redundant ? head : `${head}: ${info.message}`
}
