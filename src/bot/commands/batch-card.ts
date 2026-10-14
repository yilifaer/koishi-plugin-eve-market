// 批量查价的卡片（§2.3.2–§2.3.5）：合计、调整前、和基准比较；明细（≤ 10 种详细、11–40 种紧凑、更多时拆成几条）；
// 警告集中放在明细后面、体积前面；装配估价按分类小计；运费只在估价市场是基准市场时有。
// 合计、调整前、按 Jita 合计、运费、到货成本跟 priceDisplayMode；每一行的价格跟 listPriceDisplayMode。
// 一个价格都没取到时合计写「—」，绝不写 0 ISK。

import {
  APPRAISAL_ID_HOURS, COMPACT_LINES, DETAIL_LINES, MAX_ACTIONS_PER_ROW, MAX_CANDIDATES, MAX_LINES, MAX_MESSAGE_CHARS,
  MAX_WARNING_LINES, PENDING_MINUTES, SPLIT_FIRST_ROWS, SPLIT_MAX_ROWS, SPLIT_PART_RESERVE, UNRESOLVED_BUTTON_LINES,
} from '../../constants'
import { formatPercent, listPriceMode } from '../../core/format'
import type {
  AppraisalResult, AppraisalRow, CoreFailure, DisplaySettings, EveCore, FreightRoute, MarketDef, PriceSide,
} from '../../core/types'
import type { Action, Card, Choice, Line, Section } from '../view/card'
import { escapeMarkdown, safeEcho } from '../view/escape'
import { emptyCard } from './context'
import { downtimeWarnings } from './downtime'
import { amountText, itemName, langOf, shortName } from './names'
import { diffText, footerText } from './quotes'
import { SIDE_LABEL } from './text'

export interface BatchEnv {
  core: Pick<EveCore, 'format' | 'markets'>
  display: Pick<DisplaySettings, 'priceDisplayMode' | 'listPriceDisplayMode'>
  routes: readonly FreightRoute[]
  /** 「批量查价」现在的名字 */
  commandName: string
  /** 「改用 Jita」：基准市场（本群看得到时） */
  base?: MarketDef
  /** 现在的时间（毫秒）；写了才会在每日维护时间里提示价格暂时取不到 */
  now?: number
}

export interface ResultOptions {
  /** 「全部」：每一种、每一条没计入的行都列出来 */
  all: boolean
  /** 「全部 从81」：从第 81 项接着列（上一次发不完时「下一页」按钮带的） */
  from?: number
  /** 最多发几条（回复额度剩下的） */
  maxParts: number
  /** 标题下的说明（例如「多行内容已按批量查价处理」） */
  note?: string
  notices: string[]
}

function modifierText(pct: number): string {
  return pct ? ` ${formatPercent(pct, true)}` : ''
}

/** 「Jita 4-4 · 出售价 -5%」 */
function paramsText(marketName: string, side: PriceSide, modifierPct: number): string {
  return `${escapeMarkdown(marketName)} · ${SIDE_LABEL[side]}${modifierText(modifierPct)}`
}

/** 合计这一类的金额（一行里写不下完整价格时只写简写） */
const amount = (env: BatchEnv, value: number) => amountText(env.core.format, value, env.display.priceDisplayMode)
/** 每一行里的金额 */
const rowAmount = (env: BatchEnv, value: number) => amountText(env.core.format, value, listPriceMode(env.display))
const listIsk = (env: BatchEnv, value: number) => env.core.format.isk(value, { mode: listPriceMode(env.display) })
const qty = (env: BatchEnv, n: number) => env.core.format.quantity(n)

/** 名称一律中文（没有中文名的写英文），粘贴的是英文也一样 */
function rowName(row: AppraisalRow): string {
  return escapeMarkdown(itemName(row.item))
}

function rowLabel(row: AppraisalRow, bold: boolean): string {
  const name = bold ? `**${rowName(row)}**` : rowName(row)
  return `${row.approx ? '≈' : ''}${name}${row.fallback ? '†' : ''}`
}

const priced = (rows: readonly AppraisalRow[]) => rows.filter((r): r is AppraisalRow & { total: number } => r.total !== null)
const hasPrices = (result: AppraisalResult) => result.rows.some((r) => r.total !== null)
const byTotal = <T extends { total: number }>(rows: readonly T[]) => [...rows].sort((a, b) => b.total - a.total)

