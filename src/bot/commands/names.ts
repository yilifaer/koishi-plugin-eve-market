// 卡片和按钮里的名字：物品的中英文名、分组、标题，按钮命令里的物品写法，市场列表。
// 返回的都是 Markdown 片段（已经转义），除了明确写着「命令参数」的。

import { MAX_BUTTON_COMMAND_CHARS } from '../../constants'
import type { CommandId } from '../../constants'
import { listPriceMode } from '../../core/format'
import type { DataSet, DisplaySettings, EveCore, ItemInfo, Lang, MarketDef, PriceFormatter } from '../../core/types'
import { escapeMarkdown } from '../view/escape'
import type { CommandNamer } from '../view/clickable'

/** 蓝图大类 */
const CATEGORY_BLUEPRINT = 9

/** 单语的名字（zh 没有中文名时用英文） */
export function itemName(item: ItemInfo, lang: Lang = 'zh'): string {
  return lang === 'en' || !item.zh ? item.en : item.zh
}

/** 文字里有汉字就算中文 */
export function langOf(text: string): Lang {
  return /[㐀-鿿]/.test(text) ? 'zh' : 'en'
}

function dataOf(core: Pick<EveCore, 'data'>): DataSet | undefined {
  try {
    return core.data.current()
  } catch {
    return undefined
  }
}

/** 分组名（「战列舰」）；数据里没有时 '' */
export function groupName(core: Pick<EveCore, 'data'>, item: ItemInfo): string {
  const group = dataOf(core)?.groups.get(item.groupId)
  return group ? group.zh || group.en : ''
}

/** 大类名（「蓝图」「涂装」），同名物品的候选里用来区分 */
export function categoryName(core: Pick<EveCore, 'data'>, item: ItemInfo): string {
  const category = dataOf(core)?.categories.get(item.categoryId)
  return category ? category.zh || category.en : ''
}

export function isT2Blueprint(item: ItemInfo): boolean {
  return item.categoryId === CATEGORY_BLUEPRINT && item.techLevel === 2
}

/** **乌鸦级** Raven ×10 · 战列舰；中文名和分组名一样时（PLEX 的「伊甸币」）写成 **PLEX** ×500 · 伊甸币 */
export function itemTitle(core: Pick<EveCore, 'data' | 'format'>, item: ItemInfo, quantity: number | null): string {
  const group = groupName(core, item)
  const qty = quantity && quantity > 1 ? ` ×${core.format.quantity(quantity)}` : ''
  if (!item.zh || item.zh === group) return `**${escapeMarkdown(item.en)}**${qty}${group ? ` · ${escapeMarkdown(group)}` : ''}`
  return `**${escapeMarkdown(item.zh)}** ${escapeMarkdown(item.en)}${qty}${group ? ` · ${escapeMarkdown(group)}` : ''}`
}

/**
 * 命令参数里的物品（compose 把名字拼进参数，例如「Jita ${name}*4」）：用 commandName（中文名唯一时用中文名），
 * 整条命令超过 100 字时换成 #typeID
 */
export function itemArgs(
  core: Pick<EveCore, 'items'>, namer: CommandNamer, id: CommandId, item: ItemInfo, compose: (name: string) => string,
): string {
  const args = compose(core.items.commandName(item))
  const length = namer.commandName(id).length + 1 + args.length
  return length > MAX_BUTTON_COMMAND_CHARS ? compose(`#${item.typeId}`) : args
}

/** 「Jita · Amarr · …」 */
export function marketNames(markets: readonly MarketDef[]): string {
  return markets.map((m) => escapeMarkdown(m.name)).join(' · ')
}

/** 按钮上和命令里写市场用的最短写法（Jita 4-4 → Jita） */
export function shortName(market: MarketDef): string {
  return market.shortAlias || market.name
}

/** 命令里的市场，后面带一个空格；没有市场时 '' */
export function marketPrefix(market: MarketDef | undefined): string {
  return market ? `${shortName(market)} ` : ''
}

type DisplayMode = 'full_and_compact' | 'full_only' | 'compact_only'

/** 数量合计这类数字：跟 priceDisplayMode，但完整和简写都有时只写简写（一行放得下） */
export function amountText(format: PriceFormatter, value: number, mode: DisplayMode): string {
  const price = format.isk(value, { mode })
  if (price.na) return '—'
  return mode === 'full_only' ? price.full ?? '—' : price.compact ?? price.full ?? '—'
}

/** 列表行里的价格（套装每一件、搜索结果每一行）：258,400,000 ISK（258.40M）、258.40M 或 —（跟 listPriceDisplayMode） */
export function listPriceText(format: PriceFormatter, value: number | undefined, display: Pick<DisplaySettings, 'priceDisplayMode' | 'listPriceDisplayMode'>): string {
  if (value === undefined) return '—'
  const price = format.isk(value, { mode: listPriceMode(display) })
  return price.compact && price.full ? `${price.full}（${price.compact}）` : price.full ?? price.compact ?? '—'
}
