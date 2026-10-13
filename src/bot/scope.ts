// 平台范围、@ 要求、自我回声保护、消息去重，以及管理员和授权判断（Access）。
//
// - 只回复 qq；控制台打开 allowSandbox 时也回复沙盒。onebot（LLBot）上的消息一律不碰。
// - 群里默认只处理 @机器人 的消息（requireAt）；单聊不用 @。
// - 全量消息事件不会过滤机器人自己发的消息：不带 @ 的群消息和本插件 60 秒内在这个频道发过的文字完全相同时丢掉。
// - 同一条消息（platform:messageId）2 分钟内只处理一次（前置中间件调用）。

import type { Context, Session } from 'koishi'
import { ADMIN_AUTHORITY, DEDUP_MINUTES } from '../constants'
import type { ModuleStore } from '../core/ports'
import type { Access, AccessSettings, GeneralSettings } from '../core/types'
import { LruCache } from '../core/util'
import { echoChannel } from './send/echo'
import type { EchoLog } from './send/echo'

// ------------------------------------------------------------------ 平台和 @

export function isSandbox(platform: string): boolean {
  return platform === 'sandbox' || platform.startsWith('sandbox:')
}

/** 本插件回复的平台：qq；allowSandbox 时加上控制台沙盒 */
export function inPlatform(platform: string | undefined, general: Pick<GeneralSettings, 'allowSandbox'>): boolean {
  if (!platform) return false
  return platform === 'qq' || (general.allowSandbox && isSandbox(platform))
}

/** 消息是对本插件说的：单聊，或者 @ 了机器人 */
export function isAddressed(session: Pick<Session, 'isDirect' | 'stripped'>): boolean {
  return session.isDirect || !!session.stripped.appel
}

/** 不带 @ 的群消息，内容和本插件 60 秒内在这个频道发过的文字相同 */
export function isSelfEcho(session: Session, echo: EchoLog, now: number): boolean {
  if (isAddressed(session) || !session.elements) return false
  const channel = echoChannel(session)
  return echo.seen(channel, session.content ?? '', now) || echo.seen(channel, session.stripped.content ?? '', now)
}

export interface ScopeOptions {
  general: GeneralSettings
  /** 发送记录（sendState(store).echo） */
  echo: EchoLog
  now?: () => number
}

export interface Scopes {
  /** 平台范围：事件、后台任务 */
  scoped: Context
  /** 命令、中间件：再加上 @ 要求和自我回声保护 */
  cmdCtx: Context
  /**
   * 和 cmdCtx 一样的判断，挂在命令名和别名上：Koishi 解析命令时只看别名上的过滤器，
   * 不挂的话 onebot 上的「入侵」会解析成本插件的命令、执行时被拒绝，而且不再交给后面的中间件
   */
  filter: (session: Session) => boolean
}

export function createScopes(ctx: Context, options: ScopeOptions): Scopes {
  const { general, echo } = options
  const now = options.now ?? Date.now
  const scoped = ctx.intersect((s) => inPlatform(s.platform, general))
  const cmdCtx = scoped.intersect((s) =>
    (s.isDirect || !general.requireAt || !!s.stripped.appel) && !isSelfEcho(s, echo, now()))
  return { scoped, cmdCtx, filter: (s) => cmdCtx.filter(s) }
}

// ------------------------------------------------------------------ 去重

/** 同一条消息（全量消息模式下 @ 消息可能经两个事件各到一次）只处理一次 */
export class MessageDedupe {
  private readonly seen: LruCache<string, true>

  constructor(options: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.seen = new LruCache({ max: options.max ?? 5000, ttlMs: options.ttlMs ?? DEDUP_MINUTES * 60_000, now: options.now ?? Date.now })
  }

  /** 第一次见到时返回 true 并记下；没有消息 ID 时总是 true */
  first(key: string | undefined): boolean {
    if (!key) return true
    if (this.seen.has(key)) return false
    this.seen.set(key, true)
    return true
  }
}

export function messageKey(session: Pick<Session, 'platform' | 'messageId'>): string | undefined {
  return session.messageId ? `${session.platform}:${session.messageId}` : undefined
}

export const DEDUPE_STORE_KEY = 'bot/dedupe'

/** 放在模块级存储里：插件重载前后到达的同一条消息也能认出来 */
export function messageDedupe(store: ModuleStore): MessageDedupe {
  return store.get(DEDUPE_STORE_KEY, () => new MessageDedupe())
}

// ------------------------------------------------------------------ 管理员和授权（Access）

/** 构造 Access 需要的会话信息（Koishi 的 Session 直接能用） */
export interface AccessSession {
  platform: string
  userId?: string
  channelId?: string
  guildId?: string
  isDirect: boolean
  /** session.user（observeUser 之后才有 authority） */
  user?: unknown
  /** 事件原文在 event._data（QQ：{ d: { author: { union_openid } } }） */
  event?: unknown
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? value as Record<string, unknown> : undefined

/** QQ 事件里的 union_openid（跨群、跨私聊相同的 ID，有就用） */
export function unionIdOf(session: Pick<AccessSession, 'platform' | 'event'>): string | undefined {
  if (session.platform !== 'qq') return undefined
  const author = asRecord(asRecord(asRecord(asRecord(session.event)?._data)?.d)?.author)
  const id = author?.union_openid
  return typeof id === 'string' && id ? id : undefined
}

export function authorityOf(session: Pick<AccessSession, 'user'>): number {
  const authority = asRecord(session.user)?.authority
  return typeof authority === 'number' ? authority : 0
}

/** 一个 ID 在配置里的几种写法：原样、带平台前缀（配置里 qq: 已经去掉） */
function idForms(platform: string, ...ids: Array<string | undefined>): string[] {
  return ids.filter((id): id is string => !!id).flatMap((id) => [id, `${platform}:${id}`])
}

export function isAdmin(session: AccessSession, settings: Pick<AccessSettings, 'admins'>): boolean {
  const forms = idForms(session.platform, session.userId, unionIdOf(session))
  return settings.admins.some((id) => forms.includes(id)) || authorityOf(session) >= ADMIN_AUTHORITY
}

/** 群聊：群在授权群里；单聊：在授权私聊用户里，或者是管理员 */
export function isAllowed(session: AccessSession, settings: AccessSettings, admin = isAdmin(session, settings)): boolean {
  if (session.isDirect) {
    const forms = idForms(session.platform, session.userId, unionIdOf(session))
    return admin || settings.allowedUsers.some((id) => forms.includes(id))
  }
  const forms = idForms(session.platform, session.channelId, session.guildId)
  return settings.allowedGroups.some((id) => forms.includes(id))
}

export function buildAccess(session: AccessSession, settings: AccessSettings): Access {
  const admin = isAdmin(session, settings)
  const access: Access = {
    platform: session.platform,
    userId: session.userId ?? '',
    channelId: session.channelId ?? '',
    isDirect: session.isDirect,
    isAdmin: admin,
    allowed: isAllowed(session, settings, admin),
  }
  const unionId = unionIdOf(session)
  if (unionId) access.unionId = unionId
  return access
}

// 命令的参数只因为去掉了图片等元素而变空：前置中间件记一笔，命令回复用法时补一句提示（只补一次）。
// 会话对象在中间件和命令之间会被包一层，按会话编号记；没人取走的记录最多留一小批
const droppedImages = new Set<number>()

export function markImagesDropped(session: Pick<Session, 'id'>): void {
  if (droppedImages.size >= 200) droppedImages.clear()
  droppedImages.add(session.id)
}

export function takeImagesDropped(session: Pick<Session, 'id'>): boolean {
  return droppedImages.delete(session.id)
}
