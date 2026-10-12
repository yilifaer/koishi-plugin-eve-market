// 「市场状态」「市场授权」卡片：各种状态的写法、只在不正常时写最近一次错误、数据太旧的提醒、
// 配置问题太多时只写条数；错误说明截短、转义，卡片里没有网址。时间都是北京时间。

import { describe, expect, it } from 'vitest'
import { STATUS_TEXT, authCard, dots, errorBrief, marketLines, profileLines, statusCard } from '../../../src/bot/commands/status-card'
import type { StatusView } from '../../../src/bot/commands/status-card'
import type { BreakerStatus } from '../../../src/bot/send/breaker'
import { toQQMarkdown } from '../../../src/bot/view/markdown'
import type { Line } from '../../../src/bot/view/card'
import type { AuthProfileStatus, ConfigIssue, CoreStatus, MarketSourceStatus } from '../../../src/core/types'
import { renderOptions } from '../view/cards'
import { MINUTE, NOW } from './helpers'

const HOUR = 60 * MINUTE
const text = (lines: Line[]) => lines.map((l) => `${l.indent ? '    ' : ''}${'text' in l ? l.text : l.label}`).join('\n')

function market(o: Partial<MarketSourceStatus> = {}): MarketSourceStatus {
  return {
    marketKey: 'jita', name: 'Jita 4-4', type: 'npc-station', source: 'region', state: 'OK', paused: false,
    lastRequestAt: null, lastSyncAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null, pages: null, orders: null, ...o,
  }
}

const structure = (o: Partial<MarketSourceStatus> = {}) =>
  market({ marketKey: '联盟市场a', name: '联盟市场A', type: 'structure', source: 'structure', authProfile: 'default', ...o })

function profile(o: Partial<AuthProfileStatus> = {}): AuthProfileStatus {
  return {
    profile: 'default', status: 'OK', characterId: '2112000001', characterName: '示例角色', scopesGranted: 3, scopesRequired: 3,
    tokenValid: true, lastRefreshAt: NOW - 19 * MINUTE, lastSuccessAt: NOW - 19 * MINUTE, lastError: '', lastErrorAt: null,
    markets: ['联盟市场A', '联盟市场B'], ...o,
  }
}

function coreStatus(o: Partial<CoreStatus> = {}): CoreStatus {
  return {
    at: NOW,
    ready: true,
    data: {
      ready: true, origin: 'online', buildNumber: 3579973, dataRevision: 1, sdeReleaseDate: '2026-10-01', generatedAt: '2026-10-06T06:00:00Z',
      ageDays: 1, lastCheckAt: NOW - HOUR, lastConfirmedAt: NOW - 8 * HOUR - 20 * MINUTE, lastError: '',
      glossary: { origin: 'online', entries: 325, lastConfirmedAt: NOW - HOUR, lastError: '' },
    },
    items: { items: 40000, marketItems: 18000, adminAliases: 3, glossaryAliases: 612, sets: 30 },
    markets: [market({ lastRequestAt: NOW - MINUTE })],
    auth: [],
    esi: {
      groups: [{ group: 'market-order', limit: 12000, remaining: 11640, pausedUntil: null }],
      errorLimitRemain: 100, errorLimitResetAt: null, pausedUntil: null,
    },
    issues: [],
    ...o,
  }
}

const breaker = (o: Partial<BreakerStatus> = {}): BreakerStatus => ({ open: false, until: null, recentFailures: 0, trips: 0, lastTripAt: null, ...o })

function view(o: Partial<StatusView> = {}): StatusView {
  return { now: NOW, ssoConfigured: true, web: true, status: coreStatus(), conflicts: [], breaker: breaker(), ...o }
}

const env = { now: NOW, ssoConfigured: true, web: true }
const md = (card: ReturnType<typeof statusCard>) => toQQMarkdown(card, renderOptions()).md

describe('dots', () => {
  it('joins with « · », without a space after a full-width bracket or quote', () => {
    expect(dots(['🟢 正常', '角色「示例角色」', '权限 3/3', ''])).toBe('🟢 正常 · 角色「示例角色」· 权限 3/3')
    expect(dots(['403（没有建筑访问权限）', '13:40'])).toBe('403（没有建筑访问权限）· 13:40')
  })
})

describe('errorBrief', () => {
  it('names the usual statuses, otherwise shortens the message', () => {
    expect(errorBrief({ status: 403, message: 'Market access denied' })).toBe('403（没有建筑访问权限）')
    expect(errorBrief({ status: 401, message: 'authentication failure' })).toBe('401（令牌被拒）')
    expect(errorBrief({ status: 502, message: 'Bad gateway' })).toBe('502（ESI 服务器出错）')
    expect(errorBrief({ status: 400, message: 'bad request' })).toBe('400（bad request）')
    expect(errorBrief({ code: 'timeout', message: `${'很长的说明'.repeat(30)}` })).toHaveLength(80)
  })
})

