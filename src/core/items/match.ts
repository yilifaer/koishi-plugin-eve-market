// 各档的查找（§6.1.6）：只返回行号，范围换算、排序和结果的形状由 resolver 决定。

import type { Scope } from '../types'
import type { AliasLayer, AliasTarget } from './aliases'
import { editDistance, maxDistance, sharedChars } from './fuzzy'
import type { ItemIndex } from './item-index'
import { covers, hanBit } from './masks'
import { pinyinRows } from './pinyin'
import type { Query } from './query'
import { CATEGORY_SKIN } from './rank'
import { prefixRange } from './sorted'

export interface State {
  readonly index: ItemIndex
  readonly aliases: AliasLayer
}

export type AliasMatch =
  | { kind: 'items'; rows: readonly number[] }
  | { kind: 'groups'; groupIds: readonly number[] }
  /** ItemIndex.sets 的下标 */
  | { kind: 'sets'; sets: readonly number[] }

/** 按范围换算并去重（industry、reaction 里蓝图换成产品），不在范围里的丢掉；保持原来的顺序 */
export function inScope(index: ItemIndex, rows: Iterable<number>, scope: Scope): number[] {
  const map = index.scopeOf[scope]
  const out = new Set<number>()
  for (const row of rows) if (map[row] >= 0) out.add(map[row])
  return [...out]
}

/** 涂装只在查询提到涂装时才列；返回留下的行和去掉的涂装行 */
export function withoutSkins(index: ItemIndex, rows: readonly number[], q: Query): { rows: number[]; skins: number[] } {
  if (q.rank.skin) return { rows: [...rows], skins: [] }
  const kept: number[] = []
  const skins: number[] = []
  for (const row of rows) (index.table.category[row] === CATEGORY_SKIN ? skins : kept).push(row)
  return { rows: kept, skins }
}

export function exactRows(index: ItemIndex, key: string): readonly number[] {
  return index.exact.get(key) ?? []
}

function glossaryMatch(aliases: AliasLayer, q: Query): AliasMatch | null {
  const targets: AliasTarget[] = [...aliases.glossaryCase.get(q.caseKey) ?? [], ...aliases.glossary.get(q.key) ?? []]
  const rows = targets.flatMap((t) => (t.kind === 'item' ? [t.row] : []))
  if (rows.length) return { kind: 'items', rows }
  const groupIds = targets.flatMap((t) => (t.kind === 'group' ? [t.groupId] : []))
  return groupIds.length ? { kind: 'groups', groupIds: [...new Set(groupIds)] } : null
}

/** 别名档按优先级的每一层：后台、黑话表、套装、生成的写法（含 bp → blueprint）。没有命中的层不列 */
export function aliasMatches(st: State, q: Query, scope: Scope): AliasMatch[] {
  const { index, aliases } = st
  const out: AliasMatch[] = []
  const admin = aliases.admin.get(q.key)
  if (admin) out.push({ kind: 'items', rows: admin })
  const glossary = glossaryMatch(aliases, q)
  if (glossary) out.push(glossary)
  const sets = scope === 'market' || scope === 'any' ? index.setAliases.get(q.key) : undefined
  if (sets) out.push({ kind: 'sets', sets })
  const variants = index.variants.get(q.key)
  if (variants) out.push({ kind: 'items', rows: variants })
  if (q.blueprintKey) {
    const rows = [...exactRows(index, q.blueprintKey), ...index.variants.get(q.blueprintKey) ?? []]
    if (rows.length) out.push({ kind: 'items', rows })
  }
  return out
}

/** 名字（含生成的写法）的 key 以查询的 key 开头 */
export function prefixRows(index: ItemIndex, key: string): number[] {
  const [start, end] = prefixRange(index.prefixKeys, key)
  const out = new Set<number>()
  for (let i = start; i < end; i++) out.add(index.prefixRows[i])
  return [...out]
}

/** 查询的每个 token 都出现在「英文 + 中文」文本里；线性扫描范围里的行，先用掩码筛掉不可能的 */
export function containsRows(index: ItemIndex, q: Query, scope: Scope): number[] {
  if (!q.tokens.length) return []
  const out: number[] = []
  for (const row of index.scopeRows[scope]) {
    if (!covers(index.latinMask[row], q.latinMask) || !covers(index.hanMask[row], q.hanMask)) continue
    const text = index.text[row]
    if (q.tokens.every((token) => text.includes(token))) out.push(row)
  }
  return out
}

export function pinyinMatch(index: ItemIndex, q: Query): number[] {
  return q.pinyin ? pinyinRows(index.pinyin, q.key) : []
}

/** 容错档的一个结果：score 越小越接近 */
export interface Near {
  row: number
  score: number
}

function keepBest(best: Map<number, number>, row: number, score: number) {
  const old = best.get(row)
  if (old === undefined || score < old) best.set(row, score)
}

/** 拉丁：Damerau-Levenshtein ≤ 1（8 个字符以上 ≤ 2），只和首字母相同的英文名（纯字母时还有拼音）比 */
function nearLatin(index: ItemIndex, q: Query, scope: Scope, best: Map<number, number>) {
  const max = maxDistance(q.key)
  const first = q.key[0]
  const scopeMap = index.scopeOf[scope]
  const consider = (word: string, row: number) => {
    if (Math.abs(word.length - q.key.length) > max || scopeMap[row] < 0) return
    const d = editDistance(q.key, word, max)
    if (d <= max) keepBest(best, row, d)
  }
  for (const row of index.enByFirst.get(first) ?? []) consider(index.enKey[row], row)
  if (!q.pinyin) return
  const { readings, readingRows, readingsByFirst } = index.pinyin
  for (const i of readingsByFirst.get(first) ?? []) consider(readings[i], readingRows[i])
}

/** 中文：查询里至少一半的字出现在名字里；先按掩码算个上限，够不着的不逐字比较 */
function nearHan(index: ItemIndex, q: Query, scope: Scope, best: Map<number, number>) {
  const need = Math.ceil(q.chars.length / 2)
  const bits = q.chars.map(hanBit)
  for (const row of index.scopeRows[scope]) {
    const mask = index.hanMask[row]
    let possible = 0
    for (const bit of bits) if (bit === 0 || mask & bit) possible++
    if (possible < need) continue
    const shared = sharedChars(q.chars, index.zhKey[row])
    if (shared >= need) keepBest(best, row, q.chars.length - shared)
  }
}

export function nearRows(index: ItemIndex, q: Query, scope: Scope): Near[] {
  const best = new Map<number, number>()
  if (q.han) {
    if (q.chars.length >= 2) nearHan(index, q, scope, best)
  } else if (q.key.length >= 2) {
    nearLatin(index, q, scope, best)
  }
  return [...best].map(([row, score]) => ({ row, score }))
}
