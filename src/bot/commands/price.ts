// 查价（§2.2）：查价 [市场] <物品>[*数量]。不写市场时查本群的默认市场，写了只查那一个；
// 所有市场并行取价，整条最多等 6 秒，超时的市场单独标出；指名的不是基准市场时也取基准报价算 ▲▼：
// 走 ESI 的后台通道、只等 1 秒，从不拖慢主回答。

import { BASE_COMPARE_WAIT_MS, DEADLINE_GUARD_MS, GLOBAL_MARKET_TYPES, QUERY_DEADLINE_MS } from '../../constants'
import { describeError } from '../../core/util'
import { isFailure } from '../../core/types'
import type { CoreFailure, ImplantSet, IndustryData, ItemInfo, MarketDef, ParsedQuery, PriceQuote, Resolution, TypeId } from '../../core/types'
import type { Action, Card, CommandRef } from '../view/card'
import { escapeMarkdown, hasUrl } from '../view/escape'
import { runBatch } from './batch'
import { emptyCard, invoke, notices, replierFor, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { itemArgs, marketNames, marketPrefix } from './names'
import { priceCard, setCard } from './price-card'
import type { CardEnv, MarketQuote, SetQuotes } from './price-card'
import { candidatesCard, notFoundCard, notTradableText, searchKeyword, setName, setsCard, unknownMarketCard } from './resolution'
import type { ChoiceOptions } from './resolution'
import { SAY } from './text'
import { trendButtons, trendPrefix } from './trend'
import { within } from './wait'

export function registerPrice(commands: CommandContext): void {
  commands.registry.register('price', { args: '[query:text]', needsArgs: true, description: '查价：默认市场的出售、中间、收购价' })
    ?.action(async ({ session }, query) => {
      if (!session) return
      await invoke(commands, 'price', session, (inv) => runPrice(inv, typeof query === 'string' ? query : ''))
    })
}

async function runPrice(inv: Invocation, text: string): Promise<void> {
  const query = text.trim()
  // 粘贴了多行：按批量查价处理（回复额度按批量查价算）
  if (query.includes('\n')) {
    await runBatch({ ...inv, reply: replierFor(inv.commands, 'batch', inv.session) }, query, { note: SAY.multiLine })
    return
  }
  if (!query) {
    await sendCard(inv, usageCard(inv))
    return
  }
  const parsed = await inv.core.parse.query(query, { scope: 'market', access: inv.access, market: true, remote: true })
  if (isFailure(parsed)) return priceFailure(inv, parsed)
  if (!parsed.name) {
    await sendCard(inv, usageCard(inv))
    return
  }
  await answer(inv, parsed)
}

async function answer(inv: Invocation, parsed: ParsedQuery): Promise<void> {
  const res = parsed.resolution
  switch (res.kind) {
    case 'unique':
      return quoteItem(inv, parsed, res)
    case 'set':
      return quoteSet(inv, parsed, res.set)
    case 'sets':
      await sendCard(inv, setsCard(res.sets, parsed.name, (set) => ({ id: 'price', args: `${marketPrefix(parsed.market)}${setName(set)}` })))
      return
    case 'ambiguous':
    case 'confirm':
    case 'group':
      await sendCard(inv, candidatesCard(inv.core, res, choiceOptions(inv, parsed)), { quantity: true })
      return
    case 'out-of-scope':
      await notTradable(inv, res.item)
      return
    case 'none': {
      // 「搜索 乌鸦机」什么都搜不到：提示换成搜得到的关键词（「搜索 乌鸦」），没有就不提
      const keyword = searchKeyword(inv.core, parsed.name, res.suggestions)
      await sendCard(inv, notFoundCard(inv.core, res.suggestions, choiceOptions(inv, parsed, keyword)), { quantity: true })
    }
  }
}

async function priceFailure(inv: Invocation, failure: CoreFailure): Promise<void> {
  switch (failure.code) {
    case 'UNKNOWN_MARKET': {
      const rest = failure.rest ?? ''
      await sendCard(inv, unknownMarketCard(inv.core, failure, inv.access, (m) => ({ id: 'price', args: `${marketPrefix(m)}${rest}` })))
      return
    }
    case 'BAD_ARGUMENT':
      await inv.reply.text(SAY.badQuantity)
      return
    case 'DATA_NOT_READY':
      await inv.reply.text(SAY.loading)
      return
    default:
      inv.commands.logger.warn(`查价失败：${failure.code} ${failure.message ?? ''}`)
      await inv.reply.text(SAY.failed)
  }
}

// ------------------------------------------------------------------ 候选

/** keyword：「搜索 X」里的关键词，默认是用户写的名字；null = 不提搜索 */
function choiceOptions(inv: Invocation, parsed: ParsedQuery, keyword: string | null = parsed.name): ChoiceOptions {
  const prefix = marketPrefix(parsed.market)
  const qty = parsed.quantity ? `*${parsed.quantity}` : ''
  const options: ChoiceOptions = {
    query: parsed.name,
    command: (item) => ({ id: 'price', args: itemArgs(inv.core, inv.render, 'price', item, (name) => `${prefix}${name}${qty}`) }),
  }
  if (keyword !== null && !hasUrl(keyword) && inv.commands.registry.has('search')) {
    options.search = { id: 'search', args: `${prefix}${keyword}` }
    options.searchName = inv.commands.registry.name('search')
  }
  return options
}

// ------------------------------------------------------------------ 报价

function cardEnv(inv: Invocation): CardEnv {
  return { core: inv.core, display: inv.commands.settings.display, now: inv.commands.clock.now() }
}

/** 默认数量表（PLEX = 500）：表里的物品要能唯一认出（编号、官方名或别名） */
function defaultQuantity(inv: Pick<Invocation, 'core' | 'commands'>, item: ItemInfo): number | null {
  for (const row of inv.commands.settings.price.defaultQuantities) {
    const res = inv.core.items.resolve(row.item, { scope: 'market' })
    if (res.kind === 'unique' && res.tier !== 'prefix' && res.item.typeId === item.typeId) return row.quantity
  }
  return null
}

/** 和哪个市场比较：基准市场本群看得到、而且列表里有别的市场时 */
function compareBase(inv: Invocation, markets: readonly MarketDef[]): MarketDef | undefined {
  const base = inv.core.markets.base()
  if (!base || !inv.core.markets.visible(inv.access).some((m) => m.key === base.key)) return undefined
  return markets.some((m) => m.key !== base.key) ? base : undefined
}

function marketsFor(inv: Invocation, parsed: ParsedQuery): MarketDef[] {
  return parsed.market ? [parsed.market] : inv.core.markets.defaults(inv.access)
}

const logError = (inv: Invocation, what: string) => (e: unknown) => inv.commands.logger.warn(`${what}失败：${describeError(e)}`)

/** lane：background = 比较用的基准报价，不占交互请求的位置 */
function quoteOf(inv: Invocation, market: MarketDef, typeId: TypeId, qty: number, ms: number, lane?: 'background'): Promise<PriceQuote | null> {
  const pending = inv.core.prices.getQuote(market.key, typeId, { qty, deadlineMs: Math.min(ms, QUERY_DEADLINE_MS), ...lane ? { lane } : {} })
  return within(pending, ms + DEADLINE_GUARD_MS, logError(inv, `取「${market.name}」的报价`))
}

async function quoteItem(inv: Invocation, parsed: ParsedQuery, res: Extract<Resolution, { kind: 'unique' }>): Promise<void> {
  const { item } = res
  const markets = marketsFor(inv, parsed)
  if (!markets.length) {
    await inv.reply.text(SAY.noMarket)
    return
  }
  const quantity = parsed.quantity ?? defaultQuantity(inv, item)
  const qty = quantity ?? 1
  const global = GLOBAL_MARKET_TYPES.includes(item.typeId)
  const list = global ? markets.slice(0, 1) : markets
  const base = global ? undefined : compareBase(inv, list)
  const pending = Promise.all(list.map(async (market) => ({ market, quote: await quoteOf(inv, market, item.typeId, qty, QUERY_DEADLINE_MS) })))
  const extraBase = base && !list.some((m) => m.key === base.key) ? quoteOf(inv, base, item.typeId, qty, BASE_COMPARE_WAIT_MS, 'background') : undefined
  const quotes: MarketQuote[] = await pending
  const baseQuote = base && (extraBase ? await extraBase : quotes.find((q) => q.market.key === base.key)?.quote)
  const meta = res.tier === 'remote' ? [SAY.newItem] : res.via ? [SAY.via(escapeMarkdown(res.via))] : []
  const card = priceCard(cardEnv(inv), {
    item,
    quantity,
    quotes,
    ...base ? { base: { market: base, quote: baseQuote ?? null } } : {},
    single: !!parsed.market,
    global,
    meta,
    notices: notices(inv),
    actions: itemActions(inv, item, parsed.market, parsed.alt, parsed.quantity),
  })
  await sendCard(inv, card)
}

async function quoteSet(inv: Invocation, parsed: ParsedQuery, set: ImplantSet): Promise<void> {
  const markets = marketsFor(inv, parsed)
  if (!markets.length) {
    await inv.reply.text(SAY.noMarket)
    return
  }
  const wanted = set.items.map((i) => ({ typeId: i.typeId, qty: parsed.quantity ?? 1 }))
  const fetch = (market: MarketDef, ms: number, lane?: 'background'): Promise<SetQuotes> => {
    const pending = inv.core.prices.getQuotes(market.key, wanted, { deadlineMs: Math.min(ms, QUERY_DEADLINE_MS), ...lane ? { lane } : {} })
    return within(pending, ms + DEADLINE_GUARD_MS, logError(inv, `取「${market.name}」的报价`)).then((quotes) => ({ market, quotes }))
  }
  const base = compareBase(inv, markets)
  const pending = Promise.all(markets.map((m) => fetch(m, QUERY_DEADLINE_MS)))
  const extraBase = base && !markets.some((m) => m.key === base.key) ? fetch(base, BASE_COMPARE_WAIT_MS, 'background') : undefined
  const results = await pending
  const baseQuotes = base && (extraBase ? await extraBase : results.find((r) => r.market.key === base.key))
  const card = setCard(cardEnv(inv), {
    set,
    quantity: parsed.quantity,
    markets: results,
    ...baseQuotes ? { base: baseQuotes } : {},
    notices: notices(inv),
    actions: setActions(inv, set, parsed.market),
  })
  await sendCard(inv, card)
}

// ------------------------------------------------------------------ 按钮

/** 月度、季度走势（按钮只给这两个，§2.4.1）；args(范围的写法) → 命令参数 */
function trendActions(inv: Invocation, args: (range: string) => string): Action[] {
  return inv.commands.registry.has('trend') ? trendButtons(['month', 'quarter'], args) : []
}

function itemActions(inv: Invocation, item: ItemInfo, market: MarketDef | undefined, alt: ItemInfo | undefined, quantity: number | null): Action[][] {
  const named = (id: 'trend' | 'search', compose: (name: string) => string) => itemArgs(inv.core, inv.render, id, item, compose)
  const row: Action[] = trendActions(inv, (range) => named('trend', (name) => `${trendPrefix(market)}${name} ${range}`))
  if (inv.commands.registry.has('search')) {
    row.push({ label: '相关物品', command: { id: 'search', args: named('search', (name) => `${marketPrefix(market)}${name}`) }, ...row.length ? {} : { primary: true } })
  }
  if (alt) row.push({ label: '查所有市场', command: { id: 'price', args: `#${alt.typeId}` } })
  const cost = costAction(inv, item, quantity)
  if (cost) row.push(cost)
  return row.length ? [row] : []
}

// ------------------------------------------------------------------ 制造成本（§2.2.2、§2.2.7、§11.2）

function industryData(inv: Invocation): IndustryData | undefined {
  try {
    return inv.core.data.current().industry
  } catch {
    return undefined
  }
}

/** 有制造蓝图或反应配方的物品：「制造成本」填入基础参考（反应产物用「反应」）；命令没注册时不给 */
function costAction(inv: Invocation, item: ItemInfo, quantity: number | null): Action | undefined {
  const industry = industryData(inv)
  if (!industry) return undefined
  const id = industry.reactions.has(item.typeId) ? 'reaction' : industry.manufacturing.has(item.typeId) ? 'manufacture' : undefined
  if (!id || !inv.commands.registry.has(id)) return undefined
  const qty = quantity && quantity > 1 ? `*${quantity}` : ''
  return { label: '制造成本', command: { id, args: itemArgs(inv.core, inv.render, id, item, (name) => `${name}${qty}`) } }
}

/** 不能在市场上交易的蓝图、配方（例如 T2 蓝图）：说明，能算成本时配「制造成本」（按它的产品） */
async function notTradable(inv: Invocation, item: ItemInfo): Promise<void> {
  const recipe = industryData(inv)?.byBlueprint.get(item.typeId)
  const productId = (recipe?.m ?? recipe?.r)?.products[0]?.typeId
  const product = productId === undefined ? item : inv.core.items.byId(productId)
  const cost = product && costAction(inv, product, null)
  if (!cost) {
    await inv.reply.text(notTradableText(item))
    return
  }
  const card = emptyCard(escapeMarkdown(notTradableText(item)))
  card.actions.push([{ ...cost, primary: true }])
  await sendCard(inv, card)
}

function setActions(inv: Invocation, set: ImplantSet, market: MarketDef | undefined): Action[][] {
  const row = trendActions(inv, (range) => `${trendPrefix(market)}${setName(set)} ${range}`)
  return row.length ? [row] : []
}

// ------------------------------------------------------------------ 只发「查价」

/** §2.2.8：用法、本群可查的市场；按钮「查价 PLEX」「输入物品」（只填命令名） */
export function usageCard(inv: Pick<Invocation, 'core' | 'access' | 'commands'>): Card {
  const name = escapeMarkdown(inv.commands.registry.name('price'))
  const visible = inv.core.markets.visible(inv.access)
  const example = visible[0] ? escapeMarkdown(marketPrefix(visible[0])) : ''
  const card = emptyCard('**查价用法**')
  card.sections.push({
    lines: [
      { text: `${name} 乌鸦级：查本群的默认市场` },
      { text: `${name} ${example}乌鸦级*10：指定市场和数量` },
      { text: '中文名、英文名、常用简称都可以' },
    ],
  })
  card.sections.push({ style: 'plain', lines: [{ text: `本群可查的市场：${marketNames(visible) || '无'}` }] })
  const plex: CommandRef = { id: 'price', args: 'PLEX' }
  card.actions.push([
    { label: `${inv.commands.registry.name('price')} PLEX`, command: plex, primary: true },
    { label: '输入物品', command: { id: 'price' }, fillOnly: true },
  ])
  return card
}
