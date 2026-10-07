// 物品索引（§6.1.8），每个数据版本建一次：
// - 精确、生成写法：Map<key, 行>；前缀：排好序的 key 数组（二分查找）；拼音：见 pinyin.ts；
// - 「包含」和「容错」档直接线性扫描范围里的行，不建倒排表（省一半内存和建索引的时间，仍在 5 ms 以内）。
// 范围（§6.1.1）：industry、reaction 里蓝图名换成产品，所以每个范围有一张「行 → 代表的行」表。

import { NO_ID } from '../types'
import type { DataSet, Scope, TypeTable } from '../types'
import { hanMask, latinMask } from './masks'
import { keyOf, nameKey, normalizeName } from './normalize'
import { buildPinyin } from './pinyin'
import type { PinyinIndex } from './pinyin'
import { metaRank } from './rank'
import type { RankColumns } from './rank'
import { familyAliases, findImplantSets, setAliases } from './sets'
import type { ImplantSetEntry } from './sets'
import { sortPairs } from './sorted'
import { familyRoot, generatedNames, hullNames } from './variants'

const SCOPES: readonly Scope[] = ['market', 'industry', 'reaction', 'any']

export interface ItemIndex {
  readonly data: DataSet
  readonly table: TypeTable
  readonly rank: RankColumns
  readonly enKey: readonly string[]
  /** 没有中文名时是 '' */
  readonly zhKey: readonly string[]
  /** 规范化后的英文名、中文名（「相关物品」的「名字里包含它」用） */
  readonly enText: readonly string[]
  readonly zhText: readonly string[]
  /** 「英文 + 中文」规范化文本（包含档） */
  readonly text: readonly string[]
  /** text 里出现过哪些拉丁字母和数字、哪些汉字（见 masks.ts） */
  readonly latinMask: Int32Array
  readonly hanMask: Int32Array
  /** 英文名 key 的首字符 → 行（拉丁容错档只和首字母相同的比） */
  readonly enByFirst: ReadonlyMap<string, readonly number[]>
  /** 官方英文名或中文名的 key → 行 */
  readonly exact: ReadonlyMap<string, readonly number[]>
  /** 生成的写法（去「级」、罗马数字）的 key → 行；已去掉和任何官方名相同的 */
  readonly variants: ReadonlyMap<string, readonly number[]>
  /** 前缀档：官方名和生成写法的 key，排好序；prefixRows 和它一一对应 */
  readonly prefixKeys: readonly string[]
  readonly prefixRows: Int32Array
  readonly pinyin: PinyinIndex
  readonly sets: readonly ImplantSetEntry[]
  /** 套装写法的 key → sets 里的下标；不带等级的写法对应多个 */
  readonly setAliases: ReadonlyMap<string, readonly number[]>
  readonly setSkipped: readonly string[]
  /** 行 → 这个范围里代表的行（蓝图换成产品），-1 = 不在范围里 */
  readonly scopeOf: Readonly<Record<Scope, Int32Array>>
  /** 范围里的行（线性扫描用，含会换成产品的蓝图） */
  readonly scopeRows: Readonly<Record<Scope, Int32Array>>
  readonly groupRows: ReadonlyMap<number, readonly number[]>
  /** 同一个 variationParent 的一族：根的 typeID → 行 */
  readonly families: ReadonlyMap<number, readonly number[]>
  /** 中文名以「级」结尾的船体名个数 */
  readonly hulls: number
}

function push<K>(map: Map<K, number[]>, key: K, row: number) {
  const list = map.get(key)
  if (!list) map.set(key, [row])
  else if (list[list.length - 1] !== row) list.push(row)
}

function buildRank(table: TypeTable): RankColumns {
  const meta = new Uint8Array(table.size)
  const enLength = new Uint16Array(table.size)
  const zhLength = new Uint16Array(table.size)
  for (let row = 0; row < table.size; row++) {
    meta[row] = metaRank(table.metaGroup[row])
    enLength[row] = Math.min(table.en[row].length, 0xffff)
    zhLength[row] = Math.min((table.zh[row] || table.en[row]).length, 0xffff)
  }
  return { category: table.category, meta, enLength, zhLength }
}

/** industry / reaction：产品是自己，蓝图（配方）换成产品 */
function productScope(data: DataSet, activity: 'm' | 'r'): Int32Array {
  const { types, industry } = data
  const products = activity === 'm' ? industry.manufacturing : industry.reactions
  const out = new Int32Array(types.size).fill(-1)
  for (let row = 0; row < types.size; row++) {
    const id = types.id[row]
    if (products.has(id)) {
      out[row] = row
      continue
    }
    const product = industry.byBlueprint.get(id)?.[activity]?.products[0]
    if (product) out[row] = types.rowOf(product.typeId)
  }
  return out
}

