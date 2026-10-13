// 回复：预算、时间、分段、降级、熔断。命令的所有输出都经过它。
//
// - 预算：按收到的那条消息计数，群里最多 4 条、单聊最多 3 条（平台是 5 / 4，各留 1 条给意外情况）。
// - 时间：收到消息超过 290 秒就不再发送，只写日志（适配器 298 秒后会悄悄改成主动消息）。
// - 降级链：Markdown + 按钮 → 去掉按钮（动作写成文字）→ 纯文字。每条用户消息只降级一次，再失败就停。
// - 熔断：10 分钟内 Markdown 失败 3 次，之后 30 分钟全部发纯文字。
// - 引用 / 提醒：每次回复的第一条文字或 Markdown 消息引用用户的消息（回复里已经有消息带过引用，后面的就不再带），QQ 群里第一张 Markdown 卡片开头 @ 提问的人；
//   单张卡片可以不带（attach: 'none'），或一定要带、不看「平台拒绝过」的记录（attach: 'always'，样式自检用）；
//   带着它们的发送被平台以客户端错误拒绝时，去掉再发一次，成功就记下这类消息不支持，之后不再带。
// - 每次发送成功后把发出去的文字按频道记 60 秒，供自我回声保护用。

import type { Session } from 'koishi'
import {
  HARD_MAX_MESSAGE_CHARS, MAX_MESSAGE_CHARS, MAX_SPLIT_PARTS, MENTION_USER, QQ_ERROR, QUOTE_REPLY, REPLY_BUDGET_DIRECT, REPLY_BUDGET_GROUP,
  REPLY_CUTOFF_SEC,
} from '../../constants'
import type { Logger, ModuleStore } from '../../core/ports'
import type { OutputMode } from '../../core/types'
import type { Card, CardRenderOptions, KeyboardRow } from '../view/card'
import { keyboardRows } from '../view/clickable'
import { escapeAttr, scrubUrls } from '../view/escape'
import { markdownLayout } from '../view/markdown'
import { hardCut, planSplit, renderPart, split } from '../view/split'
import type { Layout, SplitPlan } from '../view/split'
import { textLayout } from '../view/text'
import { Breaker } from './breaker'
import { EchoLog, echoChannel } from './echo'
import { LogGate } from './log-gate'
import { senderFor } from './qq-sender'
import type { ImageMime, SendFailure, SendResult, Sender } from './qq-sender'

/** 跨消息共享的发送状态，放在模块级存储里 */
export interface SendState {
  breaker: Breaker
  echo: EchoLog
  logs: LogGate
  /** 平台拒绝过的附加项（「markdown:quote」「markdown:mention」「text:quote」），之后的回复不再带 */
  rejected: Set<string>
}

export const SEND_STATE_KEY = 'bot/send'

export function createSendState(): SendState {
  return { breaker: new Breaker(), echo: new EchoLog(), logs: new LogGate(), rejected: new Set() }
}

export function sendState(store: ModuleStore): SendState {
  return store.get(SEND_STATE_KEY, createSendState)
}

/** 命令的预算（群聊的「最多」条数）→ 这条消息实际能发几条：单聊少 1 条，再按平台留的余量封顶 */
export function replyBudget(max: number, isDirect: boolean): number {
  return isDirect
    ? Math.max(1, Math.min(REPLY_BUDGET_DIRECT, max - 1))
    : Math.max(1, Math.min(REPLY_BUDGET_GROUP, max))
}

export interface ReplierOptions {
  /** replyBudget() 算好的条数 */
  budget: number
  mode: OutputMode
  render: CardRenderOptions
  state: SendState
  logger: Logger
  now?: () => number
}

export interface TextOptions {
  /** 引用这条消息（消息 ID） */
  quote?: string
  /** 单条上限，默认 MAX_MESSAGE_CHARS，最多 HARD_MAX_MESSAGE_CHARS（样式自检的长消息用） */
  maxChars?: number
}

export interface CardOptions extends Pick<TextOptions, 'maxChars'> {
  /** 'none'：这张卡片不带自动的引用 / @（留给后面的消息）；'always'：一定带，不看平台拒绝过的记录（成功了就清掉记录） */
  attach?: 'none' | 'always'
}

type Level = 'markdown' | 'no-buttons' | 'text'
type Recovery = 'stop' | 'no-buttons' | 'text' | 'scrub'

/** 和按钮有关的错误码（样式自检时确认）；在那之前按错误说明里的关键词认 */
const KEYBOARD_ERROR_CODES: readonly number[] = []
const KEYBOARD_WORDS = /keyboard|button|按钮|键盘/i

