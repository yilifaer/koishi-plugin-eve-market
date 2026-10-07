// ESI 的两套限额：
// - 新的限流组（X-Ratelimit-*）：每组一个浮动窗口的 token 桶，429 时按 Retry-After 暂停这个组；
// - 旧的错误额度（X-ESI-Error-Limit-*）：420 时全部暂停到重置时间。
// 状态放在模块级存储里（重载不丢），暂停窗口另外由 client 写进 BlobCache（重启不丢）。

import { ERROR_LIMIT_PAUSE_REMAIN, RATELIMIT_BACKGROUND_PAUSE_PCT } from '../../constants'
import type { EsiGroupStatus, EsiStatus } from '../types'
import { readRateLimitHeaders } from './headers'
import type { HeaderSource } from './headers'

export type EsiLane = 'interactive' | 'background'

/** OpenAPI 规范 x-rate-limit 里的组（待核实）。只用来在第一次响应之前显示；实际以响应头为准 */
export const KNOWN_GROUPS: ReadonlyArray<{ group: string; limit: number; windowMs: number }> = [
  { group: 'market-order', limit: 12000, windowMs: 15 * 60_000 },
  { group: 'industry', limit: 150, windowMs: 15 * 60_000 },
  { group: 'incursion', limit: 150, windowMs: 15 * 60_000 },
  { group: 'status', limit: 600, windowMs: 15 * 60_000 },
]

/** 没有 X-Ratelimit-Used 时按状态码估算花掉的 token（待核实：2xx 2、3xx 1、4xx 5、5xx 0，429 不扣） */
export function tokenCost(status: number): number {
  if (status === 429) return 0
  if (status >= 200 && status < 300) return 2
  if (status >= 300 && status < 400) return 1
  if (status >= 400 && status < 500) return 5
  return 0
}

/** 没有 Retry-After、X-ESI-Error-Limit-Reset 时暂停多久 */
export const DEFAULT_PAUSE_MS = 60_000
/** 自己的消耗记录最多留几条（market-order 组一个窗口最多约 6000 次请求） */
const MAX_LEDGER = 10_000
/** 没有限流组的路由收到 429 时，按路由暂停 */
const ROUTE_PREFIX = 'route:'

interface GroupState {
  limit: number | null
  windowMs: number | null
  /** 最近一次响应头里的剩余 */
  remaining: number | null
  seenAt: number | null
  pausedUntil: number | null
  /** 自己花掉的 token，窗口滑过以后还回来 */
  ledger: Array<{ at: number; cost: number }>
}

export interface LimitState {
  groups: Map<string, GroupState>
  /** 路由模板 → 从 X-Ratelimit-Group 学到的组 */
  routeGroups: Map<string, string>
  errorRemain: number | null
  errorResetAt: number | null
  /** 收到 420 后全部暂停到这个时间 */
  pausedUntil: number | null
}

export function createLimitState(): LimitState {
  const groups = new Map<string, GroupState>()
  for (const known of KNOWN_GROUPS) {
    groups.set(known.group, { limit: known.limit, windowMs: known.windowMs, remaining: null, seenAt: null, pausedUntil: null, ledger: [] })
  }
  return { groups, routeGroups: new Map(), errorRemain: null, errorResetAt: null, pausedUntil: null }
}

/** 写进 BlobCache 的部分：只有还没结束的暂停窗口 */
export interface PersistedLimits {
  v: 1
  pausedUntil: number | null
  errorRemain: number | null
  errorResetAt: number | null
  groups: Record<string, number>
}

export type LimitDecision = { kind: 'rate-limited' | 'error-limited' | 'throttled'; retryAt: number; reason: string }

const later = (a: number | null, b: number) => (a !== null && a > b ? a : b)

export class EsiLimits {
  constructor(readonly state: LimitState) {}

  /** 这个路由归哪个组：调用方声明的、响应头学到的，都没有时按路由单独算 */
  groupKey(route: string, declared?: string): string {
    return declared ?? this.state.routeGroups.get(route) ?? ROUTE_PREFIX + route
  }

