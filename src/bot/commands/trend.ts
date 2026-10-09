// 走势（§2.4、§6.8）：走势 [市场] <物品> [月|季|年]，2 条消息：走势图（PNG）+ 小卡片。
// - ESI 的成交历史按星域给：不写市场用基准市场（Jita）所在的星域，写了 NPC 市场用它的星域；PLEX 不管写了哪个市场
//   都用全局市场；套装把各件的日均价相加。玩家建筑市场没有成交历史：说明原因，给一个「看 Jita 走势」按钮，不悄悄改成 Jita。
// - 有 puppeteer 时出图（同一张图放内存缓存，键是 SVG 的摘要）；取到历史、确定要第一次渲染以后 3 秒没好发一次慢提示
//   （单聊额度少 1 条，留不出图和卡片时不发）。没有 puppeteer、渲染失败、图片发不出去时，卡片里加一行文字走势条；
//   出图时插件停用了就什么都不再发（和战报一样）。
// - 有成交的日子少于 3 天：只回「成交太少，无法绘图」。

import { DEADLINE_GUARD_MS, GLOBAL_MARKET_REGION, GLOBAL_MARKET_TYPES, QUERY_DEADLINE_MS, TREND_DAYS } from '../../constants'
import { CATEGORY_SHIP } from '../../core/items'
import { inDowntime, windowStart } from '../../core/market'
import { isFailure } from '../../core/types'
import type { CoreFailure, HistoryResult, ImplantSet, ItemInfo, MarketDef, ParsedQuery, TypeId } from '../../core/types'
import { describeError } from '../../core/util'
import { chartSvg, enoughData, isRenderError, roundVolume, sparkline, trendStats } from '../../render'
import type { RenderedImage, TrendSeries, TrendStats } from '../../render'
import type { Action, Card, Line } from '../view/card'
import { escapeMarkdown, hasUrl } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { amountText, groupName, itemArgs, marketPrefix, shortName } from './names'
import { diffText } from './quotes'
import { candidatesCard, notFoundCard, notTradableText, searchKeyword, setName, setsCard, unknownMarketCard } from './resolution'
import type { ChoiceOptions } from './resolution'
import { startSlowHint } from './slow'
import { SAY, TREND } from './text'
import { within } from './wait'

export function registerTrend(commands: CommandContext): void {
  commands.registry.register('trend', { args: '[query:text]', description: '走势：近 30 / 90 / 365 天的价格图' })
    ?.action(async ({ session }, query) => {
      if (!session) return
      await invoke(commands, 'trend', session, (inv) => runTrend(inv, typeof query === 'string' ? query : ''))
    })
}

// ------------------------------------------------------------------ 参数

export type TrendRange = keyof typeof TREND_DAYS

/** 按钮和命令里的写法（月 / 季 / 年）；按钮标签在 TREND.rangeLabel */
const RANGE_WORD: Record<TrendRange, string> = { month: '月', quarter: '季', year: '年' }
const RANGES: TrendRange[] = ['month', 'quarter', 'year']

const RANGE_WORDS: Array<[RegExp, TrendRange]> = [
  [/^(?:月|月度|30\s*天?)$/, 'month'],
  [/^(?:季|季度|90\s*天?)$/, 'quarter'],
  [/^(?:年|年度|365\s*天?)$/, 'year'],
]

export interface TrendArgs {
  /** 去掉范围以后的部分（市场和物品） */
  rest: string
  range: TrendRange
}

/** 末尾的「月 / 季 / 年」（也认月度、季度、年度、30、90、365），不写是月 */
export function parseTrendArgs(text: string): TrendArgs {
  const clean = text.replace(/\s+/g, ' ').trim()
  const m = /^(.*?)\s*(\S+(?:\s*天)?)$/.exec(clean)
  if (m && m[1]) {
    const hit = RANGE_WORDS.find(([re]) => re.test(m[2]))
    if (hit) return { rest: m[1].trim(), range: hit[1] }
  }
  // 只有范围、没有物品
  const only = RANGE_WORDS.find(([re]) => re.test(clean))
  return only ? { rest: '', range: only[1] } : { rest: clean, range: 'month' }
}

