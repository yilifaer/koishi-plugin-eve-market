// core/market 测试共用：访问者、配置、假的物品识别、假的 ESI 路由（按 (星域, 物品) 编排回复）。
// 建筑 ID、名字都是编造的；Jita 等 NPC 交易中心是 SDE 里的公共数据。

import { normalizeConfig } from '../../../src/config/normalize'
import { EsiError } from '../../../src/core/esi'
import type { EsiCallOptions, EsiHistoryDay, EsiPagedResult, EsiRegionOrder, EsiResult } from '../../../src/core/esi'
import type { Access, ItemInfo, ItemResolver, Resolution, Scope, Settings } from '../../../src/core/types'

export const JITA = 30000142
export const PERIMETER = 30000144
export const JITA_4_4 = 60003760
/** Jita 里的另一个空间站 */
export const JITA_OTHER_STATION = 60000361
export const PERIMETER_STATION = 60000358
export const THE_FORGE = 10000002
export const DOMAIN = 10000043
export const AMARR_STATION = 60008494
export const RAVEN = 638
export const TRITANIUM = 34
export const PLEX = 44992
export const STRUCTURE_A = 1_000_000_000_001
export const STRUCTURE_B = 1_000_000_000_002

export const PUBLIC: Access = { platform: 'qq', userId: 'u1', channelId: 'g-public', isDirect: false, isAdmin: false, allowed: false }
export const ALLOWED: Access = { ...PUBLIC, channelId: 'g-allowed', allowed: true }

export function settingsOf(raw: Record<string, unknown> = {}): Settings {
  return normalizeConfig(raw).settings
}

/** 预置的五个交易中心 + 两个编造的建筑市场 */
export const STRUCTURE_ROWS = [
  { name: '联盟市场A', aliases: '前线', type: 'structure', location: String(STRUCTURE_A), system: 'NIH-02' },
  { name: '公开建筑', type: 'structure', location: String(STRUCTURE_B), system: 'Perimeter', authProfile: '', visibility: 'public' },
]

// ------------------------------------------------------------------ 物品识别

export function item(typeId: number, en: string, zh = ''): ItemInfo {
  return {
    typeId, en, zh, groupId: 1, categoryId: 1, marketGroupId: 1, metaGroupId: null, techLevel: null,
    volume: 1, packagedVolume: 1, portionSize: 1, capacity: null, variationParent: null,
  }
}

/** 名字（小写）→ 识别结果；不在表里的一律 none。calls 记下所有查询 */
export function fakeItems(table: Record<string, Resolution>) {
  const calls: Array<{ query: string; scope: Scope }> = []
  return {
    calls,
    resolve(query: string, opts: { scope: Scope; limit?: number }): Resolution {
      calls.push({ query, scope: opts.scope })
      return table[query.toLowerCase()] ?? { kind: 'none', suggestions: [] }
    },
  }
}

/** 完整的 ItemResolver：只有 resolve 有用，其他方法这里用不到 */
export function fakeResolver(table: Record<string, Resolution>): ItemResolver {
  const unused = (): never => { throw new Error('这个测试用不到') }
  return {
    resolve: fakeItems(table).resolve,
    resolveRemote: unused,
    resolveLine: unused,
    search: unused,
    byId: () => undefined,
    related: unused,
    aliasesOf: () => [],
    displayName: (i) => i.en,
    commandName: (i) => i.en,
    stats: unused,
  }
}

export const unique = (i: ItemInfo, tier: 'id' | 'exact' | 'alias' | 'prefix' = 'exact'): Resolution => ({ kind: 'unique', item: i, tier })
export const ambiguous = (tier: 'exact' | 'prefix', ...candidates: ItemInfo[]): Resolution => ({ kind: 'ambiguous', tier, candidates, total: candidates.length })
export const confirm = (...candidates: ItemInfo[]): Resolution => ({ kind: 'confirm', tier: 'contains', candidates, total: candidates.length })

// ------------------------------------------------------------------ ESI

let nextOrderId = 6_000_000_000

