// MarketRegistry（§2.0.5、§4.4）：控制台的市场表格 + 星图数据 → 运行时的市场。
// - 空间站、星系、星域都从 universe.json 查出星系和星域；查不到的行标无效、跳过并报告。
// - NPC 空间站和星系类市场自动加上星系的中英文名作别名，优先级低于名称和手写别名，冲突时不生效也不报告。
// - 可见范围按 Access 判断：本群看不到的市场和不存在的一样。
// - 配置里对市场的引用（基准市场、默认市场、回退市场……）和用户输入用同一套匹配；数据加载后才能认出星系名。
// 每个数据版本建一次，数据更新后第一次用到时自动重建。

import { MAX_MARKETS, PRICE_TYPE_WORDS } from '../../constants'
import { DataNotReadyError } from '../data'
import type {
  Access, ConfigIssue, DataService, DataSet, ItemResolver, MarketDef, MarketRefField, MarketRegistry, MarketSetting,
  MarketSplit, RegionInfo, Scope, Settings, SystemInfo,
} from '../types'
import { compactMarketKey, displayWidth, marketKey } from './keys'
import { splitMarket } from './split'

export interface ManagedMarketRegistry extends MarketRegistry {
  /** 全部有效的市场，不分可见范围，按显示顺序（「市场状态」、价格服务用） */
  all(): MarketDef[]
  /** 要有数据才能发现的配置问题：位置、星系查不到，配置里引用的市场找不到 */
  issues(): ConfigIssue[]
  /** 建筑所在星系（建筑同步从 /universe/structures 得到）。有变化时返回 true，下次用到时重建 */
  locateStructure(key: string, systemId: number): boolean
}

const REF_FIELDS: readonly MarketRefField[] = [
  'price.baseMarket', 'appraisal.defaultMarket', 'appraisal.fallbackMarket',
  'industry.materialMarket', 'industry.productMarket', 'industry.fallbackMarket',
]

const RESERVED = new Set<string>([...PRICE_TYPE_WORDS.sell, ...PRICE_TYPE_WORDS.buy, ...PRICE_TYPE_WORDS.mid].map(marketKey))

interface Built {
  /** 数据版本 + 建筑位置的版本 */
  key: string
  /** 按显示顺序 */
  list: MarketDef[]
  byKey: Map<string, MarketDef>
  /** 查找顺序：名称、手写别名、自动别名，然后同样三层的去空白写法 */
  layers: Array<Map<string, MarketDef>>
  maxWords: number
  refs: Partial<Record<MarketRefField, MarketDef>>
  firstPublic?: MarketDef
  issues: ConfigIssue[]
}

const EMPTY: Built = { key: '', list: [], byKey: new Map(), layers: [], maxWords: 0, refs: {}, issues: [] }

export function visibleTo(market: MarketDef, access: Access): boolean {
  return market.visibility === 'public' || access.allowed
}

function byDisplayOrder(a: { sortOrder: number; row: number }, b: { sortOrder: number; row: number }): number {
  return a.sortOrder - b.sortOrder || a.row - b.row
}

// ------------------------------------------------------------------ 星图查找

interface Places {
  systems: Map<string, SystemInfo>
  regions: Map<string, RegionInfo>
}

const placesCache = new WeakMap<DataSet, Places>()

function namesOf<T extends { en: string; zh: string }>(entries: Iterable<T>): Map<string, T> {
  const out = new Map<string, T>()
  for (const entry of entries) {
    for (const name of [entry.en, entry.zh]) {
      const key = name ? marketKey(name) : ''
      if (key && !out.has(key)) out.set(key, entry)
    }
  }
  return out
}

function placesOf(data: DataSet): Places {
  let places = placesCache.get(data)
  if (!places) {
    places = { systems: namesOf(data.universe.systems.values()), regions: namesOf(data.universe.regions.values()) }
    placesCache.set(data, places)
  }
  return places
}