/** 发送失败以后怎么办 */
export function recoveryFor(failure: SendFailure, kind: { markdown: boolean; buttons: boolean }): Recovery {
  const { code, status } = failure
  if (code === QQ_ERROR.REPLY_LIMIT) return 'stop'
  if (code === QQ_ERROR.URL_NOT_ALLOWED) return 'scrub'
  // 网络错误、服务器错误：换格式也没用
  if (status !== undefined ? status >= 500 : code === undefined) return 'stop'
  if (!kind.markdown) return 'stop'
  const keyboard = (code !== undefined && KEYBOARD_ERROR_CODES.includes(code)) || KEYBOARD_WORDS.test(failure.message)
  if (kind.buttons && keyboard) return 'no-buttons'
  return 'text'
}

/** 一张卡片的三种版式（结构相同，共用分段方案） */
interface CardParts {
  plan: SplitPlan
  text: Layout
  markdown?: Layout
  plain?: Layout
  rows: KeyboardRow[]
}

/** 超过硬上限时截断（分段已经按常规上限切好，这里只是保险） */
const clip = (content: string) => content.length > HARD_MAX_MESSAGE_CHARS ? hardCut(content, HARD_MAX_MESSAGE_CHARS)[0] : content

export class Replier {
  private used = 0
  private level: Level
  private degraded = false
  private stopped = false
  private scrub = false
  private hinted = false
  /** 还没用掉的引用 / 提醒（第一条文字或 Markdown 消息成功后清掉） */
  private pendingQuote: string | undefined
  private pendingMention: boolean
  /** 正在发的卡片的 attach 选项 */
  private attach: CardOptions['attach']
  private readonly now: () => number

  constructor(private readonly session: Session, private readonly sender: Sender, private readonly opts: ReplierOptions) {
    this.now = opts.now ?? Date.now
    this.level = sender.rich && opts.mode === 'markdown' ? 'markdown' : 'text'
    this.pendingQuote = QUOTE_REPLY ? session.messageId || undefined : undefined
    this.pendingMention = MENTION_USER && this.canMention()
  }

  private canMention(): boolean {
    return this.sender.rich && this.session.platform === 'qq' && !this.session.isDirect && !!this.session.userId
  }

  remaining(): number {
    return this.stopped ? 0 : Math.max(0, this.opts.budget - this.used)
  }

  /** 渲染 → 分段 → 发送 → 失败降级；然后单独发 copyBlocks。全部发出去时返回 true */
  async card(card: Card, options: CardOptions = {}): Promise<boolean> {
    this.attach = options.attach
    try {
      if (options.attach === 'always') {
        this.pendingQuote = this.session.messageId || undefined
        this.pendingMention = this.canMention()
      }
      return await this.cardParts(card, options)
    } finally {
      this.attach = undefined
    }
  }

  private async cardParts(card: Card, options: CardOptions): Promise<boolean> {
    const copies = (card.copyBlocks ?? []).filter((c) => c.trim())
    const parts = this.layout(card, copies.length, Math.min(HARD_MAX_MESSAGE_CHARS, options.maxChars ?? MAX_MESSAGE_CHARS))
    for (let i = 0; i < parts.plan.parts.length; i++) {
      if (!(await this.cardPart(parts, i))) return false
    }
    for (const copy of copies) {
      if (!(await this.text(copy))) return false
    }
    return true
  }

  /** 纯文字（太长时按行拆分，段数不超过剩下的预算） */
  async text(content: string, options: TextOptions = {}): Promise<boolean> {
    const max = Math.min(HARD_MAX_MESSAGE_CHARS, options.maxChars ?? MAX_MESSAGE_CHARS)
    const parts = split(content, max, Math.min(MAX_SPLIT_PARTS, Math.max(1, this.remaining())), (n) => `另有 ${n} 行未显示`)
    for (let i = 0; i < parts.length; i++) {
      if (!(await this.sendText(parts[i], i === 0 ? options.quote : undefined))) return false
    }
    return parts.length > 0
  }

  /** 慢提示：每条用户消息最多一次 */
  async hint(content: string): Promise<boolean> {
    if (this.hinted) return false
    this.hinted = true
    return this.sendText(content)
  }