// ------------------------------------------------------------------ 开头：合计、调整前、和基准比较

function title(result: AppraisalResult): { title: string; meta: string[] } {
  const params = paramsText(result.market.name, result.side, result.modifierPct)
  if (!result.fitting) return { title: `**批量估价** · ${params}`, meta: [] }
  const ship = escapeMarkdown(itemName(result.fitting.ship))
  const name = result.fitting.name.trim() ? `「${safeEcho(result.fitting.name)}」` : ''
  return { title: `**装配估价** · ${ship}${name}`, meta: [params] }
}

function summarySection(env: BatchEnv, result: AppraisalResult): Section {
  const { totals } = result
  // 一个价格都没取到：合计写「—」，原因在下面的警告里逐行列出
  if (!hasPrices(result)) return { style: 'plain', lines: [{ label: '**合计**', price: { na: true } }, { text: '没有取到任何价格' }] }
  const timeouts = result.noPrice.filter((n) => n.reason === 'timeout').length
  const facts = [
    result.modifierPct ? `调整前 ${amount(env, totals.market)}` : '',
    `${totals.pricedTypes} 种`,
    `${qty(env, totals.units)} 件`,
    timeouts ? `另有 ${timeouts} 种暂时取不到价格` : '',
  ].filter(Boolean)
  const lines: Line[] = [{ label: '**合计**', price: env.core.format.isk(totals.adjusted) }, { text: facts.join(' · ') }]
  const vs = result.vsBase
  const baseName = vs && env.core.markets.get(vs.marketKey)?.name
  if (vs && baseName) {
    const pct = diffText(vs.diffPct)
    const diff = pct ? `${vs.diffPct > 0 ? '高' : '低'} ${pct}` : '持平'
    lines.push({ text: `按 ${escapeMarkdown(baseName)} ${SIDE_LABEL[vs.side]}合计 ${amount(env, vs.total)}（${escapeMarkdown(result.market.name)} ${diff}）` })
  }
  return { style: 'plain', lines }
}

const GROUP_LABEL: Record<AppraisalRow['group'], string> = { hull: '船体', module: '装备', 'drone-charge': '无人机和弹药', other: '其他' }

/** 装配估价的分类小计：船体 乌鸦级 · 258.40M；装备 13 件 · 118.10M */
function subtotalSection(env: BatchEnv, result: AppraisalResult): Section | undefined {
  if (!result.fitting) return undefined
  const lines: Line[] = []
  for (const group of ['hull', 'module', 'drone-charge', 'other'] as const) {
    const rows = priced(result.rows).filter((r) => r.group === group)
    if (!rows.length) continue
    const total = rows.reduce((sum, r) => sum + r.total, 0)
    const units = rows.reduce((sum, r) => sum + r.quantity, 0)
    const what = group === 'hull' ? `${GROUP_LABEL.hull} ${rowName(rows[0])}`
      : group === 'module' ? `${GROUP_LABEL.module} ${qty(env, units)} 件`
        : GROUP_LABEL[group]
    lines.push({ label: `${what} ·`, price: listIsk(env, total) })
  }
  return lines.length ? { lines } : undefined
}

// ------------------------------------------------------------------ 明细

/** 详细排版：1. **乌鸦级** ×2 · `513.00M`，下一行「单价 270.00M → 256.50M」 */
function detailedLines(env: BatchEnv, rows: ReadonlyArray<AppraisalRow & { total: number }>, modifier: boolean): Line[] {
  return rows.flatMap((row): Line[] => {
    const unit = row.unit === null ? '—' : rowAmount(env, row.unit)
    const adjusted = modifier && row.adjustedUnit !== null ? ` → ${rowAmount(env, row.adjustedUnit)}` : ''
    return [
      { label: `${rowLabel(row, true)} ×${qty(env, row.quantity)} ·`, price: listIsk(env, row.total) },
      { text: `单价 ${unit}${adjusted}`, indent: 1 },
    ]
  })
}

/** 紧凑排版：- 乌鸦级 ×2 · 256.50M · **513.00M**（装配估价：1. 名称 ×6 · `12.60M`） */
function compactLine(env: BatchEnv, row: AppraisalRow & { total: number }, fitting: boolean): Line {
  if (fitting) return { label: `${rowLabel(row, false)} ×${qty(env, row.quantity)} ·`, price: listIsk(env, row.total) }
  const unit = row.adjustedUnit ?? row.unit
  return { text: `${rowLabel(row, false)} ×${qty(env, row.quantity)} · ${unit === null ? '—' : rowAmount(env, unit)} · **${rowAmount(env, row.total)}**` }
}