/** 名字（中英文）或 ID */
function lookup<T>(text: string, byId: Map<number, T>, byName: Map<string, T>): T | undefined {
  const value = text.trim()
  return /^\d+$/.test(value) ? byId.get(Number(value)) : byName.get(marketKey(value))
}

// ------------------------------------------------------------------ 每一行

interface Draft {
  setting: MarketSetting
  regionId: number | null
  systemId?: number
  locationId?: number
  /** 星系的中英文名（自动别名） */
  autoNames: string[]
}

type Located = { ok: true; draft: Draft } | { ok: false; message: string; field: string }

function locate(m: MarketSetting, data: DataSet, located: ReadonlyMap<string, number>, issues: ConfigIssue[]): Located {
  const { systems, stations, regions } = data.universe
  const places = placesOf(data)
  const fail = (message: string, field = 'location'): Located => ({ ok: false, message, field })
  const withSystem = (system: SystemInfo, extra: Partial<Draft> = {}): Located => ({
    ok: true,
    draft: { setting: m, regionId: system.regionId, systemId: system.id, autoNames: [system.en, system.zh].filter(Boolean), ...extra },
  })

  switch (m.type) {
    case 'npc-station': {
      const station = stations.get(Number(m.location))
      const system = station ? systems.get(station.systemId) : undefined
      if (!station || !system) return fail(`「位置」空间站 ${m.location} 在数据里找不到，已跳过`)
      return withSystem(system, { locationId: station.id })
    }
    case 'system': {
      const system = lookup(m.location, systems, places.systems)
      return system ? withSystem(system) : fail(`「位置」星系「${m.location}」在数据里找不到，已跳过`)
    }
    case 'region': {
      const region = lookup(m.location, regions, places.regions)
      return region
        ? { ok: true, draft: { setting: m, regionId: region.id, autoNames: [] } }
        : fail(`「位置」星域「${m.location}」在数据里找不到，已跳过`)
    }
    case 'structure': {
      const locationId = Number(m.location)
      if (!Number.isSafeInteger(locationId) || locationId <= 0) return fail(`「位置」${m.location} 不是有效的建筑 ID，已跳过`)
      let system = m.system ? lookup(m.system, systems, places.systems) : undefined
      if (m.system && !system) {
        // 不用授权时只能靠星域订单，必须知道星域
        if (!m.authProfile) return fail(`「建筑所在星系」${m.system} 在数据里找不到，已跳过`, 'system')
        issues.push({ section: 'markets', row: m.row, field: 'system', message: `「建筑所在星系」${m.system} 在数据里找不到` })
      }
      const learned = located.get(m.key)
      system ??= learned === undefined ? undefined : systems.get(learned)
      const draft: Draft = { setting: m, regionId: system?.regionId ?? null, locationId, autoNames: [] }
      if (system) draft.systemId = system.id
      return { ok: true, draft }
    }
  }
}

// ------------------------------------------------------------------ 名字和别名

interface Owned {
  hand: string[]
  auto: string[]
}

function usableAutoName(key: string): boolean {
  return !!key && !RESERVED.has(key) && !/^[\d\s.,]+$/.test(key)
}

/** 名称 → 手写别名 → 自动别名，先到先得；自动别名碰上名称或手写别名时不生效 */
function claimNames(drafts: Draft[]): { layers: Array<Map<string, Draft>>; owned: Map<Draft, Owned> } {
  const names = new Map<string, Draft>()
  const hand = new Map<string, Draft>()
  const auto = new Map<string, Draft>()
  const owned = new Map<Draft, Owned>(drafts.map((d) => [d, { hand: [], auto: [] }]))
  const taken = (key: string) => names.has(key) || hand.has(key) || auto.has(key)

  for (const d of drafts) names.set(marketKey(d.setting.name), d)
  for (const d of drafts) {
    for (const alias of d.setting.aliases) {
      const key = marketKey(alias)
      if (!key || taken(key)) continue
      hand.set(key, d)
      owned.get(d)!.hand.push(alias)
    }
  }
  for (const d of drafts) {
    for (const name of d.autoNames) {
      const key = marketKey(name)
      if (!usableAutoName(key) || taken(key)) continue
      auto.set(key, d)
      owned.get(d)!.auto.push(name)
    }
  }

  const compact = (layer: Map<string, Draft>) => {
    const out = new Map<string, Draft>()
    for (const [key, d] of layer) {
      const short = key.replace(/ /g, '')
      if (short !== key && !out.has(short)) out.set(short, d)
    }
    return out
  }
  return { layers: [names, hand, auto, compact(names), compact(hand), compact(auto)], owned }
}

