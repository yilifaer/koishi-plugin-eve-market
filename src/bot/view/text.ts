// Card → 纯文字：Markdown 发送失败、output = text、沙盒都用它。和 markdownLayout 结构相同。
// 粗体去掉，小标题写成【Jita】，列表去掉「- 」、嵌套的一层加「· 」，分割线写成 ———，告示去掉引用符号；
// 编号写成「回复 @我 1：…」，动作最多写 2 行「…：@我 发送「完整命令」」。

import type { FormattedPrice } from '../../core/types'
import type { Card, Choice, Line } from './card'
import { choiceHint, textActions } from './clickable'
import type { CommandNamer } from './clickable'
import { stripMarkdown } from './escape'
import { numbering, outline } from './outline'
import type { OutlineSection } from './outline'
import type { Block, Layout } from './split'
import { serialize } from './split'

export type TextRenderOptions = CommandNamer

/** 258,400,000 ISK (258.40M)；没有价格时 — */
export function priceText(price: FormattedPrice): string {
  const main = price.na ? undefined : price.full ?? price.compact
  if (!main) return '—'
  return price.full && price.compact ? `${main} (${price.compact})` : main
}

export function lineText(line: Line): string {
  if ('text' in line) return stripMarkdown(line.text)
  return [stripMarkdown(line.label), line.price ? priceText(line.price) : '', line.extra ? stripMarkdown(line.extra) : '', line.count ? `· ${stripMarkdown(line.count)}` : '']
    .filter(Boolean)
    .join(' ')
}

function sectionItems({ section, groups }: OutlineSection): string[] {
  const numbers = numbering(groups)
  const items = groups.map((group, g) => group.map((line, i) => {
    const text = lineText(line)
    if (i > 0 || line.indent === 1) return `· ${text}`
    return section.style === 'ordered' ? `${numbers[g]}. ${text}` : text
  }).join('\n'))
  if (!section.heading?.trim()) return items
  const heading = `【${stripMarkdown(section.heading).trim()}】${section.badge ? ` · ${stripMarkdown(section.badge)}` : ''}`
  if (!items.length) return [heading]
  items[0] = `${heading}\n${items[0]}`
  return items
}

function choiceItems(card: Card, choices: Choice[], opts: TextRenderOptions): string[] {
  const items = choices.map((c) => `回复 @我 ${c.no}：${stripMarkdown(c.label)}${c.detail ? ` · ${stripMarkdown(c.detail)}` : ''}`)
  items[items.length - 1] += `\n${choiceHint(card, opts, 'text')}`
  return items
}

function tail(card: Card, opts: TextRenderOptions, footer: string, notices: string[]): string {
  return [
    footer ? `———\n${stripMarkdown(footer)}` : '',
    ...notices.map((n) => `📢 ${stripMarkdown(n)}`),
    ...textActions(card, opts).map((a) => `${a.label}：@我 发送「${a.command}」`),
  ].filter(Boolean).join('\n')
}

/** 分段用的版式（和 markdownLayout 结构相同） */
export function textLayout(card: Card, opts: TextRenderOptions): Layout {
  const o = outline(card)
  const blocks: Block[] = []
  if (o.head.length) blocks.push({ items: [o.head.map(stripMarkdown).join('\n')], counted: false })
  for (const s of o.sections) blocks.push({ items: sectionItems(s), counted: true })
  if (o.choices.length) blocks.push({ items: choiceItems(card, o.choices, opts), counted: false })
  if (o.warnings.length) blocks.push({ items: o.warnings.map((w) => `⚠ ${stripMarkdown(w)}`), counted: false })
  return { joiner: '\n', blocks, tail: tail(card, opts, o.footer, o.notices) }
}

export function toText(card: Card, opts: TextRenderOptions): string {
  return serialize(textLayout(card, opts))
}