  /** 图片（可以带一行说明，和图片合成一条）。失败时不降级，由调用方决定怎么补救 */
  async image(data: Buffer, mime: ImageMime, caption?: string): Promise<boolean> {
    if (!this.gate()) return false
    const text = caption && this.scrub ? scrubUrls(caption) : caption
    const result = await this.sender.image(this.session, data, mime, text)
    this.used += result.sent
    if (result.sent && text) this.remember(text)
    if (result.ok) return true
    this.logFailure(result, 'image', data.length)
    if (result.code === QQ_ERROR.REPLY_LIMIT) this.stopped = true
    return false
  }

  private layout(card: Card, copies: number, maxChars: number): CardParts {
    const render = this.opts.render
    const text = textLayout(card, render)
    const rich = this.currentLevel() !== 'text'
    const markdown = rich ? markdownLayout(card, render) : undefined
    const plain = rich ? markdownLayout(card, { ...render, clickable: 'none' }) : undefined
    const layouts = [markdown, plain, text].filter((l): l is Layout => !!l)
    // copyBlocks 也要占预算，但卡片至少能发一段
    const room = this.remaining()
    const maxParts = Math.max(1, Math.min(MAX_SPLIT_PARTS, room - Math.min(copies, room - 1)))
    const plan = planSplit(layouts, maxChars, maxParts)
    return { plan, text, markdown, plain, rows: rich ? keyboardRows(card, render) : [] }
  }

  private cardPart(parts: CardParts, index: number): Promise<boolean> {
    const level = this.currentLevel()
    const text = renderPart(parts.text, parts.plan, index)
    const last = index === parts.plan.parts.length - 1
    // 空卡片什么都不发
    if (!text.trim() && !(last && level === 'markdown' && parts.rows.length)) return Promise.resolve(true)
    if (level === 'text' || !parts.markdown || !parts.plain) return this.sendText(text)
    const layout = level === 'markdown' ? parts.markdown : parts.plain
    const rows = level === 'markdown' && last ? parts.rows : []
    const plain = parts.plain
    return this.sendMarkdown(renderPart(layout, parts.plan, index), rows, {
      plain: () => renderPart(plain, parts.plan, index),
      text,
    })
  }

  private currentLevel(): Level {
    return this.level !== 'text' && this.opts.state.breaker.isOpen(this.now()) ? 'text' : this.level
  }

  private async sendMarkdown(md: string, rows: KeyboardRow[], fallback: { plain: () => string; text: string }): Promise<boolean> {
    const result = await this.attempt('markdown', md, rows)
    if (!result || result.ok) return !!result?.ok
    const recovery = recoveryFor(result, { markdown: true, buttons: rows.length > 0 })
    if (recovery === 'no-buttons' || recovery === 'text') this.markdownFailed()
    if (recovery === 'stop' || this.degraded) return this.halt()
    this.degraded = true
    if (recovery === 'scrub') {
      this.scrub = true
      return this.finish(await this.attempt('markdown', md, rows))
    }
    if (recovery === 'no-buttons') {
      this.level = 'no-buttons'
      return this.finish(await this.attempt('markdown', fallback.plain(), []))
    }
    this.level = 'text'
    return this.finish(await this.attempt('text', fallback.text))
  }

  private async sendText(content: string, quote?: string): Promise<boolean> {
    const result = await this.attempt('text', content, [], quote)
    if (!result || result.ok) return !!result?.ok
    if (recoveryFor(result, { markdown: false, buttons: false }) !== 'scrub' || this.degraded) return this.halt()
    this.degraded = true
    this.scrub = true
    return this.finish(await this.attempt('text', content, [], quote))
  }

  /** 检查预算和时间后发一条；没发（预算用完、太晚）时返回 null。quote：调用方指定的引用，不受「平台不支持」记录的影响 */
  private async attempt(kind: 'markdown' | 'text', content: string, rows: KeyboardRow[] = [], quote?: string): Promise<SendResult | null> {
    if (!this.gate()) return null
    const body = clip(this.scrub ? scrubUrls(content) : content)
    const state = this.opts.state.rejected
    const auto = this.attach !== 'none'
    const always = this.attach === 'always'
    const useQuote = quote ?? (auto && this.pendingQuote && (always || !state.has(`${kind}:quote`)) ? this.pendingQuote : undefined)
    const mention = auto && kind === 'markdown' && this.pendingMention && (always || !state.has('markdown:mention'))
    let refused = false
    let result = await this.deliver(kind, body, rows, useQuote, mention)
    this.used += result.sent
    if (!result.ok && (useQuote || mention) && this.isClientError(result)) {
      // 可能是引用 / 提醒被拒绝：去掉再发一次；失败的发送不占预算，也不算 Markdown 失败
      const retry = await this.deliver(kind, body, rows)
      this.used += retry.sent
      if (retry.ok) this.noteRejected(kind, !!useQuote, mention, result)
      refused = true
      result = retry
    }
    if (result.ok) {
      this.remember(body)
      // 实测带着发成功了：之前记下的「不支持」作废
      if (always && !refused) {
        if (useQuote) state.delete(`${kind}:quote`)
        if (mention) state.delete('markdown:mention')
      }
      // 已经有消息带过引用（自动的或调用方指定的），后面的不再带
      if (useQuote) this.pendingQuote = undefined
      if (auto && kind === 'markdown') this.pendingMention = false
    } else this.logFailure(result, kind, body.length)
    return result
  }