// ------------------------------------------------------------------ 流程

async function runTrend(inv: Invocation, text: string): Promise<void> {
  const args = parseTrendArgs(text)
  if (!args.rest) {
    await sendCard(inv, usageCard(inv))
    return
  }
  const parsed = await inv.core.parse.query(args.rest, { scope: 'market', access: inv.access, market: true, remote: true })
  if (isFailure(parsed)) return trendFailure(inv, parsed, args)
  if (!parsed.name) {
    await sendCard(inv, usageCard(inv))
    return
  }
  const res = parsed.resolution
  const word = RANGE_WORD[args.range]
  const prefix = marketPrefix(parsed.market)
  switch (res.kind) {
    case 'unique':
      return trendOf(inv, parsed, args.range, { item: res.item, typeIds: [res.item.typeId] })
    case 'set':
      return trendOf(inv, parsed, args.range, { set: res.set, typeIds: res.set.items.map((i) => i.typeId) })
    case 'sets':
      await sendCard(inv, setsCard(res.sets, parsed.name, (set) => ({ id: 'trend', args: `${prefix}${setName(set)} ${word}` })))
      return
    case 'ambiguous':
    case 'confirm':
    case 'group':
      await sendCard(inv, candidatesCard(inv.core, res, choiceOptions(inv, parsed, word)))
      return
    case 'out-of-scope':
      await inv.reply.text(notTradableText(res.item))
      return
    case 'none': {
      const keyword = searchKeyword(inv.core, parsed.name, res.suggestions)
      await sendCard(inv, notFoundCard(inv.core, res.suggestions, choiceOptions(inv, parsed, word, keyword)))
    }
  }
}

async function trendFailure(inv: Invocation, failure: CoreFailure, args: TrendArgs): Promise<void> {
  switch (failure.code) {
    case 'UNKNOWN_MARKET': {
      // 只列有成交历史的 NPC 市场：点了玩家建筑市场只会得到「ESI 不提供成交历史」
      const rest = `${failure.rest ?? ''} ${RANGE_WORD[args.range]}`
      await sendCard(inv, unknownMarketCard(inv.core, failure, inv.access, (m) => ({ id: 'trend', args: `${marketPrefix(m)}${rest}` }), hasHistory))
      return
    }
    case 'BAD_ARGUMENT':
      await inv.reply.text(SAY.badQuantity)
      return
    case 'DATA_NOT_READY':
      await inv.reply.text(SAY.loading)
      return
    default:
      inv.commands.logger.warn(`走势失败：${failure.code} ${failure.message ?? ''}`)
      await inv.reply.text(SAY.failed)
  }
}

function choiceOptions(inv: Invocation, parsed: ParsedQuery, word: string, keyword: string | null = parsed.name): ChoiceOptions {
  const prefix = marketPrefix(parsed.market)
  const options: ChoiceOptions = {
    query: parsed.name,
    command: (item) => ({ id: 'trend', args: itemArgs(inv.core, inv.render, 'trend', item, (name) => `${prefix}${name} ${word}`) }),
  }
  if (keyword !== null && !hasUrl(keyword) && inv.commands.registry.has('search')) {
    options.search = { id: 'search', args: `${prefix}${keyword}` }
    options.searchName = inv.commands.registry.name('search')
  }
  return options
}

// ------------------------------------------------------------------ 取历史、出图

interface Subject {
  item?: ItemInfo
  set?: ImplantSet
  typeIds: TypeId[]
}

/** 有成交历史的市场：NPC 空间站、星系、星域（玩家建筑没有） */
const hasHistory = (m: MarketDef): boolean => m.type !== 'structure' && m.regionId !== null

/** 看哪个市场的历史：写了就是它（玩家建筑除外），不写用基准市场；基准市场是建筑时用第一个能看到的 NPC 市场 */
function historyMarket(inv: Invocation, named: MarketDef | undefined): MarketDef | undefined {
  if (named) return named
  const base = inv.core.markets.configured('price.baseMarket', inv.access)
  return base && hasHistory(base) ? base : inv.core.markets.visible(inv.access).find(hasHistory)
}