  /** 发请求之前：返回 null 表示可以发 */
  check(route: string, declared: string | undefined, lane: EsiLane, now: number): LimitDecision | null {
    const s = this.state
    if (s.pausedUntil !== null && now < s.pausedUntil) {
      return { kind: 'error-limited', retryAt: s.pausedUntil, reason: '错误额度用完（420），全部暂停' }
    }
    const key = this.groupKey(route, declared)
    const group = s.groups.get(key)
    const groupPause = group?.pausedUntil ?? null
    if (groupPause !== null && now < groupPause) {
      return { kind: 'rate-limited', retryAt: groupPause, reason: `限流组 ${key} 收到 429，暂停中` }
    }
    if (lane === 'interactive') return null
    if (this.errorLimitLow(now)) {
      return { kind: 'throttled', retryAt: s.errorResetAt!, reason: `错误额度只剩 ${s.errorRemain}，后台请求暂停` }
    }
    if (group?.limit) {
      const threshold = group.limit * RATELIMIT_BACKGROUND_PAUSE_PCT / 100
      const estimate = this.estimate(group, now)
      if (estimate !== null && estimate < threshold) {
        return { kind: 'throttled', retryAt: this.recoverAt(group, threshold, now), reason: `限流组 ${key} 只剩 ${estimate}/${group.limit}，后台请求暂停` }
      }
    }
    return null
  }

  /** 收到响应以后（包括错误响应）。返回 true 表示暂停窗口变了，要写进 BlobCache */
  observe(route: string, declared: string | undefined, status: number, res: HeaderSource, now: number): boolean {
    const s = this.state
    const h = readRateLimitHeaders(res, now)
    const before = JSON.stringify(this.snapshot(now))
    if (h.group) s.routeGroups.set(route, h.group)
    const key = h.group ?? this.groupKey(route, declared)

    if (h.group || h.limit || h.remaining !== undefined) {
      const group = this.ensure(key)
      if (h.limit) {
        group.limit = h.limit.limit
        group.windowMs = h.limit.windowMs
      }
      const cost = h.used ?? tokenCost(status)
      if (cost > 0) group.ledger.push({ at: now, cost })
      if (h.remaining !== undefined) {
        group.remaining = h.remaining
        group.seenAt = now
      }
      this.prune(group)
    }
    if (status === 429) {
      const group = this.ensure(key)
      group.pausedUntil = later(group.pausedUntil, h.retryAt ?? now + DEFAULT_PAUSE_MS)
    }

    if (h.errorRemain !== undefined) s.errorRemain = h.errorRemain
    if (h.errorResetAt !== undefined) s.errorResetAt = h.errorResetAt
    if (status === 420) {
      const resetAt = s.errorResetAt !== null && s.errorResetAt > now ? s.errorResetAt : now + DEFAULT_PAUSE_MS
      s.pausedUntil = later(s.pausedUntil, resetAt)
    }
    return JSON.stringify(this.snapshot(now)) !== before
  }

  /** 估算现在还剩多少 token：上次看到的剩余 + 之后滑出窗口、还回来的自己的消耗 */
  estimate(group: GroupState, now: number): number | null {
    const { remaining, seenAt, windowMs, limit } = group
    if (remaining === null || seenAt === null || !windowMs) return remaining
    const cap = limit ?? Infinity
    if (now - seenAt >= windowMs) return limit ?? remaining
    let back = 0
    for (const e of group.ledger) {
      if (e.at > seenAt - windowMs && e.at <= seenAt && e.at + windowMs <= now) back += e.cost
    }
    return Math.min(cap, remaining + back)
  }

