// 认不出唯一物品时的卡片（§2.0.4、§2.2.6、§2.2.7）：候选、没有找到、套装等级、未知市场、不能上市场。
// 候选的每一项都是一条完整命令（原来的市场、数量照样保留，只把物品名换成精确名），同时记编号待办。

import { CANDIDATE_OVERFLOW, MAX_ACTIONS_PER_ROW, MAX_CANDIDATES, OVERFLOW_EXAMPLES } from '../../constants'
import type { Access, CoreFailure, EveCore, ImplantSet, ItemInfo, MarketDef, Resolution } from '../../core/types'
import type { Card, Choice, CommandRef } from '../view/card'
import { escapeMarkdown, hasUrl, safeEcho } from '../view/escape'
import { emptyCard } from './context'
import { categoryName, isT2Blueprint, itemName, langOf, marketNames, shortName } from './names'
import { SAY } from './text'

type Listed = Extract<Resolution, { kind: 'ambiguous' | 'confirm' | 'group' }>

export interface ChoiceOptions {
  /** 用户写的物品名（回显前经过 safeEcho） */
  query: string
  /** 这个物品对应的完整命令 */
  command(item: ItemInfo): CommandRef
  /** 「全部结果」按钮、「发送「搜索 X」」里的搜索参数；不给 = 没有搜索命令 */
  search?: CommandRef
  /** 「搜索」命令现在的名字（提示语里用） */
  searchName?: string
}

/** 1. 大型护盾扩展装置 II · Large Shield Extender II；同名的不同物品加大类 */
function itemChoices(core: Pick<EveCore, 'data'>, items: ItemInfo[], options: ChoiceOptions): Choice[] {
  const names = items.map((i) => itemName(i))
  return items.map((item, i) => {
    const twin = names.some((n, j) => j !== i && n === names[i])
    const category = twin ? categoryName(core, item) : ''
    const detail = [item.zh ? item.en : '', category].filter(Boolean).map(escapeMarkdown).join(' · ')
    const choice: Choice = { no: i + 1, label: escapeMarkdown(names[i]), command: options.command(item) }
    if (detail) choice.detail = detail
    return choice
  })
}

function searchHint(options: ChoiceOptions, more: number): string {
  if (!options.searchName || !options.search) return `还有 ${more} 个，请把名字写完整一点`
  return `还有 ${more} 个，发送「${escapeMarkdown(options.searchName)} ${safeEcho(options.search.args ?? '')}」看全部`
}

/** 有歧义、要确认、黑话组名：列候选，从不替用户挑 */
export function candidatesCard(core: Pick<EveCore, 'data'>, res: Listed, options: ChoiceOptions): Card {
  const query = safeEcho(options.query)
  const overflow = res.total > CANDIDATE_OVERFLOW
  const shown = res.candidates.slice(0, overflow ? OVERFLOW_EXAMPLES : MAX_CANDIDATES)
  const title = overflow
    ? `**「${query}」匹配太多（${res.total} 个），例如：**`
    : res.kind === 'group'
      ? `**「${escapeMarkdown(res.groupName)}」包括以下物品，请选择：**`
      : `**「${query}」可能是以下物品，请选择：**`
  const card = emptyCard(title)
  card.choices = itemChoices(core, shown, options)
  const more = res.total - shown.length
  if (more > 0) card.meta.push(searchHint(options, more))
  if (more > 0 && options.search) card.actions.push([{ label: '全部结果', command: options.search }])
  return card
}

/** 没有找到：附最多 3 个最接近的（同样要点选）；一个都没有时只有第一句和最后一句 */
export function notFoundCard(core: Pick<EveCore, 'data'>, suggestions: ItemInfo[], options: ChoiceOptions): Card {
  const card = emptyCard(`没有找到「${safeEcho(options.query)}」对应的物品。`)
  const search = options.searchName && options.search
    ? `，或者发送「${escapeMarkdown(options.searchName)} ${safeEcho(options.search.args ?? '')}」`
    : ''
  card.meta.push(`也可以换成英文名、完整的中文名${search}。`)
  if (suggestions.length) {
    card.sections.push({ style: 'plain', lines: [{ text: '你是不是要找：' }] })
    card.choices = itemChoices(core, suggestions, options)
  }
  return card
}

