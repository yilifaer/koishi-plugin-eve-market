// 响应头解析：缓存时间、限流、错误额度。纯函数，现在的时间由调用方传入。

import type { HttpResponse } from '../ports'

export type HeaderSource = Pick<HttpResponse, 'header'>

/** HTTP 日期（Expires、Last-Modified、Date）→ 毫秒；读不懂时 null */
export function parseHttpDate(value: string | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** 非负整数；读不懂时 null */
export function parseCount(value: string | undefined): number | null {
  if (value === undefined) return null
  const text = value.trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : null
}

/** Cache-Control 的 max-age（秒）；no-store、no-cache 当作 0；没有时 null */
export function parseMaxAge(cacheControl: string | undefined): number | null {
  if (!cacheControl) return null
  let maxAge: number | null = null
  for (const part of cacheControl.split(',')) {
    const [name, raw] = part.trim().split('=', 2)
    const directive = name.toLowerCase()
    if (directive === 'no-store' || directive === 'no-cache') return 0
    if (directive === 'max-age') {
      const n = parseCount(raw?.replace(/^"|"$/g, ''))
      if (n !== null) maxAge = n
    }
  }
  return maxAge
}

/**
 * 缓存到什么时候：依次看 Cache-Control 的 max-age（减去 Age）、Expires（按服务器的 Date 换算到本机时间）、
 * 路由的默认值。
 */
export function freshUntil(res: HeaderSource, now: number, defaultSec: number): number {
  const maxAge = parseMaxAge(res.header('cache-control'))
  if (maxAge !== null) {
    const age = parseCount(res.header('age')) ?? 0
    return now + Math.max(0, maxAge - age) * 1000
  }
  const expires = parseHttpDate(res.header('expires'))
  if (expires !== null) {
    const date = parseHttpDate(res.header('date')) ?? now
    return now + Math.max(0, expires - date)
  }
  return now + defaultSec * 1000
}

/** Retry-After（秒数或 HTTP 日期）→ 可以再试的时间；没有时 null */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value) return null
  const seconds = parseCount(value)
  if (seconds !== null) return now + seconds * 1000
  const at = parseHttpDate(value)
  return at === null ? null : Math.max(now, at)
}

const WINDOW_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 }

/** X-Ratelimit-Limit 的「150/15m」→ { limit: 150, windowMs: 900000 } */
export function parseRateLimit(value: string | undefined): { limit: number; windowMs: number } | null {
  if (!value) return null
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*([smh])\s*$/i.exec(value)
  if (!m) return null
  const limit = Number(m[1])
  const windowMs = Number(m[2]) * WINDOW_UNIT_MS[m[3].toLowerCase()]
  return limit > 0 && windowMs > 0 ? { limit, windowMs } : null
}

/** 限流相关的响应头 */
export interface RateLimitHeaders {
  group?: string
  limit?: { limit: number; windowMs: number }
  remaining?: number
  used?: number
  /** 毫秒时间戳 */
  retryAt?: number
  errorRemain?: number
  /** 毫秒时间戳 */
  errorResetAt?: number
}

export function readRateLimitHeaders(res: HeaderSource, now: number): RateLimitHeaders {
  const out: RateLimitHeaders = {}
  const group = res.header('x-ratelimit-group')?.trim()
  if (group) out.group = group
  const limit = parseRateLimit(res.header('x-ratelimit-limit'))
  if (limit) out.limit = limit
  const remaining = parseCount(res.header('x-ratelimit-remaining'))
  if (remaining !== null) out.remaining = remaining
  const used = parseCount(res.header('x-ratelimit-used'))
  if (used !== null) out.used = used
  const retryAt = parseRetryAfter(res.header('retry-after'), now)
  if (retryAt !== null) out.retryAt = retryAt
  const errorRemain = parseCount(res.header('x-esi-error-limit-remain'))
  if (errorRemain !== null) out.errorRemain = errorRemain
  const errorReset = parseCount(res.header('x-esi-error-limit-reset'))
  if (errorReset !== null) out.errorResetAt = now + errorReset * 1000
  return out
}