/**
 * 按钮命令里的写法：名称是一个词时就用名称（卡片小标题上就是它）；否则在别名里挑不带空格、有字母的，
 * 按显示宽度取最短，一样宽时手写别名 > 自动别名（英文在前）
 */
function shortAliasOf(name: string, owned: Owned): string {
  if (!/\s/.test(name)) return name
  const candidates = [...owned.hand, ...owned.auto]
    .filter((text) => !/\s/.test(text))
    .map((text, order) => ({ text, order, letter: /\p{L}/u.test(text) ? 0 : 1, width: displayWidth(text) }))
  candidates.sort((a, b) => a.letter - b.letter || a.width - b.width || a.order - b.order)
  return candidates[0]?.text ?? name
}

// ------------------------------------------------------------------ 建表

function findIn(layers: Array<Map<string, MarketDef>>, text: string, accept: (m: MarketDef) => boolean = () => true): MarketDef | undefined {
  const key = marketKey(text)
  if (!key) return undefined
  const short = compactMarketKey(text)
  for (const [i, layer] of layers.entries()) {
    const found = layer.get(i < 3 ? key : short)
    if (found && accept(found)) return found
  }
  return undefined
}

/** 基准市场排在第一个：其他引用认不出时改用它 */
function resolveRefs(settings: Settings, built: Built): void {
  for (const field of REF_FIELDS) {
    const ref = settings.marketRefs[field]
    const fallback = field === 'price.baseMarket' ? built.firstPublic : built.refs['price.baseMarket'] ?? built.firstPublic
    if (!ref.ref) {
      if (ref.whenEmpty === 'base') built.refs[field] = fallback
      continue
    }
    const found = findIn(built.layers, ref.ref)
    if (found) {
      built.refs[field] = found
      continue
    }
    built.refs[field] = fallback
    if (ref.quiet) continue
    const instead = fallback ? `改用 ${fallback.name}` : '也没有可以代替的公开市场'
    built.issues.push({ section: ref.section, field: ref.field, message: `「${ref.label}」写的「${ref.ref}」找不到这个市场，${instead}` })
  }
}

