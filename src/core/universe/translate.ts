// 「翻译」（§2.13）：物品、分组、大类、星系、星座、星域、黑话表的中英对照。
// 先找完全一致的（物品走识别器的 0–2 档：编号、官方名、别名、套装、黑话里的组名），有就只列这些；
// 没有再按包含找（物品用「搜索」的结果：前缀、包含、拼音）。物品在前，然后分组、大类、星域、星座、星系、黑话。
// 黑话词条就是某个物品或分组的别名时并进那一项（物品的「别名」一行已经有它），不单列。

import { USE_GLOSSARY } from '../../constants'
import { nameKey } from '../items'
import type { ModuleStore } from '../ports'
import { NO_ID } from '../types'
import type { DataService, DataSet, ItemInfo, ItemResolver, Resolution, TranslateEntry, TranslateResult } from '../types'
import { caseKey, isCaseSensitive, placeIndex, slangIndex } from './lookup'
import type { NamedPlace, PlaceKind, SlangIndex, SlangTerm } from './lookup'

export interface TranslatorDeps {
  data: Pick<DataService, 'current' | 'glossary'>
  items: Pick<ItemResolver, 'resolve' | 'search' | 'aliasesOf'>
  store: ModuleStore
  /** 默认 USE_GLOSSARY */
  useGlossary?: boolean
}

interface Found {
  entries: TranslateEntry[]
  total: number
}

/** 包含查找至少要几个字（有汉字时 1 个就行），免得一个字母扫出几千个星系 */
const MIN_CONTAINS_CHARS = 2

const KIND_ORDER: Record<PlaceKind, number> = { group: 0, category: 1, region: 2, constellation: 3, system: 4 }

const HAN = /\p{Script=Han}/u

const nameOf = (info: { en: string; zh: string } | undefined) => (info ? { zh: info.zh, en: info.en } : undefined)

/** 物品识别 0–2 档命中的物品（含套装的各件）；组名单独给出分组 ID */
function exactItems(res: Resolution): { items: ItemInfo[]; total: number; groupId?: number } {
  switch (res.kind) {
    case 'unique':
      return res.tier === 'prefix' ? { items: [], total: 0 } : { items: [res.item], total: 1 }
    case 'ambiguous':
      return res.tier === 'prefix' ? { items: [], total: 0 } : { items: res.candidates, total: res.total }
    case 'set':
      return { items: res.set.items, total: res.set.items.length }
    case 'sets': {
      const items = res.sets.flatMap((s) => s.items)
      return { items, total: items.length }
    }
    case 'group':
      return res.candidates.length ? { items: [], total: 0, groupId: res.candidates[0].groupId } : { items: [], total: 0 }
    default:
      return { items: [], total: 0 }
  }
}

export class Translator {
  constructor(private readonly deps: TranslatorDeps) {}

  /** 数据还没加载好时抛 DataNotReadyError（和 DataService.current 一样） */
  translate(query: string, limit: number): TranslateResult {
    const text = query.normalize('NFKC').replace(/\s+/g, ' ').trim()
    const key = nameKey(text)
    if (!key) return { entries: [], total: 0 }
    const max = Math.max(1, Math.floor(limit))
    const data = this.deps.data.current()
    const found = this.exact(data, text, key, max)
    const { entries, total } = found.entries.length ? found : this.contains(data, text, key, max)
    return { entries: entries.slice(0, max), total }
  }

  // ---------------------------------------------------------------- 完全一致

