// 管理页的保护（§8.4）：只接受本机（对端地址、没有转发头、Host 是本机的写法）、可选口令（常数时间比较）、
// 一次性操作令牌、一次性 state。
// 这些都只在内存里（模块级存储，控制台保存配置后还在，重启 Koishi 才丢），绝不写日志。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  ADMIN_ACTION_MAX, ADMIN_ACTION_TTL_MIN, ADMIN_SESSION_HOURS, SSO_STATE_MAX, SSO_STATE_TTL_MIN,
} from '../constants'

/** socket 的对端地址；Node 双栈监听时 IPv4 写成 ::ffff:127.0.0.1。写死，不是配置项 */
export const LOOPBACK_ADDRESSES: readonly string[] = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

export function isLoopback(address: string | undefined): boolean {
  return !!address && LOOPBACK_ADDRESSES.includes(address)
}

/**
 * 反向代理、内网穿透、CDN 转发时加的请求头。只看有没有，从不拿它的值来放行：
 * 经它们转发的请求在本机看来也来自 127.0.0.1，但其实可能来自外网
 */
export const PROXY_HEADERS: readonly string[] = [
  'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip',
]

const HOST_PATTERN = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/

/** 请求头 Host 里的主机名（小写，IPv6 带方括号）；格式不对时 null */
export function hostnameOf(host: string | undefined): string | null {
  if (!host || !HOST_PATTERN.test(host)) return null
  try {
    return new URL(`http://${host}/`).hostname.toLowerCase()
  } catch {
    return null
  }
}

const LOCAL_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/**
 * 浏览器地址栏里的主机名必须是本机的写法（端口不限，SSH 隧道换了端口也行），或者和回调地址的主机名一样。
 * 防 DNS 重绑定：别的网站把自己的域名解析到 127.0.0.1 时，Host 是它自己的域名
 */
export function isLocalHost(host: string | undefined, callbackUrl: string): boolean {
  const name = hostnameOf(host)
  if (!name) return false
  if (LOCAL_HOSTNAMES.includes(name)) return true
  try {
    return new URL(callbackUrl).hostname.toLowerCase() === name
  } catch {
    return false
  }
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest()

/** 两边先算 sha256 再比较，长度不同也不会提前返回 */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected))
}

export function hashHex(value: string): string {
  return sha256(value).toString('hex')
}

export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}

/** 有过期时间和数量上限的表；超出上限时丢掉最早放进去的 */
export class Expiring<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>()

  constructor(private readonly max: number) {}

  set(key: string, value: T, ttlMs: number, now: number): void {
    this.prune(now)
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: now + ttlMs })
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string)
  }

  /** 读出来但不删 */
  peek(key: string, now: number): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  /** 读出来并删掉（一次性） */
  take(key: string, now: number): T | undefined {
    const value = this.peek(key, now)
    this.entries.delete(key)
    return value
  }

  get size(): number {
    return this.entries.size
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key)
  }
}

export type AdminAction = 'start' | 'delete' | 'search'

/** 授权结果页的内容（回调处理完以后跳到 ?r=<编号>，刷新页面不会再用一次 code） */
export interface CallbackView {
  ok: boolean
  title: string
  profile?: string
  characterName?: string
  /** 失败时：原因和下一步怎么做 */
  lines: string[]
  structures: Array<{ market: string; structureId: string; name: string; system: string; access: 'ok' | 'forbidden' | 'not_found' | 'error' }>
}

const MINUTE = 60_000
/** 结果页保留多久、最多几份 */
const RESULT_TTL_MS = 10 * MINUTE
const RESULT_MAX = 10
const SESSION_MAX = 20

export class AdminGuard {
  private readonly actions = new Expiring<{ action: AdminAction; profile?: string }>(ADMIN_ACTION_MAX)
  /** 键是 cookie 值的 sha256；值里记着当时口令的 sha256，口令改了就失效 */
  private readonly sessions = new Expiring<{ keyHash: string }>(SESSION_MAX)
  private readonly states = new Expiring<{ profile: string }>(SSO_STATE_MAX)
  private readonly results = new Expiring<CallbackView>(RESULT_MAX)

  /** 页面渲染时发一个令牌；绑定档案时只能用于这个档案 */
  issueAction(action: AdminAction, now: number, profile?: string): string {
    const token = newToken()
    this.actions.set(token, { action, profile }, ADMIN_ACTION_TTL_MIN * MINUTE, now)
    return token
  }

  /** 令牌只能用一次；动作或档案对不上也作废 */
  useAction(token: string | null, action: AdminAction, now: number, profile?: string): boolean {
    if (!token) return false
    const entry = this.actions.take(token, now)
    if (!entry || entry.action !== action) return false
    return entry.profile === undefined || entry.profile === profile
  }

  openSession(adminKey: string, now: number): { cookie: string; maxAgeSec: number } {
    const cookie = newToken(32)
    const ttl = ADMIN_SESSION_HOURS * 60 * MINUTE
    this.sessions.set(hashHex(cookie), { keyHash: hashHex(adminKey) }, ttl, now)
    return { cookie, maxAgeSec: ttl / 1000 }
  }

  hasSession(cookie: string | undefined, adminKey: string, now: number): boolean {
    if (!cookie) return false
    const session = this.sessions.peek(hashHex(cookie), now)
    return !!session && sameSecret(session.keyHash, hashHex(adminKey))
  }

  rememberState(state: string, profile: string, now: number): void {
    this.states.set(state, { profile }, SSO_STATE_TTL_MIN * MINUTE, now)
  }

  /** state 只能用一次、10 分钟内有效 */
  useState(state: string, now: number): { profile: string } | undefined {
    return this.states.take(state, now)
  }

  saveResult(view: CallbackView, now: number): string {
    const id = newToken(16)
    this.results.set(id, view, RESULT_TTL_MS, now)
    return id
  }

  result(id: string, now: number): CallbackView | undefined {
    return this.results.peek(id, now)
  }
}