/** 地点：卡片上写星域名，图上写「伏尔戈（Jita 4-4）」；全局市场写「全局市场」 */
interface Place {
  regionId: number
  card: string
  chart: string
  global: boolean
}

const GLOBAL_PLACE: Place = { regionId: GLOBAL_MARKET_REGION, card: TREND.global, chart: TREND.global, global: true }

/** NPC 市场所在的星域；没有可用的市场时 null */
function npcPlace(inv: Invocation, named: MarketDef | undefined): Place | null {
  const market = historyMarket(inv, named)
  if (!market || market.regionId === null) return null
  const regionId = market.regionId
  const region = inv.core.data.current().universe.regions.get(regionId)
  const name = region ? region.zh || region.en : String(regionId)
  const chart = market.type === 'region' || market.name === name ? name : `${name}（${market.name}）`
  return { regionId, card: name, chart, global: false }
}

/** PLEX 这类全宇宙统一交易的物品：历史总在全局市场 */
const allGlobal = (typeIds: readonly TypeId[]) => typeIds.every((id) => GLOBAL_MARKET_TYPES.includes(id))

async function trendOf(inv: Invocation, parsed: ParsedQuery, range: TrendRange, subject: Subject): Promise<void> {
  // PLEX 的历史和写了哪个市场无关：写了玩家建筑市场也照样看全局市场（卡片上写明是全局市场）
  const global = allGlobal(subject.typeIds)
  if (!global && parsed.market?.type === 'structure') return structureCard(inv, parsed.market, subject, range)
  const place = global ? GLOBAL_PLACE : npcPlace(inv, parsed.market)
  if (!place) {
    await inv.reply.text(TREND.noMarket)
    return
  }
  const days = TREND_DAYS[range]
  const history = await within(inv.core.history.get(place.regionId, subject.typeIds, days), QUERY_DEADLINE_MS + DEADLINE_GUARD_MS)
  if (!history || isFailure(history)) return historyFailure(inv, history, { named: parsed.market, subject, place, range })
  // 窗口最后一天是今天（UTC 日，和 HistoryService 的窗口一致）
  const series: TrendSeries = { points: history.points, days, end: windowStart(inv.commands.clock.now(), 1) }
  if (!enoughData(series)) {
    await sendCard(inv, thinCard(inv, parsed.market, subject, place, range))
    return
  }
  const stats = trendStats(series)!
  const image = await chartImage(inv, () => chartSvg({
    item: chartItemName(inv, subject),
    place: place.chart,
    days,
    end: series.end,
    points: series.points,
    ...history.missing.length ? { note: `缺 ${history.missing.length} 件` } : {},
  }, { formatter: inv.core.format }))
  if (image === 'closed') return
  const shown = image ? await inv.reply.image(image.data, image.mime) : false
  await sendCard(inv, trendCard(inv, { market: parsed.market, subject, place, range, stats, history, spark: shown ? null : sparkline(series) }))
}

/**
 * 出图：缓存里有就直接用（puppeteer 后来停用了也照样发）；第一次渲染超过 SLOW_HINT_MS 发一次慢提示。
 * 没有 puppeteer、渲染失败（写日志）时 null；出图时插件停用了返回 'closed'（什么都不再发）
 */
async function chartImage(inv: Invocation, build: () => string): Promise<RenderedImage | null | 'closed'> {
  const media = inv.commands.media
  if (!media) return null
  const svg = build()
  const hit = media.charts.cached(svg)
  if (hit) return hit
  if (!media.renderer.available()) return null
  // 慢提示只为第一次渲染；提示后面还要发图和卡片
  const hint = startSlowHint(inv, 2, () => TREND.hint)
  try {
    return await media.charts.get(svg)
  } catch (e) {
    // 出图时没有传 signal：取消只可能是插件停用
    if (isRenderError(e, 'aborted')) return 'closed'
    if (!isRenderError(e, 'unavailable')) inv.commands.logger.warn(`走势图出图失败：${describeError(e)}`)
    return null
  } finally {
    // 已经开始发的提示先发完，图排在它后面
    hint.stop()
    await hint.sent()
  }
}

