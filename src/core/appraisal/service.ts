// AppraisalService（§2.3、§6.5、§6.6）：批量查价和装配估价。
// 识别每一行 → 存成估价编号 → 定市场（本群看不到 = 未知市场）→ 整个市场不能用就停（不自动换市场）
// → 主市场报价（整份 BATCH_DEADLINE_MS）先排上，基准市场报价走后台通道（不占交互请求的位置，只等 BASE_COMPARE_WAIT_MS）
// → 没挂单的物品改用回退市场（明确标出）→ 合计、打包体积、运费、和基准比较。
// 没赶上时限的物品不计入合计；请求在后台做完写进缓存，重发一次通常就齐了。

import {
  BASE_COMPARE_WAIT_MS, BATCH_DEADLINE_MS, DEADLINE_GUARD_MS, EFT_LOADED_CHARGES, MAX_MODIFIER_PCT, QUERY_DEADLINE_MS,
} from '../../constants'
import { DataNotReadyError } from '../data'
import type { EsiLane } from '../esi'
import { parsePaste } from '../parse'
import type { Clock, Logger, ModuleStore, Scheduler } from '../ports'
import type {
  Access, AppraisalResult, AppraisalService, AppraiseOptions, CoreFailure, ItemInfo, ItemResolver, MarketAvailability,
  MarketDef, MarketRegistry, MarketService, PasteParse, PriceQuote, PriceSide, Settings, TypeId,
} from '../types'
import { describeError, withDeadline } from '../util'
import type { Random } from '../util'
import { freightFor, visibleRoutes } from './freight'
import { readList, replaceLines } from './lines'
import type { Entry, ItemList, LoadedChargeMode } from './lines'
import { collateralOf, compareWithBase, draftRows, outcomeOf, priceRows } from './pricing'
import type { Drafted, Priced, QuoteBatch, RowDraft } from './pricing'
import { SavedAppraisals } from './saved'
import type { SavedAppraisal } from './saved'

export interface AppraisalServiceOptions {
  items: Pick<ItemResolver, 'resolveLine' | 'byId'>
  markets: Pick<MarketRegistry, 'match' | 'visible' | 'get' | 'base' | 'configured'>
  prices: Pick<MarketService, 'getQuotes' | 'available' | 'touch'>
  settings: Pick<Settings, 'appraisal' | 'freight'>
  store: ModuleStore
  clock: Clock
  scheduler: Scheduler
  logger?: Logger
  /** 估价编号用；默认 Math.random */
  random?: Random
  /** 装填的弹药怎么算；默认 EFT_LOADED_CHARGES */
  loadedCharges?: LoadedChargeMode
}

/** 这一次明确写了的参数（命令、表头、按钮里）；没写的用这份估价上一次的，再没有用配置 */
interface Request {
  market?: string
  side?: PriceSide
  modifierPct?: number
}

interface Pricing {
  id: string
  list: ItemList
  market: MarketDef
  side: PriceSide
  modifierPct: number
  access: Access
  deadlineAt: number
}

type Settled<T> = { kind: 'done'; value: T } | { kind: 'late' } | { kind: 'error' }

type MarketPick =
  | { kind: 'ok'; market: MarketDef }
  | { kind: 'unknown'; token: string }
  | { kind: 'none' }

function usable(availability: MarketAvailability): boolean {
  return availability.status === 'ok' || availability.status === 'stale'
}

function dataFailure(error: unknown): CoreFailure {
  if (error instanceof DataNotReadyError) return { ok: false, code: 'DATA_NOT_READY', message: error.message }
  throw error
}

/** 装填的弹药：同一种弹药、每个模块装一样多的合成一项 */
function loadedChargesOf(resolved: Drafted['resolved']): NonNullable<AppraisalResult['fitting']>['loadedCharges'] {
  const out = new Map<string, { charge: ItemInfo; modules: number; perModule: number }>()
  for (const { entry, item } of resolved) {
    if (entry.role !== 'charge') continue
    const key = `${item.typeId}:${entry.quantity}`
    const found = out.get(key)
    if (found) found.modules++
    else out.set(key, { charge: item, modules: 1, perModule: entry.quantity })
  }
  return out.size ? [...out.values()] : undefined
}