  private exact(data: DataSet, text: string, key: string, limit: number): Found {
    const hit = exactItems(this.deps.items.resolve(text, { scope: 'any', limit }))
    const items = hit.items.map((item) => this.itemEntry(data, item))
    const places = new Map<string, NamedPlace>()
    if (hit.groupId !== undefined) {
      const group = data.groups.get(hit.groupId)
      if (group) places.set(`group:${group.id}`, { kind: 'group', id: group.id, en: group.en, zh: group.zh, keys: [] })
    }
    for (const p of placeIndex(this.deps.store, data).exact.get(key) ?? []) places.set(`${p.kind}:${p.id}`, p)
    const placeEntries = [...places.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]).map((p) => this.placeEntry(data, p))
    const slang = this.slangExact(text, key).filter((term) => !this.mergeInto(term, items, placeEntries))
    return {
      entries: [...items, ...placeEntries, ...slang.map(slangEntry)],
      total: hit.total + placeEntries.length + slang.length,
    }
  }

  private slang(): SlangIndex {
    const glossary = (this.deps.useGlossary ?? USE_GLOSSARY) ? this.deps.data.glossary() : null
    return slangIndex(this.deps.store, glossary)
  }

  private slangExact(text: string, key: string): SlangTerm[] {
    const index = this.slang()
    const found = isCaseSensitive(text) ? index.exactCase.get(caseKey(text)) : index.exact.get(key)
    return [...found ?? []]
  }

  /**
   * 黑话词条是不是某个物品或分组的别名：是的话把它的写法并进那一项，返回 true。
   * 物品看别名层有没有接上这个词条（写法在物品的别名里）；分组看词条有没有写这个分组的名字
   */
  private mergeInto(term: SlangTerm, items: TranslateEntry[], places: TranslateEntry[]): boolean {
    const keys = new Set(term.writings.map(nameKey))
    if (items.some((e) => e.aliases.some((a) => keys.has(nameKey(a))))) return true
    const group = places.find((e) => e.kind === 'group' && [e.en, e.zh].some((n) => n && keys.has(nameKey(n))))
    if (!group) return false
    const own = new Set([group.en, group.zh, ...group.aliases].map(nameKey))
    for (const text of [term.en, term.zh, ...term.aliases]) {
      const k = nameKey(text)
      if (k && !own.has(k)) {
        own.add(k)
        group.aliases.push(text)
      }
    }
    return true
  }

  // ---------------------------------------------------------------- 包含

  private contains(data: DataSet, text: string, key: string, limit: number): Found {
    const found = this.deps.items.search(text, { scope: 'any', offset: 0, limit })
    const items = (found.exact ? [found.exact] : found.items).map((item) => this.itemEntry(data, item))
    const itemTotal = found.exact ? 1 : found.total
    if (!HAN.test(text) && key.length < MIN_CONTAINS_CHARS) return { entries: items, total: itemTotal }
    // 同一种里名字越短越接近
    const places = placeIndex(this.deps.store, data).all
      .map((place) => ({ place, length: Math.min(...place.keys.filter((k) => k.includes(key)).map((k) => k.length)) }))
      .filter((p) => Number.isFinite(p.length))
      .sort((a, b) => KIND_ORDER[a.place.kind] - KIND_ORDER[b.place.kind] || a.length - b.length)
      .map((p) => p.place)
    const slang = this.slang().all.filter((term) => term.keys.some((k) => k.includes(key)))
    return {
      entries: [...items, ...places.slice(0, limit).map((p) => this.placeEntry(data, p)), ...slang.slice(0, limit).map(slangEntry)],
      total: itemTotal + places.length + slang.length,
    }
  }

  // ---------------------------------------------------------------- 结果

  private itemEntry(data: DataSet, item: ItemInfo): TranslateEntry {
    const entry: TranslateEntry = { kind: 'item', id: item.typeId, zh: item.zh, en: item.en, item, aliases: this.deps.items.aliasesOf(item.typeId) }
    const group = nameOf(data.groups.get(item.groupId))
    const category = nameOf(data.categories.get(item.categoryId))
    if (group) entry.group = group
    if (category) entry.category = category
    return entry
  }

  private placeEntry(data: DataSet, p: NamedPlace): TranslateEntry {
    const entry: TranslateEntry = { kind: p.kind, id: p.id, zh: p.zh, en: p.en, aliases: [] }
    const { universe } = data
    switch (p.kind) {
      case 'group': {
        const category = nameOf(data.categories.get(data.groups.get(p.id)?.categoryId ?? NO_ID))
        if (category) entry.category = category
        break
      }
      case 'constellation': {
        const region = nameOf(universe.regions.get(universe.constellations.get(p.id)?.regionId ?? NO_ID))
        if (region) entry.region = region
        break
      }
      case 'system': {
        const system = universe.systems.get(p.id)
        const region = nameOf(universe.regions.get(system?.regionId ?? NO_ID))
        if (region) entry.region = region
        if (system) entry.security = system.security
        break
      }
      default:
        break
    }
    return entry
  }
}

function slangEntry(term: SlangTerm): TranslateEntry {
  return {
    kind: 'slang',
    id: null,
    zh: term.zh,
    en: term.en,
    slang: { category: term.entry.category, note: term.entry.note },
    aliases: [...term.aliases],
  }
}
