// 批量查价（§2.3）：批量查价 [市场] [sell|mid|buy] [±N%|N折]，换行后是清单或 EFT 装配；表头里的 #K7Q2 用保存的清单重算。
// 只发表头、或者一行都没认出来时记一条「批量清单」待办（后者带着候选的编号）；
// 冷启动、未缓存的物品很多、3 秒内没算完时发一次慢提示。

import { MAX_SPLIT_PARTS, PRICE_TYPE_WORDS, SLOW_HINT_MS, SLOW_HINT_UNCACHED_TYPES } from '../../constants'
import { primaryHypothesis } from '../../core/parse'
import type { ManagedMarketService } from '../../core/market'
import { isFailure } from '../../core/types'
import type { AppraisalResult, CoreFailure, MarketDef, MarketService, PasteHeader, PasteParse, TypeId } from '../../core/types'
import { choicesOf, pendingKey } from '../pending'
import { hasUrl } from '../view/escape'
import { headerCard, nothingCard, resultCards, unavailableCard } from './batch-card'
import type { BatchEnv, HeaderView } from './batch-card'
import { invoke, notices, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { marketPrefix, shortName } from './names'
import { unknownMarketCard } from './resolution'
import { SAY } from './text'

export function registerBatch(commands: CommandContext): void {
  commands.registry.register('batch', { args: '[args:text]', description: '批量查价：粘贴清单或装配，算总价' })
    ?.action(async ({ session }, args) => {
      if (!session) return
      await invoke(commands, 'batch', session, (inv) => runBatch(inv, typeof args === 'string' ? args : ''))
    })
}

interface BatchOptions {
  /** 标题下的说明（多行的「查价」转过来时） */
  note?: string
}

export async function runBatch(inv: Invocation, text: string, options: BatchOptions = {}): Promise<void> {
  const parsed = inv.core.appraisal.parse(text, inv.access)
  if (isFailure(parsed)) return batchFailure(inv, parsed, {})
  if (headerOnly(parsed)) return askForList(inv, parsed, text)
  const hint = slowHint(inv, parsed)
  const result = await inv.core.appraisal.appraise(parsed, { access: inv.access }).finally(() => hint.stop())
  await hint.sent()
  if (isFailure(result)) return batchFailure(inv, result, parsed.header)
  if (!result.rows.length) return nothingRecognized(inv, result)
  await sendResult(inv, result, parsed.header, options.note)
}

/** 一行都没认出来：只写警告和用法；批量清单待办带着卡片上的候选，回复编号和重新粘贴都行 */
async function nothingRecognized(inv: Invocation, result: AppraisalResult): Promise<void> {
  const card = nothingCard(batchEnv(inv), result, inv.session.isDirect)
  await inv.reply.card(card)
  inv.commands.pending.setList(pendingKey(inv.session), headerArgs(result), choicesOf(card, inv.commands.registry.namer()))
}

/** 没有清单、也没有估价编号（空行、表头行不算） */
function headerOnly(parsed: PasteParse): boolean {
  if (parsed.lines.length || parsed.header.appraisalId) return false
  return parsed.skipped.every((s) => s.reason === 'empty' || s.reason === 'header')
}

function batchEnv(inv: Invocation): BatchEnv {
  const base = inv.core.markets.base()
  const env: BatchEnv = {
    core: inv.core,
    display: inv.commands.settings.display,
    routes: inv.commands.settings.freight.routes,
    commandName: inv.commands.registry.name('batch'),
  }
  if (base && inv.core.markets.visible(inv.access).some((m) => m.key === base.key)) env.base = base
  return env
}

async function sendResult(inv: Invocation, result: AppraisalResult, header: PasteHeader, note?: string): Promise<void> {
  const maxParts = Math.min(MAX_SPLIT_PARTS, Math.max(1, inv.reply.remaining()))
  const view = { all: !!header.all, ...header.from ? { from: header.from } : {} }
  const cards = resultCards(batchEnv(inv), result, { ...view, maxParts, notices: notices(inv), ...note ? { note } : {} })
  for (const card of cards) {
    if (!(await sendCard(inv, card))) return
  }
}

// ------------------------------------------------------------------ 只发表头

/** 表头里的市场：写了就按本群可见的认，没写用默认市场 */
function headerMarket(inv: Invocation, header: PasteHeader): MarketDef | null | undefined {
  if (header.market) return inv.core.markets.match(header.market, inv.access)
  return inv.core.markets.configured('appraisal.defaultMarket', inv.access)
}

async function askForList(inv: Invocation, parsed: PasteParse, text: string): Promise<void> {
  const { header } = parsed
  const market = headerMarket(inv, header)
  if (market === null) {
    // 表头里的市场本群看不到：和不存在的市场同一句话，按钮换成可用的市场（带网址的文字不进按钮）
    const others = text.trim().split(/\s+/).filter((w) => w !== header.market).join(' ')
    const failure: CoreFailure = { ok: false, code: 'UNKNOWN_MARKET', token: header.market ?? '' }
    const card = unknownMarketCard(inv.core, failure, inv.access, (m) => ({ id: 'batch', args: `${marketPrefix(m)}${others}`.trim() }))
    if (hasUrl(others)) card.actions = []
    await sendCard(inv, card)
    return
  }
  if (!market) {
    await inv.reply.text(SAY.noMarket)
    return
  }
  const view: HeaderView = {
    marketName: market.name,
    side: header.side ?? inv.commands.settings.appraisal.defaultPriceType,
    modifierPct: header.modifierPct ?? 0,
  }
  await sendCard(inv, headerCard(batchEnv(inv), view, inv.session.isDirect))
  inv.commands.pending.setList(pendingKey(inv.session), text.replace(/\s+/g, ' ').trim())
}

/** 一行都没认出来时，待办里记下这次的参数（下一条消息照样用） */
function headerArgs(result: AppraisalResult): string {
  const words = [shortName(result.market), PRICE_TYPE_WORDS[result.side][0]]
  if (result.modifierPct) words.push(`${result.modifierPct > 0 ? '+' : ''}${result.modifierPct}%`)
  return words.join(' ')
}

// ------------------------------------------------------------------ 出错

async function batchFailure(inv: Invocation, failure: CoreFailure, header: PasteHeader): Promise<void> {
  switch (failure.code) {
    case 'BAD_ARGUMENT':
      await inv.reply.text(failure.reason === 'two-markets' ? SAY.twoMarkets : SAY.modifierRange)
      return
    case 'UNKNOWN_MARKET': {
      const id = failure.appraisalId
      await sendCard(inv, unknownMarketCard(inv.core, failure, inv.access, (m) => ({ id: 'batch', args: id ? `#${id} ${shortName(m)}` : shortName(m) })))
      return
    }
    case 'MARKET_UNAVAILABLE': {
      const view = { side: header.side ?? inv.commands.settings.appraisal.defaultPriceType, modifierPct: header.modifierPct ?? 0 }
      await sendCard(inv, unavailableCard(batchEnv(inv), failure, view))
      return
    }
    case 'APPRAISAL_EXPIRED':
      await inv.reply.text(SAY.expired)
      return
    case 'NOT_CONFIGURED':
      await inv.reply.text(SAY.noMarket)
      return
    case 'DATA_NOT_READY':
      await inv.reply.text(SAY.loading)
      return
    default:
      inv.commands.logger.warn(`批量查价失败：${failure.code} ${failure.message ?? ''}`)
      await inv.reply.text(SAY.failed)
  }
}

// ------------------------------------------------------------------ 慢提示

interface SlowHint {
  stop(): void
  /** 已经开始发的提示发完（卡片要排在它后面） */
  sent(): Promise<void>
}

function hasCache(prices: MarketService): prices is ManagedMarketService {
  return typeof (prices as Partial<ManagedMarketService>).cached === 'function'
}

/** 清单里有几种物品的价格不在缓存里（按每行最可能的读法认） */
function uncachedTypes(inv: Invocation, parsed: PasteParse): number {
  const market = headerMarket(inv, parsed.header)
  if (!market) return 0
  const ids = new Set<TypeId>()
  for (const line of parsed.lines) {
    const name = primaryHypothesis(line)?.name
    const res = name ? inv.core.items.resolveLine(name) : undefined
    if (res && 'item' in res) ids.add(res.item.typeId)
  }
  const prices = inv.core.prices
  if (!hasCache(prices)) return ids.size
  return [...ids].filter((id) => !prices.cached(market.key, id)).length
}

/** 3 秒还没算完、而且未缓存的物品超过 30 种时发一次慢提示（正在查询 N 种物品的价格） */
function slowHint(inv: Invocation, parsed: PasteParse): SlowHint {
  let sending: Promise<unknown> = Promise.resolve()
  const cancel = parsed.lines.length > SLOW_HINT_UNCACHED_TYPES
    ? inv.commands.scheduler.timeout(() => {
      const count = uncachedTypes(inv, parsed)
      if (count > SLOW_HINT_UNCACHED_TYPES) sending = inv.reply.hint(`⏳ 正在查询 ${count} 种物品的价格…`)
    }, SLOW_HINT_MS)
    : undefined
  return {
    stop: () => cancel?.(),
    sent: async () => {
      await sending
    },
  }
}
