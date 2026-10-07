// 命令卡片单测共用：真实的物品识别和市场注册表（tests/fixtures 的小数据集）、固定时钟的金额格式，
// 报价和估价结果的构造函数，以及把卡片渲染成 Markdown / 纯文字。价格数字都是示例值。

import { normalizeConfig } from '../../../src/config/normalize'
import { COMMAND_NAMES } from '../../../src/constants'
import { createPriceFormatter } from '../../../src/core/format'
import { createItemResolver } from '../../../src/core/items'
import { createMarketRegistry } from '../../../src/core/market'
import { createModuleStore } from '../../../src/core/ports'
import type {
  Access, AppraisalResult, AppraisalRow, DisplaySettings, ItemInfo, MarketDef, PriceQuote, Settings,
} from '../../../src/core/types'
import type { Card, CardRenderOptions } from '../../../src/bot/view/card'
import { toQQMarkdown } from '../../../src/bot/view/markdown'
import { toText } from '../../../src/bot/view/text'
import { itemByName, loadFixtureData, staticDataService } from '../../fixtures/data/load'

/** 北京时间 2026-10-07 14:20 */
export const NOW = Date.UTC(2026, 9, 7, 6, 20)
export const MINUTE = 60_000

export const PUBLIC: Access = { platform: 'qq', userId: 'u1', channelId: 'g-public', isDirect: false, isAdmin: false, allowed: false }
export const ALLOWED: Access = { ...PUBLIC, channelId: 'g-allowed', allowed: true }

/** 编造的玩家建筑市场（不用授权，从星域订单里读公开订单） */
export const ALLIANCE_ROW = { name: '联盟市场A', aliases: '前线', type: 'structure', location: '1000000000101', system: 'Jita', authProfile: '' }

export interface TestCore {
  settings: Settings
  data: ReturnType<typeof staticDataService>
  items: ReturnType<typeof createItemResolver>
  markets: ReturnType<typeof createMarketRegistry>
  format: ReturnType<typeof createPriceFormatter>
}

export function testCore(raw: Record<string, unknown> = {}, display: Partial<DisplaySettings> = {}): TestCore {
  const settings = normalizeConfig(raw).settings
  settings.display = { ...settings.display, ...display }
  const data = staticDataService()
  return {
    settings,
    data,
    items: createItemResolver({ data, store: createModuleStore(), aliases: settings.aliases }),
    markets: createMarketRegistry(settings, data),
    format: createPriceFormatter(settings.display, { now: () => NOW }),
  }
}

const fixture = loadFixtureData()

export function item(en: string): ItemInfo {
  return itemByName(fixture, en)
}

export function marketOf(core: TestCore, key: string): MarketDef {
  const market = core.markets.get(key)
  if (!market) throw new Error(`没有市场 ${key}`)
  return market
}

export function quote(marketKey: string, typeId: number, sell: number | null, buy: number | null, extra: Partial<PriceQuote> = {}): PriceQuote {
  const side = (best: number) => ({ best, volumeAtBest: 1, orders: 1, totalVolume: 1 })
  return {
    marketKey,
    typeId,
    sell: sell === null ? null : side(sell),
    buy: buy === null ? null : side(buy),
    mid: sell !== null && buy !== null ? (sell + buy) / 2 : null,
    status: 'ok',
    dataTime: NOW,
    ageSec: 0,
    source: 'region',
    ...extra,
  }
}

export function row(it: ItemInfo, quantity: number, unit: number | null, extra: Partial<AppraisalRow> = {}): AppraisalRow {
  return {
    item: it,
    quantity,
    approx: false,
    lang: 'zh',
    sourceLines: [1],
    unit,
    adjustedUnit: unit,
    total: unit === null ? null : unit * quantity,
    packagedM3: it.packagedVolume * quantity,
    status: 'ok',
    group: 'other',
    ...extra,
  }
}

/** 按 ±pct% 调整以后的一行 */
export function adjusted(r: AppraisalRow, pct: number): AppraisalRow {
  if (r.unit === null) return r
  const unit = r.unit * (1 + pct / 100)
  return { ...r, adjustedUnit: unit, total: unit * r.quantity }
}

/** 一份估价结果；totals 按行算 */
export function appraisal(market: MarketDef, rows: AppraisalRow[], extra: Partial<AppraisalResult> = {}): AppraisalResult {
  const priced = rows.filter((r) => r.total !== null)
  return {
    id: 'K7Q2',
    market,
    side: 'sell',
    modifierPct: 0,
    rows,
    unresolved: [],
    noPrice: [],
    skipped: [],
    truncated: 0,
    totals: {
      market: priced.reduce((s, r) => s + (r.unit ?? 0) * r.quantity, 0),
      adjusted: priced.reduce((s, r) => s + (r.total ?? 0), 0),
      packagedM3: rows.reduce((s, r) => s + r.packagedM3, 0),
      pricedTypes: priced.length,
      units: priced.reduce((s, r) => s + r.quantity, 0),
      missing: rows.length - priced.length,
    },
    freight: [],
    freightMissing: 0,
    mutated: 0,
    dataTime: NOW,
    ...extra,
  }
}

export function renderOptions(overrides: Partial<CardRenderOptions> = {}): CardRenderOptions {
  return { numberStyle: 'code', clickable: 'buttons', cmdInputInLists: false, commandName: (id) => COMMAND_NAMES[id], ...overrides }
}

export const md = (card: Card, options?: Partial<CardRenderOptions>) => toQQMarkdown(card, renderOptions(options)).md
export const text = (card: Card) => toText(card, renderOptions())
export const buttons = (card: Card) => toQQMarkdown(card, renderOptions()).rows.map((r) => r.map((b) => `${b.label}=>${b.text}`))