  status(now: number): EsiStatus {
    const s = this.state
    const groups: EsiGroupStatus[] = []
    for (const [key, group] of s.groups) {
      groups.push({
        group: key.startsWith(ROUTE_PREFIX) ? key.slice(ROUTE_PREFIX.length) : key,
        limit: group.limit,
        remaining: this.estimate(group, now),
        pausedUntil: group.pausedUntil !== null && group.pausedUntil > now ? group.pausedUntil : null,
      })
    }
    const errorLive = s.errorResetAt !== null && s.errorResetAt > now
    return {
      groups,
      errorLimitRemain: errorLive ? s.errorRemain : null,
      errorLimitResetAt: errorLive ? s.errorResetAt : null,
      pausedUntil: s.pausedUntil !== null && s.pausedUntil > now ? s.pausedUntil : null,
    }
  }

  snapshot(now: number): PersistedLimits {
    const s = this.state
    const groups: Record<string, number> = {}
    for (const [key, group] of s.groups) {
      if (group.pausedUntil !== null && group.pausedUntil > now) groups[key] = group.pausedUntil
    }
    const low = this.errorLimitLow(now)
    return {
      v: 1,
      pausedUntil: s.pausedUntil !== null && s.pausedUntil > now ? s.pausedUntil : null,
      errorRemain: low ? s.errorRemain : null,
      errorResetAt: low ? s.errorResetAt : null,
      groups,
    }
  }

  /** 从 BlobCache 读回来的暂停窗口，和现有的取较晚的那个；已经结束的忽略 */
  restore(data: unknown, now: number) {
    if (!isPersisted(data)) return
    const s = this.state
    if (data.pausedUntil !== null && data.pausedUntil > now) s.pausedUntil = later(s.pausedUntil, data.pausedUntil)
    if (data.errorResetAt !== null && data.errorResetAt > now && data.errorRemain !== null) {
      if (s.errorResetAt === null || s.errorResetAt <= now || data.errorRemain < (s.errorRemain ?? Infinity)) {
        s.errorRemain = data.errorRemain
        s.errorResetAt = data.errorResetAt
      }
    }
    for (const [key, until] of Object.entries(data.groups)) {
      if (until > now) this.ensure(key).pausedUntil = later(this.ensure(key).pausedUntil, until)
    }
  }

  private errorLimitLow(now: number): boolean {
    const s = this.state
    return s.errorRemain !== null && s.errorResetAt !== null && now < s.errorResetAt && s.errorRemain < ERROR_LIMIT_PAUSE_REMAIN
  }

  /** 估算的剩余什么时候回到 threshold 以上 */
  private recoverAt(group: GroupState, threshold: number, now: number): number {
    const { remaining, seenAt, windowMs } = group
    if (remaining === null || seenAt === null || !windowMs) return now + DEFAULT_PAUSE_MS
    let acc = remaining
    const counted = group.ledger
      .filter((e) => e.at > seenAt - windowMs && e.at <= seenAt)
      .sort((a, b) => a.at - b.at)
    for (const e of counted) {
      acc += e.cost
      if (acc >= threshold) return Math.max(now, e.at + windowMs)
    }
    return Math.max(now, seenAt + windowMs)
  }

  private ensure(key: string): GroupState {
    let group = this.state.groups.get(key)
    if (!group) {
      group = { limit: null, windowMs: null, remaining: null, seenAt: null, pausedUntil: null, ledger: [] }
      this.state.groups.set(key, group)
    }
    return group
  }

  /** 早于「上次看到剩余 - 窗口」的记录以后不会再用到 */
  private prune(group: GroupState) {
    const { seenAt, windowMs } = group
    if (seenAt !== null && windowMs) {
      const cutoff = seenAt - windowMs
      if (group.ledger.length && group.ledger[0].at <= cutoff) group.ledger = group.ledger.filter((e) => e.at > cutoff)
    }
    if (group.ledger.length > MAX_LEDGER) group.ledger.splice(0, group.ledger.length - MAX_LEDGER)
  }
}

function isTime(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isPersisted(value: unknown): value is PersistedLimits {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  if (o.v !== 1 || !isTime(o.pausedUntil) || !isTime(o.errorRemain) || !isTime(o.errorResetAt)) return false
  if (!o.groups || typeof o.groups !== 'object') return false
  return Object.values(o.groups).every((v) => typeof v === 'number' && Number.isFinite(v))
}
