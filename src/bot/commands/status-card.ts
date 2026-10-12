// 「市场状态」「市场授权」的卡片（§2.16）：只用 core 给的状态，纯函数，方便单测。
// 只写状态和原因，绝不出现口令、token、Client Secret 和网址（错误说明在 core 里已经脱敏，这里再截短、转义）。
// 最近一次错误在恢复以后还留着，只在状态不正常时显示。

import { DATA_STALE_WARN_DAYS, TIMEZONE } from '../../constants'
import { describeIssue } from '../../core'
import { formatClock } from '../../core/format'
import type { AuthProfileStatus, CoreStatus, DataOrigin, MarketSourceStatus, MarketType, SafeErrorInfo } from '../../core/types'
import type { CommandConflict } from '../register'
import { describeConflict } from '../register'
import type { BreakerStatus } from '../send/breaker'
import type { Action, Card, Line } from '../view/card'
import type { WatchdogStatus } from '../watchdog'
import { escapeMarkdown } from '../view/escape'
import { emptyCard } from './context'

/** 错误说明最多显示多少字 */
const MAX_ERROR_CHARS = 80
/** 配置问题、命令冲突最多列几条，再多只写条数 */
const MAX_LISTED = 8

export const STATUS_TEXT = {
  title: '**数据状态**',
  authTitle: '**EVE 授权档案**',
  refresh: '立即刷新',
  refreshArg: '刷新',
  none: '无',
  noServer: '需要 Koishi 的 server 插件（授权页面和 SSO 回调都挂在它上面）',
  notConfigured: '控制台「EVE 授权」里还没填 Client ID 和 Secret Key',
  noProfiles: '还没有授权档案：只有联盟建筑市场需要授权（市场表格里「授权档案」一栏写的名字，例如 default）',
  howTo: '要授权或重新授权：在浏览器里打开 Koishi 控制台，进本插件的设置页，点最上面的「打开 EVE 授权页面」。',
  more: (n: number) => `另有 ${n} 条，详见 Koishi 日志`,
} as const

const TYPE_LABEL: Record<MarketType, string> = {
  'npc-station': 'NPC 市场',
  system: '星系市场',
  region: '星域市场',
  structure: '建筑市场',
}

const ORIGIN_LABEL: Record<DataOrigin, string> = {
  online: '来自在线',
  cache: '来自本机缓存',
  bundled: '插件自带',
}

const GLOSSARY_ORIGIN: Record<DataOrigin, string> = {
  online: '在线',
  cache: '本机缓存',
  bundled: '插件自带',
}

export interface StatusEnv {
  now: number
  /** 控制台填了 Client ID 和 Secret Key */
  ssoConfigured: boolean
  /** 授权页面挂上了（有 server 插件） */
  web: boolean
}

export interface StatusView extends StatusEnv {
  status: CoreStatus
  conflicts: readonly CommandConflict[]
  breaker: BreakerStatus
  /** 官方机器人和看门狗；不写 = 不显示这一行 */
  watchdog?: WatchdogStatus
  /** 「市场状态 刷新」的结果，写在标题下面 */
  refreshed?: string[]
}

const clock = (ms: number, now: number) => formatClock(ms, now, TIMEZONE)

/** 用「 · 」连起来；前一段以全角括号、引号结尾时不加空格（「示例角色」· 权限 3/3） */
export function dots(parts: readonly string[]): string {
  return parts.filter(Boolean).reduce((out, part) => !out ? part : /[）」』]$/.test(out) ? `${out}· ${part}` : `${out} · ${part}`, '')
}

function cut(text: string, max = MAX_ERROR_CHARS): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** 「403（没有建筑访问权限）」；没有 HTTP 状态时用说明本身 */
export function errorBrief(error: SafeErrorInfo): string {
  const s = error.status
  if (s === 401) return '401（令牌被拒）'
  if (s === 403) return '403（没有建筑访问权限）'
  if (s === 404) return '404（找不到这个建筑）'
  if (s === 420) return '420（ESI 错误额度用完）'
  if (s === 429) return '429（请求太频繁）'
  if (s !== undefined && s >= 500) return `${s}（ESI 服务器出错）`
  if (s !== undefined) return `${s}（${cut(error.message, 40)}）`
  return cut(error.message)
}

