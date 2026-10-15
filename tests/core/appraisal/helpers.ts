// core/appraisal 测试共用：一小份物品（SDE 里的公共数据）、假的物品识别、假的市场注册表、假的报价服务。
// 联盟市场的名字和建筑 ID 都是编造的。

import { createAppraisalService } from '../../../src/core/appraisal'
import type { LoadedChargeMode } from '../../../src/core/appraisal'
import { createModuleStore } from '../../../src/core/ports'
import type { ModuleStore } from '../../../src/core/ports'
import type {
  Access, AppraisalResult, CoreFailure, FreightRoute, ItemInfo, ItemResolver, MarketAvailability, MarketDef, MarketRefField,
  MarketRegistry, MarketService, PriceQuote, PriceSide, QuoteReason, QuoteStatus, TypeId,
} from '../../../src/core/types'
import { isFailure } from '../../../src/core/types'
import { FakeTime } from '../../fakes/fake-time'

export const PUBLIC: Access = { platform: 'qq', userId: 'u1', channelId: 'g-public', isDirect: false, isAdmin: false, allowed: false }
export const ALLOWED: Access = { ...PUBLIC, channelId: 'g-allowed', allowed: true }

// ------------------------------------------------------------------ 物品

interface ItemSpec {
  id: TypeId
  en: string
  zh: string
  category: number
  volume: number
  packaged?: number
  capacity?: number
  market?: boolean
}

const SPECS: ItemSpec[] = [
  { id: 638, en: 'Raven', zh: '乌鸦级', category: 6, volume: 470000, packaged: 50000, capacity: 830 },
  { id: 17636, en: 'Raven Navy Issue', zh: '乌鸦级海军型', category: 6, volume: 470000, packaged: 50000, capacity: 800 },
  { id: 34, en: 'Tritanium', zh: '三钛合金', category: 4, volume: 0.01 },
  { id: 35, en: 'Pyerite', zh: '类晶体胶矿', category: 4, volume: 0.01 },
  { id: 19739, en: 'Cruise Missile Launcher II', zh: '巡航导弹发射器 II', category: 7, volume: 20, capacity: 1.35 },
  { id: 203, en: 'Scourge Cruise Missile', zh: '鞭挞巡航导弹', category: 8, volume: 0.05 },
  { id: 204, en: 'Inferno Cruise Missile', zh: '炼狱巡航导弹', category: 8, volume: 0.05 },
  { id: 2456, en: 'Hobgoblin II', zh: '地精灵 II', category: 18, volume: 5 },
  { id: 22291, en: 'Ballistic Control System II', zh: '弹道控制系统 II', category: 7, volume: 5 },
  { id: 3841, en: 'Large Shield Extender II', zh: '大型护盾扩展装置 II', category: 7, volume: 20 },
  { id: 3839, en: 'Large Shield Extender I', zh: '大型护盾扩充器I', category: 7, volume: 20 },
  { id: 2281, en: 'Multispectrum Shield Hardener II', zh: '多谱式护盾增强器 II', category: 7, volume: 5 },
  { id: 4405, en: 'Drone Damage Amplifier II', zh: '无人机伤害增效装置 II', category: 7, volume: 5 },
  { id: 2048, en: 'Damage Control II', zh: '损伤控制 II', category: 7, volume: 5 },
  { id: 28668, en: 'Nanite Repair Paste', zh: '纳米体修复粘合剂', category: 8, volume: 0.01 },
  { id: 33475, en: 'Mobile Tractor Unit', zh: '移动式牵引装置', category: 22, volume: 100, capacity: 27000 },
  { id: 47911, en: 'Entropic Radiation Sink II', zh: '熵辐射槽 II', category: 7, volume: 5 },
  { id: 2024, en: 'Medium Capacitor Booster II', zh: '中型电容注电器 II', category: 7, volume: 10, capacity: 40 },
  { id: 32014, en: 'Navy Cap Booster 800', zh: '海军电容注电器装料 800', category: 8, volume: 24 },
  { id: 688, en: 'Raven Blueprint', zh: '乌鸦级蓝图', category: 9, volume: 0.01, market: false },
]

function toItem(s: ItemSpec): ItemInfo {
  return {
    typeId: s.id, en: s.en, zh: s.zh, groupId: s.category * 100, categoryId: s.category,
    marketGroupId: s.market === false ? null : 1, metaGroupId: null, techLevel: null,
    volume: s.volume, packagedVolume: s.packaged ?? s.volume, portionSize: 1, capacity: s.capacity ?? null, variationParent: null,
  }
}

export const ITEMS: ReadonlyMap<TypeId, ItemInfo> = new Map(SPECS.map((s) => [s.id, toItem(s)]))

export function item(id: TypeId): ItemInfo {
  const found = ITEMS.get(id)
  if (!found) throw new Error(`测试数据里没有 ${id}`)
  return found
}

