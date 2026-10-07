// 长消息分段。渲染器把卡片排成「块」：开头、每个小节、编号列表、警告，最后是页脚和告示。
// 只在块之间切，块太长时在条目之间切（列表项连同它下面嵌套的行是一个条目，小标题粘在第一个条目上）。
// 段数超过上限时从后往前去掉数据行，在最后一段写「另有 N 行未显示…」。长度按最终序列化后的文字算。

import { MAX_MESSAGE_CHARS, MAX_SPLIT_PARTS } from '../../constants'

export interface Block {
  /** 条目，块内用单个换行连接 */
  items: string[]
  /** 条目是数据行：段数不够时可以去掉，并计入「另有 N 行未显示」 */
  counted: boolean
}

export interface Layout {
  /** 块之间的分隔：Markdown 是空行，纯文字是单个换行 */
  joiner: string
  blocks: Block[]
  /** 页脚、告示、动作的文字说明：总在最后一段的末尾 */
  tail: string
}

/** 分段方案：每段是哪些条目（条目在所有块里按顺序编号）；同一结构的几种版式可以共用 */
export interface SplitPlan {
  parts: number[][]
  /** 去掉的数据行数 */
  dropped: number
  /** 去掉了行时写在最后一段的说明；没去掉时是空字符串 */
  note: string
}

export type OverflowNote = (n: number) => string

/** 卡片（批量查价、材料清单）的默认说明 */
export const overflowNote: OverflowNote = (n) => `另有 ${n} 行未显示，合计已包含`

interface Atom {
  block: number
  /** 每种版式里的长度 */
  lengths: number[]
  counted: boolean
}

function atomsOf(layouts: Layout[]): Atom[] {
  const [first] = layouts
  if (!first) return []
  for (const layout of layouts) {
    const same = layout.blocks.length === first.blocks.length
      && layout.blocks.every((b, i) => b.items.length === first.blocks[i].items.length)
    if (!same) throw new Error('layouts do not share the same structure')
  }
  return first.blocks.flatMap((block, b) => block.items.map((_, i) => ({
    block: b,
    lengths: layouts.map((layout) => layout.blocks[b].items[i].length),
    counted: block.counted,
  })))
}

/** 依次装箱（每种版式的长度一起累加）；最后一段还要放得下 tail 和去掉行时的说明 */
function pack(atoms: Atom[], ids: number[], layouts: Layout[], limit: number, note: string): number[][] {
  const joiners = layouts.map((layout) => layout.joiner.length)
  // 说明和 tail 各占一个分隔符
  const tailLength = (k: number) => [note, layouts[k].tail].filter(Boolean).reduce((sum, t) => sum + joiners[k] + t.length, 0)
  const parts: number[][] = []
  let current: number[] = []
  let lengths: number[] = []
  for (const id of ids) {
    const atom = atoms[id]
    if (current.length) {
      const prev = atoms[current[current.length - 1]]
      const next = lengths.map((len, k) => len + (prev.block === atom.block ? 1 : joiners[k]) + atom.lengths[k])
      if (next.every((len) => len <= limit)) {
        current.push(id)
        lengths = next
        continue
      }
      parts.push(current)
    }
    current = [id]
    lengths = atom.lengths.slice()
  }
  if (current.length && lengths.some((len, k) => len + tailLength(k) > limit)) {
    parts.push(current)
    current = []
  }
  parts.push(current)
  return parts
}

/**
 * 给几种结构相同的版式（例如 Markdown、去掉按钮的 Markdown、纯文字）算一个共用的分段方案：
 * 每一段在每种版式里都不超过 limit。
 */
export function planSplit(
  layouts: Layout[],
  limit = MAX_MESSAGE_CHARS,
  maxParts = MAX_SPLIT_PARTS,
  noteFor: OverflowNote = overflowNote,
): SplitPlan {
  const atoms = atomsOf(layouts)
  const all = atoms.map((_, i) => i)
  const max = Math.max(1, maxParts)
  const parts = pack(atoms, all, layouts, limit, '')
  if (parts.length <= max) return { parts, dropped: 0, note: '' }

  // 从后往前去掉数据行：二分找最少要去掉几行才放得进 max 段。说明的长度按最多能去掉的行数预留
  const counted = all.filter((i) => atoms[i].counted)
  const reserve = noteFor(counted.length)
  const without = (n: number) => {
    const dropped = new Set(counted.slice(counted.length - n))
    return pack(atoms, all.filter((id) => !dropped.has(id)), layouts, limit, reserve)
  }
  let best = { dropped: counted.length, parts: without(counted.length) }
  for (let lo = 1, hi = counted.length - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1
    const attempt = without(mid)
    if (attempt.length <= max) {
      best = { dropped: mid, parts: attempt }
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return { parts: best.parts.slice(0, max), dropped: best.dropped, note: best.dropped ? noteFor(best.dropped) : '' }
}

/** 按方案取出第 index 段的文字 */
export function renderPart(layout: Layout, plan: SplitPlan, index: number): string {
  const ids = plan.parts[index] ?? []
  const refs = layout.blocks.flatMap((block, b) => block.items.map((text) => ({ block: b, text })))
  let body = ''
  ids.forEach((id, i) => {
    const sep = i === 0 ? '' : refs[ids[i - 1]].block === refs[id].block ? '\n' : layout.joiner
    body += sep + refs[id].text
  })
  if (index !== plan.parts.length - 1) return body
  return [body, plan.note, layout.tail].filter(Boolean).join(layout.joiner)
}

/** 整个版式（不分段） */
export function serialize(layout: Layout): string {
  const body = layout.blocks.map((b) => b.items.join('\n')).filter(Boolean)
  return [...body, layout.tail].filter(Boolean).join(layout.joiner)
}

/** 把一段现成的文字排成版式：空行分块，每行一个条目（缩进的行粘在上一行），超长的行硬切 */
export function layoutOf(text: string, limit = MAX_MESSAGE_CHARS): Layout {
  const joiner = text.includes('\n\n') ? '\n\n' : '\n'
  const blocks = text.split(/\n{2,}/).filter((p) => p.trim()).map((paragraph) => {
    const items: string[] = []
    for (const line of paragraph.split('\n')) {
      if (items.length && /^[ \t]/.test(line)) items[items.length - 1] += `\n${line}`
      else items.push(line)
    }
    return { items: items.flatMap((item) => hardCut(item, limit)), counted: true }
  })
  return { joiner, blocks, tail: '' }
}

/** 按长度硬切，不切开代理对 */
export function hardCut(text: string, limit: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = Math.max(1, limit)
    const code = rest.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff && cut > 1) cut--
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  out.push(rest)
  return out
}

/**
 * 切成若干段：最多 maxParts 段，放不下时去掉后面的数据行并写「另有 N 行未显示」。
 * 按钮只挂在最后一段，由发送方处理。
 */
export function split(
  input: string | Layout,
  limit = MAX_MESSAGE_CHARS,
  maxParts = MAX_SPLIT_PARTS,
  noteFor: OverflowNote = overflowNote,
): string[] {
  const layout = typeof input === 'string' ? layoutOf(input, limit) : input
  const plan = planSplit([layout], limit, maxParts, noteFor)
  return plan.parts.map((_, i) => renderPart(layout, plan, i)).filter(Boolean)
}