/** 第一个认出船体的装配；一段粘贴里有几个装配时合在一起估价 */
function fittingOf(list: ItemList, resolved: Drafted['resolved']): AppraisalResult['fitting'] {
  if (list.format !== 'eft') return undefined
  const hull = resolved.find(({ entry }) => entry.role === 'hull')
  if (!hull) return undefined
  const fitting: NonNullable<AppraisalResult['fitting']> = { ship: hull.item, name: list.fittings[hull.entry.fitting ?? 0]?.name ?? '' }
  const loaded = loadedChargesOf(resolved)
  if (loaded) fitting.loadedCharges = loaded
  return fitting
}

function mutatedCount(resolved: Drafted['resolved']): number {
  return resolved.reduce((sum, { entry }) => sum + (entry.mutated ? entry.quantity : 0), 0)
}

class Service implements AppraisalService {
  private readonly saved: SavedAppraisals
  private readonly mode: LoadedChargeMode

  constructor(private readonly o: AppraisalServiceOptions) {
    this.saved = new SavedAppraisals(o.store, o.clock, o.random ?? Math.random)
    this.mode = o.loadedCharges ?? EFT_LOADED_CHARGES
  }

  parse(text: string, access: Access): PasteParse | CoreFailure {
    return parsePaste(text, { matchMarket: (phrase) => this.o.markets.match(phrase, access)?.key ?? null })
  }

  async appraise(input: PasteParse, opts: AppraiseOptions): Promise<AppraisalResult | CoreFailure> {
    const { header } = input
    // 「批量查价 #K7Q2 Jita」：用保存的清单重算
    if (header.appraisalId && !input.lines.length) {
      return this.reprice(header.appraisalId, {
        access: opts.access,
        market: opts.market ?? header.market,
        side: opts.side ?? header.side,
        modifierPct: opts.modifierPct ?? header.modifierPct,
        replace: header.replace,
        all: header.all,
      })
    }
    let read: ReturnType<typeof readList>
    try {
      read = readList(input, this.o.items, this.mode)
    } catch (e) {
      return dataFailure(e)
    }
    const { id, saved } = this.saved.save(read.list)
    const request: Request = {
      market: opts.market ?? read.header.market,
      side: opts.side ?? read.header.side,
      modifierPct: opts.modifierPct ?? read.header.modifierPct,
    }
    return this.run(id, saved, request, opts.access)
  }

  async reprice(id: string, opts: AppraiseOptions & { replace?: Record<number, TypeId>; all?: boolean }): Promise<AppraisalResult | CoreFailure> {
    const saved = this.saved.get(id)
    if (!saved) return { ok: false, code: 'APPRAISAL_EXPIRED', message: `估价 #${id} 已过期或不存在` }
    if (opts.replace && Object.keys(opts.replace).length) {
      try {
        saved.list = replaceLines(saved.list, opts.replace, this.o.items, this.mode)
      } catch (e) {
        return dataFailure(e)
      }
    }
    return this.run(id.toUpperCase(), saved, { market: opts.market, side: opts.side, modifierPct: opts.modifierPct }, opts.access)
  }

  // ------------------------------------------------------------------ 市场

  private async run(id: string, saved: SavedAppraisal, request: Request, access: Access): Promise<AppraisalResult | CoreFailure> {
    const side = request.side ?? saved.params.side ?? this.o.settings.appraisal.defaultPriceType
    const modifierPct = request.modifierPct ?? saved.params.modifierPct ?? 0
    if (!(Math.abs(modifierPct) <= MAX_MODIFIER_PCT)) {
      return { ok: false, code: 'BAD_ARGUMENT', reason: 'modifier-range', appraisalId: id, message: `价格调整 ${modifierPct}% 超出范围` }
    }
    const pick = this.pickMarket(request.market, saved.params.marketKey, access)
    if (pick.kind !== 'ok') {
      // 「批量查价 #K7Q2 Jita」按钮照用这一次的价格类型和调整
      saved.params = { ...saved.params, side, modifierPct }
      return this.noMarket(pick, id, access)
    }
    const { market } = pick
    saved.params = { marketKey: market.key, side, modifierPct }
    const deadlineAt = this.now() + BATCH_DEADLINE_MS
    const availability = await this.availability(market, deadlineAt)
    if (!usable(availability)) return this.unavailable(market, availability, id, access)
    try {
      return await this.price({ id, list: saved.list, market, side, modifierPct, access, deadlineAt })
    } catch (e) {
      return dataFailure(e)
    }
  }

