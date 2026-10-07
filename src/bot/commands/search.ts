// 搜索（§2.5）：搜索 [市场] <关键词> [第N页]。关键词正好是一个物品时列相关物品（同系列、蓝图或产品、名字里包含它的），
// 否则按名字列搜索结果；每页 10 个，每一行带简写的出售、收购价（同一页并行取，最多等 6 秒）。
// 「另有涂装 N 个」按「涂装」按钮实际会列出的个数算（和那一页用同一个搜索）。

import { DEADLINE_GUARD_MS, QUERY_DEADLINE_MS, SEARCH_PAGE_SIZE } from '../../constants'
import type { CoreFailure, ItemInfo, MarketDef, PriceQuote, TypeId } from '../../core/types'
import type { Action, Card, Choice } from '../view/card'
import { escapeMarkdown, safeEcho } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { itemArgs, itemName, listPriceText, marketPrefix } from './names'
import { usableQuote } from './quotes'
import { unknownMarketCard } from './resolution'
import { within } from './wait'

export function registerSearch(commands: CommandContext): void {
  commands.registry.register('search', { args: '[query:text]', description: '搜索：按名字找物品，或者列出相关物品，带价格' })
    ?.action(async ({ session }, query) => {
      if (!session) return
      await invoke(commands, 'search', session, (inv) => runSearch(inv, typeof query === 'string' ? query : ''))
    })
}

const PAGE = /\s*第\s*(\d{1,3})\s*页$/
const SKIN_WORD = /\s+(涂装|skins?)$/i

interface SearchQuery {
  keyword: string
  page: number
  /** 关键词后面写了「涂装」：涂装照常列出 */
  skins: boolean
}

/** 去掉末尾的「第N页」和「涂装」（它们不是市场，也不该参与切市场） */
export function parseSearch(text: string): SearchQuery {
  let keyword = text.replace(/\s+/g, ' ').trim()
  const page = PAGE.exec(keyword)
  if (page) keyword = keyword.slice(0, page.index).trim()
  const skin = SKIN_WORD.exec(keyword)
  if (skin) keyword = keyword.slice(0, skin.index).trim()
  return { keyword, page: page ? Math.max(1, Number(page[1])) : 1, skins: !!skin }
}

interface Listing {
  title: string
  /** 这一页的物品 */
  page: ItemInfo[]
  /** 能列出的物品一共几个（不含没列出的涂装） */
  count: number
  /** 没有列出的涂装 */
  skins: number
}

async function runSearch(inv: Invocation, text: string): Promise<void> {
  const query = parseSearch(text)
  if (!query.keyword) {
    await sendCard(inv, usageCard(inv))
    return
  }
  const split = inv.core.markets.split(query.keyword, inv.access, inv.core.items, 'market')
  if (split.unknown !== undefined) {
    const rest = `${split.rest}${query.skins ? ' 涂装' : ''}`
    const failure: CoreFailure = { ok: false, code: 'UNKNOWN_MARKET', token: split.unknown }
    await sendCard(inv, unknownMarketCard(inv.core, failure, inv.access, (m) => ({ id: 'search', args: `${marketPrefix(m)}${rest}` })))
    return
  }
  const keyword = split.market ? split.rest : query.keyword
  const market = split.market ?? inv.core.markets.configured('price.baseMarket', inv.access) ?? inv.core.markets.visible(inv.access)[0]
  if (!keyword) {
    await sendCard(inv, usageCard(inv))
    return
  }
  const listing = list(inv, keyword, query)
  if (!listing.count && !listing.skins) {
    await sendCard(inv, emptyCard(`没有名字里包含「${safeEcho(keyword)}」的物品。`))
    return
  }
  const pages = Math.max(1, Math.ceil(listing.count / SEARCH_PAGE_SIZE))
  if (query.page > pages) {
    await inv.reply.text(`没有第 ${query.page} 页（一共 ${pages} 页）`)
    return
  }
  const quotes = market ? await pageQuotes(inv, market, listing.page) : new Map<TypeId, PriceQuote>()
  await sendCard(inv, searchCard(inv, { listing, pages, query, keyword, market, named: split.market, quotes }), { quantity: true })
}

const skinQuery = (keyword: string) => `${keyword} 涂装`

/** 「涂装」按钮那一页一共会列出几个（没有没列出的涂装时不用搜） */
function skinCount(inv: Invocation, keyword: string, skins: number): number {
  return skins ? inv.core.items.search(skinQuery(keyword), { scope: 'any', offset: 0, limit: 0 }).total : 0
}