function rowsSection(env: BatchEnv, result: AppraisalResult, rows: ReadonlyArray<AppraisalRow & { total: number }>, detailed: boolean): Section {
  const fitting = !!result.fitting
  const lines = detailed ? detailedLines(env, rows, result.modifierPct !== 0) : rows.map((r) => compactLine(env, r, fitting))
  return { style: detailed || fitting ? 'ordered' : 'bullet', lines }
}

// ------------------------------------------------------------------ 警告

function noPriceText(result: AppraisalResult, reason: AppraisalResult['noPrice'][number]['reason']): string {
  if (reason === 'timeout') return '超时，暂时取不到价格'
  if (reason === 'market-unavailable') return '市场不可用'
  const what = result.side === 'sell' ? '无有效卖单' : result.side === 'buy' ? '无有效买单' : '无有效买单或卖单'
  return `${escapeMarkdown(result.market.name)} ${what}`
}

/** 匹配到几种物品时请写完整名称；只有模糊的建议时「是不是：X」 */
function unresolvedText(entry: AppraisalResult['unresolved'][number]): string {
  const head = `第 ${entry.lineNo} 行「${safeEcho(entry.raw)}」`
  if (entry.notTradable) return `${head}不能在市场上交易`
  if (entry.total > 1) return `${head}可能是 ${entry.total} 种物品，请写完整名称`
  if (!entry.suggestion) return `${head}没有找到`
  return `${head}没有找到，是不是：${escapeMarkdown(itemName(entry.suggestion, langOf(entry.raw)))}？`
}

function skippedText(entry: AppraisalResult['skipped'][number]): string | undefined {
  if (entry.reason === 'quantity') return `第 ${entry.lineNo} 行「${safeEcho(entry.raw)}」数量要是正整数`
  if (entry.reason === 'bpc') return `第 ${entry.lineNo} 行「${safeEcho(entry.raw)}」蓝图拷贝不能在市场交易`
  return undefined
}

/** 不计入合计的每一行，按行号排 */
export function warningLines(result: AppraisalResult): string[] {
  const entries: Array<{ no: number; text: string }> = []
  for (const u of result.unresolved) entries.push({ no: u.lineNo, text: unresolvedText(u) })
  for (const s of result.skipped) {
    const text = skippedText(s)
    if (text) entries.push({ no: s.lineNo, text })
  }
  for (const n of result.noPrice) {
    const row = result.rows.find((r) => r.item.typeId === n.item.typeId)
    const no = row?.sourceLines[0]
    const name = escapeMarkdown(itemName(n.item))
    entries.push({ no: no ?? 0, text: `${no === undefined ? '' : `第 ${no} 行 `}${name}：${noPriceText(result, n.reason)}` })
  }
  return entries.sort((a, b) => a.no - b.no).map((e) => e.text)
}

const warningHead = (count: number): Section => ({ style: 'plain', lines: [{ text: `⚠ 有 ${count} 行没有计入合计：` }] })

/** 有物品什么都没匹配到时，在警告后面说一句可能的原因（数据里没有的多半是这两种） */
function unknownNote(result: AppraisalResult): Section[] {
  const unknown = result.unresolved.some((u) => !u.notTradable && u.total === 0)
  return unknown ? [{ style: 'plain', lines: [{ text: '没有找到的可能是活动物品或者改过名的船，插件的数据里暂时没有' }] }] : []
}

/** 没计入合计的行最多列 15 行；more = 剩下的在哪里能看到 */
function warningSections(env: BatchEnv, result: AppraisalResult, more = ''): Section[] {
  const sections: Section[] = [...truncatedSection(result)]
  const lines = warningLines(result)
  if (lines.length) {
    const shown = lines.slice(0, MAX_WARNING_LINES).map((text): Line => ({ text }))
    if (lines.length > shown.length) shown.push({ text: `…另有 ${lines.length - shown.length} 行${more}` })
    sections.push(warningHead(lines.length), { lines: shown }, ...unknownNote(result))
  }
  return [...sections, ...fallbackSection(env, result)]
}