  private noMarket(pick: Exclude<MarketPick, { kind: 'ok' }>, id: string, access: Access): CoreFailure {
    if (pick.kind === 'none') return { ok: false, code: 'NOT_CONFIGURED', appraisalId: id, message: '市场表格里没有本群能用的市场' }
    return { ok: false, code: 'UNKNOWN_MARKET', token: pick.token, markets: this.visibleKeys(access), appraisalId: id, message: `未知市场：${pick.token}` }
  }

  /** 整个市场不能用：不出合计，也不自动换市场；按钮列本群能用的其他市场 */
  private unavailable(market: MarketDef, availability: MarketAvailability, id: string, access: Access): CoreFailure {
    const failure: CoreFailure = {
      ok: false,
      code: 'MARKET_UNAVAILABLE',
      marketKey: market.key,
      markets: this.visibleKeys(access).filter((key) => key !== market.key),
      appraisalId: id,
      message: `${market.name} 市场数据暂时不可用（${availability.status}）`,
    }
    if (availability.reason) failure.quoteReason = availability.reason
    return failure
  }

  /** 明确写了的市场按本群可见的匹配；没写时用这份估价上一次的市场（本群看得到才用），再不行用默认市场 */
  private pickMarket(word: string | undefined, savedKey: string | undefined, access: Access): MarketPick {
    const token = word?.trim()
    if (token) {
      const market = this.o.markets.match(token, access)
      return market ? { kind: 'ok', market } : { kind: 'unknown', token }
    }
    const last = savedKey === undefined ? undefined : this.o.markets.get(savedKey)
    if (last && this.isVisible(last, access)) return { kind: 'ok', market: last }
    const fallback = this.o.markets.configured('appraisal.defaultMarket', access)
    return fallback ? { kind: 'ok', market: fallback } : { kind: 'none' }
  }

  private isVisible(market: MarketDef, access: Access): boolean {
    return this.o.markets.visible(access).some((m) => m.key === market.key)
  }

  private visibleKeys(access: Access): string[] {
    return this.o.markets.visible(access).map((m) => m.key)
  }

  /** 建筑市场先恢复暂停的同步（数据太旧时最多等 QUERY_DEADLINE_MS），再看整个市场能不能用 */
  private async availability(market: MarketDef, deadlineAt: number): Promise<MarketAvailability> {
    const waitMs = Math.max(0, Math.min(QUERY_DEADLINE_MS, deadlineAt - this.now()))
    await this.settle(() => this.o.prices.touch(market.key, waitMs), waitMs + DEADLINE_GUARD_MS, `恢复「${market.name}」的同步`)
    return this.o.prices.available(market.key)
  }

  // ------------------------------------------------------------------ 定价

  private async price(p: Pricing): Promise<AppraisalResult> {
    const drafted = draftRows(p.list.entries, this.o.items)
    const { drafts } = drafted
    const wanted = drafts.map((d) => ({ typeId: d.item.typeId, qty: d.quantity }))
    const base = this.o.markets.base()
    const isBase = base?.key === p.market.key
    const compareTo = !isBase && base && this.isVisible(base, p.access) ? base : undefined
    // 主市场的请求先排上；比较只用缓存里或 BASE_COMPARE_WAIT_MS 内拿到的基准报价，没拿到的在后台继续取进缓存
    const pendingMain = this.quotes(p.market, wanted, p.deadlineAt - this.now())
    const pendingBase = compareTo && this.quotes(compareTo, wanted, BASE_COMPARE_WAIT_MS, 'background')
    const main = await pendingMain
    const fallback = await this.fallbackQuotes(drafts, main, p)
    const priced = priceRows({ drafts, side: p.side, modifierPct: p.modifierPct, main, fallback })
    const result = this.result(p, drafted, priced)
    if (compareTo && pendingBase) {
      const vsBase = compareWithBase(priced.rows, await pendingBase, p.side, compareTo.key)
      if (vsBase) result.vsBase = vsBase
    }
    if (isBase) Object.assign(result, this.freight(drafts, main, priced, p.access))
    return result
  }

