// IndustryService 测试共用：假的报价服务、假的系统指数和调整价、把真的识别器、市场注册表、工业地点接在一起。
// 价格、指数都是编造的；地点名、建筑名也是编造的（XX-1、联盟工业点A），星系用公共星系。

import { normalizeConfig } from '../../../src/config/normalize'
import { createIndustryArgs } from '../../../src/core/parse'
import { createIndustryLocations, createIndustryService } from '../../../src/core/industry'
import type { AdjustedPrices, IndustryIndices, SystemIndices } from '../../../src/core/industry'
import { createMarketRegistry } from '../../../src/core/market'
import type {
  Access, CoreFailure, DataSet, IndustryActivity, MarketAvailability, MarketService, PriceQuote, TypeId,
} from '../../../src/core/types'
import { loadFixtureData, loadFixtureGlossary, staticDataService } from '../../fixtures/data/load'
import { MemoryLogger, realScheduler } from '../esi/helpers'
import { fixtureResolver } from '../items/helpers'

export const PUBLIC: Access = { platform: 'qq', userId: 'u1', channelId: 'g-public', isDirect: false, isAdmin: false, allowed: false }
export const ALLOWED: Access = { ...PUBLIC, channelId: 'g-allowed', allowed: true }

export const JITA_KEY = 'jita 4-4'
export const AMARR_KEY = 'amarr'
/** 报价的数据时间（固定，结果可以直接比较） */
export const QUOTE_TIME = Date.UTC(2026, 9, 7, 6, 20)
export const INDICES_TIME = Date.UTC(2026, 9, 7, 5, 0)

export interface FakeBookEntry { sell?: number; buy?: number; dataTime?: number }

/** 按（市场, 物品）给报价；没给的物品是「没有挂单」 */
export class FakePrices implements Pick<MarketService, 'getQuotes' | 'available' | 'touch'> {
  readonly books = new Map<string, Map<TypeId, FakeBookEntry>>()
  readonly status = new Map<string, MarketAvailability>()
  readonly calls: Array<{ market: string; typeIds: TypeId[] }> = []
  readonly touched: string[] = []

  set(market: string, prices: Record<number, number | FakeBookEntry>): this {
    const book = this.books.get(market) ?? new Map<TypeId, FakeBookEntry>()
    for (const [id, p] of Object.entries(prices)) book.set(Number(id), typeof p === 'number' ? { sell: p } : p)
    this.books.set(market, book)
    return this
  }

  async getQuotes(marketKey: string, items: Array<{ typeId: TypeId; qty: number }>): Promise<Map<TypeId, PriceQuote>> {
    this.calls.push({ market: marketKey, typeIds: items.map((i) => i.typeId) })
    const book = this.books.get(marketKey) ?? new Map<TypeId, FakeBookEntry>()
    return new Map(items.map(({ typeId }) => [typeId, quoteOf(marketKey, typeId, book.get(typeId))]))
  }

  available(marketKey: string): MarketAvailability {
    return this.status.get(marketKey) ?? { status: 'ok' }
  }

  async touch(marketKey: string): Promise<void> {
    this.touched.push(marketKey)
  }
}

function side(best: number | undefined) {
  return best === undefined ? null : { best, volumeAtBest: 10, orders: 1, totalVolume: 10 }
}

function quoteOf(marketKey: string, typeId: TypeId, entry: FakeBookEntry | undefined): PriceQuote {
  const sell = side(entry?.sell)
  const buy = side(entry?.buy)
  return {
    marketKey, typeId, sell, buy, mid: sell && buy ? (sell.best + buy.best) / 2 : null, status: 'ok',
    dataTime: entry?.dataTime ?? QUOTE_TIME, ageSec: 60, source: 'region',
  }
}

export interface FakeIndicesSetup {
  /** 星系 → 活动 → 指数；CoreFailure = 取不到 */
  systems?: Record<number, Partial<Record<IndustryActivity, number>>> | CoreFailure
  /** typeID → 调整价；CoreFailure = 取不到 */
  adjusted?: Record<number, number> | CoreFailure
  /** 用的是更新失败前的旧数据 */
  stale?: { indices?: boolean; adjusted?: boolean }
}

export class FakeIndices implements Pick<IndustryIndices, 'systemIndices' | 'adjustedPrices'> {
  systemCalls = 0
  adjustedCalls = 0
  constructor(public setup: FakeIndicesSetup = {}) {}

  async systemIndices(): Promise<SystemIndices | CoreFailure> {
    this.systemCalls++
    const s = this.setup.systems ?? {}
    if ('ok' in s && s.ok === false) return s as CoreFailure
    const bySystem = new Map(Object.entries(s).map(([id, v]) => [Number(id), v as Partial<Record<IndustryActivity, number>>]))
    return { bySystem, dataTime: INDICES_TIME, stale: !!this.setup.stale?.indices }
  }

  async adjustedPrices(): Promise<AdjustedPrices | CoreFailure> {
    this.adjustedCalls++
    const a = this.setup.adjusted ?? {}
    if ('ok' in a && a.ok === false) return a as CoreFailure
    const byType = new Map(Object.entries(a).map(([id, v]) => [Number(id), v as number]))
    return { byType, dataTime: INDICES_TIME, stale: !!this.setup.stale?.adjusted }
  }
}

export const UNAVAILABLE: CoreFailure = { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: '测试：取不到' }

export interface ServiceSetup {
  data?: DataSet
  prices?: FakePrices
  indices?: FakeIndices
}

/** raw 是控制台配置（只写要用到的分组） */
export function makeService(raw: Record<string, unknown>, setup: ServiceSetup = {}) {
  const { settings, issues } = normalizeConfig(raw)
  const dataSet = setup.data ?? loadFixtureData()
  const data = staticDataService(dataSet, setup.data ? null : loadFixtureGlossary())
  const items = fixtureResolver({ data: dataSet, glossary: setup.data ? null : undefined, aliases: settings.aliases })
  const markets = createMarketRegistry(settings, data)
  const locations = createIndustryLocations(settings.industry, data)
  const prices = setup.prices ?? new FakePrices()
  const indices = setup.indices ?? new FakeIndices()
  const logger = new MemoryLogger()
  const service = createIndustryService({
    data, items, markets, prices, locations, indices, settings: settings.industry,
    clock: { now: () => Date.now() }, scheduler: realScheduler, logger,
  })
  const parse = createIndustryArgs({ items, locations })
  return { settings, issues, data, items, markets, locations, prices, indices, logger, service, parse }
}