function buildScopes(data: DataSet) {
  const { types } = data
  const market = new Int32Array(types.size)
  const any = new Int32Array(types.size)
  for (let row = 0; row < types.size; row++) {
    market[row] = types.marketGroup[row] === NO_ID ? -1 : row
    any[row] = row
  }
  const scopeOf: Record<Scope, Int32Array> = {
    market, any, industry: productScope(data, 'm'), reaction: productScope(data, 'r'),
  }
  const scopeRows = {} as Record<Scope, Int32Array>
  for (const scope of SCOPES) {
    const rows: number[] = []
    scopeOf[scope].forEach((target, row) => { if (target >= 0) rows.push(row) })
    scopeRows[scope] = Int32Array.from(rows)
  }
  return { scopeOf, scopeRows }
}

interface NameTables {
  enKey: string[]
  zhKey: string[]
  enText: string[]
  zhText: string[]
  text: string[]
  latinMask: Int32Array
  hanMask: Int32Array
  exact: Map<string, number[]>
  enByFirst: Map<string, number[]>
}

function buildNames(table: TypeTable): NameTables {
  const out: NameTables = {
    enKey: [], zhKey: [], enText: [], zhText: [], text: [],
    latinMask: new Int32Array(table.size), hanMask: new Int32Array(table.size), exact: new Map(), enByFirst: new Map(),
  }
  for (let row = 0; row < table.size; row++) {
    const en = normalizeName(table.en[row])
    const zh = table.zh[row] ? normalizeName(table.zh[row]) : ''
    const text = zh ? `${en}\n${zh}` : en
    const ek = keyOf(en)
    const zk = keyOf(zh)
    out.enText.push(en)
    out.zhText.push(zh)
    out.text.push(text)
    out.enKey.push(ek)
    out.zhKey.push(zk)
    out.latinMask[row] = latinMask(text)
    out.hanMask[row] = zh ? hanMask(zh) : 0
    if (ek) {
      push(out.exact, ek, row)
      push(out.enByFirst, ek[0], row)
    }
    if (zk) push(out.exact, zk, row)
  }
  return out
}

/** 生成的写法；和任何官方名的 key 相同时丢掉（精确匹配永远优先） */
function buildVariants(table: TypeTable, exact: ReadonlyMap<string, readonly number[]>) {
  const hulls = hullNames(table)
  const variants = new Map<string, number[]>()
  for (let row = 0; row < table.size; row++) {
    for (const name of generatedNames(table, row, hulls)) {
      const key = nameKey(name)
      if (key && !exact.has(key)) push(variants, key, row)
    }
  }
  return { variants, hulls: hulls.size }
}

function buildPrefix(names: NameTables, variants: ReadonlyMap<string, readonly number[]>) {
  const keys: string[] = []
  const rows: number[] = []
  const add = (key: string, row: number) => {
    keys.push(key)
    rows.push(row)
  }
  names.enKey.forEach((key, row) => { if (key) add(key, row) })
  names.zhKey.forEach((key, row) => { if (key && key !== names.enKey[row]) add(key, row) })
  for (const [key, list] of variants) for (const row of list) add(key, row)
  const sorted = sortPairs(keys, rows)
  return { prefixKeys: sorted.keys, prefixRows: sorted.rows }
}

function buildSets(table: TypeTable, exact: ReadonlyMap<string, readonly number[]>) {
  const { sets, skipped } = findImplantSets(table)
  const aliases = new Map<string, number[]>()
  sets.forEach((entry, i) => {
    for (const name of [...setAliases(entry), ...familyAliases(entry)]) {
      const key = nameKey(name)
      if (key && !exact.has(key)) push(aliases, key, i)
    }
  })
  return { sets, setAliases: aliases, setSkipped: skipped }
}

function buildGroups(table: TypeTable) {
  const groupRows = new Map<number, number[]>()
  const families = new Map<number, number[]>()
  for (let row = 0; row < table.size; row++) {
    push(groupRows, table.group[row], row)
    push(families, familyRoot(table, row), row)
  }
  return { groupRows, families }
}

export function buildItemIndex(data: DataSet): ItemIndex {
  const table = data.types
  const names = buildNames(table)
  const { variants, hulls } = buildVariants(table, names.exact)
  return {
    data,
    table,
    rank: buildRank(table),
    ...names,
    variants,
    ...buildPrefix(names, variants),
    pinyin: buildPinyin(table),
    ...buildSets(table, names.exact),
    ...buildScopes(data),
    ...buildGroups(table),
    hulls,
  }
}