function truncatedSection(result: AppraisalResult): Section[] {
  return result.truncated ? [{ style: 'plain', lines: [{ text: `⚠ 清单太长，只处理了前 ${MAX_LINES} 行，剩下的请分开发` }] }] : []
}

function fallbackSection(env: BatchEnv, result: AppraisalResult): Section[] {
  const sections: Section[] = []
  const fallback = result.rows.find((r) => r.fallback)?.fallback
  const fallbackName = fallback && env.core.markets.get(fallback.marketKey)?.name
  if (fallback && fallbackName) {
    const modifier = result.modifierPct ? `（${formatPercent(result.modifierPct, true)} 照常计算）` : ''
    const text = `† 标记的物品 ${escapeMarkdown(result.market.name)} 没有价格，已改用 ${escapeMarkdown(fallbackName)} ${SIDE_LABEL[fallback.side]}${modifier}`
    sections.push({ style: 'plain', lines: [{ text }] })
  }
  return sections
}

// ------------------------------------------------------------------ 体积和运费

function volumeLine(env: BatchEnv, result: AppraisalResult): string {
  const parts = [`📦 打包体积 ${env.core.format.volume(result.totals.packagedM3)}`]
  const loaded = result.fitting?.loadedCharges
  if (loaded?.length) parts.push(`装填弹药按满装计算（${loaded.map((c) => `${c.modules} × ${qty(env, c.perModule)} 发`).join('、')}）`)
  if (result.mutated) parts.push('突变装备按基础型号估价')
  return parts.join(' · ')
}

function freightLines(env: BatchEnv, result: AppraisalResult): Line[] {
  const lines: Line[] = result.freight.map((f): Line => {
    const route = env.routes.find((r) => r.name === f.route)
    const extra = [
      route ? `· ${qty(env, route.iskPerM3)} ISK/m³ + 押金 ${formatPercent(route.collateralPct)}` : '',
      `· 到货成本 ${amount(env, f.landed)}`,
      f.contracts > 1 && route ? `· 超过 ${env.core.format.volume(route.maxVolume)}，需要拆成 ${f.contracts} 单` : '',
    ].filter(Boolean).join(' ')
    return { label: `🚚 运到 ${escapeMarkdown(f.route)} 约`, price: env.core.format.isk(f.fee), extra }
  })
  if (result.freight.length && result.freightMissing) {
    lines.push({ text: `（${result.freightMissing} 种物品没有 ${escapeMarkdown(result.market.name)} 出售价，押金没有算进去）` })
  }
  return lines
}

/** 一个价格都没有时不写运费（到货成本算不出来） */
function volumeSection(env: BatchEnv, result: AppraisalResult): Section {
  const freight = hasPrices(result) ? freightLines(env, result) : []
  return { style: 'plain', lines: [{ text: volumeLine(env, result) }, ...freight] }
}

// ------------------------------------------------------------------ 按钮和编号

function sideActions(env: BatchEnv, result: AppraisalResult): Action[] {
  const label: Record<PriceSide, string> = { sell: '改用出售价', buy: '改用收购价', mid: '改用中间价' }
  const actions: Action[] = (['sell', 'buy', 'mid'] as const)
    .filter((side) => side !== result.side)
    .map((side) => ({ label: label[side], command: { id: 'batch', args: `#${result.id} ${side}` } }))
  const base = env.base
  if (base && base.key !== result.market.key) actions.push({ label: `改用 ${shortName(base)}`, command: { id: 'batch', args: `#${result.id} ${shortName(base)}` } })
  return actions
}

/** 未识别的行不超过 3 行时，每行给候选（第 7 行：乌鸦级海军型 → 批量查价 #K7Q2 7=#17636） */
function unresolvedChoices(result: AppraisalResult): Choice[] {
  if (!result.unresolved.length || result.unresolved.length > UNRESOLVED_BUTTON_LINES) return []
  const choices: Choice[] = []
  for (const entry of result.unresolved) {
    const items = entry.candidates?.length ? entry.candidates : entry.suggestion ? [entry.suggestion] : []
    for (const item of items) {
      if (choices.length >= MAX_CANDIDATES) return choices
      choices.push({
        no: choices.length + 1,
        label: `第 ${entry.lineNo} 行：${escapeMarkdown(itemName(item, langOf(entry.raw)))}`,
        command: { id: 'batch', args: `#${result.id} ${entry.lineNo}=#${item.typeId}` },
      })
    }
  }
  return choices
}

