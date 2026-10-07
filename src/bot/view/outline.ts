// 卡片的骨架：Markdown 和纯文字两个渲染器都从这里取块和条目，保证两种版式结构相同，
// 分段方案可以共用（拆分后只有发送失败的那一段降级）。

import { MAX_NOTICES } from '../../constants'
import type { Card, Choice, Line, Section } from './card'

export interface OutlineSection {
  section: Section
  /** 条目：一条顶层的行连同它下面嵌套的行 */
  groups: Line[][]
}

export interface Outline {
  /** 标题和元信息行 */
  head: string[]
  sections: OutlineSection[]
  choices: Choice[]
  warnings: string[]
  footer: string
  notices: string[]
}

const present = (s: string | undefined): s is string => !!s && s.trim().length > 0

function groupLines(lines: Line[]): Line[][] {
  const groups: Line[][] = []
  for (const line of lines) {
    if (line.indent === 1 && groups.length) groups[groups.length - 1].push(line)
    else groups.push([line])
  }
  return groups
}

export function outline(card: Card): Outline {
  return {
    head: [card.title, ...card.meta].filter(present),
    sections: card.sections
      .filter((s) => present(s.heading) || s.lines.length > 0)
      .map((section) => ({ section, groups: groupLines(section.lines) })),
    choices: card.choices ?? [],
    warnings: card.warnings.filter(present),
    footer: present(card.footer) ? card.footer : '',
    notices: card.notices.filter(present).slice(0, MAX_NOTICES),
  }
}

/** 有序列表的编号：只数顶层的行 */
export function numbering(groups: Line[][]): Array<number | null> {
  let n = 0
  return groups.map((group) => group[0].indent === 1 ? null : ++n)
}
