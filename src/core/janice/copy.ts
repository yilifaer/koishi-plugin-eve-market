// 可以复制的内容：合同价（三个数字，各占一行，整数、不带千分位）和物品清单（每行「英文名<Tab>数量」，
// 和多买清单同一格式，能粘回 Janice 和游戏）。物品清单太长时按消息长度切块，超出条数预算的行丢掉并报个数。

import { MAX_MESSAGE_CHARS, MULTIBUY_SEPARATOR } from '../../constants'
import { chunkLines } from '../industry'
import type { JaniceView } from '../types'

/** 数字前的中文标签：留着是为了不会把三个数字弄混；数字在空格后面 */
export function priceCopyText(view: Pick<JaniceView, 'totals'>): string {
  const { sell, buy, split } = view.totals
  return [`出售 ${sell}`, `收购 ${buy}`, `中间 ${split}`].join('\n')
}

/** 一行一种物品，顺序和 Janice 的清单一样；名字里的制表符、换行换成空格 */
export function itemListLines(view: Pick<JaniceView, 'items'>): string[] {
  return view.items.map((i) => `${i.en.replace(/[\t\r\n]+/g, ' ')}${MULTIBUY_SEPARATOR}${i.amount}`)
}

export interface ItemListBlocks {
  blocks: string[]
  /** 因为条数预算放不下而没发的行数 */
  omitted: number
}

/** 物品清单切块：每块不超过 maxChars；最多 maxBlocks 块（不写 = 不限），放不下的行数记在 omitted */
export function itemListBlocks(view: Pick<JaniceView, 'items'>, opts: { maxChars?: number; maxBlocks?: number } = {}): ItemListBlocks {
  const lines = itemListLines(view)
  const all = chunkLines(lines, Math.max(1, opts.maxChars ?? MAX_MESSAGE_CHARS))
  const blocks = opts.maxBlocks === undefined ? all : all.slice(0, Math.max(0, opts.maxBlocks))
  const kept = blocks.reduce((n, b) => n + b.split('\n').length, 0)
  return { blocks, omitted: lines.length - kept }
}