// ------------------------------------------------------------------ 组装

const FULL_LIST = '完整清单'

function headCard(env: BatchEnv, result: AppraisalResult, options: ResultOptions): Card {
  const head = title(result)
  const card = emptyCard(head.title)
  card.meta = [...head.meta, ...options.note ? [options.note] : []]
  card.sections.push(summarySection(env, result))
  const subtotals = subtotalSection(env, result)
  if (subtotals) card.sections.push(subtotals)
  card.footer = footerText(env.core.format, result.dataTime, [`估价 #${result.id}`], `${escapeMarkdown(result.market.name)} `)
  card.warnings = downtimeWarnings(env.now, result.noPrice.some((n) => n.reason !== 'no-orders'))
  card.notices = options.notices
  return card
}

function firstCard(env: BatchEnv, result: AppraisalResult, rows: Section | undefined, options: ResultOptions): Card {
  const card = headCard(env, result, options)
  if (rows) card.sections.push(rows)
  card.sections.push(...warningSections(env, result, `，在「${FULL_LIST}」里`), volumeSection(env, result))
  return card
}

const lineSize = (line: Line) => ('text' in line ? line.text.length : line.label.length + 40) + 6
const counted = (chunks: Line[][]) => chunks.reduce((n, c) => n + c.length, 0)
const PART_CHARS = MAX_MESSAGE_CHARS - SPLIT_PART_RESERVE

/** 明细按长度分成最多 parts 条（按 Markdown 估算，纯文字更短）；used = 放进去的行数 */
function chunkRows(lines: Line[], parts: number): { chunks: Line[][]; used: number } {
  const chunks = fill(lines, Array.from({ length: Math.max(0, parts) }, () => PART_CHARS), lineSize)
  return { chunks, used: counted(chunks) }
}

/** 按顺序装进几条消息，第 i 条最多 room[i] 字；每条至少放一项（第一条可以一项都不放） */
function fill<T>(items: readonly T[], room: readonly number[], size: (item: T) => number): T[][] {
  const chunks: T[][] = []
  let at = 0
  for (const [i, max] of room.entries()) {
    const chunk: T[] = []
    let length = 0
    while (at < items.length) {
      const n = size(items[at])
      if (length + n > max && (chunk.length || i === 0)) break
      chunk.push(items[at++])
      length += n
    }
    chunks.push(chunk)
    if (at >= items.length) break
  }
  return chunks
}

/**
 * 估价结果 → 一条或几条卡片（按钮和编号只挂在最后一条）。
 * ≤ 10 种详细排版（按粘贴顺序；装配估价按金额）；11–40 种紧凑；更多时第一条放合计、警告、体积和金额最高的 30 种，
 * 其余拆成「明细 2/3」，放不下的只写「…其余 N 种共 X，已计入合计」和「完整清单」按钮；「全部」见 fullCards
 */
export function resultCards(env: BatchEnv, result: AppraisalResult, options: ResultOptions): Card[] {
  const rows = priced(result.rows)
  const fitting = !!result.fitting
  const detailed = !fitting && rows.length <= DETAIL_LINES
  const ordered = detailed ? rows : byTotal(rows)
  if (options.all && (ordered.length > COMPACT_LINES || warningLines(result).length > MAX_WARNING_LINES)) return fullCards(env, result, options)
  if (ordered.length <= COMPACT_LINES) {
    const card = firstCard(env, result, ordered.length ? rowsSection(env, result, ordered, detailed) : undefined, options)
    return [finish(env, result, card, [])]
  }
  const top = ordered.slice(0, SPLIT_FIRST_ROWS)
  const first = firstCard(env, result, rowsSection(env, result, top, false), options)
  const lines = ordered.slice(SPLIT_FIRST_ROWS, SPLIT_MAX_ROWS).map((r) => compactLine(env, r, fitting))
  const { chunks, used } = chunkRows(lines, options.maxParts - 1)
  const omitted = ordered.slice(SPLIT_FIRST_ROWS + used)
  const total = chunks.length + 1
  const cards = [first, ...chunks.map((chunk, i) => detailCard(result, chunk, i + 2, total))]
  return [...cards.slice(0, -1), finish(env, result, cards[cards.length - 1], omitted)]
}

function detailCard(result: AppraisalResult, lines: Line[], no: number, total: number): Card {
  const card = emptyCard(`**批量估价 #${result.id} 明细 ${no}/${total}**`)
  card.sections.push({ style: result.fitting ? 'ordered' : 'bullet', lines })
  return card
}