const withTime = (text: string, at: number | null, now: number) => at === null ? text : dots([text, clock(at, now)])

// ------------------------------------------------------------------ 市场

function lastSuccess(m: MarketSourceStatus, now: number): string {
  return m.lastSuccessAt === null ? '还没有成功过' : `最后成功 ${clock(m.lastSuccessAt, now)}`
}

function marketKind(m: MarketSourceStatus): string {
  // 授权档案留空的玩家建筑从星域订单里读公开订单
  return m.type === 'structure' && m.source === 'region' ? '建筑市场（公开订单）' : TYPE_LABEL[m.type]
}

function okMarket(m: MarketSourceStatus, now: number): string {
  if (m.source === 'region') {
    return dots(['🟢 正常', marketKind(m), m.lastRequestAt === null ? '还没有人查' : `最近请求 ${clock(m.lastRequestAt, now)}`])
  }
  const parts = ['🟢 正常', marketKind(m)]
  if (m.lastSuccessAt !== null) parts.push(`同步于 ${clock(m.lastSuccessAt, now)}`)
  if (m.pages !== null && m.orders !== null) parts.push(`${m.pages} 页 ${m.orders.toLocaleString('en-US')} 单`)
  if (m.paused) parts.push('没人查，同步已暂停')
  return dots(parts)
}

function needsAuth(m: MarketSourceStatus, env: StatusEnv): string {
  if (!env.ssoConfigured) return `🟡 需要授权（${STATUS_TEXT.notConfigured}）`
  return `🟡 需要授权（授权页面里的档案 ${escapeMarkdown(m.authProfile ?? 'default')}）`
}

export function marketLines(m: MarketSourceStatus, env: StatusEnv): Line[] {
  const name = escapeMarkdown(m.name)
  const { now } = env
  let head: string
  switch (m.state) {
    case 'OK':
      return [{ text: `${name}：${okMarket(m, now)}` }]
    case 'FIRST_SYNC':
      return [{ text: `${name}：${dots(['⏳ 首次同步中', marketKind(m)])}` }]
    case 'NEEDS_AUTH':
      return [{ text: `${name}：${needsAuth(m, env)}` }]
    case 'DEGRADED':
      head = `${name}：${dots([`🟡 ${m.source === 'region' ? 'ESI 出错' : '同步异常'}`, lastSuccess(m, now)])}`
      break
    case 'AUTH_ERROR':
      head = `${name}：${dots(['🔴 授权异常', lastSuccess(m, now)])}`
      break
  }
  const lines: Line[] = [{ text: head }]
  if (m.lastError) lines.push({ text: withTime(escapeMarkdown(errorBrief(m.lastError)), m.lastErrorAt, now), indent: 1 })
  return lines
}

// ------------------------------------------------------------------ 授权档案

function profileState(p: AuthProfileStatus, forStatus: boolean): string {
  switch (p.status) {
    case 'OK':
      return forStatus && p.tokenValid ? '🟢 令牌有效' : '🟢 正常'
    case 'DEGRADED':
      return '🟡 暂时刷新不了'
    case 'AUTH_ERROR':
      return '🔴 需要重新授权'
    case 'NEEDS_AUTH':
      return '🟡 需要授权'
  }
}

