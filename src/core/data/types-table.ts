// types.json → 按列存放的物品表 + 分组、大类、市场分组、元分组。

import { NO_ID } from '../types'
import type { CategoryInfo, GroupInfo, ItemInfo, MarketGroupInfo, MetaGroupInfo, TypeId, TypeTable } from '../types'
import { checkFileSchema, DataError, mapById, openTable } from './shapes'
import type { JsonObject, TableSpec } from './shapes'

const FILE = 'types.json'

type TypeColumn =
  | 'id' | 'en' | 'zh' | 'group' | 'marketGroup' | 'metaGroup' | 'techLevel' | 'volume' | 'packagedVolume'
  | 'portionSize' | 'variationParent' | 'capacity' | 'py'

export const TYPES_SPEC: TableSpec<TypeColumn> = {
  columns: 'columns',
  rows: 'types',
  need: {
    id: 'int', en: 'str', zh: 'str', group: 'int', marketGroup: 'int?', metaGroup: 'int?', techLevel: 'int?',
    volume: 'num?', packagedVolume: 'num?', portionSize: 'int', variationParent: 'int?', capacity: 'num?', py: 'str?',
  },
}

export const GROUPS_SPEC: TableSpec<'id' | 'category' | 'en' | 'zh' | 'published'> = {
  columns: 'groupColumns', rows: 'groups', need: { id: 'int', category: 'int', en: 'str', zh: 'str', published: 'bool' },
}
export const CATEGORIES_SPEC: TableSpec<'id' | 'en' | 'zh' | 'published'> = {
  columns: 'categoryColumns', rows: 'categories', need: { id: 'int', en: 'str', zh: 'str', published: 'bool' },
}
export const MARKET_GROUPS_SPEC: TableSpec<'id' | 'parent' | 'en' | 'zh'> = {
  columns: 'marketGroupColumns', rows: 'marketGroups', need: { id: 'int', parent: 'int?', en: 'str', zh: 'str' },
}
export const META_GROUPS_SPEC: TableSpec<'id' | 'en' | 'zh'> = {
  columns: 'metaGroupColumns', rows: 'metaGroups', need: { id: 'int', en: 'str', zh: 'str' },
}

export interface TypesData {
  types: TypeTable
  groups: Map<number, GroupInfo>
  categories: Map<number, CategoryInfo>
  marketGroups: Map<number, MarketGroupInfo>
  metaGroups: Map<number, MetaGroupInfo>
}

const orNone = (v: unknown) => (v === null ? NO_ID : v as number)
const orNull = (v: number) => (v === NO_ID ? null : v)

class ColumnTypeTable implements TypeTable {
  readonly size: number
  readonly id: Int32Array
  readonly group: Int32Array
  readonly category: Int32Array
  readonly marketGroup: Int32Array
  readonly metaGroup: Int32Array
  readonly techLevel: Int32Array
  readonly volume: Float64Array
  readonly packagedVolume: Float64Array
  readonly portionSize: Int32Array
  readonly variationParent: Int32Array
  readonly capacity: Float64Array
  readonly en: string[]
  readonly zh: string[]
  readonly py: string[]
  /** item() 的结果按行缓存，同一行总是同一个对象 */
  private readonly infos: Array<ItemInfo | undefined>

  constructor(size: number) {
    this.size = size
    this.id = new Int32Array(size)
    this.group = new Int32Array(size)
    this.category = new Int32Array(size)
    this.marketGroup = new Int32Array(size)
    this.metaGroup = new Int32Array(size)
    this.techLevel = new Int32Array(size)
    this.volume = new Float64Array(size)
    this.packagedVolume = new Float64Array(size)
    this.portionSize = new Int32Array(size)
    this.variationParent = new Int32Array(size)
    this.capacity = new Float64Array(size)
    this.en = new Array<string>(size)
    this.zh = new Array<string>(size)
    this.py = new Array<string>(size)
    this.infos = new Array<ItemInfo | undefined>(size)
  }

