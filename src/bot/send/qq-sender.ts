// 发送（0.1.0 只经适配器）。session.send 从不抛错，没法知道 Markdown 被拒绝，所以 QQ 上一律调用
// bot.sendMessage(channelId, 元素, undefined, { session }) 并 catch：适配器负责 msg_id、msg_seq、按钮 ID、图片上传，
// 失败时抛出的错误里 errors[i].response.data 是 { code, message }。
//
// 硬性规定：原始 Markdown 整段放进一个 qq:markdown 元素（发字符串会被解析，<qqbot-cmd-input> 会被悄悄丢掉）；
// 纯文本用 h.text 包住；图片写明 MIME，数据一定是真正的 Buffer。

import { h } from 'koishi'
import type { Session } from 'koishi'
import { MAX_KEYBOARD_ROWS } from '../../constants'
import type { ImageMime } from '../../core/types'
import { safeError } from '../../core/util'
import type { KeyboardButton, KeyboardRow } from '../view/card'

export type { ImageMime }

export interface SendFailure {
  ok: false
  /** 失败前已经发出去的条数（图片上传失败时，说明文字会单独发出去） */
  sent: number
  /** 平台错误码；网络错误时没有 */
  code?: number
  status?: number
  message: string
}

export type SendResult = { ok: true; sent: number } | SendFailure

export interface Sender {
  /** 能发 Markdown 和按钮（QQ）；沙盒只发纯文字 */
  readonly rich: boolean
  /** quote：引用这条消息（message_reference） */
  markdown(session: Session, md: string, rows: KeyboardRow[], quote?: string): Promise<SendResult>
  /** quote：引用这条消息（message_reference） */
  text(session: Session, text: string, quote?: string): Promise<SendResult>
  image(session: Session, data: Buffer, mime: ImageMime, caption?: string): Promise<SendResult>
}

/** 平台规定每行最多 5 个按钮 */
const BUTTONS_PER_ROW = 5
const MESSAGE_ROUTE = /\/v2\/(?:groups|users)\/[^/]+\/messages(?:[?#]|$)/

/**
 * satori 处理非 Buffer 的类型化数组时会编码整块底层内存，所以交给机器人之前一律转成只覆盖这段数据的 Buffer
 */
export function toBuffer(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

function buttonElement(button: KeyboardButton): h {
  const attrs: Record<string, string> = { type: 'input', text: button.text }
  if (button.primary) attrs.class = 'primary'
  return h('button', attrs, button.label)
}

/**
 * 适配器把裸按钮每 5 个排一行；button-group 会在前后各插一个空行，最后只去掉末尾那一个。
 * 所以交替排：第 1 行裸按钮，第 2 行包一层 button-group，第 3 行裸按钮（正好填进 group 留下的空行），依此类推，
 * 键盘里不会出现空行
 */
export function markdownElements(md: string, rows: KeyboardRow[], quote?: string): h[] {
  // 引用一条消息时前面加 quote 元素（适配器转成 message_reference）
  const elements: h[] = quote ? [h.quote(quote), h('qq:markdown', {}, md)] : [h('qq:markdown', {}, md)]
  rows.slice(0, MAX_KEYBOARD_ROWS).forEach((row, i) => {
    const buttons = row.slice(0, BUTTONS_PER_ROW).map(buttonElement)
    if (!buttons.length) return
    if (i % 2 === 0) elements.push(...buttons)
    else elements.push(h('button-group', {}, buttons))
  })
  return elements
}

/** 纯文字；引用一条消息时前面加 quote 元素（适配器转成 message_reference） */
export function textElements(text: string, quote?: string): h[] {
  return quote ? [h.quote(quote), h.text(text)] : [h.text(text)]
}

type Loose = Record<string, unknown>

const asRecord = (value: unknown): Loose | undefined =>
  value && typeof value === 'object' ? value as Loose : undefined

/** 适配器把每次失败的请求收进 errors（部分成功时也会抛）；其他错误原样 */
export function sendErrors(error: unknown): unknown[] {
  const list = asRecord(error)?.errors
  return Array.isArray(list) && list.length ? list : [error]
}

export function qqErrorCode(error: unknown): number | undefined {
  const code = asRecord(asRecord(asRecord(error)?.response)?.data)?.code
  if (typeof code === 'number' && Number.isFinite(code)) return code
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code)
  return undefined
}

function failedRoute(error: unknown): string {
  const url = asRecord(asRecord(error)?.response)?.url
  return typeof url === 'string' ? url : ''
}

export function describeFailure(error: unknown, sent = 0): SendFailure {
  const errors = sendErrors(error)
  const main = errors.find((e) => qqErrorCode(e) !== undefined) ?? errors[0]
  const info = safeError(main)
  const failure: SendFailure = { ok: false, sent, message: info.message }
  const code = qqErrorCode(main)
  if (code !== undefined) failure.code = code
  if (info.status !== undefined) failure.status = info.status
  return failure
}

/** 图片上传失败而发消息本身没失败：说明文字已经单独发出去了 */
function captionDelivered(error: unknown): boolean {
  const list = asRecord(error)?.errors
  return Array.isArray(list) && list.length > 0 && !list.some((e) => MESSAGE_ROUTE.test(failedRoute(e)))
}

async function deliver(session: Session, elements: h[], sentOnError: (error: unknown) => number = () => 0): Promise<SendResult> {
  try {
    await session.bot.sendMessage(session.channelId!, elements, undefined, { session })
    return { ok: true, sent: 1 }
  } catch (error) {
    return describeFailure(error, sentOnError(error))
  }
}

export class QQSender implements Sender {
  readonly rich = true

  markdown(session: Session, md: string, rows: KeyboardRow[], quote?: string): Promise<SendResult> {
    return deliver(session, markdownElements(md, rows, quote))
  }

  text(session: Session, text: string, quote?: string): Promise<SendResult> {
    return deliver(session, textElements(text, quote))
  }

  /** 图片后面的文字和图片合成一条（msg_type 7） */
  image(session: Session, data: Buffer, mime: ImageMime, caption?: string): Promise<SendResult> {
    const elements = [h.image(toBuffer(data), mime)]
    if (caption) elements.push(h.text(caption))
    return deliver(session, elements, (error) => caption && captionDelivered(error) ? 1 : 0)
  }
}

/** 沙盒：session.send，只发纯文字和图片；session.send 自己会吞掉错误 */
export class SessionSender implements Sender {
  readonly rich = false

  markdown(session: Session, md: string, _rows: KeyboardRow[], quote?: string): Promise<SendResult> {
    return this.text(session, md, quote)
  }

  async text(session: Session, text: string, quote?: string): Promise<SendResult> {
    await session.send(quote ? textElements(text, quote) : h.text(text))
    return { ok: true, sent: 1 }
  }

  async image(session: Session, data: Buffer, mime: ImageMime, caption?: string): Promise<SendResult> {
    const elements = [h.image(toBuffer(data), mime)]
    if (caption) elements.push(h.text(caption))
    await session.send(elements)
    return { ok: true, sent: 1 }
  }
}

const qqSender = new QQSender()
const sessionSender = new SessionSender()

/** QQ 走适配器，其他平台（控制台沙盒）走 session.send */
export function senderFor(session: Session): Sender {
  return session.platform === 'qq' ? qqSender : sessionSender
}
