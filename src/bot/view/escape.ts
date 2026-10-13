// 转义和清理。卡片的文本字段是 Markdown 片段（只允许 **粗体**），动态内容由生成卡片的一方先转义：
// 物品名用 escapeMarkdown，回显用户的文字一律用 safeEcho。纯文字渲染时用 stripMarkdown 还原。

import { ECHO_MAX_CHARS } from '../../constants'

/** 物品名、用户输入里要转义的 Markdown 字符 */
const MARKDOWN_SPECIAL = /[\\`*_~[\]<>]/g
/** 反斜杠转义（任何 ASCII 标点）或粗体标记 */
const ESCAPE_OR_BOLD = /\\([!-/:-@[-`{-~])|\*\*/g

/** 带协议的网址 */
const SCHEME_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'「」]*/gi
/** 像域名的片段：xx.yy.com、abc.cn */
const DOMAIN_LIKE = /[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?![\w-])/gi

export const LINK_PLACEHOLDER = '[链接]'

export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL, '\\$&')
}

/** 去掉 **粗体** 标记、还原反斜杠转义（纯文字渲染用） */
export function stripMarkdown(text: string): string {
  return text.replace(ESCAPE_OR_BOLD, (_, ch: string | undefined) => ch ?? '')
}

/** 只去掉没转义的 ** （小标题本身会再包一层粗体） */
export function unbold(text: string): string {
  return text.replace(ESCAPE_OR_BOLD, (all: string, ch: string | undefined) => ch === undefined ? '' : all)
}

export function hasUrl(text: string): boolean {
  return new RegExp(SCHEME_URL.source, 'i').test(text) || new RegExp(DOMAIN_LIKE.source, 'i').test(text)
}

/** 把像网址的片段换成「[链接]」。群里发网址会被拒绝（40054010） */
export function scrubUrls(text: string): string {
  return text.replace(SCHEME_URL, LINK_PLACEHOLDER).replace(DOMAIN_LIKE, LINK_PLACEHOLDER)
}

/** 按码点截断，被截断时加「…」 */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : text
}

/** 回显用户的文字：合成一行、去掉网址、截到约 30 字、转义 Markdown */
export function safeEcho(text: string, max = ECHO_MAX_CHARS): string {
  // 图片、表情等元素的标记不回显
  const line = text.replace(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/g, ' ').replace(/\s+/g, ' ').trim()
  return escapeMarkdown(truncate(scrubUrls(line), max))
}

/** 放进 <qqbot-cmd-input> 属性里的文字 */
export function escapeAttr(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