/** forStatus：「市场状态」里的写法（前面加「授权档案」）；否则是「市场授权」里的写法（带角色名和用到的市场） */
export function profileLines(p: AuthProfileStatus, now: number, forStatus: boolean): Line[] {
  const parts = [profileState(p, forStatus)]
  if (p.characterName && !forStatus) parts.push(`角色「${escapeMarkdown(p.characterName)}」`)
  if (p.characterName) parts.push(`权限 ${p.scopesGranted}/${p.scopesRequired}`)
  if (p.status !== 'NEEDS_AUTH' && p.lastRefreshAt !== null) parts.push(`刷新于 ${clock(p.lastRefreshAt, now)}`)
  if (p.status === 'DEGRADED' && p.lastSuccessAt !== null) parts.push(`最后成功 ${clock(p.lastSuccessAt, now)}`)
  const label = `${forStatus ? '授权档案 ' : ''}${escapeMarkdown(p.profile)}`
  const lines: Line[] = [{ text: `${label}：${dots(parts)}` }]
  if (p.status !== 'OK' && p.lastError) lines.push({ text: withTime(escapeMarkdown(cut(p.lastError, 120)), p.lastErrorAt, now), indent: 1 })
  if (!forStatus && p.markets.length) lines.push({ text: `使用的市场：${p.markets.map(escapeMarkdown).join('、')}`, indent: 1 })
  return lines
}

// ------------------------------------------------------------------ 数据、ESI、消息

function dataLines(status: CoreStatus, now: number): Line[] {
  const d = status.data
  if (!d.ready) return [{ text: '物品数据：加载中' }]
  const build = `SDE build ${d.buildNumber ?? '?'}`
  const origin = d.origin ? ORIGIN_LABEL[d.origin] : ''
  const confirmed = d.lastConfirmedAt === null ? '' : `（${clock(d.lastConfirmedAt, now)} 确认最新）`
  const lines: Line[] = []
  if (d.ageDays !== null && d.ageDays > DATA_STALE_WARN_DAYS) {
    lines.push({ text: `⚠ 物品数据已经 ${Math.floor(d.ageDays)} 天没更新（eve-cn-slang 的每周更新可能没合并或没运行）` })
    lines.push({ text: dots([build, origin]), indent: 1 })
  } else {
    lines.push({ text: `物品数据：${dots([build, `${origin}${confirmed}`])}` })
  }
  if (d.lastError) lines.push({ text: `最近一次在线检查失败：${escapeMarkdown(cut(d.lastError))}`, indent: 1 })
  const g = d.glossary
  if (!g.origin) {
    lines.push({ text: '黑话表：没有加载' })
  } else {
    lines.push({ text: `黑话表：${dots([GLOSSARY_ORIGIN[g.origin], `${g.entries.toLocaleString('en-US')} 条`, `别名接入 ${status.items.glossaryAliases.toLocaleString('en-US')} 个`])}` })
  }
  if (g.lastError) lines.push({ text: `最近一次在线检查失败：${escapeMarkdown(cut(g.lastError))}`, indent: 1 })
  return lines
}

/** 系统指数：13:00 更新 · 调整价：13:05 更新（配了工业地点时才有） */
function industryLines(status: CoreStatus, now: number): Line[] {
  const i = status.industry
  if (!i) return []
  const at = (ms: number | null) => (ms === null ? '还没有' : `${clock(ms, now)} 更新`)
  return [{ text: `系统指数：${at(i.indicesAt)} · 调整价：${at(i.adjustedPricesAt)}` }]
}

function esiLine(status: CoreStatus, now: number): Line[] {
  const e = status.esi
  const parts: string[] = []
  for (const g of e.groups) {
    if (g.pausedUntil !== null && g.pausedUntil > now) parts.push(`${escapeMarkdown(g.group)} 暂停到 ${clock(g.pausedUntil, now)}`)
    else if (g.limit && g.remaining !== null) parts.push(`${escapeMarkdown(g.group)} 剩余 ${Math.floor((g.remaining / g.limit) * 100)}%`)
  }
  if (e.errorLimitRemain !== null) parts.push(`错误额度 ${e.errorLimitRemain}`)
  const lines: Line[] = [{ text: `ESI 配额：${parts.length ? dots(parts) : '还没有请求'}` }]
  if (e.pausedUntil !== null && e.pausedUntil > now) lines.push({ text: `⚠ 错误太多（420），全部请求暂停到 ${clock(e.pausedUntil, now)}`, indent: 1 })
  return lines
}

