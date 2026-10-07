// Card → QQ Markdown。只用官方支持的语法：粗体、列表（嵌套缩进 4 个空格）、引用、分割线，
// 外加行内代码（numberStyle = code）。列表前面一定空一行；同一段里换行用单个 \n。

import { MAX_BUTTON_COMMAND_CHARS } from '../../constants'
import type { FormattedPrice, NumberStyle } from '../../core/types'
import type { Card, CardRenderOptions, Choice, KeyboardRow, Line } from './card'
import { choiceHint, commandText, keyboardRows, textActions } from './clickable'
import { escapeAttr, escapeMarkdown, stripMarkdown, unbold } from './escape'
import { numbering, outline } from './outline'
import type { OutlineSection } from './outline'
import type { Block, Layout } from './split'
import { serialize } from './split'

export interface QQMarkdown {
  md: string
  rows: KeyboardRow[]
}

const NESTED = '    - '

export function styledNumber(text: string, style: NumberStyle): string {
  if (style === 'code') return `\`${text}\``
  if (style === 'bold') return `**${text}**`
  return text
}

/** `258,400,000 ISK`（258.40M）；只有简写时 `513.00M`；没有价格时 — */
export function priceMarkdown(price: FormattedPrice, style: NumberStyle): string {
  const main = price.na ? undefined : price.full ?? price.compact
  if (!main) return '—'
  const styled = styledNumber(main, style)
  return price.full && price.compact ? `${styled}（${price.compact}）` : styled
}

export function lineMarkdown(line: Line, style: NumberStyle): string {
  if ('text' in line) return line.text
  const head = [line.label, line.price ? priceMarkdown(line.price, style) : ''].filter(Boolean).join(' ')
  if (!line.extra) return head
  // 全角括号后面直接接（`…`（258.40M）▲4.5%），其他情况空一格
  return head && !head.endsWith('）') ? `${head} ${line.extra}` : `${head}${line.extra}`
}

function sectionItems({ section, groups }: OutlineSection, style: NumberStyle): string[] {
  const kind = section.style ?? 'bullet'
  const numbers = numbering(groups)
  const items = groups.map((group, g) => group.map((line, i) => {
    const text = lineMarkdown(line, style)
    if (i > 0 || line.indent === 1) return kind === 'plain' ? `· ${text}` : `${NESTED}${text}`
    if (kind === 'plain') return text
    return kind === 'ordered' ? `${numbers[g]}. ${text}` : `- ${text}`
  }).join('\n'))
  if (!section.heading?.trim()) return items
  const heading = `**${unbold(section.heading)}**${section.badge ? ` · ${section.badge}` : ''}`
  if (!items.length) return [heading]
  items[0] = `${heading}${kind === 'plain' ? '\n' : '\n\n'}${items[0]}`
  return items
}

function choiceLabel(choice: Choice, opts: CardRenderOptions): string {
  if (!opts.cmdInputInLists || opts.clickable !== 'buttons') return choice.label
  const command = commandText(choice.command, opts)
  const show = stripMarkdown(choice.label).trim()
  if (!show || command.length > MAX_BUTTON_COMMAND_CHARS || show.length > MAX_BUTTON_COMMAND_CHARS) return choice.label
  return `<qqbot-cmd-input text="${escapeAttr(command)}" show="${escapeAttr(show)}" reference="false" />`
}

function choiceItems(card: Card, choices: Choice[], opts: CardRenderOptions): string[] {
  const items = choices.map((c) => `${c.no}. ${choiceLabel(c, opts)}${c.detail ? ` · ${c.detail}` : ''}`)
  const hint = escapeMarkdown(choiceHint(card, opts, opts.clickable === 'buttons' ? 'buttons' : 'none'))
  items[items.length - 1] += `\n\n${hint}`
  return items
}

function tail(card: Card, opts: CardRenderOptions, footer: string, notices: string[]): string {
  const end = [footer ? `***\n${footer}` : '', ...notices.map((n) => `> 📢 ${n}`)].filter(Boolean).join('\n')
  const actions = opts.clickable === 'none'
    ? textActions(card, opts).map((a) => `${escapeMarkdown(a.label)}：@我 发送「${escapeMarkdown(a.command)}」`).join('\n')
    : ''
  return [end, actions].filter(Boolean).join('\n\n')
}

/** 分段用的版式（和 textLayout 结构相同） */
export function markdownLayout(card: Card, opts: CardRenderOptions): Layout {
  const o = outline(card)
  const blocks: Block[] = []
  if (o.head.length) blocks.push({ items: [o.head.join('\n')], counted: false })
  for (const s of o.sections) blocks.push({ items: sectionItems(s, opts.numberStyle), counted: true })
  if (o.choices.length) blocks.push({ items: choiceItems(card, o.choices, opts), counted: false })
  if (o.warnings.length) blocks.push({ items: o.warnings.map((w) => `⚠ ${w}`), counted: false })
  return { joiner: '\n\n', blocks, tail: tail(card, opts, o.footer, o.notices) }
}

export function toQQMarkdown(card: Card, opts: CardRenderOptions): QQMarkdown {
  return { md: serialize(markdownLayout(card, opts)), rows: keyboardRows(card, opts) }
}
