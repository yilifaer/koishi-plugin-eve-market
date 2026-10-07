// 用到的 ESI 路由的类型化封装（§7.2）。字段名换成驼峰，时间换成毫秒，range 的跳数换成数字。
// 路径、限流组、默认缓存时间都按 2026-08-18 的规范（待核实），改动集中在这一个文件。

import {
  ADJUSTED_PRICES_CACHE_MIN,
  HISTORY_CACHE_HOURS,
  HISTORY_STALE_HOURS,
  INCURSIONS_CACHE_MIN,
  INCURSIONS_STALE_MIN,
  INDUSTRY_INDICES_CACHE_MIN,
  INDUSTRY_STALE_HOURS,
  REGION_ORDERS_DEFAULT_SEC,
  REGION_ORDERS_STALE_MIN,
  REMOTE_ITEM_CACHE_DAYS,
  STATUS_CACHE_SEC,
  STATUS_STALE_MIN,
  STRUCTURE_INFO_HOURS,
  STRUCTURE_INFO_STALE_DAYS,
  STRUCTURE_SYNC_MIN_INTERVAL_MIN,
} from '../../constants'
import type { EsiAuth, EsiCallOptions, EsiClient, EsiLanguage, EsiPagedResult, EsiResult } from './client'
import { ShapeError, bool, int, intList, list, num, oneOf, optInt, optNum, row, rows, str, time } from './shape'
import type { Row } from './shape'

const MINUTE = 60
const HOUR = 3600
const DAY = 86400

/** POST /universe/names、/universe/ids 一次最多几个 */
export const MAX_NAMES_IDS = 1000
export const MAX_IDS_NAMES = 500

// ------------------------------------------------------------------ 类型

/** 买单射程：数字是跳数 */
export type OrderRange = 'station' | 'solarsystem' | 'region' | number

export interface EsiOrder {
  orderId: number
  typeId: number
  locationId: number
  isBuyOrder: boolean
  price: number
  volumeRemain: number
  volumeTotal: number
  minVolume: number
  range: OrderRange
  /** 天 */
  duration: number
  issued: number
}

export interface EsiRegionOrder extends EsiOrder {
  systemId: number
}

/** 建筑订单没有 system_id */
export type EsiStructureOrder = EsiOrder

export interface EsiHistoryDay {
  /** YYYY-MM-DD */
  date: string
  average: number
  highest: number
  lowest: number
  volume: number
  orderCount: number
}

export interface EsiMarketPrice {
  typeId: number
  adjustedPrice: number | null
  averagePrice: number | null
}

export const INDUSTRY_ACTIVITIES = [
  'copying', 'duplicating', 'invention', 'manufacturing', 'none', 'reaction',
  'researching_material_efficiency', 'researching_technology', 'researching_time_efficiency', 'reverse_engineering',
] as const
export type EsiIndustryActivity = typeof INDUSTRY_ACTIVITIES[number]

export interface EsiIndustrySystem {
  systemId: number
  costIndices: Partial<Record<EsiIndustryActivity, number>>
}

export interface EsiStructureInfo {
  name: string
  ownerId: number
  solarSystemId: number
  typeId: number | null
}

export const NAME_CATEGORIES = [
  'alliance', 'character', 'constellation', 'corporation', 'inventory_type', 'region', 'solar_system', 'station', 'faction',
] as const
export type EsiNameCategory = typeof NAME_CATEGORIES[number]

export interface EsiName {
  id: number
  name: string
  category: EsiNameCategory
}

export interface EsiIdName {
  id: number
  name: string
}

/** POST /universe/ids 的结果；没有命中的分类是空数组 */
export interface EsiIds {
  agents: EsiIdName[]
  alliances: EsiIdName[]
  characters: EsiIdName[]
  constellations: EsiIdName[]
  corporations: EsiIdName[]
  factions: EsiIdName[]
  inventoryTypes: EsiIdName[]
  regions: EsiIdName[]
  stations: EsiIdName[]
  systems: EsiIdName[]
}

export interface EsiType {
  typeId: number
  name: string
  groupId: number
  marketGroupId: number | null
  published: boolean
  volume: number | null
  packagedVolume: number | null
  capacity: number | null
  portionSize: number | null
}

export const INCURSION_STATES = ['established', 'mobilizing', 'withdrawing'] as const