interface FailureView {
  /** 用户写的市场（按钮里带上） */
  named: MarketDef | undefined
  subject: Subject
  place: Place
  range: TrendRange
}

async function historyFailure(inv: Invocation, failure: CoreFailure | null, view: FailureView): Promise<void> {
  if (failure?.code === 'NO_HISTORY') {
    await sendCard(inv, thinCard(inv, view.named, view.subject, view.place, view.range, true))
    return
  }
  if (failure?.code === 'DATA_NOT_READY') {
    await inv.reply.text(SAY.loading)
    return
  }
  // ESI 出错已经由 ESI 客户端记过；这里只记意料之外的
  if (failure && failure.code !== 'UPSTREAM_UNAVAILABLE') inv.commands.logger.warn(`取成交历史失败：${failure.code} ${failure.message ?? ''}`)
  await inv.reply.text(inDowntime(inv.commands.clock.now()) ? TREND.downtime : TREND.esiDown)
}

// ------------------------------------------------------------------ 卡片

/** 中文名；没有中文名、或者中文名就是分组名（PLEX 的「伊甸币」）时用英文名 */
function zhName(core: Invocation['core'], item: ItemInfo): string {
  return item.zh && item.zh !== groupName(core, item) ? item.zh : item.en
}

/** 卡片标题里的名字（已转义） */
function subjectName(inv: Invocation, subject: Subject): string {
  if (subject.set) return escapeMarkdown(setName(subject.set))
  return escapeMarkdown(zhName(inv.core, subject.item!))
}

/** 图上的名字：乌鸦级 Raven */
function chartItemName(inv: Invocation, subject: Subject): string {
  if (subject.set) return [setName(subject.set), subject.set.name.en].filter(Boolean).join(' ')
  const item = subject.item!
  const zh = zhName(inv.core, item)
  return zh !== item.en ? `${zh} ${item.en}` : item.en
}

/** 船按「艘」，其他按「个」；套装的成交量是各件加起来的，按「件」 */
function unitOf(subject: Subject): string {
  if (subject.set) return TREND.unitSet
  return subject.item?.categoryId === CATEGORY_SHIP ? TREND.unitShip : TREND.unitItem
}

/** 命令参数里的物品（套装用套装名） */
function subjectArgs(inv: Invocation, subject: Subject, id: 'trend' | 'price', compose: (name: string) => string): string {
  if (subject.set) return compose(setName(subject.set))
  return itemArgs(inv.core, inv.render, id, subject.item!, compose)
}

/** 走势按钮的市场前缀：指名 NPC 市场时带上；玩家建筑没有成交历史，不带（查价卡片也用） */
export function trendPrefix(market: MarketDef | undefined): string {
  return market && market.type !== 'structure' ? marketPrefix(market) : ''
}

/** 这几个范围的走势按钮，第一个是主按钮；args(范围的写法：月 / 季 / 年) → 命令参数（查价卡片也用） */
export function trendButtons(ranges: readonly TrendRange[], args: (word: string) => string): Action[] {
  return ranges.map((r, i): Action => ({
    label: TREND.rangeLabel[r],
    command: { id: 'trend', args: args(RANGE_WORD[r]) },
    ...i === 0 ? { primary: true } : {},
  }))
}

/** 其他范围的走势 + 查价；当前的范围不给按钮。named：用户写的 NPC 市场（按钮里带上） */
function trendActions(inv: Invocation, named: MarketDef | undefined, subject: Subject, range: TrendRange): Action[][] {
  const prefix = trendPrefix(named)
  const row = trendButtons(RANGES.filter((r) => r !== range), (word) => subjectArgs(inv, subject, 'trend', (name) => `${prefix}${name} ${word}`))
  if (inv.commands.registry.has('price')) {
    row.push({ label: inv.commands.registry.name('price'), command: { id: 'price', args: subjectArgs(inv, subject, 'price', (name) => `${prefix}${name}`) } })
  }
  return [row]
}