  private deliver(kind: 'markdown' | 'text', body: string, rows: KeyboardRow[], quote?: string, mention = false): Promise<SendResult> {
    if (kind === 'markdown') {
      const md = mention ? `<qqbot-at-user id="${escapeAttr(this.session.userId!)}" /> ${body}` : body
      return quote ? this.sender.markdown(this.session, md, rows, quote) : this.sender.markdown(this.session, md, rows)
    }
    return quote ? this.sender.text(this.session, body, quote) : this.sender.text(this.session, body)
  }

  /** 平台明确拒绝了请求（有错误码、不是服务器错误），而且不是额度用完、网址被拒或内容超长（这些和引用 / @ 无关） */
  private isClientError(failure: SendFailure): boolean {
    return failure.code !== undefined && (failure.status === undefined || failure.status < 500)
      && failure.code !== QQ_ERROR.REPLY_LIMIT && failure.code !== QQ_ERROR.URL_NOT_ALLOWED
      && failure.code !== QQ_ERROR.MARKDOWN_TOO_LONG
  }

  private noteRejected(kind: 'markdown' | 'text', quoted: boolean, mentioned: boolean, failure: SendFailure) {
    const keys = [quoted ? `${kind}:quote` : '', mentioned ? 'markdown:mention' : ''].filter(Boolean)
    const fresh = keys.filter((key) => !this.opts.state.rejected.has(key))
    for (const key of keys) this.opts.state.rejected.add(key)
    if (!fresh.length) return
    const what = [quoted ? '引用' : '', mentioned ? '@提醒' : ''].filter(Boolean).join('和')
    this.opts.logger.warn(`${kind === 'markdown' ? 'Markdown' : '纯文字'}消息带${what}被平台拒绝（${failure.code} ${failure.message}），去掉后发送成功，之后不再带`)
  }

  private finish(result: SendResult | null): boolean {
    if (result?.ok) return true
    return result ? this.halt() : false
  }

  private halt(): false {
    this.stopped = true
    return false
  }

  private gate(): boolean {
    if (this.stopped) return false
    if (this.used >= this.opts.budget) {
      this.log('budget', `回复已达本条消息的预算（${this.opts.budget} 条），后面的内容没有发送`)
      return false
    }
    if (this.tooOld()) {
      this.stopped = true
      this.log('too-old', `收到消息已超过 ${REPLY_CUTOFF_SEC} 秒，不再回复`)
      return false
    }
    return true
  }

  private tooOld(): boolean {
    const received = this.session.timestamp
    return typeof received === 'number' && received > 0 && this.now() - received > REPLY_CUTOFF_SEC * 1000
  }

  private markdownFailed() {
    if (this.opts.state.breaker.fail(this.now())) {
      this.opts.logger.warn('Markdown 连续发送失败，之后一段时间改发纯文字')
    }
  }

  private remember(content: string) {
    this.opts.state.echo.record(echoChannel(this.session), content, this.now())
  }

  /** 只记错误码、错误信息和长度，不记内容；同一个错误码每小时一次 */
  private logFailure(failure: SendFailure, kind: string, length: number) {
    const reason = [failure.code, failure.status !== undefined ? `HTTP ${failure.status}` : '', failure.message]
      .filter((p) => p !== undefined && p !== '')
      .join(' ')
    this.log(`fail:${failure.code ?? failure.status ?? 'network'}`, `发送失败（${kind}，${length} 字）：${reason}`)
  }

  private log(key: string, message: string) {
    if (this.opts.state.logs.allow(key, this.now())) this.opts.logger.warn(message)
  }
}

/** QQ 上经适配器发送，沙盒上用 session.send */
export function createReplier(session: Session, opts: ReplierOptions): Replier {
  return new Replier(session, senderFor(session), opts)
}