export const RAVEN = 638
export const RAVEN_NAVY = 17636
export const TRITANIUM = 34
export const PYERITE = 35
export const CML2 = 19739
export const SCOURGE_CRUISE = 203
export const HOBGOBLIN2 = 2456
export const LSE2 = 3841
export const NANITE = 28668
export const MTU = 33475
export const DC2 = 2048

const key = (name: string) => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

const NAMES: Array<{ key: string; item: ItemInfo }> = [...ITEMS.values()]
  .filter((i) => i.marketGroupId !== null)
  .flatMap((i) => [{ key: key(i.en), item: i }, { key: key(i.zh), item: i }])

type LineResult = ReturnType<ItemResolver['resolveLine']>

/** 精确名 → 认出；唯一前缀 → 认出并带 ≈；其余认不出，包含查询的物品作为候选 */
export function resolveLine(name: string): LineResult {
  const k = key(name)
  const exact = NAMES.find((n) => n.key === k)
  if (exact) return { item: exact.item, approx: false }
  const prefix = new Set(NAMES.filter((n) => k && n.key.startsWith(k)).map((n) => n.item))
  if (prefix.size === 1) return { item: [...prefix][0], approx: true }
  const words = k.split(' ').filter((w) => w.length > 2)
  const near = [...new Set(NAMES.filter((n) => words.some((w) => n.key.includes(w))).map((n) => n.item))]
  return near.length ? { unresolved: true, suggestion: near[0], candidates: near.slice(0, 5), total: near.length } : { unresolved: true, total: 0 }
}

export interface FakeItems extends Pick<ItemResolver, 'resolveLine' | 'byId'> {
  /** 模拟数据还没加载好 */
  broken?: Error
}

export function fakeItems(): FakeItems {
  const items: FakeItems = {
    resolveLine(name) {
      if (items.broken) throw items.broken
      return resolveLine(name)
    },
    byId(id) {
      if (items.broken) throw items.broken
      return ITEMS.get(id)
    },
  }
  return items
}

// ------------------------------------------------------------------ 市场

function market(key: string, name: string, extra: Partial<MarketDef> = {}): MarketDef {
  return {
    key, name, aliases: [], shortAlias: name.split(' ')[0], type: 'npc-station', regionId: 10000002, inDefaultList: true,
    sortOrder: 0, visibility: 'public', ...extra,
  }
}

export const JITA = market('jita 4-4', 'Jita 4-4', { aliases: ['Jita', '吉他'], systemId: 30000142, locationId: 60003760 })
export const AMARR = market('amarr', 'Amarr', { regionId: 10000043, locationId: 60008494, inDefaultList: false, sortOrder: 1 })
export const DODIXIE = market('dodixie', 'Dodixie', { regionId: 10000032, locationId: 60011866, inDefaultList: false, sortOrder: 2 })
/** 编造的联盟建筑市场：只在授权群可见 */
export const ALLIANCE = market('联盟市场a', '联盟市场A', {
  aliases: ['前线'], shortAlias: '联盟市场A', type: 'structure', regionId: null, locationId: 1_000_000_000_001, visibility: 'allowed',
  authProfile: 'default', sortOrder: 3,
})

export interface RegistryOptions {
  base?: MarketDef | null
  defaultMarket?: MarketDef
  fallback?: MarketDef
}

export function fakeRegistry(opts: RegistryOptions = {}): Pick<MarketRegistry, 'match' | 'visible' | 'get' | 'base' | 'configured'> {
  const all = [JITA, AMARR, DODIXIE, ALLIANCE]
  const base = opts.base === null ? undefined : opts.base ?? JITA
  const refs: Partial<Record<MarketRefField, MarketDef>> = {
    'price.baseMarket': base,
    'appraisal.defaultMarket': opts.defaultMarket ?? base,
    'appraisal.fallbackMarket': opts.fallback,
  }
  const visible = (m: MarketDef, access: Access) => m.visibility === 'public' || access.allowed
  return {
    visible: (access) => all.filter((m) => visible(m, access)),
    match: (token, access) => all.find((m) => visible(m, access) && [m.name, ...m.aliases].some((n) => key(n) === key(token))) ?? null,
    get: (k) => all.find((m) => m.key === k),
    base: () => base,
    configured(field, access) {
      const found = refs[field]
      if (!found || !access || visible(found, access)) return found
      return base
    },
  }
}

// ------------------------------------------------------------------ 报价

export interface QuoteSpec {
  sell?: number
  buy?: number
  status?: QuoteStatus
  reason?: QuoteReason
  /** 多少毫秒以后才拿到 */
  delay?: number
  dataTime?: number
}

export interface QuoteCall {
  marketKey: string
  items: Array<{ typeId: TypeId; qty: number }>
  deadlineMs: number | undefined
  lane: 'interactive' | 'background'
  at: number
}

function side(best: number | undefined) {
  return best === undefined ? null : { best, volumeAtBest: 10, orders: 1, totalVolume: 10, volumeNear: 10 }
}