function messageLine(breaker: BreakerStatus, now: number): Line {
  const head = breaker.open && breaker.until !== null
    ? `🔴 Markdown 连续发送失败，${clock(breaker.until, now)} 之前改发纯文字`
    : 'Markdown 正常'
  const trips = breaker.trips && breaker.lastTripAt !== null ? `累计降级 ${breaker.trips} 次（最近 ${clock(breaker.lastTripAt, now)}）` : ''
  return { text: `消息：${dots([head, trips])}` }
}

/** 官方机器人：在线 · 自动重启过 1 次（最近 14:20，之前不在线 12 分钟） */
function botLine(w: WatchdogStatus | undefined, now: number): Line[] {
  if (!w) return []
  if (!w.bots) return [{ text: '官方机器人：没有找到（adapter-qq 没有启用）' }]
  const restarted = w.restarts && w.lastRestartAt !== null
    ? `自动重启过 ${w.restarts} 次（最近 ${clock(w.lastRestartAt, now)}${w.lastDownMinutes === null ? '' : `，之前不在线 ${w.lastDownMinutes} 分钟`}）`
    : ''
  const off = w.enabled ? '' : '看门狗已关闭'
  if (w.downSince === null) return [{ text: `官方机器人：${dots(['在线', restarted, off])}` }]
  const minutes = Math.max(0, Math.floor((now - w.downSince) / 60_000))
  const auto = w.enabled ? '连续 10 分钟不在线会自动重启 adapter-qq' : off
  return [{ text: `官方机器人：${dots([`🔴 已经 ${minutes} 分钟不在线`, auto, restarted])}` }]
}

/** 「配置问题：无」「配置问题：…」或「配置问题：3 条」加下面的明细 */
function listLines(label: string, items: string[]): Line[] {
  if (!items.length) return [{ text: `${label}：${STATUS_TEXT.none}` }]
  if (items.length === 1) return [{ text: `${label}：${items[0]}` }]
  const shown = items.slice(0, MAX_LISTED).map((text): Line => ({ text, indent: 1 }))
  if (items.length > MAX_LISTED) shown.push({ text: STATUS_TEXT.more(items.length - MAX_LISTED), indent: 1 })
  return [{ text: `${label}：${items.length} 条` }, ...shown]
}

// ------------------------------------------------------------------ 卡片

export function statusCard(view: StatusView, actions: Action[][]): Card {
  const { status, now } = view
  const card = emptyCard(`${STATUS_TEXT.title} · ${clock(now, now)}`)
  if (view.refreshed?.length) card.meta.push(...view.refreshed)
  const lines: Line[] = [
    ...status.markets.flatMap((m) => marketLines(m, view)),
    ...status.auth.flatMap((p) => profileLines(p, now, true)),
    ...view.web ? [] : [{ text: `授权页面：${STATUS_TEXT.noServer}` }],
    ...dataLines(status, now),
    ...industryLines(status, now),
    ...esiLine(status, now),
    ...botLine(view.watchdog, now),
    messageLine(view.breaker, now),
    ...listLines('配置问题', status.issues.map((i) => escapeMarkdown(describeIssue(i)))),
    ...listLines('命令冲突', view.conflicts.map((c) => escapeMarkdown(describeConflict(c)))),
  ]
  card.sections.push({ lines })
  card.actions = actions
  return card
}

export function authCard(profiles: AuthProfileStatus[], env: StatusEnv, actions: Action[][]): Card {
  const card = emptyCard(STATUS_TEXT.authTitle)
  const lines = profiles.flatMap((p) => profileLines(p, env.now, false))
  card.sections.push({ lines: lines.length ? lines : [{ text: STATUS_TEXT.noProfiles }] })
  const notes: Line[] = []
  if (!env.ssoConfigured) notes.push({ text: `${STATUS_TEXT.notConfigured}。` })
  if (!env.web) notes.push({ text: `授权页面：${STATUS_TEXT.noServer}。` })
  notes.push({ text: STATUS_TEXT.howTo })
  card.sections.push({ style: 'plain', lines: notes })
  card.actions = actions
  return card
}
