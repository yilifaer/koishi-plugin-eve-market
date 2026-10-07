// 少量待办：编号回复（候选、步骤）和批量清单（只发了表头）。键是「平台:频道:用户」，每个键只留最新一条，
// 5 分钟过期。放在模块级存储里，控制台保存配置后还在；丢了也没关系（按钮里都是完整命令）。
// 估价编号不在这里，由 core 的 AppraisalService 保存。

import { MAX_CHOICE_NO, PENDING_MINUTES } from '../constants'
import type { ModuleStore } from '../core/ports'
import { LruCache } from '../core/util'
import type { Card } from './view/card'
import { commandText } from './view/clickable'
import type { CommandNamer } from './view/clickable'

export interface PendingChoice {
  no: number
  /** 完整命令（含命令名），例如「查价 Jita 大型护盾扩展装置 II*4」 */
  command: string
}

export interface ChoicesPending {
  kind: 'choices'
  choices: PendingChoice[]
  /** 编号后面可以带数量（「2*10」）：把命令末尾的 *N 换掉，没有就加上 */
  quantity: boolean
  /** 高级制造：也接受「ME7」「TE14」，接在这条命令后面 */
  meTe?: string
}

export interface ListPending {
  kind: 'list'
  /** 命令名后面的表头参数，例如「Jita -5%」；'' = 没写表头 */
  header: string
  /** 一行都没认出来时卡片上的候选（「第 1 行：小型护盾扩展装置 II」）：照样可以回复编号 */
  choices?: PendingChoice[]
}

export type Pending = ChoicesPending | ListPending

/** 同一个人在同一个频道 */
export function pendingKey(session: { platform: string; channelId?: string; userId?: string }): string {
  return `${session.platform}:${session.channelId ?? ''}:${session.userId ?? ''}`
}

export interface PendingOptions {
  ttlMs?: number
  /** 最多记多少个人的待办 */
  max?: number
  now?: () => number
}

export class PendingStore {
  private readonly entries: LruCache<string, Pending>

  constructor(options: PendingOptions = {}) {
    this.entries = new LruCache({ max: options.max ?? 2000, ttlMs: options.ttlMs ?? PENDING_MINUTES * 60_000, now: options.now ?? Date.now })
  }

  /** 记录编号待办（覆盖这个人之前的待办）；编号只认 1–99，没有有效编号时不记 */
  setChoices(key: string, choices: readonly PendingChoice[], options: { quantity?: boolean; meTe?: string } = {}): void {
    const valid = validChoices(choices)
    if (!valid.length) return
    const pending: ChoicesPending = { kind: 'choices', choices: valid, quantity: !!options.quantity }
    if (options.meTe?.trim()) pending.meTe = options.meTe.trim()
    this.entries.set(key, pending)
  }

  /** 记录批量清单待办（只发了表头，或者一行都没认出来；后者可以带着候选的编号） */
  setList(key: string, header: string, choices: readonly PendingChoice[] = []): void {
    const pending: ListPending = { kind: 'list', header: header.trim() }
    const valid = validChoices(choices)
    if (valid.length) pending.choices = valid
    this.entries.set(key, pending)
  }

  get(key: string): Pending | undefined {
    return this.entries.get(key)
  }

  /** 清掉这个人的待办；原来有没过期的待办时返回 true */
  clear(key: string): boolean {
    const had = this.entries.has(key)
    this.entries.delete(key)
    return had
  }
}

function validChoices(choices: readonly PendingChoice[]): PendingChoice[] {
  return choices
    .filter((c) => Number.isInteger(c.no) && c.no >= 1 && c.no <= MAX_CHOICE_NO && c.command.trim())
    .map((c) => ({ no: c.no, command: c.command.trim() }))
}

export const PENDING_STORE_KEY = 'bot/pending'

export function pendingStore(store: ModuleStore): PendingStore {
  return store.get(PENDING_STORE_KEY, () => new PendingStore())
}

/** 卡片上的选项 → 编号待办的内容（命令名按当前注册的名字） */
export function choicesOf(card: Pick<Card, 'choices'>, namer: CommandNamer): PendingChoice[] {
  return (card.choices ?? []).map((c) => ({ no: c.no, command: commandText(c.command, namer) }))
}

// ------------------------------------------------------------------ 编号回复 → 完整命令

export type ChoiceReply =
  | { kind: 'number'; no: number; quantity?: string }
  | { kind: 'me-te'; tokens: string }

/** 回复里的数量：数字（可以带千分位、空格分组）、单位、量词；对不对由命令自己再检查 */
const QUANTITY = String.raw`\d(?:[\d,.]|\s(?=\d))*(?:kk|[kmb]|万|亿)?[个艘件发颗台只]?`
const NUMBER_REPLY = new RegExp(String.raw`^(\d{1,2})(?:\s*[*×✕x]\s*(${QUANTITY}))?$`, 'i')
const ME_TE_TOKEN = /(ME|TE)\s*(\d{1,2})/gi
const ME_TE_REPLY = /^(?:ME|TE)\s*\d{1,2}(?:\s+(?:ME|TE)\s*\d{1,2})?$/i

/** 消息只有编号（1–99，可以带 *数量）或 ME7 / TE14 时返回解析结果 */
export function parseChoiceReply(content: string): ChoiceReply | null {
  const text = content.trim()
  const m = NUMBER_REPLY.exec(text)
  if (m) {
    const no = Number(m[1])
    if (no < 1 || no > MAX_CHOICE_NO) return null
    return m[2] ? { kind: 'number', no, quantity: m[2].replace(/\s+/g, ' ').trim() } : { kind: 'number', no }
  }
  if (ME_TE_REPLY.test(text)) {
    const tokens = [...text.matchAll(ME_TE_TOKEN)].map((t) => `${t[1].toUpperCase()}${Number(t[2])}`)
    return { kind: 'me-te', tokens: tokens.join(' ') }
  }
  return null
}

/** 把命令末尾的 *N 换成新的数量（没有就加上） */
export function withQuantity(command: string, quantity: string): string {
  return `${command.replace(/\s*\*\s*[^\s*]+$/, '')}*${quantity}`
}

export type ChoiceResult =
  | { ok: true; command: string }
  /** 编号不在列表里；max 是最大的编号 */
  | { ok: false; max: number }

/** 编号待办 + 回复 → 改写后的完整命令。ME/TE 回复只在高级制造的待办里有效，其他情况返回 null（不接管） */
export function applyChoice(pending: ChoicesPending, reply: ChoiceReply): ChoiceResult | null {
  if (reply.kind === 'me-te') return pending.meTe ? { ok: true, command: `${pending.meTe} ${reply.tokens}` } : null
  const choice = pending.choices.find((c) => c.no === reply.no)
  if (!choice) return { ok: false, max: Math.max(...pending.choices.map((c) => c.no)) }
  const command = reply.quantity && pending.quantity ? withQuantity(choice.command, reply.quantity) : choice.command
  return { ok: true, command }
}