/** 按 (市场, 物品) 编排报价；没写的物品 = 市场正常、没有挂单。按时限返回，赶不上的物品标超时 */
export class FakePrices implements Pick<MarketService, 'getQuotes' | 'available' | 'touch'> {
  readonly book = new Map<string, Map<TypeId, QuoteSpec>>()
  readonly availability = new Map<string, MarketAvailability>()
  readonly calls: QuoteCall[] = []
  readonly touches: Array<{ marketKey: string; waitMs: number | undefined }> = []
  /** 整批出错 */
  readonly failing = new Set<string>()

  constructor(private readonly time: FakeTime) {}

  set(marketKey: string, typeId: TypeId, spec: QuoteSpec): this {
    let market = this.book.get(marketKey)
    if (!market) this.book.set(marketKey, market = new Map())
    market.set(typeId, spec)
    return this
  }

  quote(marketKey: string, typeId: TypeId, spec: QuoteSpec | undefined, timedOut: boolean): PriceQuote {
    const head = { marketKey, typeId, source: 'region' as const, ageSec: 0 }
    if (timedOut) return { ...head, sell: null, buy: null, mid: null, status: 'timeout', dataTime: null }
    const sell = side(spec?.sell)
    const buy = side(spec?.buy)
    const quote: PriceQuote = {
      ...head, sell, buy, mid: sell && buy ? (sell.best + buy.best) / 2 : null, status: spec?.status ?? 'ok', dataTime: spec?.dataTime ?? this.time.now(),
    }
    if (spec?.reason) quote.reason = spec.reason
    return quote
  }

  async getQuotes(marketKey: string, items: Array<{ typeId: TypeId; qty: number }>, opts: { deadlineMs?: number; lane?: 'interactive' | 'background' } = {}): Promise<Map<TypeId, PriceQuote>> {
    this.calls.push({ marketKey, items, deadlineMs: opts.deadlineMs, lane: opts.lane ?? 'interactive', at: this.time.now() })
    if (this.failing.has(marketKey)) throw new Error(`${marketKey} 出错了`)
    const deadline = opts.deadlineMs ?? 12_000
    const specs = items.map(({ typeId }) => [typeId, this.book.get(marketKey)?.get(typeId)] as const)
    const slowest = Math.max(0, ...specs.map(([, spec]) => spec?.delay ?? 0))
    const wait = Math.min(slowest, deadline)
    if (wait > 0) await new Promise<void>((resolve) => this.time.timeout(resolve, wait))
    return new Map(specs.map(([typeId, spec]) => [typeId, this.quote(marketKey, typeId, spec, (spec?.delay ?? 0) > deadline)]))
  }

  available(marketKey: string): MarketAvailability {
    return this.availability.get(marketKey) ?? { status: 'ok' }
  }

  async touch(marketKey: string, waitMs?: number): Promise<void> {
    this.touches.push({ marketKey, waitMs })
  }

  /** 某个市场被请求过的物品 */
  requested(marketKey: string): TypeId[] {
    return this.calls.filter((c) => c.marketKey === marketKey).flatMap((c) => c.items.map((i) => i.typeId))
  }
}

// ------------------------------------------------------------------ 组装

export interface SetupOptions {
  registry?: RegistryOptions
  routes?: FreightRoute[]
  defaultSide?: PriceSide
  loadedCharges?: LoadedChargeMode
  store?: ModuleStore
  time?: FakeTime
  random?: () => number
}

export function setup(opts: SetupOptions = {}) {
  const time = opts.time ?? new FakeTime()
  const store = opts.store ?? createModuleStore()
  const prices = new FakePrices(time)
  const items = fakeItems()
  const warnings: string[] = []
  const logger = { debug() {}, info() {}, warn: (...a: unknown[]) => warnings.push(a.join(' ')), error() {} }
  const service = createAppraisalService({
    items,
    markets: fakeRegistry(opts.registry),
    prices,
    settings: { appraisal: { defaultPriceType: opts.defaultSide ?? 'sell' }, freight: { routes: opts.routes ?? [] } },
    store,
    clock: time,
    scheduler: time,
    logger,
    random: opts.random ?? (() => 0.5),
    loadedCharges: opts.loadedCharges,
  })
  return { service, prices, items, time, store, warnings }
}

export function route(name: string, extra: Partial<FreightRoute> = {}): FreightRoute {
  return { row: 1, name, iskPerM3: 0, collateralPct: 0, maxVolume: 0, visibility: 'allowed', ...extra }
}

export function ok(result: AppraisalResult | CoreFailure): AppraisalResult {
  if (isFailure(result)) throw new Error(`unexpected failure: ${result.code} ${result.message ?? ''}`)
  return result
}

export function failure(result: AppraisalResult | CoreFailure): CoreFailure {
  if (!isFailure(result)) throw new Error('expected a failure')
  return result
}

/** 每一行：[英文名, 数量, 总价] */
export function summary(result: AppraisalResult): Array<[string, number, number | null]> {
  return result.rows.map((r) => [r.item.en, r.quantity, r.total])
}
