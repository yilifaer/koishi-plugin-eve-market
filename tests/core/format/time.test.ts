import { describe, expect, it } from 'vitest'
import { createPriceFormatter, formatAgo, formatClock, formatDuration, zonedParts } from '../../../src/core/format'
import { FakeTime } from '../../fakes/fake-time'

const DISPLAY = { priceDisplayMode: 'full_and_compact', compactDecimals: 2, thousandSeparator: true, showCurrency: true } as const

/** 北京时间 → 毫秒 */
const beijing = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - 8, mi)

describe('clock', () => {
  it('runs under a test time zone that is not UTC+8', () => {
    // vitest.config 里设的 TZ；本机时区不能影响显示
    expect(new Date(Date.UTC(2026, 9, 7, 6, 20)).getTimezoneOffset()).not.toBe(-480)
  })

  it('shows HH:MM in Beijing time for today, MM/DD HH:MM otherwise', () => {
    const time = new FakeTime(beijing(2026, 10, 7, 14, 30))
    const f = createPriceFormatter(DISPLAY, time)
    expect(f.clock(beijing(2026, 10, 7, 14, 20))).toBe('14:20')
    expect(f.clock(beijing(2026, 10, 7, 0, 5))).toBe('00:05')
    expect(f.clock(beijing(2026, 10, 6, 23, 55))).toBe('10/06 23:55')
    expect(f.clock(beijing(2025, 10, 7, 14, 20))).toBe('10/07 14:20')
  })

  it('uses the Beijing date, not the UTC date, to decide what today is', () => {
    // 北京时间 10/08 01:00 = UTC 10/07 17:00
    const time = new FakeTime(beijing(2026, 10, 8, 1, 0))
    const f = createPriceFormatter(DISPLAY, time)
    expect(f.clock(beijing(2026, 10, 8, 0, 30))).toBe('00:30')
    expect(f.clock(beijing(2026, 10, 7, 23, 59))).toBe('10/07 23:59')
  })

  it('follows the clock port as time passes', async () => {
    const time = new FakeTime(beijing(2026, 10, 7, 23, 50))
    const f = createPriceFormatter(DISPLAY, time)
    const at = beijing(2026, 10, 7, 23, 45)
    expect(f.clock(at)).toBe('23:45')
    await time.advance(20 * 60_000)
    expect(f.clock(at)).toBe('10/07 23:45')
  })

  it('formats any time zone, e.g. EVE time in UTC', () => {
    const now = Date.UTC(2026, 9, 7, 11, 5)
    expect(formatClock(Date.UTC(2026, 9, 7, 11, 0), now, 'UTC')).toBe('11:00')
    expect(formatClock(Date.UTC(2026, 9, 7, 11, 0), now, 'Asia/Shanghai')).toBe('19:00')
    expect(zonedParts(Date.UTC(2026, 9, 7, 16, 0), 'Asia/Shanghai')).toEqual({ year: 2026, month: 10, day: 8, hour: 0, minute: 0 })
  })
})

describe('duration', () => {
  it('writes seconds, minutes, hours and days', () => {
    expect(formatDuration(45)).toBe('45 秒')
    expect(formatDuration(57 * 60)).toBe('57 分')
    expect(formatDuration(83 * 60)).toBe('1 小时 23 分')
    expect(formatDuration(2 * 3600)).toBe('2 小时')
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe('3 天 4 小时')
    expect(formatDuration(30 * 86400)).toBe('30 天')
  })

  it('rounds and carries over', () => {
    expect(formatDuration(59.4)).toBe('59 秒')
    expect(formatDuration(59.6)).toBe('1 分')
    expect(formatDuration(3599)).toBe('1 小时')
    expect(formatDuration(86_370)).toBe('1 天')
    expect(formatDuration(3 * 86400 + 4 * 3600 + 40 * 60)).toBe('3 天 5 小时')
  })

  it('treats negative and invalid values as zero', () => {
    expect(formatDuration(-5)).toBe('0 秒')
    expect(formatDuration(Number.NaN)).toBe('0 秒')
  })

  it('is what the formatter uses', () => {
    expect(createPriceFormatter(DISPLAY, new FakeTime()).duration(83 * 60)).toBe('1 小时 23 分')
  })
})

describe('ago', () => {
  it('writes how old data is, rounded down', () => {
    expect(formatAgo(30)).toBe('刚刚')
    expect(formatAgo(18 * 60 + 50)).toBe('18 分钟前')
    expect(formatAgo(72 * 60)).toBe('1 小时 12 分钟前')
    expect(formatAgo(3 * 3600 + 30)).toBe('3 小时前')
    expect(formatAgo(26 * 3600)).toBe('1 天 2 小时前')
    expect(formatAgo(-10)).toBe('刚刚')
  })
})
