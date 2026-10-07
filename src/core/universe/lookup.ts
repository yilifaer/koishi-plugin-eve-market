// 「翻译」查的名字表（物品之外的部分）：已发布的分组和大类、星域、星座、星系，以及黑话表的词条。
// 按数据版本、黑话表版本各建一次，放在模块级存储里（插件重载后复用）。名字的规范化和物品识别是同一套。

import { memoByKey } from '../data'
import { nameKey } from '../items'
import type { ModuleStore } from '../ports'
import type { DataSet, GlossaryData, GlossaryEntry } from '../types'

export type PlaceKind = 'group' | 'category' | 'region' | 'constellation' | 'system'

export interface NamedPlace {
  kind: PlaceKind
  id: number
  en: string
  zh: string
  /** 中英文名的 key（空的不收） */
  keys: readonly string[]
}

export interface PlaceIndex {
  /** 分组、大类、星域、星座、星系的顺序，同一种按 ID */
  readonly all: readonly NamedPlace[]
  readonly exact: ReadonlyMap<string, readonly NamedPlace[]>
}

export interface SlangTerm {
  entry: GlossaryEntry
  /** 去掉了末尾括号里的说明（「毁电（也常指本地中立玩家）」→「毁电」） */
  en: string
  zh: string
  /** 显示用的其他写法：中文在前，和 en、zh 或前面的写法 key 相同的不列 */
  aliases: string[]
  /** 全部写法原文（匹配用，大小写不同的都留着） */
  writings: readonly string[]
  /** 不区分大小写的那些写法的 key（包含查找、和物品分组对应时用） */
  keys: readonly string[]
}

export interface SlangIndex {
  readonly all: readonly SlangTerm[]
  /** 其余写法：不区分大小写 */
  readonly exact: ReadonlyMap<string, readonly SlangTerm[]>
  /** 3 个英文字母以内的写法只认大小写完全一致的（黑话表自己的规则） */
  readonly exactCase: ReadonlyMap<string, readonly SlangTerm[]>
}

/** 黑话表的大小写规则：英文字母不超过这么多个时区分大小写 */
const CASE_SENSITIVE_LETTERS = 3
const EMPTY_SLANG: SlangIndex = { all: [], exact: new Map(), exactCase: new Map() }

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key)
  if (!list) map.set(key, [value])
  else if (!list.includes(value)) list.push(value)
}

function keysOf(en: string, zh: string): string[] {
  return [...new Set([nameKey(en), zh ? nameKey(zh) : ''])].filter(Boolean)
}

// ------------------------------------------------------------------ 分组、大类、星图

function* places(data: DataSet): Generator<NamedPlace> {
  const place = (kind: PlaceKind, id: number, en: string, zh: string): NamedPlace => ({ kind, id, en, zh, keys: keysOf(en, zh) })
  for (const g of data.groups.values()) if (g.published) yield place('group', g.id, g.en, g.zh)
  for (const c of data.categories.values()) if (c.published) yield place('category', c.id, c.en, c.zh)
  for (const r of data.universe.regions.values()) yield place('region', r.id, r.en, r.zh)
  for (const k of data.universe.constellations.values()) yield place('constellation', k.id, k.en, k.zh)
  for (const s of data.universe.systems.values()) yield place('system', s.id, s.en, s.zh)
}

function buildPlaces(data: DataSet): PlaceIndex {
  const all = [...places(data)]
  const exact = new Map<string, NamedPlace[]>()
  for (const p of all) for (const key of p.keys) push(exact, key, p)
  return { all, exact }
}

export function placeIndex(store: ModuleStore, data: DataSet): PlaceIndex {
  return memoByKey(store, 'universe/places', data.key, () => buildPlaces(data))
}

// ------------------------------------------------------------------ 黑话表

/** 写法末尾括号里的说明不算写法的一部分 */
export function stripNote(text: string): string {
  return text.replace(/\s*[（(][^（()）]*[）)]\s*$/, '').trim()
}

function letterCount(text: string): number {
  return (text.match(/[A-Za-z]/g) ?? []).length
}

/** 区分大小写的 key：NFKC 后去掉空白和标点，不转小写 */
export function caseKey(text: string): string {
  return text.normalize('NFKC').replace(/[\s\-_.,:;()[\]/\\'"‘’“”]/g, '')
}

/** 3 个英文字母以内、没有汉字的写法区分大小写 */
export function isCaseSensitive(text: string): boolean {
  const letters = letterCount(text)
  return letters > 0 && letters <= CASE_SENSITIVE_LETTERS && !/\p{Script=Han}/u.test(text)
}

function termOf(entry: GlossaryEntry): SlangTerm {
  const en = stripNote(entry.en) || entry.en
  const zh = stripNote(entry.zh) || entry.zh
  const others = [...entry.zhAliases, ...entry.enAliases].map(stripNote).filter(Boolean)
  const seen = new Set([nameKey(en), nameKey(zh)])
  const aliases: string[] = []
  for (const text of others) {
    const key = nameKey(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    aliases.push(text)
  }
  const writings = [...new Set([en, zh, ...others])]
  const keys = [...new Set(writings.filter((w) => !isCaseSensitive(w)).map(nameKey))].filter(Boolean)
  return { entry, en, zh, aliases, writings, keys }
}

function buildSlang(glossary: GlossaryData): SlangIndex {
  const all = glossary.entries.map(termOf)
  const exact = new Map<string, SlangTerm[]>()
  const exactCase = new Map<string, SlangTerm[]>()
  for (const term of all) {
    for (const text of term.writings) {
      if (isCaseSensitive(text)) push(exactCase, caseKey(text), term)
      else if (nameKey(text)) push(exact, nameKey(text), term)
    }
  }
  return { all, exact, exactCase }
}

export function slangIndex(store: ModuleStore, glossary: GlossaryData | null): SlangIndex {
  if (!glossary) return EMPTY_SLANG
  return memoByKey(store, 'universe/slang', glossary.key, () => buildSlang(glossary))
}