export interface EsiIncursion {
  constellationId: number
  factionId: number
  hasBoss: boolean
  infestedSystems: number[]
  /** 0–1 */
  influence: number
  stagingSystemId: number
  state: typeof INCURSION_STATES[number]
  type: string
}

export interface EsiServerStatus {
  players: number
  serverVersion: string
  startTime: number
  vip: boolean
}

// ------------------------------------------------------------------ 解析

const RANGES = ['station', 'solarsystem', 'region'] as const

function orderRange(r: Row): OrderRange {
  const v = str(r, 'range')
  if ((RANGES as readonly string[]).includes(v)) return v as OrderRange
  if (/^\d{1,3}$/.test(v)) return Number(v)
  throw new ShapeError(`range 是未知的值 ${JSON.stringify(v).slice(0, 20)}`)
}

function order(r: Row): EsiOrder {
  return {
    orderId: int(r, 'order_id'),
    typeId: int(r, 'type_id'),
    locationId: int(r, 'location_id'),
    isBuyOrder: bool(r, 'is_buy_order'),
    price: num(r, 'price'),
    volumeRemain: int(r, 'volume_remain'),
    volumeTotal: int(r, 'volume_total'),
    minVolume: int(r, 'min_volume'),
    range: orderRange(r),
    duration: int(r, 'duration'),
    issued: time(r, 'issued'),
  }
}

export function parseRegionOrders(json: unknown): EsiRegionOrder[] {
  return rows(json, 'orders', (r) => ({ ...order(r), systemId: int(r, 'system_id') }))
}

export function parseStructureOrders(json: unknown): EsiStructureOrder[] {
  return rows(json, 'orders', order)
}

export function parseHistory(json: unknown): EsiHistoryDay[] {
  return rows(json, 'history', (r) => {
    const date = str(r, 'date')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ShapeError('date 应该是 YYYY-MM-DD')
    return {
      date,
      average: num(r, 'average'),
      highest: num(r, 'highest'),
      lowest: num(r, 'lowest'),
      volume: int(r, 'volume'),
      orderCount: int(r, 'order_count'),
    }
  })
}

export function parsePrices(json: unknown): EsiMarketPrice[] {
  return rows(json, 'prices', (r) => ({
    typeId: int(r, 'type_id'),
    adjustedPrice: optNum(r, 'adjusted_price'),
    averagePrice: optNum(r, 'average_price'),
  }))
}

export function parseIndustrySystems(json: unknown): EsiIndustrySystem[] {
  return rows(json, 'systems', (r) => {
    const costIndices: Partial<Record<EsiIndustryActivity, number>> = {}
    for (const [i, item] of list(r.cost_indices, 'cost_indices').entries()) {
      const c = row(item, `cost_indices[${i}]`)
      // 以后新加的活动不认识也不报错，只是不用
      const activity = str(c, 'activity')
      if ((INDUSTRY_ACTIVITIES as readonly string[]).includes(activity)) costIndices[activity as EsiIndustryActivity] = num(c, 'cost_index')
    }
    return { systemId: int(r, 'solar_system_id'), costIndices }
  })
}

export function parseStructureInfo(json: unknown): EsiStructureInfo {
  const r = row(json, 'structure')
  return { name: str(r, 'name'), ownerId: int(r, 'owner_id'), solarSystemId: int(r, 'solar_system_id'), typeId: optInt(r, 'type_id') }
}

export function parseNames(json: unknown): EsiName[] {
  return rows(json, 'names', (r) => ({ id: int(r, 'id'), name: str(r, 'name'), category: oneOf(r, 'category', NAME_CATEGORIES) }))
}

const IDS_KEYS: Array<[keyof EsiIds, string]> = [
  ['agents', 'agents'], ['alliances', 'alliances'], ['characters', 'characters'], ['constellations', 'constellations'],
  ['corporations', 'corporations'], ['factions', 'factions'], ['inventoryTypes', 'inventory_types'], ['regions', 'regions'],
  ['stations', 'stations'], ['systems', 'systems'],
]

export function parseIds(json: unknown): EsiIds {
  const r = row(json, 'ids')
  const out = {} as EsiIds
  for (const [key, field] of IDS_KEYS) {
    out[key] = r[field] === undefined ? [] : rows(r[field], field, (x) => ({ id: int(x, 'id'), name: str(x, 'name') }))
  }
  return out
}