describe('市场状态: markets', () => {
  it('each state has its own words; the last error only while it is not OK', () => {
    const lines = [
      market({ lastRequestAt: NOW - MINUTE }),
      structure({ lastSuccessAt: NOW - 4 * MINUTE, pages: 3, orders: 2841, lastError: { status: 403, message: 'x' }, lastErrorAt: NOW - HOUR }),
      structure({ name: '联盟市场B', state: 'AUTH_ERROR', lastSuccessAt: NOW - 3 * HOUR - 18 * MINUTE, lastError: { status: 403, message: 'Market access denied' }, lastErrorAt: NOW - 40 * MINUTE }),
      structure({ name: '联盟市场C', state: 'NEEDS_AUTH', authProfile: 'logistics' }),
      structure({ name: '联盟市场D', state: 'DEGRADED', lastError: { status: 503, message: 'Service unavailable' }, lastErrorAt: NOW - 5 * MINUTE }),
      structure({ name: '联盟市场E', state: 'FIRST_SYNC' }),
      structure({ name: '联盟市场F', paused: true, lastSuccessAt: NOW - 25 * HOUR, pages: 1, orders: 12 }),
      market({ name: '公开建筑', type: 'structure', source: 'region' }),
      market({ name: 'Amarr', state: 'DEGRADED', lastSuccessAt: NOW - 2 * MINUTE, lastError: { route: 'GET /markets/{region_id}/orders', code: 'timeout', message: '10000 毫秒没有响应' }, lastErrorAt: NOW - MINUTE }),
    ].flatMap((m) => marketLines(m, env))
    expect(text(lines)).toBe([
      'Jita 4-4：🟢 正常 · NPC 市场 · 最近请求 14:19',
      '联盟市场A：🟢 正常 · 建筑市场 · 同步于 14:16 · 3 页 2,841 单',
      '联盟市场B：🔴 授权异常 · 最后成功 11:02',
      '    403（没有建筑访问权限）· 13:40',
      '联盟市场C：🟡 需要授权（授权页面里的档案 logistics）',
      '联盟市场D：🟡 同步异常 · 还没有成功过',
      '    503（ESI 服务器出错）· 14:15',
      '联盟市场E：⏳ 首次同步中 · 建筑市场',
      '联盟市场F：🟢 正常 · 建筑市场 · 同步于 10/06 13:20 · 1 页 12 单 · 没人查，同步已暂停',
      '公开建筑：🟢 正常 · 建筑市场（公开订单）· 还没有人查',
      'Amarr：🟡 ESI 出错 · 最后成功 14:18',
      '    10000 毫秒没有响应 · 14:19',
    ].join('\n'))
  })

  it('without a Client ID the structure says what to fill in', () => {
    expect(text(marketLines(structure({ state: 'NEEDS_AUTH' }), { ...env, ssoConfigured: false })))
      .toBe('联盟市场A：🟡 需要授权（控制台「EVE 授权」里还没填 Client ID 和 Secret Key）')
  })
})