function buildRegistry(settings: Settings, data: DataSet, located: ReadonlyMap<string, number>, key: string): Built {
  const issues: ConfigIssue[] = []
  const drafts: Draft[] = []
  for (const m of settings.markets) {
    const result = locate(m, data, located, issues)
    if (result.ok) drafts.push(result.draft)
    else issues.push({ section: 'markets', row: m.row, field: result.field, message: result.message })
  }

  const { layers: draftLayers, owned } = claimNames(drafts)
  // 先建可变的对象：默认列表要等基准市场认出来以后才知道
  const defs = new Map<Draft, MarketDef>()
  for (const d of drafts) {
    const m = d.setting
    const own = owned.get(d)!
    const def: MarketDef = {
      key: m.key,
      name: m.name,
      aliases: [...own.hand, ...own.auto],
      shortAlias: shortAliasOf(m.name, own),
      type: m.type,
      regionId: d.regionId,
      inDefaultList: m.inDefaultList,
      sortOrder: m.sortOrder,
      visibility: m.visibility,
    }
    if (d.systemId !== undefined) def.systemId = d.systemId
    if (d.locationId !== undefined) def.locationId = d.locationId
    if (m.type === 'structure' && m.authProfile) def.authProfile = m.authProfile
    defs.set(d, def)
  }

  const ordered = [...drafts].sort((a, b) => byDisplayOrder(a.setting, b.setting))
  const list = ordered.map((d) => defs.get(d)!)
  const built: Built = {
    key,
    list,
    byKey: new Map(list.map((m) => [m.key, m])),
    layers: draftLayers.map((layer) => new Map([...layer].map(([k, d]) => [k, defs.get(d)!]))),
    maxWords: 0,
    refs: {},
    firstPublic: drafts.map((d) => defs.get(d)!).find((m) => m.visibility === 'public'),
    issues,
  }
  for (const layer of built.layers.slice(0, 3)) {
    for (const k of layer.keys()) built.maxWords = Math.max(built.maxWords, k.split(' ').length)
  }
  resolveRefs(settings, built)

  // 默认查价选「自动」的行：玩家建筑和基准市场列出；没有基准市场时列第一个公开市场
  const listed = (built.refs['price.baseMarket'] ?? built.firstPublic)?.key
  for (const d of drafts) {
    if (d.setting.autoDefaultList) defs.get(d)!.inDefaultList = d.setting.type === 'structure' || d.setting.key === listed
  }
  for (const def of list) Object.freeze(def)
  return built
}

// ------------------------------------------------------------------ 对外

class Registry implements ManagedMarketRegistry {
  private built: Built | undefined
  private readonly located = new Map<string, number>()
  private revision = 0

  constructor(private readonly settings: Settings, private readonly data: Pick<DataService, 'current'>) {}

  all(): MarketDef[] {
    return [...this.state().list]
  }

  visible(access: Access): MarketDef[] {
    return this.state().list.filter((m) => visibleTo(m, access))
  }

  defaults(access: Access): MarketDef[] {
    const listed = this.visible(access).filter((m) => m.inDefaultList).slice(0, MAX_MARKETS)
    if (listed.length) return listed
    // 配置里什么都没列：至少给一个
    const fallback = this.configured('price.baseMarket', access) ?? this.visible(access)[0]
    return fallback ? [fallback] : []
  }

  match(token: string, access: Access): MarketDef | null {
    return findIn(this.state().layers, token, (m) => visibleTo(m, access)) ?? null
  }

  split(text: string, access: Access, items: ItemResolver, scope: Scope): MarketSplit {
    return splitMarket(text, { match: (phrase) => this.match(phrase, access), maxWords: this.state().maxWords, items, scope })
  }

  get(key: string): MarketDef | undefined {
    return this.state().byKey.get(key)
  }

  base(): MarketDef | undefined {
    return this.state().refs['price.baseMarket']
  }

  configured(field: MarketRefField, access?: Access): MarketDef | undefined {
    const built = this.state()
    const market = built.refs[field]
    if (!market || !access || visibleTo(market, access)) return market
    // 本群看不到：悄悄改用基准市场，再不行用第一个公开市场
    const base = built.refs['price.baseMarket']
    return base && visibleTo(base, access) ? base : built.firstPublic
  }

  issues(): ConfigIssue[] {
    return [...this.state().issues]
  }

  locateStructure(key: string, systemId: number): boolean {
    if (this.located.get(key) === systemId) return false
    this.located.set(key, systemId)
    this.revision++
    return true
  }

  private state(): Built {
    let data: DataSet
    try {
      data = this.data.current()
    } catch (e) {
      if (e instanceof DataNotReadyError) return EMPTY
      throw e
    }
    const key = `${data.key}#${this.revision}`
    if (this.built?.key !== key) this.built = buildRegistry(this.settings, data, this.located, key)
    return this.built
  }
}

export function createMarketRegistry(settings: Settings, data: Pick<DataService, 'current'>): ManagedMarketRegistry {
  return new Registry(settings, data)
}