export function order(o: Partial<EsiRegionOrder> = {}): EsiRegionOrder {
  return {
    orderId: ++nextOrderId,
    typeId: RAVEN,
    locationId: JITA_4_4,
    systemId: JITA,
    isBuyOrder: false,
    price: 250_000_000,
    volumeRemain: 1,
    volumeTotal: 1,
    minVolume: 1,
    range: 'region',
    duration: 90,
    issued: Date.UTC(2026, 9, 1),
    ...o,
  }
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export type OrdersReply =
  | { orders: EsiRegionOrder[]; stale?: boolean; error?: EsiError; lastModified?: number | null; validatedAt?: number; expiresAt?: number }
  | { fail: EsiError }
  | { wait: Deferred<EsiPagedResult<EsiRegionOrder>> }

export const httpError = (status: number, route = 'GET /markets/{region_id}/orders') =>
  new EsiError('http', `HTTP ${status}`, { route, status })

/** 按 (星域, 物品) 编排回复的 regionOrders */
export class FakeOrdersApi {
  readonly calls: Array<{ regionId: number; typeId: number; opts: EsiCallOptions }> = []
  readonly replies = new Map<string, OrdersReply | OrdersReply[]>()

  constructor(private readonly now: () => number) {}

  set(regionId: number, typeId: number, reply: OrdersReply | OrdersReply[]) {
    this.replies.set(`${regionId}:${typeId}`, reply)
    return this
  }

  count(regionId: number, typeId: number) {
    return this.calls.filter((c) => c.regionId === regionId && c.typeId === typeId).length
  }

  async regionOrders(regionId: number, typeId: number, opts: EsiCallOptions = {}): Promise<EsiPagedResult<EsiRegionOrder>> {
    this.calls.push({ regionId, typeId, opts })
    const key = `${regionId}:${typeId}`
    const queued = this.replies.get(key)
    const reply = Array.isArray(queued) ? queued.shift() : queued
    if (!reply) return this.result([])
    if ('fail' in reply) throw reply.fail
    if ('wait' in reply) return reply.wait.promise
    return this.result(reply.orders, reply)
  }

  result(orders: EsiRegionOrder[], o: Partial<Extract<OrdersReply, { orders: EsiRegionOrder[] }>> = {}): EsiPagedResult<EsiRegionOrder> {
    const now = this.now()
    const out: EsiPagedResult<EsiRegionOrder> = {
      value: orders,
      lastModified: o.lastModified === undefined ? now - 60_000 : o.lastModified,
      expiresAt: o.expiresAt ?? now + 300_000,
      validatedAt: o.validatedAt ?? now,
      cached: false,
      stale: !!o.stale,
      pages: 1,
      inconsistent: false,
    }
    if (o.error) out.error = o.error
    return out
  }
}

export function day(date: string, average: number, volume = 10): EsiHistoryDay {
  return { date, average, highest: average * 1.1, lowest: average * 0.9, volume, orderCount: 3 }
}

/** 按 (星域, 物品) 编排回复的 history */
export class FakeHistoryApi {
  readonly calls: Array<{ regionId: number; typeId: number }> = []
  readonly rows = new Map<string, EsiHistoryDay[] | EsiError>()
  stale = false

  constructor(private readonly now: () => number) {}

  set(regionId: number, typeId: number, rows: EsiHistoryDay[] | EsiError) {
    this.rows.set(`${regionId}:${typeId}`, rows)
    return this
  }

  async history(regionId: number, typeId: number): Promise<EsiResult<EsiHistoryDay[]>> {
    this.calls.push({ regionId, typeId })
    const rows = this.rows.get(`${regionId}:${typeId}`)
    if (rows === undefined) throw new EsiError('http', 'HTTP 404: Type not found', { route: 'GET /markets/{region_id}/history', status: 404 })
    if (rows instanceof EsiError) throw rows
    const now = this.now()
    return { value: rows, lastModified: Date.parse(`${rows.at(-1)?.date ?? '2026-10-06'}T11:05:00Z`), expiresAt: now + 3600_000, validatedAt: now, cached: false, stale: this.stale }
  }
}