  private result(p: Pricing, drafted: Drafted, priced: Priced): AppraisalResult {
    const result: AppraisalResult = {
      id: p.id,
      market: p.market,
      side: p.side,
      modifierPct: p.modifierPct,
      rows: priced.rows,
      unresolved: drafted.unresolved.map((entry) => this.unresolvedOf(entry)),
      noPrice: priced.noPrice,
      skipped: p.list.skipped,
      truncated: p.list.truncated,
      totals: priced.totals,
      freight: [],
      freightMissing: 0,
      mutated: mutatedCount(drafted.resolved),
      dataTime: priced.dataTime,
    }
    const fitting = fittingOf(p.list, drafted.resolved)
    if (fitting) result.fitting = fitting
    return result
  }

  /** 回退市场只给主市场正常、只是没挂单的物品报价；整个时限用完了就不回退 */
  private async fallbackQuotes(drafts: readonly RowDraft[], main: QuoteBatch, p: Pricing): Promise<{ marketKey: string; batch: QuoteBatch } | undefined> {
    const market = this.o.markets.configured('appraisal.fallbackMarket', p.access)
    if (!market || market.key === p.market.key) return undefined
    const missing = drafts.filter((d) => {
      const outcome = outcomeOf(main, d.item.typeId, p.side)
      return outcome.kind === 'missing' && outcome.reason === 'no-orders'
    })
    if (!missing.length) return undefined
    const batch = await this.quotes(market, missing.map((d) => ({ typeId: d.item.typeId, qty: d.quantity })), p.deadlineAt - this.now())
    return { marketKey: market.key, batch }
  }

  /** 运费是「从基准市场运过去」的价，只在估价市场是基准市场时算；押金按这里的出售价 */
  private freight(drafts: readonly RowDraft[], main: QuoteBatch, priced: Priced, access: Access): Pick<AppraisalResult, 'freight' | 'freightMissing'> {
    const routes = visibleRoutes(this.o.settings.freight.routes, access)
    if (!routes.length || !drafts.length) return { freight: [], freightMissing: 0 }
    const { collateral, missing } = collateralOf(drafts, main)
    const basis = { volume: priced.totals.packagedM3, collateral, adjusted: priced.totals.adjusted }
    return { freight: routes.map((route) => freightFor(route, basis)), freightMissing: missing }
  }

  private unresolvedOf(entry: Entry): AppraisalResult['unresolved'][number] {
    const out: AppraisalResult['unresolved'][number] = { lineNo: entry.lineNo, raw: entry.raw, total: entry.total ?? 0 }
    const suggestion = entry.suggestion === undefined ? undefined : this.o.items.byId(entry.suggestion)
    if (suggestion) out.suggestion = suggestion
    const candidates = (entry.candidates ?? []).flatMap((id) => this.o.items.byId(id) ?? [])
    if (candidates.length) out.candidates = candidates
    return out
  }

  // ------------------------------------------------------------------ 等待

  private async quotes(market: MarketDef, items: Array<{ typeId: TypeId; qty: number }>, ms: number, lane: EsiLane = 'interactive'): Promise<QuoteBatch> {
    if (!items.length) return { kind: 'done', quotes: new Map() }
    if (ms <= 0) return { kind: 'late' }
    const settled = await this.settle<Map<TypeId, PriceQuote>>(
      () => this.o.prices.getQuotes(market.key, items, { deadlineMs: ms, lane }), ms + DEADLINE_GUARD_MS, `取「${market.name}」的报价`,
    )
    return settled.kind === 'done' ? { kind: 'done', quotes: settled.value } : settled
  }

  /** 最多等 ms；超时不取消原来的请求（结果进缓存），出错写日志 */
  private async settle<T>(task: () => Promise<T>, ms: number, what: string): Promise<Settled<T>> {
    try {
      const result = await withDeadline(task(), ms, this.o.scheduler)
      return result.done ? { kind: 'done', value: result.value } : { kind: 'late' }
    } catch (e) {
      this.o.logger?.warn(`批量估价：${what}失败：${describeError(e)}`)
      return { kind: 'error' }
    }
  }

  private now(): number {
    return this.o.clock.now()
  }
}

export function createAppraisalService(options: AppraisalServiceOptions): AppraisalService {
  return new Service(options)
}