  rowOf(id: TypeId): number {
    let lo = 0
    let hi = this.size - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const v = this.id[mid]
      if (v === id) return mid
      if (v < id) lo = mid + 1
      else hi = mid - 1
    }
    return -1
  }

  item(row: number): ItemInfo {
    if (!Number.isInteger(row) || row < 0 || row >= this.size) throw new RangeError(`物品表没有第 ${row} 行`)
    const cached = this.infos[row]
    if (cached) return cached
    const capacity = this.capacity[row]
    const info: ItemInfo = Object.freeze({
      typeId: this.id[row],
      en: this.en[row],
      zh: this.zh[row],
      groupId: this.group[row],
      categoryId: this.category[row],
      marketGroupId: orNull(this.marketGroup[row]),
      metaGroupId: orNull(this.metaGroup[row]),
      techLevel: orNull(this.techLevel[row]),
      volume: this.volume[row],
      packagedVolume: this.packagedVolume[row],
      portionSize: this.portionSize[row],
      capacity: Number.isNaN(capacity) ? null : capacity,
      variationParent: orNull(this.variationParent[row]),
    })
    this.infos[row] = info
    return info
  }
}

function readGroups(raw: JsonObject, categories: Map<number, CategoryInfo>): Map<number, GroupInfo> {
  const t = openTable(FILE, raw, GROUPS_SPEC)
  const c = t.col
  const groups = mapById(t, (row): GroupInfo => ({
    id: row[c.id] as number,
    categoryId: row[c.category] as number,
    en: row[c.en] as string,
    zh: row[c.zh] as string,
    published: row[c.published] as boolean,
  }))
  for (const group of groups.values()) {
    if (!categories.has(group.categoryId)) {
      throw new DataError('reference', `${t.where} 的分组 ${group.id} 引用的大类 ${group.categoryId} 不存在`)
    }
  }
  return groups
}

function readCategories(raw: JsonObject): Map<number, CategoryInfo> {
  const t = openTable(FILE, raw, CATEGORIES_SPEC)
  const c = t.col
  return mapById(t, (row): CategoryInfo => ({
    id: row[c.id] as number,
    en: row[c.en] as string,
    zh: row[c.zh] as string,
    published: row[c.published] as boolean,
  }))
}

function readMarketGroups(raw: JsonObject): Map<number, MarketGroupInfo> {
  const t = openTable(FILE, raw, MARKET_GROUPS_SPEC)
  const c = t.col
  return mapById(t, (row): MarketGroupInfo => ({
    id: row[c.id] as number,
    parentId: row[c.parent] as number | null,
    en: row[c.en] as string,
    zh: row[c.zh] as string,
  }))
}

function readMetaGroups(raw: JsonObject): Map<number, MetaGroupInfo> {
  const t = openTable(FILE, raw, META_GROUPS_SPEC)
  const c = t.col
  return mapById(t, (row): MetaGroupInfo => ({ id: row[c.id] as number, en: row[c.en] as string, zh: row[c.zh] as string }))
}

function readTypes(raw: JsonObject, groups: Map<number, GroupInfo>): TypeTable {
  const t = openTable(FILE, raw, TYPES_SPEC)
  const c = t.col
  const table = new ColumnTypeTable(t.rows.length)
  let previous = -Infinity
  t.rows.forEach((row, r) => {
    const id = row[c.id] as number
    // rowOf 用二分查找，所以必须按 id 升序且不重复
    if (id <= previous) throw new DataError('format', `${t.where} 第 ${r + 1} 行的 id ${id} 没有按升序排列或重复`)
    previous = id
    const groupId = row[c.group] as number
    const group = groups.get(groupId)
    if (!group) throw new DataError('reference', `${t.where} 的物品 ${id} 引用的分组 ${groupId} 不存在`)
    const volume = (row[c.volume] as number | null) ?? 0
    table.id[r] = id
    table.en[r] = row[c.en] as string
    table.zh[r] = row[c.zh] as string
    table.py[r] = (row[c.py] as string | null) ?? ''
    table.group[r] = groupId
    table.category[r] = group.categoryId
    table.marketGroup[r] = orNone(row[c.marketGroup])
    table.metaGroup[r] = orNone(row[c.metaGroup])
    table.techLevel[r] = orNone(row[c.techLevel])
    table.volume[r] = volume
    table.packagedVolume[r] = (row[c.packagedVolume] as number | null) ?? volume
    table.portionSize[r] = row[c.portionSize] as number
    table.variationParent[r] = orNone(row[c.variationParent])
    table.capacity[r] = (row[c.capacity] as number | null) ?? Number.NaN
  })
  return table
}

export function buildTypes(raw: JsonObject): TypesData {
  checkFileSchema(FILE, raw)
  const categories = readCategories(raw)
  const groups = readGroups(raw, categories)
  return {
    types: readTypes(raw, groups),
    groups,
    categories,
    marketGroups: readMarketGroups(raw),
    metaGroups: readMetaGroups(raw),
  }
}
