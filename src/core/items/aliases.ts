// 别名层（§6.1.4）：后台别名（控制台「物品别名」）和黑话表别名。优先级：后台 > 黑话表 > 套装 > 生成的写法。
// 别名的 key 等于另一个物品的官方名 key 时丢弃：精确匹配永远优先。
//
// 黑话表按严格规则接，免得 'caps' 变成技能 Capital Ships、'AB' 变成技能 Afterburner：
// 1. 只用 ship、module、structure、industry、chat 类的词条；
// 2. 英文写法等于某个市场物品（技能、蓝图、涂装除外）的英文名，或中文写法等于它的中文名 → 物品别名；
// 3. 否则等于大类 6、7、8、18、20、22、32、65、66、87 里某个已发布分组的名字 → 组别名（总是列候选）；
// 4. 3 个字母以内的英文写法只认大小写完全一致的（和黑话表自己的规则一样）。
// 船型类词条只接舰船（「加成船」的英文 Booster 也是植入体里的一个分组名）。

import type { ConfigIssue, DataSet, GlossaryData, GlossaryEntry, ItemAliasSetting, TypeId } from '../types'
import type { ItemIndex } from './item-index'
import { caseKey, letterCount, nameKey, stripNote } from './normalize'
import { CATEGORY_BLUEPRINT, CATEGORY_SHIP, CATEGORY_SKILL, CATEGORY_SKIN } from './rank'

export type AliasTarget = { kind: 'item'; row: number } | { kind: 'group'; groupId: number }

const GLOSSARY_CATEGORIES = new Set(['ship', 'module', 'structure', 'industry', 'chat'])
const ITEM_EXCLUDED_CATEGORIES = new Set([CATEGORY_SKILL, CATEGORY_BLUEPRINT, CATEGORY_SKIN])
const GROUP_CATEGORIES = new Set([6, 7, 8, 18, 20, 22, 32, 65, 66, 87])
/** 词条类别 → 只能接这些大类；没写 = 不限 */
const ENTRY_CATEGORIES: Readonly<Record<string, ReadonlySet<number>>> = { ship: new Set([CATEGORY_SHIP]) }
/** 黑话表的大小写规则：英文字母不超过这么多个时区分大小写 */
const CASE_SENSITIVE_LETTERS = 3

export interface GlossaryReport {
  /** 接成物品别名、组别名的词条数 */
  items: number
  groups: number
  /** 注册的写法个数 */
  aliases: number
  /** 没接上的原因（一个词条对应多个物品、写法和别的物品重名、同一写法指向不同目标） */
  skipped: string[]
}

export interface AliasLayer {
  /** 后台别名：key → 目标行 */
  readonly admin: ReadonlyMap<string, readonly number[]>
  /** 黑话表别名：不区分大小写的 key、区分大小写的 key（3 个字母以内） */
  readonly glossary: ReadonlyMap<string, readonly AliasTarget[]>
  readonly glossaryCase: ReadonlyMap<string, readonly AliasTarget[]>
  /** typeID → 别名原文（后台在前、黑话表在后），翻译显示「别名：…」用 */
  readonly byType: ReadonlyMap<TypeId, readonly string[]>
  /** 后台别名的坏行 */
  readonly issues: readonly ConfigIssue[]
  readonly glossaryReport: GlossaryReport
  readonly adminCount: number
}

function addTarget(map: Map<string, AliasTarget[]>, key: string, target: AliasTarget) {
  const list = map.get(key) ?? []
  if (!list.some((t) => sameTarget(t, target))) list.push(target)
  map.set(key, list)
}

function sameTarget(a: AliasTarget, b: AliasTarget): boolean {
  return a.kind === 'item' ? b.kind === 'item' && a.row === b.row : b.kind === 'group' && a.groupId === b.groupId
}

function addName(byType: Map<TypeId, string[]>, id: TypeId, name: string) {
  const list = byType.get(id) ?? []
  if (!list.some((n) => nameKey(n) === nameKey(name))) list.push(name)
  byType.set(id, list)
}

/** 官方名和 key 相同的别的物品（不算 self） */
function namedOther(index: ItemIndex, key: string, self?: number): number | undefined {
  return index.exact.get(key)?.find((row) => row !== self)
}

// ------------------------------------------------------------------ 后台别名

