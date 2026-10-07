// 报价状态的说法（§2.2.7）、▲▼（§2.0.7）、页脚（§2.0.8）。

import { describe, expect, it } from 'vitest'
import { diffMark, footerText, newestTime, quoteView } from '../../../src/bot/commands/quotes'
import { MINUTE, NOW, quote, testCore } from './helpers'

const q = (extra: Parameters<typeof quote>[4]) => quote('jita 4-4', 638, 100, 90, extra)

describe('quoteView', () => {
  it('ok quotes show prices; only markets older than the newest by more than 10 minutes get「N 分钟前」', () => {
    expect(quoteView(q({}), NOW, NOW)).toEqual({})
    expect(quoteView(q({ dataTime: NOW - 10 * MINUTE }), NOW, NOW)).toEqual({})
    expect(quoteView(q({ dataTime: NOW - 18 * MINUTE }), NOW, NOW)).toEqual({ badge: '18 分钟前' })
    expect(quoteView(q({ dataTime: null }), NOW, NOW)).toEqual({})
  })

  it('stale data says why', () => {
    expect(quoteView(q({ status: 'stale', reason: 'cache', dataTime: NOW - 23 * MINUTE }), NOW, NOW)).toEqual({ badge: '23 分钟前（缓存）' })
    expect(quoteView(q({ status: 'stale', reason: 'cache', downtime: true }), NOW, NOW)).toEqual({ badge: 'DT 维护中，显示维护前数据' })
    expect(quoteView(q({ status: 'stale', reason: 'sync_error', dataTime: NOW - 60 * MINUTE }), NOW, NOW)).toEqual({ badge: '⚠ 1 小时前（同步异常）' })
    expect(quoteView(q({ status: 'stale', reason: 'refreshing', dataTime: NOW - 180 * MINUTE }), NOW, NOW)).toEqual({ badge: '⚠ 3 小时前（正在刷新）' })
  })

  it('markets without usable data show one sentence instead of prices', () => {
    const problem = (extra: Parameters<typeof q>[0]) => quoteView(q(extra), NOW, NOW).problem
    expect(problem({ status: 'unavailable', reason: 'esi_error' })).toBe('⚠ ESI 暂时没有响应')
    expect(problem({ status: 'unavailable', reason: 'esi_error', downtime: true })).toBe('⚠ DT 维护中，暂时取不到价格')
    expect(problem({ status: 'unavailable', reason: 'sync_error' })).toBe('⚠ 市场数据暂时不可用（同步异常）')
    expect(problem({ status: 'auth_error', reason: 'auth' })).toBe('⚠ 市场数据暂时不可用（ESI 授权或建筑访问权限异常）')
    // 还没授权：群友看到的和授权异常同一句话
    expect(problem({ status: 'not_ready', reason: 'needs_auth' })).toBe('⚠ 市场数据暂时不可用（ESI 授权或建筑访问权限异常）')
    expect(problem({ status: 'not_ready', reason: 'first_sync' })).toBe('⏳ 首次同步中，请稍后再查')
    expect(problem({ status: 'not_ready', reason: 'resyncing' })).toBe('⏳ 正在同步，请稍后再查')
    expect(problem({ status: 'timeout' })).toBe('⚠ 查询超时，暂时取不到价格')
    expect(quoteView(null, NOW, NOW).problem).toBe('⚠ 查询超时，暂时取不到价格')
  })

  it('the newest time ignores markets without usable data', () => {
    expect(newestTime([q({ dataTime: NOW - MINUTE }), q({ status: 'unavailable', dataTime: NOW }), null])).toBe(NOW - MINUTE)
    expect(newestTime([null])).toBeNull()
  })
})

describe('diffMark', () => {
  it('compares with the base market on the same side, 1 decimal', () => {
    expect(diffMark(270_000_000, 258_400_000)).toBe('▲4.5%')
    expect(diffMark(240_000_000, 249_000_000)).toBe('▼3.6%')
    expect(diffMark(100.25, 100)).toBe('▲0.3%')
  })

  it('stays quiet under 0.1% or when a side is missing', () => {
    expect(diffMark(100.05, 100)).toBeUndefined()
    expect(diffMark(null, 100)).toBeUndefined()
    expect(diffMark(100, undefined)).toBeUndefined()
    expect(diffMark(100, 0)).toBeUndefined()
  })
})

describe('footerText', () => {
  const { format } = testCore()

  it('writes the server, the update time in Beijing time, and extras', () => {
    expect(footerText(format, NOW)).toBe('欧服 · 更新于 14:20')
    expect(footerText(format, NOW - 4 * MINUTE, ['▲▼ 与 Jita 比较'], '联盟市场A ')).toBe('欧服 · 联盟市场A 更新于 14:16 · ▲▼ 与 Jita 比较')
    expect(footerText(format, Date.UTC(2026, 9, 6, 15, 55))).toBe('欧服 · 更新于 10/06 23:55')
    expect(footerText(format, null, ['估价 #K7Q2'])).toBe('欧服 · 估价 #K7Q2')
  })
})
