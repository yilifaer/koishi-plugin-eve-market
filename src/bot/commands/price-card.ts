// 查价的卡片（§2.2.2–§2.2.5）：每个市场一节（出售 / 中间 / 收购），和基准市场比较的 ▲▼，数量合计；
// PLEX 这类全局市场物品只显示一次；植入体套装第一个市场逐件列出，其他市场只写一行合计。

import { SHOW_MID } from '../../constants'
import type {
  DisplaySettings, EveCore, FormattedPrice, ImplantSet, ItemInfo, MarketDef, PriceQuote, TypeId,
} from '../../core/types'
import type { Action, Card, Line, Section } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { emptyCard } from './context'
import { amountText, itemName, itemTitle, listPriceText } from './names'
import { diffMark, footerText, newestTime, quoteView, usableQuote } from './quotes'
import { setName } from './resolution'
import { QUOTE } from './text'

export interface CardEnv {
  core: Pick<EveCore, 'data' | 'format' | 'items'>
  display: Pick<DisplaySettings, 'priceDisplayMode' | 'listPriceDisplayMode'>
  now: number
}

export interface MarketQuote {
  market: MarketDef
  /** null = 等超时了还没回来 */
  quote: PriceQuote | null
}

export interface PriceCardInput {
  item: ItemInfo
  /** 写了的数量，或者默认数量表里的；null = 不算合计 */
  quantity: number | null
  quotes: MarketQuote[]
  /** 基准市场（▲▼ 和它比）；undefined = 不比较 */
  base?: { market: MarketDef; quote: PriceQuote | null }
  /** 只查用户指名的这一个市场 */
  single: boolean
  /** PLEX 这类全宇宙统一交易的物品 */
  global: boolean
  meta: string[]
  notices: string[]
  actions: Action[][]
}

const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' ')

function totalOf(env: CardEnv, unit: number, quantity: number | null): string | undefined {
  if (!quantity || quantity <= 1) return undefined
  return `· 合计 ${amountText(env.core.format, unit * quantity, env.display.priceDisplayMode)}`
}

function priceLine(label: string, price: FormattedPrice, extra: string): Line {
  return extra ? { label, price, extra } : { label, price }
}

/** 出售 / 中间 / 收购三行；某一边没有订单时写「暂无卖单」，中间价写 —，绝不写 0 */
function sideLines(env: CardEnv, quote: PriceQuote, quantity: number | null, base: PriceQuote | null): Line[] {
  const { format } = env.core
  const lines: Line[] = []
  const sell = quote.sell?.best
  const buy = quote.buy?.best
  lines.push(sell === undefined
    ? { label: `出售 ${QUOTE.noSell}` }
    : priceLine('出售', format.isk(sell), join(diffMark(sell, base?.sell?.best), totalOf(env, sell, quantity))))
  if (SHOW_MID) {
    lines.push(quote.mid === null
      ? { label: '中间', price: { na: true } }
      : priceLine('中间', format.isk(quote.mid), join(totalOf(env, quote.mid, quantity))))
  }
  lines.push(buy === undefined
    ? { label: `收购 ${QUOTE.noBuy}` }
    : priceLine('收购', format.isk(buy), join(diffMark(buy, base?.buy?.best), totalOf(env, buy, quantity))))
  return lines
}

function marketSection(env: CardEnv, heading: string, quote: PriceQuote | null, newest: number | null, quantity: number | null, base: PriceQuote | null): Section {
  const view = quoteView(quote, env.now, newest)
  const section: Section = { heading, lines: [] }
  if (view.badge) section.badge = view.badge
  if (view.problem || !usableQuote(quote)) {
    section.style = 'plain'
    section.lines.push({ text: view.problem ?? QUOTE.timeout })
    return section
  }
  section.lines = sideLines(env, quote, quantity, base)
  return section
}

/** 基准市场的报价能用来比较（本市场不是基准市场、基准报价按时拿到了） */
function baseFor(input: Pick<PriceCardInput, 'base'>, market: MarketDef): PriceQuote | null {
  if (!input.base || input.base.market.key === market.key) return null
  return usableQuote(input.base.quote) ? input.base.quote : null
}

export function priceCard(env: CardEnv, input: PriceCardInput): Card {
  const quotes = input.quotes.map((q) => q.quote)
  const newest = newestTime(quotes)
  const card = emptyCard(itemTitle(env.core, input.item, input.quantity))
  card.meta = input.meta
  let compared = false
  for (const { market, quote } of input.quotes) {
    const base = baseFor(input, market)
    const heading = input.global ? `${escapeMarkdown(input.item.en)} 全局市场` : escapeMarkdown(market.name)
    const section = marketSection(env, heading, quote, newest, input.quantity, base)
    compared ||= section.lines.some((l) => 'label' in l && /[▲▼]/.test(l.extra ?? ''))
    card.sections.push(section)
  }
  const extras: string[] = []
  if (compared && input.base) extras.push(`▲▼ 与 ${escapeMarkdown(input.base.market.name)} 比较`)
  if (input.global) extras.push(`${escapeMarkdown(input.item.en)} 全宇宙统一交易，不分市场`)
  const where = input.single && !input.global && input.quotes[0] ? `${escapeMarkdown(input.quotes[0].market.name)} ` : ''
  card.footer = footerText(env.core.format, newest, extras, where)
  card.notices = input.notices
  card.actions = input.actions
  return card
}

// ------------------------------------------------------------------ 植入体套装

export interface SetQuotes {
  market: MarketDef
  /** null = 等超时了还没回来 */
  quotes: Map<TypeId, PriceQuote> | null
}

