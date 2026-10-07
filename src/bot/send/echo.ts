// 自我回声保护用的记录：全量消息事件不会过滤机器人自己发的消息，所以每次发送成功后，
// 把发出去的文字的摘要按频道记 60 秒；不带 @ 的群消息和其中某条完全相同时由 scope 丢掉。

import { createHash } from 'node:crypto'
import { SELF_ECHO_SEC } from '../../constants'

/** 每个频道最多记几条（60 秒内一个频道发不了这么多） */
const MAX_PER_CHANNEL = 50
/** 频道多于这个数时顺手清掉所有过期的 */
const SWEEP_CHANNELS = 200

/** 收到的消息和发出的文字按同样的规则比较：统一换行、合并空白、去掉首尾空白 */
export function echoKey(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
  return createHash('sha1').update(normalized).digest('base64')
}

export class EchoLog {
  private channels = new Map<string, Map<string, number>>()

  constructor(private readonly ttlMs = SELF_ECHO_SEC * 1000) {}

  record(channel: string, content: string, now: number): void {
    if (!content.trim()) return
    if (this.channels.size > SWEEP_CHANNELS) for (const other of [...this.channels.keys()]) this.prune(other, now)
    const entries = this.prune(channel, now) ?? new Map<string, number>()
    const key = echoKey(content)
    entries.delete(key)
    entries.set(key, now + this.ttlMs)
    while (entries.size > MAX_PER_CHANNEL) entries.delete(entries.keys().next().value!)
    this.channels.set(channel, entries)
  }

  /** 这段文字是不是本插件 60 秒内在这个频道发过的 */
  seen(channel: string, content: string, now: number): boolean {
    if (!content.trim()) return false
    return this.prune(channel, now)?.has(echoKey(content)) ?? false
  }

  private prune(channel: string, now: number): Map<string, number> | undefined {
    const entries = this.channels.get(channel)
    if (!entries) return undefined
    for (const [key, expires] of entries) if (expires <= now) entries.delete(key)
    if (!entries.size) {
      this.channels.delete(channel)
      return undefined
    }
    return entries
  }
}

/** 频道的键：平台 + 频道 ID */
export function echoChannel(session: { platform: string; channelId?: string }): string {
  return `${session.platform}:${session.channelId ?? ''}`
}
