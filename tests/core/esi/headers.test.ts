import { describe, expect, it } from 'vitest'
import { freshUntil, parseHttpDate, parseRateLimit, parseRetryAfter, userAgent } from '../../../src/core/esi'
import { parseCount, parseMaxAge, readRateLimitHeaders } from '../../../src/core/esi/headers'

const NOW = Date.UTC(2026, 9, 7, 6, 20)

function headers(h: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
  return { header: (name: string) => lower[name.toLowerCase()] }
}

describe('cache headers', () => {
  it('reads max-age and treats no-store / no-cache as zero', () => {
    expect(parseMaxAge('public, max-age=300')).toBe(300)
    expect(parseMaxAge('max-age="60"')).toBe(60)
    expect(parseMaxAge('private, no-cache')).toBe(0)
    expect(parseMaxAge('no-store, max-age=300')).toBe(0)
    expect(parseMaxAge('public')).toBeNull()
    expect(parseMaxAge(undefined)).toBeNull()
    expect(parseMaxAge('max-age=abc')).toBeNull()
  })

  it('prefers Cache-Control, minus Age', () => {
    expect(freshUntil(headers({ 'Cache-Control': 'max-age=300', Expires: 'Wed, 07 Oct 2026 09:00:00 GMT' }), NOW, 60)).toBe(NOW + 300_000)
    expect(freshUntil(headers({ 'Cache-Control': 'max-age=300', Age: '100' }), NOW, 60)).toBe(NOW + 200_000)
    expect(freshUntil(headers({ 'Cache-Control': 'max-age=300', Age: '900' }), NOW, 60)).toBe(NOW)
  })

  it('converts Expires to local time using the server Date, so a skewed server clock does not matter', () => {
    const serverNow = NOW + 3_600_000
    const h = headers({ Expires: new Date(serverNow + 120_000).toUTCString(), Date: new Date(serverNow).toUTCString() })
    expect(freshUntil(h, NOW, 60)).toBe(NOW + 120_000)
    // 没有 Date 头时按本机时间
    expect(freshUntil(headers({ Expires: new Date(NOW + 90_000).toUTCString() }), NOW, 60)).toBe(NOW + 90_000)
    // 已经过期
    expect(freshUntil(headers({ Expires: new Date(NOW - 5_000).toUTCString() }), NOW, 60)).toBe(NOW)
  })

  it('falls back to the route default', () => {
    expect(freshUntil(headers({}), NOW, 300)).toBe(NOW + 300_000)
    expect(freshUntil(headers({ Expires: 'garbage' }), NOW, 300)).toBe(NOW + 300_000)
  })

  it('parses HTTP dates and counts strictly', () => {
    expect(parseHttpDate('Wed, 07 Oct 2026 06:20:00 GMT')).toBe(NOW)
    expect(parseHttpDate('nope')).toBeNull()
    expect(parseHttpDate(undefined)).toBeNull()
    expect(parseCount('42')).toBe(42)
    expect(parseCount(' 7 ')).toBe(7)
    expect(parseCount('-1')).toBeNull()
    expect(parseCount('1.5')).toBeNull()
    expect(parseCount('')).toBeNull()
  })
})

describe('rate limit headers', () => {
  it('parses X-Ratelimit-Limit windows', () => {
    expect(parseRateLimit('150/15m')).toEqual({ limit: 150, windowMs: 900_000 })
    expect(parseRateLimit('12000/15m')).toEqual({ limit: 12000, windowMs: 900_000 })
    expect(parseRateLimit('10/1h')).toEqual({ limit: 10, windowMs: 3_600_000 })
    expect(parseRateLimit('5/30s')).toEqual({ limit: 5, windowMs: 30_000 })
    expect(parseRateLimit('150')).toBeNull()
    expect(parseRateLimit('0/15m')).toBeNull()
    expect(parseRateLimit('150/15d')).toBeNull()
  })

  it('parses Retry-After in seconds or as a date', () => {
    expect(parseRetryAfter('30', NOW)).toBe(NOW + 30_000)
    expect(parseRetryAfter(new Date(NOW + 45_000).toUTCString(), NOW)).toBe(NOW + 45_000)
    expect(parseRetryAfter(new Date(NOW - 45_000).toUTCString(), NOW)).toBe(NOW)
    expect(parseRetryAfter('soon', NOW)).toBeNull()
    expect(parseRetryAfter(undefined, NOW)).toBeNull()
  })

  it('collects every limit header it understands', () => {
    const h = readRateLimitHeaders(headers({
      'X-Ratelimit-Group': 'market-order',
      'X-Ratelimit-Limit': '12000/15m',
      'X-Ratelimit-Remaining': '11998',
      'X-Ratelimit-Used': '2',
      'Retry-After': '10',
      'X-ESI-Error-Limit-Remain': '99',
      'X-ESI-Error-Limit-Reset': '42',
    }), NOW)
    expect(h).toEqual({
      group: 'market-order',
      limit: { limit: 12000, windowMs: 900_000 },
      remaining: 11998,
      used: 2,
      retryAt: NOW + 10_000,
      errorRemain: 99,
      errorResetAt: NOW + 42_000,
    })
    expect(readRateLimitHeaders(headers({}), NOW)).toEqual({})
  })
})

describe('userAgent', () => {
  it('names the plugin, its version and the project; contact goes inside the comment', () => {
    expect(userAgent('0.0.1')).toBe('koishi-plugin-eve-market/0.0.1 (+https://github.com/yilifaer/koishi-plugin-eve-market)')
    expect(userAgent('0.0.2', 'eve:Some Pilot')).toBe('koishi-plugin-eve-market/0.0.2 (+https://github.com/yilifaer/koishi-plugin-eve-market; eve:Some Pilot)')
  })

  it('drops characters that would break the header or the comment', () => {
    expect(userAgent('1.0.0', ' 舰长 (main)\r\nX-Evil: 1 ')).toBe('koishi-plugin-eve-market/1.0.0 (+https://github.com/yilifaer/koishi-plugin-eve-market; main X-Evil: 1)')
    expect(userAgent('1.0.0', '舰长')).toBe('koishi-plugin-eve-market/1.0.0 (+https://github.com/yilifaer/koishi-plugin-eve-market)')
  })
})