export function parseType(json: unknown): EsiType {
  const r = row(json, 'type')
  return {
    typeId: int(r, 'type_id'),
    name: str(r, 'name'),
    groupId: int(r, 'group_id'),
    marketGroupId: optInt(r, 'market_group_id'),
    published: bool(r, 'published'),
    volume: optNum(r, 'volume'),
    packagedVolume: optNum(r, 'packaged_volume'),
    capacity: optNum(r, 'capacity'),
    portionSize: optInt(r, 'portion_size'),
  }
}

export function parseIncursions(json: unknown): EsiIncursion[] {
  return rows(json, 'incursions', (r) => ({
    constellationId: int(r, 'constellation_id'),
    factionId: int(r, 'faction_id'),
    hasBoss: bool(r, 'has_boss'),
    infestedSystems: intList(r, 'infested_solar_systems'),
    influence: num(r, 'influence'),
    stagingSystemId: int(r, 'staging_solar_system_id'),
    state: oneOf(r, 'state', INCURSION_STATES),
    type: str(r, 'type'),
  }))
}

export function parseServerStatus(json: unknown): EsiServerStatus {
  const r = row(json, 'status')
  return { players: int(r, 'players'), serverVersion: str(r, 'server_version'), startTime: time(r, 'start_time'), vip: bool(r, 'vip', false) }
}

export function parseStructureSearch(json: unknown): number[] {
  const r = row(json, 'search')
  return r.structure === undefined ? [] : intList(r, 'structure')
}

// ------------------------------------------------------------------ 路由

/** 调用方没写 staleIfErrorMs 时用路由的默认值（§9.1 的「出错时最多用多旧」） */
function withStale(opts: EsiCallOptions, ms: number): EsiCallOptions {
  return opts.staleIfErrorMs === undefined ? { ...opts, staleIfErrorMs: ms } : opts
}

function positiveId(id: number, what: string) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError(`${what} 应该是正整数：${id}`)
}

export type AuthedOptions = EsiCallOptions & { auth: EsiAuth }

export class EsiApi {
  constructor(readonly client: EsiClient) {}

  /** 星域订单（买卖都要），按物品过滤，取全部页。限流组 market-order */
  regionOrders(regionId: number, typeId: number, opts: EsiCallOptions = {}): Promise<EsiPagedResult<EsiRegionOrder>> {
    positiveId(regionId, 'regionId')
    positiveId(typeId, 'typeId')
    return this.client.pages({
      route: 'GET /markets/{region_id}/orders',
      path: `/markets/${regionId}/orders`,
      query: { order_type: 'all', type_id: typeId },
      group: 'market-order',
      ttlSec: REGION_ORDERS_DEFAULT_SEC,
      parse: parseRegionOrders,
    }, withStale(opts, REGION_ORDERS_STALE_MIN * MINUTE * 1000))
  }

  /** 建筑市场的全部订单（要授权）。建筑同步自己管旧数据，这里不默认用旧缓存 */
  structureOrders(structureId: number, opts: AuthedOptions): Promise<EsiPagedResult<EsiStructureOrder>> {
    positiveId(structureId, 'structureId')
    return this.client.pages({
      route: 'GET /markets/structures/{structure_id}',
      path: `/markets/structures/${structureId}`,
      ttlSec: STRUCTURE_SYNC_MIN_INTERVAL_MIN * MINUTE,
      parse: parseStructureOrders,
    }, opts)
  }

  history(regionId: number, typeId: number, opts: EsiCallOptions = {}): Promise<EsiResult<EsiHistoryDay[]>> {
    positiveId(regionId, 'regionId')
    positiveId(typeId, 'typeId')
    return this.client.request({
      route: 'GET /markets/{region_id}/history',
      path: `/markets/${regionId}/history`,
      query: { type_id: typeId },
      ttlSec: HISTORY_CACHE_HOURS * HOUR,
      parse: parseHistory,
    }, withStale(opts, HISTORY_STALE_HOURS * HOUR * 1000))
  }

  /** 调整价（EIV） */
  prices(opts: EsiCallOptions = {}): Promise<EsiResult<EsiMarketPrice[]>> {
    return this.client.request({
      route: 'GET /markets/prices',
      path: '/markets/prices',
      ttlSec: ADJUSTED_PRICES_CACHE_MIN * MINUTE,
      parse: parsePrices,
    }, withStale(opts, INDUSTRY_STALE_HOURS * HOUR * 1000))
  }