/** 最后一条：没列出的行写一句，加按钮和编号；警告没列完时也给「完整清单」 */
function finish(env: BatchEnv, result: AppraisalResult, card: Card, omitted: ReadonlyArray<{ total: number }>): Card {
  const actions: Action[][] = [sideActions(env, result)]
  if (omitted.length) {
    const sum = omitted.reduce((s, r) => s + r.total, 0)
    card.sections.push({ style: 'plain', lines: [{ text: `…其余 ${omitted.length} 种共 ${rowAmount(env, sum)}，已计入合计` }] })
  }
  if (omitted.length || warningLines(result).length > MAX_WARNING_LINES) {
    actions.unshift([{ label: FULL_LIST, command: { id: 'batch', args: `#${result.id} 全部` }, primary: true }])
  }
  card.actions = actions.filter((row) => row.length)
  const choices = unresolvedChoices(result)
  if (choices.length) card.choices = choices
  return card
}

// ------------------------------------------------------------------ 「全部」：完整清单

interface Entry {
  kind: 'row' | 'warning'
  line: Line
}

const sectionSize = (section: Section) => section.lines.reduce((n, l) => n + lineSize(l), 0)
const cardSize = (card: Card) => card.title.length + (card.footer?.length ?? 0) + 40
  + [...card.meta ?? [], ...card.notices ?? []].reduce((n, t) => n + t.length + 2, 0)
  + card.sections.reduce((n, s) => n + sectionSize(s), 0)

/**
 * 「全部」：金额从高到低的每一种（紧凑排版），后面是每一条没计入合计的行，一共 N 项。
 * 第一条放合计、体积，剩下的地方接着放明细；回复条数用完还没列完时，最后一条给「下一页」（全部 从M），点了接着列
 */
function fullCards(env: BatchEnv, result: AppraisalResult, options: ResultOptions): Card[] {
  const fitting = !!result.fitting
  const warnings = warningLines(result)
  const entries: Entry[] = [
    ...byTotal(priced(result.rows)).map((r): Entry => ({ kind: 'row', line: compactLine(env, r, fitting) })),
    ...warnings.map((text): Entry => ({ kind: 'warning', line: { text } })),
  ]
  const start = Math.min(Math.max(0, (options.from ?? 1) - 1), Math.max(0, entries.length - 1))
  const head = start === 0 ? headCard(env, result, options) : undefined
  if (head) head.sections.push(...truncatedSection(result), ...fallbackSection(env, result), volumeSection(env, result))
  const parts = Math.max(1, options.maxParts)
  const room = Array.from({ length: parts }, (_, i) => (i === 0 && head ? PART_CHARS - cardSize(head) : PART_CHARS))
  const chunks = fill(entries.slice(start), room, (e) => lineSize(e.line))
  const cards: Card[] = []
  let at = start
  for (const [i, chunk] of chunks.entries()) {
    const card = i === 0 && head ? head : emptyCard(`**批量估价 #${result.id} ${FULL_LIST}**`)
    if (chunk.length) card.meta = [...card.meta ?? [], `第 ${at + 1}–${at + chunk.length} 项，共 ${entries.length} 项`]
    card.sections.push(...entrySections(chunk, at, entries, warnings.length, fitting))
    at += chunk.length
    cards.push(card)
  }
  const last = cards[cards.length - 1]
  const actions: Action[][] = [sideActions(env, result)]
  if (at >= entries.length && warnings.length) last.sections.push(...unknownNote(result))
  if (at < entries.length) {
    last.sections.push({ style: 'plain', lines: [{ text: `…还有 ${entries.length - at} 项，点「下一页」接着看` }] })
    actions.unshift([{ label: '下一页', command: { id: 'batch', args: `#${result.id} 全部 从${at + 1}` }, primary: true }])
  }
  last.actions = actions.filter((row) => row.length)
  const choices = unresolvedChoices(result)
  if (choices.length) last.choices = choices
  return cards
}