const ID_TARGET = /^(?:#|id:)?\s*(\d+)$/i

/** 别名目标：#typeID / typeID / 官方名 / 生成的写法（乌鸦）；多个时只留能上市场的 */
export function resolveAliasTarget(index: ItemIndex, target: string): { row: number } | { error: 'missing' | 'ambiguous' } {
  const id = ID_TARGET.exec(target.trim())
  if (id) {
    const row = index.table.rowOf(Number(id[1]))
    return row >= 0 ? { row } : { error: 'missing' }
  }
  const key = nameKey(target)
  const rows = index.exact.get(key) ?? index.variants.get(key) ?? []
  if (rows.length === 1) return { row: rows[0] }
  const market = rows.filter((row) => index.scopeOf.market[row] >= 0)
  if (market.length === 1) return { row: market[0] }
  return { error: rows.length ? 'ambiguous' : 'missing' }
}

function buildAdmin(index: ItemIndex, settings: readonly ItemAliasSetting[], byType: Map<TypeId, string[]>) {
  const admin = new Map<string, number[]>()
  const firstRow = new Map<string, number>()
  const issues: ConfigIssue[] = []
  const issue = (s: ItemAliasSetting, field: string, message: string) => issues.push({ section: 'aliases', row: s.row, field, message })
  for (const s of settings) {
    const key = nameKey(s.alias)
    if (!key) {
      issue(s, 'alias', `别名「${s.alias}」里没有可用的字，已跳过`)
      continue
    }
    const first = firstRow.get(key)
    if (first !== undefined) {
      issue(s, 'alias', `别名「${s.alias}」和第 ${first} 行的写法相同，已跳过`)
      continue
    }
    const target = resolveAliasTarget(index, s.target)
    if ('error' in target) {
      issue(s, 'target', target.error === 'missing'
        ? `别名「${s.alias}」的目标「${s.target}」找不到对应的物品，这一行不生效`
        : `别名「${s.alias}」的目标「${s.target}」对应多个物品，请改写成 #typeID，这一行不生效`)
      continue
    }
    const other = namedOther(index, key, target.row)
    if (other !== undefined) {
      issue(s, 'alias', `别名「${s.alias}」和物品「${index.table.en[other]}」的名字相同，按名字查询优先，这一行不生效`)
      continue
    }
    firstRow.set(key, s.row)
    if (index.exact.has(key)) continue // 就是目标自己的名字，不用另外记
    admin.set(key, [target.row])
    addName(byType, index.table.id[target.row], s.alias.trim())
  }
  return { admin, issues }
}

// ------------------------------------------------------------------ 黑话表

interface EntryNames {
  en: string[]
  zh: string[]
}

function namesOf(entry: GlossaryEntry): EntryNames {
  const clean = (list: string[]) => list.map(stripNote).filter(Boolean)
  return { en: clean([entry.en, ...entry.enAliases]), zh: clean([entry.zh, ...entry.zhAliases]) }
}

function allowedCategory(entry: GlossaryEntry, categoryId: number): boolean {
  const only = ENTRY_CATEGORIES[entry.category]
  return !only || only.has(categoryId)
}

/** 第 2 步：英文写法等于英文名、或中文写法等于中文名的市场物品 */
function entryItems(index: ItemIndex, entry: GlossaryEntry, names: EntryNames): Set<number> {
  const out = new Set<number>()
  const consider = (written: string, keys: readonly string[]) => {
    const key = nameKey(written)
    for (const row of index.exact.get(key) ?? []) {
      const category = index.table.category[row]
      if (keys[row] !== key || index.scopeOf.market[row] < 0) continue
      if (ITEM_EXCLUDED_CATEGORIES.has(category) || !allowedCategory(entry, category)) continue
      out.add(row)
    }
  }
  for (const written of names.en) consider(written, index.enKey)
  for (const written of names.zh) consider(written, index.zhKey)
  return out
}

/** 分组名（中英文）的 key → 分组；只收能接组别名的大类 */
function groupNames(data: DataSet): Map<string, Array<{ id: number; lang: 'en' | 'zh' }>> {
  const out = new Map<string, Array<{ id: number; lang: 'en' | 'zh' }>>()
  for (const group of data.groups.values()) {
    if (!group.published || !GROUP_CATEGORIES.has(group.categoryId)) continue
    for (const lang of ['en', 'zh'] as const) {
      const key = group[lang] ? nameKey(group[lang]) : ''
      if (key) out.set(key, [...(out.get(key) ?? []), { id: group.id, lang }])
    }
  }
  return out
}

/** 第 3 步：等于某个分组的名字，并且这个分组里有能上市场的物品 */
function entryGroups(index: ItemIndex, entry: GlossaryEntry, names: EntryNames, groups: ReturnType<typeof groupNames>): Set<number> {
  const out = new Set<number>()
  const consider = (written: string, lang: 'en' | 'zh') => {
    for (const hit of groups.get(nameKey(written)) ?? []) {
      const group = index.data.groups.get(hit.id)
      if (hit.lang !== lang || !group || !allowedCategory(entry, group.categoryId)) continue
      if (index.groupRows.get(hit.id)?.some((row) => index.scopeOf.market[row] >= 0)) out.add(hit.id)
    }
  }
  for (const written of names.en) consider(written, 'en')
  for (const written of names.zh) consider(written, 'zh')
  return out
}

function describeEntry(entry: GlossaryEntry): string {
  return `「${entry.zh} / ${entry.en}」`
}

function entryTarget(index: ItemIndex, entry: GlossaryEntry, names: EntryNames, groups: ReturnType<typeof groupNames>, skipped: string[]): AliasTarget | null {
  const items = entryItems(index, entry, names)
  if (items.size === 1) return { kind: 'item', row: [...items][0] }
  if (items.size > 1) {
    skipped.push(`${describeEntry(entry)} 对应多个物品（${[...items].map((r) => index.table.en[r]).join('、')}），没有接入`)
    return null
  }
  const found = entryGroups(index, entry, names, groups)
  if (found.size === 1) return { kind: 'group', groupId: [...found][0] }
  if (found.size > 1) skipped.push(`${describeEntry(entry)} 对应多个分组，没有接入`)
  return null
}

interface GlossaryMaps {
  glossary: Map<string, AliasTarget[]>
  glossaryCase: Map<string, AliasTarget[]>
}

/** 注册一个词条的全部写法；返回注册了几个 */
function registerEntry(index: ItemIndex, entry: GlossaryEntry, names: EntryNames, target: AliasTarget, maps: GlossaryMaps, byType: Map<TypeId, string[]>, skipped: string[]): number {
  let added = 0
  const self = target.kind === 'item' ? target.row : undefined
  for (const written of new Set([...names.en, ...names.zh])) {
    const key = nameKey(written)
    if (!key) continue
    const other = namedOther(index, key, self)
    if (other !== undefined) {
      skipped.push(`${describeEntry(entry)} 的写法「${written}」是物品「${index.table.en[other]}」的名字，不作别名`)
      continue
    }
    if (index.exact.has(key)) continue
    const letters = letterCount(written)
    if (letters > 0 && letters <= CASE_SENSITIVE_LETTERS) addTarget(maps.glossaryCase, caseKey(written), target)
    else addTarget(maps.glossary, key, target)
    if (self !== undefined) addName(byType, index.table.id[self], written)
    added++
  }
  return added
}

/** 同一个写法被不同词条指向不同目标：保留（别名档会列候选），但写进报告 */
function reportClashes(index: ItemIndex, maps: GlossaryMaps, skipped: string[]) {
  const label = (t: AliasTarget) => (t.kind === 'item' ? index.table.en[t.row] : `分组 ${index.data.groups.get(t.groupId)?.en ?? t.groupId}`)
  for (const map of [maps.glossary, maps.glossaryCase]) {
    for (const [key, targets] of map) {
      if (targets.length > 1) skipped.push(`写法「${key}」指向多个目标（${targets.map(label).join('、')}），查询时列候选`)
    }
  }
}

function buildGlossary(index: ItemIndex, glossary: GlossaryData | null, byType: Map<TypeId, string[]>) {
  const maps: GlossaryMaps = { glossary: new Map(), glossaryCase: new Map() }
  const report: GlossaryReport = { items: 0, groups: 0, aliases: 0, skipped: [] }
  if (!glossary) return { ...maps, report }
  const groups = groupNames(index.data)
  for (const entry of glossary.entries) {
    if (!GLOSSARY_CATEGORIES.has(entry.category)) continue
    const names = namesOf(entry)
    const target = entryTarget(index, entry, names, groups, report.skipped)
    if (!target) continue
    const added = registerEntry(index, entry, names, target, maps, byType, report.skipped)
    if (!added) continue
    report.aliases += added
    if (target.kind === 'item') report.items++
    else report.groups++
  }
  reportClashes(index, maps, report.skipped)
  return { ...maps, report }
}

// ------------------------------------------------------------------ 合起来

export function buildAliasLayer(index: ItemIndex, glossary: GlossaryData | null, settings: readonly ItemAliasSetting[]): AliasLayer {
  const byType = new Map<TypeId, string[]>()
  const { admin, issues } = buildAdmin(index, settings, byType)
  const { glossary: gl, glossaryCase, report } = buildGlossary(index, glossary, byType)
  return { admin, glossary: gl, glossaryCase, byType, issues, glossaryReport: report, adminCount: admin.size }
}