export interface SetCardInput {
  set: ImplantSet
  quantity: number | null
  markets: SetQuotes[]
  base?: SetQuotes
  notices: string[]
  actions: Action[][]
}

interface SetTotals {
  sell: number
  buy: number
  missingSell: number
  missingBuy: number
}

/** 「阿尔法型」：中文名去掉套装名和分隔符 */
export function pieceName(set: ImplantSet, item: ItemInfo): string {
  const strip = (name: string, prefix: string) =>
    prefix && name.startsWith(prefix) ? name.slice(prefix.length).replace(/^[\s\-‐-―−]+/, '') : ''
  return strip(item.zh, set.name.zh) || strip(item.en, set.name.en) || itemName(item)
}

function setTotals(set: ImplantSet, quotes: Map<TypeId, PriceQuote>, quantity: number): SetTotals {
  const totals: SetTotals = { sell: 0, buy: 0, missingSell: 0, missingBuy: 0 }
  for (const item of set.items) {
    const q = quotes.get(item.typeId)
    const ok = usableQuote(q ?? null)
    if (ok && q?.sell) totals.sell += q.sell.best * quantity
    else totals.missingSell++
    if (ok && q?.buy) totals.buy += q.buy.best * quantity
    else totals.missingBuy++
  }
  return totals
}

/** 整个市场一件价格都没有时的说法（取第一件的状态） */
function setProblem(env: CardEnv, set: ImplantSet, quotes: Map<TypeId, PriceQuote> | null): string | undefined {
  if (!quotes) return QUOTE.timeout
  const list = set.items.map((i) => quotes.get(i.typeId) ?? null)
  if (list.some(usableQuote)) return undefined
  return quoteView(list[0] ?? null, env.now, null).problem ?? QUOTE.timeout
}

const listPrice = (env: CardEnv, value: number | undefined) => listPriceText(env.core.format, value, env.display)

function setDetail(env: CardEnv, input: SetCardInput, first: SetQuotes, newest: number | null): Section {
  const quotes = first.quotes!
  const section: Section = { heading: escapeMarkdown(first.market.name), lines: [] }
  const view = quoteView(input.set.items.map((i) => quotes.get(i.typeId) ?? null).find(usableQuote) ?? null, env.now, newest)
  if (view.badge) section.badge = view.badge
  for (const item of input.set.items) {
    const q = quotes.get(item.typeId)
    const ok = usableQuote(q ?? null)
    const sell = ok ? q?.sell?.best : undefined
    const buy = ok ? q?.buy?.best : undefined
    section.lines.push({ text: `${escapeMarkdown(pieceName(input.set, item))} · 出售 ${listPrice(env, sell)} · 收购 ${listPrice(env, buy)}` })
  }
  const totals = setTotals(input.set, quotes, input.quantity ?? 1)
  const totalLine = (side: '出售' | '收购', value: number, missing: number): Line =>
    missing ? { text: `**合计** ${side} 缺 ${missing} 件` } : { label: `**合计** ${side}`, price: env.core.format.isk(value) }
  section.lines.push(totalLine('出售', totals.sell, totals.missingSell), totalLine('收购', totals.buy, totals.missingBuy))
  return section
}

/** **Amarr** 合计 出售 318.20M ▲3.4% · 收购 缺 1 件 */
function setSummary(env: CardEnv, input: SetCardInput, market: SetQuotes, base: SetTotals | null): Line {
  const name = `**${escapeMarkdown(market.market.name)}**`
  const problem = setProblem(env, input.set, market.quotes)
  if (problem) return { text: `${name} ${problem}` }
  const t = setTotals(input.set, market.quotes!, input.quantity ?? 1)
  const amount = (v: number) => amountText(env.core.format, v, env.display.priceDisplayMode)
  const sell = t.missingSell ? `缺 ${t.missingSell} 件` : join(amount(t.sell), base && !base.missingSell ? diffMark(t.sell, base.sell) : undefined)
  const buy = t.missingBuy ? `缺 ${t.missingBuy} 件` : join(amount(t.buy), base && !base.missingBuy ? diffMark(t.buy, base.buy) : undefined)
  return { text: `${name} 合计 出售 ${sell} · 收购 ${buy}` }
}

export function setCard(env: CardEnv, input: SetCardInput): Card {
  const { set } = input
  const qty = input.quantity && input.quantity > 1 ? ` ×${env.core.format.quantity(input.quantity)}` : ''
  const card = emptyCard(`**${escapeMarkdown(setName(set))}** ${escapeMarkdown(set.name.en)}${qty} · ${set.items.length} 件`)
  const all = input.markets.flatMap((m) => (m.quotes ? [...m.quotes.values()] : []))
  const newest = newestTime(all)
  const [first, ...rest] = input.markets
  if (first) {
    const problem = setProblem(env, set, first.quotes)
    card.sections.push(problem
      ? { heading: escapeMarkdown(first.market.name), style: 'plain', lines: [{ text: problem }] }
      : setDetail(env, input, first, newest))
  }
  const baseTotals = input.base?.quotes && !setProblem(env, set, input.base.quotes)
    ? setTotals(set, input.base.quotes, input.quantity ?? 1)
    : null
  const summaries = rest.map((m) => setSummary(env, input, m, m.market.key === input.base?.market.key ? null : baseTotals))
  if (summaries.length) card.sections.push({ style: 'plain', lines: summaries })
  const compared = summaries.some((l) => 'text' in l && /[▲▼]/.test(l.text))
  const extras = compared && input.base ? [`▲▼ 与 ${escapeMarkdown(input.base.market.name)} 比较`] : []
  card.footer = footerText(env.core.format, newest, extras)
  card.notices = input.notices
  card.actions = input.actions
  return card
}