interface TrendView {
  market: MarketDef | undefined
  subject: Subject
  place: Place
  range: TrendRange
  stats: TrendStats
  history: HistoryResult
  /** 没有图时的文字走势条 */
  spark: string | null
}

function trendCard(inv: Invocation, view: TrendView): Card {
  const { stats, place } = view
  const days = TREND_DAYS[view.range]
  const mode = inv.commands.settings.display.priceDisplayMode
  const amount = (v: number) => amountText(inv.core.format, v, mode)
  const card = emptyCard(TREND.title(subjectName(inv, view.subject), escapeMarkdown(place.card), days))
  const change = diffText(stats.changePct)
  const latest: Line = { label: TREND.latest, price: inv.core.format.isk(stats.latest) }
  if (change) latest.extra = `${stats.changePct > 0 ? '▲' : '▼'}${change}`
  const lines: Line[] = [
    latest,
    { text: TREND.range(days, amount(stats.high), amount(stats.low)) },
    { text: TREND.volume(inv.core.format.quantity(roundVolume(stats.avgVolume), true), unitOf(view.subject), amount(stats.avgTurnover)) },
  ]
  if (view.spark) lines.push({ text: TREND.spark(view.spark) })
  card.sections.push({ lines })
  const notes = [place.global ? TREND.globalNote : TREND.regionNote(escapeMarkdown(place.card))]
  if (view.history.missing.length) notes.push(TREND.missing(view.history.missing.length))
  if (view.history.stale) notes.push(TREND.stale)
  card.sections.push({ style: 'plain', lines: notes.map((text) => ({ text })) })
  card.actions = trendActions(inv, view.market, view.subject, view.range)
  return card
}

/** 成交太少（或者完全没有成交记录） */
function thinCard(inv: Invocation, named: MarketDef | undefined, subject: Subject, place: Place, range: TrendRange, none = false): Card {
  const days = TREND_DAYS[range]
  const card = emptyCard(TREND.title(subjectName(inv, subject), escapeMarkdown(place.card), days))
  const text = none ? TREND.noHistory(subjectName(inv, subject), escapeMarkdown(place.card)) : TREND.thin(days)
  card.sections.push({ style: 'plain', lines: [{ text }] })
  card.actions = trendActions(inv, named, subject, range)
  return card
}

/** 玩家建筑市场：说明没有成交历史，按钮去看基准市场（Jita）的走势 */
async function structureCard(inv: Invocation, market: MarketDef, subject: Subject, range: TrendRange): Promise<void> {
  const card = emptyCard(TREND.structure(escapeMarkdown(market.name)))
  const base = historyMarket(inv, undefined)
  if (base) {
    const args = subjectArgs(inv, subject, 'trend', (name) => `${marketPrefix(base)}${name} ${RANGE_WORD[range]}`)
    card.actions.push([{ label: TREND.structureButton(shortName(base)), command: { id: 'trend', args }, primary: true }])
  }
  await sendCard(inv, card)
}

// ------------------------------------------------------------------ 用法

function usageCard(inv: Invocation): Card {
  const name = escapeMarkdown(inv.commands.registry.name('trend'))
  const visible = inv.core.markets.visible(inv.access).filter((m) => m.type !== 'structure')
  const example = visible[1] ?? visible[0]
  const card = emptyCard('**走势用法**')
  card.sections.push({
    lines: [
      { text: `${name} 乌鸦级：近 30 天的价格图（基准市场所在的星域）` },
      { text: `${name} 乌鸦级 季：近 90 天；写「年」是近 365 天` },
      { text: `${name} ${example ? escapeMarkdown(marketPrefix(example)) : ''}乌鸦级：指定 NPC 市场（按它所在的星域）` },
      { text: '玩家建筑市场没有成交历史' },
    ],
  })
  card.actions.push([{ label: '输入物品', command: { id: 'trend' }, fillOnly: true, primary: true }])
  return card
}