/** 搜索这个关键词能不能列出东西（和「搜索」命令一样按名字找，范围不限） */
function searchable(core: Pick<EveCore, 'items'>, keyword: string): boolean {
  if (!keyword.trim() || hasUrl(keyword)) return false
  const found = core.items.search(keyword, { scope: 'any', offset: 0, limit: 0 })
  return !!found.exact || found.total > 0 || found.skins > 0
}

/** 两个名字共同的开头（英文不分大小写），按 query 的写法返回 */
function commonPrefix(query: string, name: string): string {
  const a = Array.from(query)
  const b = Array.from(name.toLowerCase())
  let n = 0
  while (n < a.length && n < b.length && a[n].toLowerCase() === b[n]) n++
  return a.slice(0, n).join('').trim()
}

/**
 * 「没有找到」里提示的搜索关键词：原样搜得到就用原样；否则用它和第一个建议共同的开头（「乌鸦机」和「乌鸦级」→「乌鸦」），
 * 也要搜得到；都不行返回 null，不提搜索（搜索不容错，照原样提示只会再得到一句「没有」）
 */
export function searchKeyword(core: Pick<EveCore, 'items'>, query: string, suggestions: readonly ItemInfo[]): string | null {
  if (searchable(core, query)) return query
  const first = suggestions[0]
  const prefix = first ? commonPrefix(query, itemName(first, langOf(query))) : ''
  return Array.from(prefix).length >= 2 && searchable(core, prefix) ? prefix : null
}

/** 「水晶」：各等级的套装让用户选 */
export function setsCard(sets: ImplantSet[], query: string, command: (set: ImplantSet) => CommandRef): Card {
  const card = emptyCard(`**「${safeEcho(query)}」有以下几种套装，请选择：**`)
  card.choices = sets.slice(0, MAX_CANDIDATES).map((set, i) => ({
    no: i + 1,
    label: escapeMarkdown(setName(set)),
    detail: escapeMarkdown(set.name.en),
    command: command(set),
  }))
  return card
}

/** 「高级水晶套装」 */
export function setName(set: ImplantSet): string {
  return set.name.zh ? `${set.name.zh}套装` : `${set.name.en} set`
}

/**
 * 未知市场 / 本群看不到的市场（同一句话）：按钮是前 4 个可用市场，保留原来的物品和数量。
 * usable：这个命令能用哪些市场（走势只列有成交历史的 NPC 市场）；不写 = 全部
 */
export function unknownMarketCard(
  core: Pick<EveCore, 'markets'>, failure: CoreFailure, access: Access, command: (market: MarketDef) => CommandRef,
  usable: (market: MarketDef) => boolean = () => true,
): Card {
  const markets = (failure.markets ?? core.markets.visible(access).map((m) => m.key))
    .map((key) => core.markets.get(key))
    .filter((m): m is MarketDef => !!m && usable(m))
  const card = emptyCard(SAY.unknownMarket(safeEcho(failure.token ?? '')))
  card.sections.push({ style: 'plain', lines: [{ text: markets.length ? SAY.marketsHere(marketNames(markets)) : SAY.noMarketsHere }] })
  const buttons = markets.slice(0, MAX_ACTIONS_PER_ROW).map((m) => ({ label: shortName(m), command: command(m) }))
  if (buttons.length) card.actions.push(buttons)
  return card
}

/** 「伊什塔级蓝图 不能在市场上交易（T2 蓝图一般通过发明获得）。」 */
export function notTradableText(item: ItemInfo): string {
  return SAY.notTradable(itemName(item), isT2Blueprint(item) ? SAY.t2Blueprint : '')
}
