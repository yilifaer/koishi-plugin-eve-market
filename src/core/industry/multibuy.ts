// 多买清单（§2.6.5、§6.7.11）：可以直接粘进游戏「多重购买」窗口的纯文本。
// 每行「名称<Tab>数量」，数量不带千分位；名称默认英文（控制台「多买清单语言」，没有中文名的用英文）。
// 超过一条消息的长度时按行切开，一行不会被切断。游戏实际认哪种格式待实测（§12.2）。

import { MAX_MESSAGE_CHARS, MULTIBUY_SEPARATOR } from '../../constants'
import type { IndustryResult, Lang } from '../types'

export interface MultibuyOptions {
  lang?: Lang
  /** 每块最多几个字（默认 MAX_MESSAGE_CHARS） */
  maxChars?: number
  separator?: string
}

/** 一行一种材料，顺序和结果里的材料一样 */
export function multibuyLines(materials: IndustryResult['materials'], opts: Pick<MultibuyOptions, 'lang' | 'separator'> = {}): string[] {
  const separator = opts.separator ?? MULTIBUY_SEPARATOR
  return materials
    .filter((m) => m.quantity > 0)
    .map((m) => `${opts.lang === 'zh' && m.item.zh ? m.item.zh : m.item.en}${separator}${Math.round(m.quantity)}`)
}

/** 按长度把行拼成几块（每块不超过 maxChars；单独一行就超长时这一行自成一块） */
export function chunkLines(lines: readonly string[], maxChars: number): string[] {
  const out: string[] = []
  let current = ''
  for (const line of lines) {
    if (current && current.length + 1 + line.length > maxChars) {
      out.push(current)
      current = ''
    }
    current = current ? `${current}\n${line}` : line
  }
  if (current) out.push(current)
  return out
}

export function multibuyBlocks(result: Pick<IndustryResult, 'materials'>, opts: MultibuyOptions = {}): string[] {
  return chunkLines(multibuyLines(result.materials, opts), Math.max(1, opts.maxChars ?? MAX_MESSAGE_CHARS))
}