/** 一条消息里的明细：连续的物品一段，没计入的行一段（第一条前面写「有 N 行没有计入合计」） */
function entrySections(chunk: readonly Entry[], at: number, entries: readonly Entry[], warnings: number, fitting: boolean): Section[] {
  const sections: Section[] = []
  for (const [i, entry] of chunk.entries()) {
    const prev = chunk[i - 1]
    if (prev?.kind !== entry.kind) {
      if (entry.kind === 'warning') {
        const first = entries[at + i - 1]?.kind !== 'warning'
        sections.push(first ? warningHead(warnings) : { style: 'plain', lines: [{ text: '⚠ 没有计入合计的行（接上）：' }] })
      }
      sections.push({ style: entry.kind === 'row' && fitting ? 'ordered' : 'bullet', lines: [] })
    }
    sections[sections.length - 1].lines.push(entry.line)
  }
  return sections
}

// ------------------------------------------------------------------ 只发表头、一行都没认出来、市场不可用

export interface HeaderView {
  marketName: string
  side: PriceSide
  modifierPct: number
}

const PASTE_HINT = '一行一个，可以直接从游戏里复制，也可以粘贴装配。'

/** 「请在 5 分钟内 @我 粘贴清单」；单聊里不用 @ */
const pasteWithin = (isDirect: boolean, what: string) => `请在 ${PENDING_MINUTES} 分钟内${isDirect ? '' : ' @我 '}${what}：${PASTE_HINT}`

/** 只发了表头：请在 5 分钟内 @我 粘贴清单 */
export function headerCard(env: BatchEnv, view: HeaderView, isDirect: boolean): Card {
  const card = emptyCard(`**${escapeMarkdown(env.commandName)}** · ${paramsText(view.marketName, view.side, view.modifierPct)}`)
  card.sections.push(
    { style: 'plain', lines: [{ text: pasteWithin(isDirect, '粘贴清单') }] },
    { lines: [{ text: '例：Raven*2' }, { text: '例：Tritanium 1000000' }] },
  )
  return card
}

/** 一行都没认出来：只写警告和用法，保留批量清单待办，可以重新粘贴 */
export function nothingCard(env: BatchEnv, result: AppraisalResult, isDirect: boolean): Card {
  const card = emptyCard(`**批量估价** · ${paramsText(result.market.name, result.side, result.modifierPct)}`)
  card.sections.push(...warningSections(env, result))
  if (!warningLines(result).length) card.sections.push({ style: 'plain', lines: [{ text: '⚠ 没有认出任何物品' }] })
  card.sections.push({ style: 'plain', lines: [{ text: pasteWithin(isDirect, '重新粘贴清单') }] })
  const choices = unresolvedChoices(result)
  if (choices.length) card.choices = choices
  return card
}

const UNAVAILABLE: Partial<Record<NonNullable<CoreFailure['quoteReason']>, string>> = {
  sync_error: '同步异常',
  first_sync: '首次同步还没完成',
  resyncing: '正在同步',
}

/** 整个市场不可用：不出合计，从不自动换市场；按钮改用基准市场和本群能用的其他市场 */
export function unavailableCard(env: BatchEnv, failure: CoreFailure, view: Omit<HeaderView, 'marketName'>): Card {
  const market = failure.marketKey ? env.core.markets.get(failure.marketKey) : undefined
  const name = market?.name ?? failure.marketKey ?? ''
  const card = emptyCard(`**批量估价** · ${paramsText(name, view.side, view.modifierPct)}`)
  const why = (failure.quoteReason && UNAVAILABLE[failure.quoteReason]) ?? 'ESI 授权或建筑访问权限异常'
  card.sections.push(
    { style: 'plain', lines: [{ text: `⚠ ${escapeMarkdown(name)} 市场数据暂时不可用（${why}）` }] },
    { style: 'plain', lines: [{ text: `清单已保存为 #${failure.appraisalId}（${APPRAISAL_ID_HOURS} 小时内有效），可以先改用其他市场估价。` }] },
  )
  const others = (failure.markets ?? []).map((key) => env.core.markets.get(key)).filter((m): m is MarketDef => !!m)
  const ordered = env.base && others.some((m) => m.key === env.base!.key) ? [env.base, ...others.filter((m) => m.key !== env.base!.key)] : others
  const buttons = ordered.slice(0, MAX_ACTIONS_PER_ROW).map((m, i): Action => ({
    label: `改用 ${shortName(m)}`,
    command: { id: 'batch', args: `#${failure.appraisalId} ${shortName(m)}` },
    ...i === 0 ? { primary: true } : {},
  }))
  if (buttons.length && failure.appraisalId) card.actions.push(buttons)
  return card
}