describe('市场状态: the whole card', () => {
  it('lays out markets, profiles, data, ESI, messages, config problems and conflicts with the refresh button', () => {
    const card = statusCard(view({
      status: coreStatus({
        markets: [market({ lastRequestAt: NOW - MINUTE }), structure({ lastSuccessAt: NOW - 4 * MINUTE, pages: 3, orders: 2841 })],
        auth: [profile()],
        issues: [{ section: 'markets', row: 6, field: 'location', message: '「位置」不是数字，已跳过' }],
      }),
    }), [[{ label: STATUS_TEXT.refresh, command: { id: 'marketStatus', args: '刷新' }, primary: true }]])
    expect(md(card)).toBe([
      '**数据状态 · 14:20**',
      '',
      '- Jita 4-4：🟢 正常 · NPC 市场 · 最近请求 14:19',
      '- 联盟市场A：🟢 正常 · 建筑市场 · 同步于 14:16 · 3 页 2,841 单',
      '- 授权档案 default：🟢 令牌有效 · 权限 3/3 · 刷新于 14:01',
      '- 物品数据：SDE build 3579973 · 来自在线（06:00 确认最新）',
      '- 黑话表：在线 · 325 条 · 别名接入 612 个',
      '- ESI 配额：market-order 剩余 97% · 错误额度 100',
      '- 消息：Markdown 正常',
      '- 配置问题：市场第 6 行「位置」不是数字，已跳过',
      '- 命令冲突：无',
    ].join('\n'))
    expect(toQQMarkdown(card, renderOptions()).rows).toEqual([[{ label: '立即刷新', text: '市场状态 刷新', primary: true }]])
  })

  it('warns about old data, a 420 pause, the Markdown breaker, the missing server plugin and many problems', () => {
    const issues: ConfigIssue[] = Array.from({ length: 10 }, (_, i) => ({ section: 'aliases', row: i + 1, message: `别名第 ${i + 1} 个有问题` }))
    const card = statusCard(view({
      web: false,
      refreshed: ['刷新结果：物品数据在线确认是最新'],
      status: coreStatus({
        data: { ...coreStatus().data, ageDays: 16.4, lastError: 'HTTP 503' },
        esi: { groups: [{ group: 'market-order', limit: 12000, remaining: 100, pausedUntil: NOW + 5 * MINUTE }], errorLimitRemain: 0, errorLimitResetAt: NOW + MINUTE, pausedUntil: NOW + MINUTE },
        issues,
      }),
      breaker: breaker({ open: true, until: NOW + 29 * MINUTE, trips: 2, lastTripAt: NOW - MINUTE }),
      conflicts: [{ id: 'search', name: '搜索', kind: 'name' }],
    }), [])
    const out = md(card)
    expect(out).toContain('**数据状态 · 14:20**\n刷新结果：物品数据在线确认是最新\n\n')
    expect(out).toContain('- 授权页面：需要 Koishi 的 server 插件')
    expect(out).toContain('- ⚠ 物品数据已经 16 天没更新（eve-cn-slang 的每周更新可能没合并或没运行）\n    - SDE build 3579973 · 来自在线\n    - 最近一次在线检查失败：HTTP 503')
    expect(out).toContain('- ESI 配额：market-order 暂停到 14:25 · 错误额度 0\n    - ⚠ 错误太多（420），全部请求暂停到 14:21')
    expect(out).toContain('- 消息：🔴 Markdown 连续发送失败，14:49 之前改发纯文字 · 累计降级 2 次（最近 14:19）')
    expect(out).toContain('- 配置问题：10 条\n    - 物品别名第 1 行别名第 1 个有问题')
    expect(out).toContain('    - 另有 2 条，详见 Koishi 日志')
    expect(out).toContain('- 命令冲突：「搜索」和别的插件的命令重名，没有注册')
  })

  it('with industry locations: when the system indices and adjusted prices were updated (§2.16)', () => {
    const industry = { indicesAt: NOW - 80 * MINUTE, adjustedPricesAt: NOW - 75 * MINUTE }
    const out = md(statusCard(view({ status: coreStatus({ industry }) }), []))
    expect(out).toContain('- 黑话表：在线 · 325 条 · 别名接入 612 个\n- 系统指数：13:00 更新 · 调整价：13:05 更新\n- ESI 配额：')
    const none = md(statusCard(view({ status: coreStatus({ industry: { indicesAt: null, adjustedPricesAt: null } }) }), []))
    expect(none).toContain('- 系统指数：还没有 · 调整价：还没有')
    // 没配工业地点时不写这一行
    expect(md(statusCard(view(), []))).not.toContain('系统指数')
  })

  it('before the data is loaded', () => {
    const out = md(statusCard(view({ status: coreStatus({ ready: false, data: { ...coreStatus().data, ready: false } }) }), []))
    expect(out).toContain('- 物品数据：加载中')
  })
})

describe('市场授权', () => {
  it('lists each profile with its character, scopes and markets, and how to authorize; no secrets, no links', () => {
    const card = authCard([
      profile(),
      profile({
        profile: 'logistics', status: 'AUTH_ERROR', characterName: '仓库角色', tokenValid: false, lastRefreshAt: NOW - 17 * HOUR,
        lastError: '刷新令牌失效（被撤销、过期或已经换过），请重新授权', lastErrorAt: NOW - 17 * HOUR - 10 * MINUTE, markets: [],
      }),
      profile({ profile: 'spare', status: 'NEEDS_AUTH', characterName: '', scopesGranted: 0, tokenValid: false, lastRefreshAt: null, markets: ['联盟市场C'] }),
    ], env, [[{ label: '市场状态', command: { id: 'marketStatus' } }]])
    const out = md(card)
    expect(out).toBe([
      '**EVE 授权档案**',
      '',
      '- default：🟢 正常 · 角色「示例角色」· 权限 3/3 · 刷新于 14:01',
      '    - 使用的市场：联盟市场A、联盟市场B',
      '- logistics：🔴 需要重新授权 · 角色「仓库角色」· 权限 3/3 · 刷新于 10/06 21:20',
      '    - 刷新令牌失效（被撤销、过期或已经换过），请重新授权 · 10/06 21:10',
      '- spare：🟡 需要授权',
      '    - 使用的市场：联盟市场C',
      '',
      '要授权或重新授权：在浏览器里打开 Koishi 控制台，进本插件的设置页，点最上面的「打开 EVE 授权页面」。',
    ].join('\n'))
    expect(out).not.toMatch(/https?:|\/eve-market/)
  })

  it('says when nothing is configured, there is no profile or no server plugin', () => {
    const out = md(authCard([], { now: NOW, ssoConfigured: false, web: false }, []))
    expect(out).toContain(`- ${STATUS_TEXT.noProfiles}`)
    expect(out).toContain('控制台「EVE 授权」里还没填 Client ID 和 Secret Key。\n授权页面：需要 Koishi 的 server 插件（授权页面和 SSO 回调都挂在它上面）。')
  })

  it('escapes names that look like Markdown', () => {
    expect(text(profileLines(profile({ characterName: '**粗体**' }), NOW, false))[0]).not.toContain('**粗体')
  })
})