  /** 系统指数。限流组 industry */
  industrySystems(opts: EsiCallOptions = {}): Promise<EsiResult<EsiIndustrySystem[]>> {
    return this.client.request({
      route: 'GET /industry/systems',
      path: '/industry/systems',
      group: 'industry',
      ttlSec: INDUSTRY_INDICES_CACHE_MIN * MINUTE,
      parse: parseIndustrySystems,
    }, withStale(opts, INDUSTRY_STALE_HOURS * HOUR * 1000))
  }

  /** 建筑名和所在星系（要授权） */
  structure(structureId: number, opts: AuthedOptions): Promise<EsiResult<EsiStructureInfo>> {
    positiveId(structureId, 'structureId')
    return this.client.request({
      route: 'GET /universe/structures/{structure_id}',
      path: `/universe/structures/${structureId}`,
      ttlSec: STRUCTURE_INFO_HOURS * HOUR,
      parse: parseStructureInfo,
    }, withStale(opts, STRUCTURE_INFO_STALE_DAYS * DAY * 1000))
  }

  /** 管理页按名字找建筑 ID（要授权，路由和权限名待核实） */
  searchStructures(characterId: number, search: string, opts: AuthedOptions): Promise<EsiResult<number[]>> {
    positiveId(characterId, 'characterId')
    return this.client.request({
      route: 'GET /characters/{character_id}/search',
      path: `/characters/${characterId}/search`,
      query: { categories: 'structure', search },
      ttlSec: 0,
      parse: parseStructureSearch,
    }, opts)
  }

  /** ID → 名字和分类（去重、排序后请求，最多 1000 个） */
  names(ids: readonly number[], opts: EsiCallOptions = {}): Promise<EsiResult<EsiName[]>> {
    const body = [...new Set(ids)].sort((a, b) => a - b)
    body.forEach((id) => positiveId(id, 'id'))
    if (!body.length || body.length > MAX_NAMES_IDS) throw new RangeError(`names：ID 个数要在 1–${MAX_NAMES_IDS} 之间`)
    return this.client.request({
      method: 'POST',
      route: 'POST /universe/names',
      path: '/universe/names',
      body,
      ttlSec: REMOTE_ITEM_CACHE_DAYS * DAY,
      parse: parseNames,
    }, opts)
  }

  /** 名字 → ID（精确匹配；language 决定按哪种语言的名字找，最多 500 个） */
  ids(names: readonly string[], language: EsiLanguage, opts: EsiCallOptions = {}): Promise<EsiResult<EsiIds>> {
    const body = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
    if (!body.length || body.length > MAX_IDS_NAMES) throw new RangeError(`ids：名字个数要在 1–${MAX_IDS_NAMES} 之间`)
    return this.client.request({
      method: 'POST',
      route: 'POST /universe/ids',
      path: '/universe/ids',
      body,
      language,
      ttlSec: REMOTE_ITEM_CACHE_DAYS * DAY,
      parse: parseIds,
    }, opts)
  }

  /** 物品信息；不存在的 typeID 是 HTTP 404 */
  type(typeId: number, opts: EsiCallOptions & { language?: EsiLanguage } = {}): Promise<EsiResult<EsiType>> {
    positiveId(typeId, 'typeId')
    const { language, ...rest } = opts
    return this.client.request({
      route: 'GET /universe/types/{type_id}',
      path: `/universe/types/${typeId}`,
      ttlSec: REMOTE_ITEM_CACHE_DAYS * DAY,
      ...(language ? { language } : {}),
      parse: parseType,
    }, rest)
  }

  /** 限流组 incursion */
  incursions(opts: EsiCallOptions = {}): Promise<EsiResult<EsiIncursion[]>> {
    return this.client.request({
      route: 'GET /incursions',
      path: '/incursions',
      group: 'incursion',
      ttlSec: INCURSIONS_CACHE_MIN * MINUTE,
      parse: parseIncursions,
    }, withStale(opts, INCURSIONS_STALE_MIN * MINUTE * 1000))
  }

  /** 服务器状态。限流组 status */
  serverStatus(opts: EsiCallOptions = {}): Promise<EsiResult<EsiServerStatus>> {
    return this.client.request({
      route: 'GET /status',
      path: '/status',
      group: 'status',
      ttlSec: STATUS_CACHE_SEC,
      parse: parseServerStatus,
    }, withStale(opts, STATUS_STALE_MIN * MINUTE * 1000))
  }
}