/** 精确命中：这个物品、同系列、蓝图或产品、名字里包含它的；否则按名字搜 */
function list(inv: Invocation, keyword: string, query: SearchQuery): Listing {
  const offset = (query.page - 1) * SEARCH_PAGE_SIZE
  const found = inv.core.items.search(query.skins ? skinQuery(keyword) : keyword, { scope: 'any', offset, limit: SEARCH_PAGE_SIZE })
  if (found.exact) {
    const r = inv.core.items.related(found.exact.typeId)
    const items = [found.exact, ...r.variants, ...r.blueprint ? [r.blueprint] : [], ...r.product ? [r.product] : [], ...r.containing]
    const title = `**「${escapeMarkdown(itemName(found.exact))}」相关物品**`
    return { title, page: items.slice(offset, offset + SEARCH_PAGE_SIZE), count: items.length, skins: skinCount(inv, keyword, r.skins) }
  }
  const skins = query.skins ? 0 : skinCount(inv, keyword, found.skins)
  return { title: `**「${safeEcho(keyword)}」的搜索结果**`, page: found.items, count: found.total, skins }
}

async function pageQuotes(inv: Invocation, market: MarketDef, items: ItemInfo[]): Promise<Map<TypeId, PriceQuote>> {
  const wanted = items.filter((i) => i.marketGroupId !== null).map((i) => ({ typeId: i.typeId, qty: 1 }))
  if (!wanted.length) return new Map()
  const pending = inv.core.prices.getQuotes(market.key, wanted, { deadlineMs: QUERY_DEADLINE_MS })
  return (await within(pending, QUERY_DEADLINE_MS + DEADLINE_GUARD_MS)) ?? new Map()
}

interface SearchView {
  listing: Listing
  pages: number
  query: SearchQuery
  keyword: string
  market: MarketDef | undefined
  /** 用户写了的市场（按钮里带上） */
  named: MarketDef | undefined
  quotes: Map<TypeId, PriceQuote>
}

/** 出售 258.40M · 收购 249.00M；不能上市场的物品不写价格 */
function priceText(inv: Invocation, item: ItemInfo, quotes: Map<TypeId, PriceQuote>): string {
  if (item.marketGroupId === null) return ''
  const quote = quotes.get(item.typeId) ?? null
  const side = (value: number | undefined) =>
    usableQuote(quote) ? listPriceText(inv.core.format, value, inv.commands.settings.display) : '—'
  return `出售 ${side(quote?.sell?.best)} · 收购 ${side(quote?.buy?.best)}`
}

function searchCard(inv: Invocation, view: SearchView): Card {
  const { listing, query } = view
  const where = view.market ? ` · ${escapeMarkdown(view.market.name)}` : ''
  const card = emptyCard(`${listing.title}${where} · 共 ${listing.count + listing.skins} 个`)
  if (view.pages > 1) card.meta.push(`第 ${query.page}/${view.pages} 页`)
  const prefix = marketPrefix(view.named)
  card.choices = listing.page.map((item, i): Choice => {
    const detail = [item.zh ? escapeMarkdown(item.en) : '', priceText(inv, item, view.quotes)].filter(Boolean).join(' · ')
    const command = { id: 'price' as const, args: itemArgs(inv.core, inv.render, 'price', item, (name) => `${prefix}${name}`) }
    return { no: i + 1, label: escapeMarkdown(itemName(item)), command, ...detail ? { detail } : {} }
  })
  const actions: Action[] = []
  if (listing.skins && !query.skins) {
    card.meta.push(`另有涂装 ${listing.skins} 个`)
    actions.push({ label: `涂装 ${listing.skins} 个`, command: { id: 'search', args: `${prefix}${skinQuery(view.keyword)}` } })
  }
  if (query.page < view.pages) {
    const skins = query.skins ? ' 涂装' : ''
    actions.push({ label: '下一页', command: { id: 'search', args: `${prefix}${view.keyword}${skins} 第${query.page + 1}页` }, primary: true })
  }
  if (actions.length) card.actions.push(actions)
  return card
}

function usageCard(inv: Invocation): Card {
  const name = escapeMarkdown(inv.commands.registry.name('search'))
  const card = emptyCard('**搜索用法**')
  card.sections.push({
    lines: [
      { text: `${name} 乌鸦：名字里有「乌鸦」的物品（中文、英文、拼音都可以）` },
      { text: `${name} 乌鸦级：写完整名字时列出相关物品` },
      { text: `${name} 乌鸦 第2页：翻页` },
    ],
  })
  return card
}
