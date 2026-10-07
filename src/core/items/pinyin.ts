// 拼音（§6.1.6 的 4p 档）。数据里的 py 是成对的「全拼 首字母」，多音字最多 4 种读法；
// 只给能上市场、有中文名的物品写。首字母用 Map 精确找，全拼用排好序的数组按前缀找。

import type { TypeTable } from '../types'
import { lowerBound, sortPairs } from './sorted'

export interface PinyinIndex {
  /** 首字母串 → 行 */
  readonly initials: Map<string, number[]>
  /** 全拼，排好序；fullRows 和它一一对应 */
  readonly full: string[]
  readonly fullRows: Int32Array
  /** 容错档逐个比较用：每行的全部读法（全拼和首字母），和 readingRows 一一对应 */
  readonly readings: string[]
  readonly readingRows: Int32Array
  /** 读法的首字母 → readings 里的下标 */
  readonly readingsByFirst: ReadonlyMap<string, readonly number[]>
}

/** 一行的读法：去重后的全拼和首字母 */
function readingsOf(py: string): { full: Set<string>; short: Set<string> } {
  const words = py ? py.split(' ') : []
  const full = new Set<string>()
  const short = new Set<string>()
  for (let i = 0; i + 1 < words.length; i += 2) {
    full.add(words[i])
    short.add(words[i + 1])
  }
  return { full, short }
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

export function buildPinyin(table: TypeTable): PinyinIndex {
  const initials = new Map<string, number[]>()
  const fullKeys: string[] = []
  const fullRows: number[] = []
  const readings: string[] = []
  const readingRows: number[] = []
  const readingsByFirst = new Map<string, number[]>()
  for (let row = 0; row < table.size; row++) {
    if (!table.py[row]) continue
    const { full, short } = readingsOf(table.py[row])
    for (const word of full) {
      fullKeys.push(word)
      fullRows.push(row)
    }
    for (const word of short) append(initials, word, row)
    for (const word of new Set([...full, ...short])) {
      append(readingsByFirst, word[0], readings.length)
      readings.push(word)
      readingRows.push(row)
    }
  }
  const sorted = sortPairs(fullKeys, fullRows)
  return { initials, full: sorted.keys, fullRows: sorted.rows, readings, readingRows: Int32Array.from(readingRows), readingsByFirst }
}

/** 查询等于某个首字母串，或者是某个全拼的前缀（等于也算） */
export function pinyinRows(index: PinyinIndex, query: string): number[] {
  const out = new Set<number>(index.initials.get(query) ?? [])
  for (let i = lowerBound(index.full, query); i < index.full.length && index.full[i].startsWith(query); i++) {
    out.add(index.fullRows[i])
  }
  return [...out]
}
