// 批量查价命令后面的整段文字 → PasteParse（§6.5.1–§6.5.2）。只提出每一行的读法，物品由 appraise 识别后用
// selectHypotheses 选。
//
// - 表头：第一行（命令所在的那一行）全是参数时；第一行是空的时看第二行。第一行开头是参数、后面是物品时
//   （「Jita Raven*2」）参数先记在表头里，这一行另给一组去掉参数的读法。
// - 格式：有 [船, 名称] 行 → EFT；有 Item Required 表头 → 游戏工业窗口；其余逐行。
// - 分列行（游戏复制）：有 Tab 按 Tab 切，否则 2 个以上连续空格也算分列；名字是第 1 列，数量是第 2 列（空 = 1）。
//   Tab 被换成单个空格时按「压平的分列行」给出几种切法。
// - 行号从清单的第一行算起（表头和开头的空行不算），和用户粘贴的内容对得上；表头写在命令后面还是下一行都一样。

import { MAX_LINES } from '../../constants'
import type { CoreFailure, PasteHeader, PasteLine, PasteParse } from '../types'
import { eftHeader, eftItem, isBracketLine, isMutationBlockStart } from './eft'
import { parseHeaderLine } from './header'
import type { MarketMatcher } from './header'
import { columnQuantity, dedupeHypotheses, readLine } from './quantity'
import type { Hypothesis } from './quantity'
import { hasContent, normalizeLine, stripGameMarkup } from './text'

export interface PasteOptions {
  matchMarket: MarketMatcher
  /** 默认 MAX_LINES；表头和空行不算 */
  maxLines?: number
}

type SkipReason = PasteParse['skipped'][number]['reason']

interface Row {
  lineNo: number
  /** 原文去掉首尾空白（回显给用户的就是它） */
  raw: string
  /** 规范化以后 */
  text: string
}

/** 第一行开头的表头参数去掉以后剩下的物品部分 */
interface Inline {
  lineNo: number
  rest: string
}

/** 同一行写多个物品时的分隔符。「，」要在 NFKC 之前认（NFKC 会把它变成和千分位一样的逗号） */
const ITEM_SEPARATORS = /[、，;；|｜]/
const BLUEPRINT_COPY = /\((?:copy|拷贝|复制)\)/i
const MULTI_SPACE = /\s{2,}/

class Builder {
  readonly lines: PasteLine[] = []
  readonly skipped: PasteParse['skipped'] = []
  readonly fittings: PasteParse['fittings'] = []

  skip(lineNo: number, raw: string, reason: SkipReason) {
    this.skipped.push({ lineNo, raw, reason })
  }

  add(line: PasteLine) {
    this.lines.push(line)
  }
}

/** 只有一种读法（EFT 的行结构明确） */
function only(name: string, quantity: number, kind: Hypothesis['kind']): Hypothesis[] {
  return [{ name, quantity, kind }]
}

function toRows(text: string): Row[] {
  return text.split(/\r\n|\r|\n|\u2028|\u2029/).map((line, i) => {
    const raw = stripGameMarkup(line)
    return { lineNo: i + 1, raw: raw.trim(), text: normalizeLine(raw) }
  })
}

/** Tab 分列的行不拆；其他行按分隔符拆成几个物品 */
function splitPieces(raw: string): string[] {
  if (raw.includes('\t')) return [raw]
  return raw.split(ITEM_SEPARATORS).map((piece) => piece.trim()).filter(Boolean)
}

function isIndustryHeader(text: string): boolean {
  const [first = '', second = ''] = text.toLowerCase().split(/\s+/, 2)
  return (first === 'item' && second === 'required') || (first === '物品' && /^(?:需求|需要)/.test(second))
}

/**
 * 分列行的读法：第 1 个非空列是名字，紧跟着的一列是数量（空 = 1）。Tab 分列一定是游戏复制的，优先用；
 * 多个空格分列时第 2 列真是数量才优先，否则可能只是手打多了一个空格（「Raven  Navy Issue」），和其他读法一起比
 */
function columnsHypothesis(cells: string[], tabbed: boolean): Hypothesis | 'bad' | undefined {
  const at = cells.findIndex((cell) => cell.trim())
  if (at < 0) return undefined
  const quantity = columnQuantity(cells[at + 1])
  if (quantity === 'bad') return 'bad'
  const kind = tabbed || quantity !== undefined ? 'columns' : 'flattened'
  return { name: cells[at].trim(), quantity: quantity ?? 1, kind }
}

/**
 * 一段文字（一行或一行里的一个物品）的读法。分列行先给分列的读法，再给合并空白以后的读法兜底
 * （用户手打的「Cap  Booster 800」第 1 列只有 Cap）。数量写错 → 'bad'
 */
function pieceHypotheses(text: string): Hypothesis[] | 'bad' {
  const tabbed = text.includes('\t')
  if (tabbed || MULTI_SPACE.test(text)) {
    const cells = text.split(tabbed ? '\t' : MULTI_SPACE)
    const columns = columnsHypothesis(cells, tabbed)
    if (columns === 'bad') return 'bad'
    const fallback = tabbed ? readLine(cells.find((c) => c.trim())?.trim() ?? '', { flattened: false }) : readLine(text.replace(/\s+/g, ' '))
    return dedupeHypotheses([...(columns ? [columns] : []), ...fallback.hypotheses])
  }
  const reading = readLine(text)
  return reading.badQuantity ? 'bad' : reading.hypotheses
}

function skipReason(text: string): SkipReason | undefined {
  if (!hasContent(text)) return 'empty'
  if (isBracketLine(text)) return 'slot'
  if (BLUEPRINT_COPY.test(text)) return 'bpc'
  return undefined
}

/** 通用的一行：可能有几个物品；inline 是第一行开头参数去掉以后的部分 */
function parseListRow(row: Row, b: Builder, inline?: Inline) {
  if (!row.text) return
  const pieces = splitPieces(row.raw)
  pieces.forEach((raw, i) => {
    const text = pieces.length === 1 ? row.text : normalizeLine(raw)
    const reason = skipReason(text)
    if (reason) return b.skip(row.lineNo, raw, reason)
    const hypotheses = pieceHypotheses(text)
    if (hypotheses === 'bad') return b.skip(row.lineNo, raw, 'quantity')
    const rest = i === 0 && inline?.lineNo === row.lineNo ? inline.rest : undefined
    const stripped = rest === undefined ? [] : pieceHypotheses(rest)
    const all = stripped === 'bad' ? hypotheses : dedupeHypotheses([...hypotheses, ...stripped.map((h) => ({ ...h, stripped: true }))])
    b.add({ lineNo: row.lineNo, raw, hypotheses: all })
  })
}

/** 游戏工业窗口：跳过表头、表头前面的蓝图行和「Minerals」这类分节标题 */
function parseIndustryWindow(rows: Row[], b: Builder) {
  const headers = new Set(rows.flatMap((row, i) => (isIndustryHeader(row.text) ? [i] : [])))
  const blueprints = new Set<number>()
  let previous = -1
  rows.forEach((row, i) => {
    if (!headers.has(i)) return
    // 第一个表头以前的都是蓝图行；后面的表头只算紧挨着的上一行
    for (let j = i - 1; j > previous; j--) {
      if (!rows[j].text) continue
      blueprints.add(j)
      if (previous >= 0) break
    }
    previous = i
  })
  rows.forEach((row, i) => {
    if (!row.text) return
    if (headers.has(i) || blueprints.has(i) || !/\d/.test(row.text)) return b.skip(row.lineNo, row.raw, 'header')
    parseListRow(row, b)
  })
}

/** EFT 装配；第一个 [船, 名称] 以前的行按通用格式 */
function parseEft(rows: Row[], b: Builder, inline?: Inline) {
  let fitting = -1
  let inMutation = false
  for (const row of rows) {
    if (!row.text) {
      inMutation = false
      continue
    }
    const header = eftHeader(row.text)
    if (header) {
      b.fittings.push(header)
      fitting = b.fittings.length - 1
      inMutation = false
      b.add({ lineNo: row.lineNo, raw: row.raw, hypotheses: only(header.ship, 1, 'whole'), fitting, role: 'hull' })
      continue
    }
    if (fitting < 0) {
      parseListRow(row, b, inline)
      continue
    }
    if (inMutation || isMutationBlockStart(row.text)) {
      inMutation = true
      b.skip(row.lineNo, row.raw, 'mutaplasmid')
      continue
    }
    const reason = skipReason(row.text)
    if (reason) {
      b.skip(row.lineNo, row.raw, reason)
      continue
    }
    addEftItem(row, fitting, b)
  }
}

function addEftItem(row: Row, fitting: number, b: Builder) {
  const item = eftItem(row.text)
  if (item.role === 'bad-quantity') return b.skip(row.lineNo, row.raw, 'quantity')
  const base = { lineNo: row.lineNo, raw: row.raw, fitting, ...(item.mutated ? { mutated: true } : {}) }
  if (item.role === 'cargo') {
    b.add({ ...base, hypotheses: only(item.name, item.quantity, 'explicit'), role: 'cargo' })
  } else {
    const charge = item.loadedCharge ? { loadedCharge: item.loadedCharge } : {}
    b.add({ ...base, hypotheses: only(item.name, 1, 'whole'), role: 'module', ...charge })
  }
}

interface Head {
  header: PasteHeader
  /** 清单从哪一行（rows 的下标）开始 */
  bodyStart: number
  inline?: Inline
}

/** 第一行全是参数 → 表头；第一行是空的时看第二行。第一行开头是参数、后面是物品 → inline */
function detectHeader(rows: Row[], matchMarket: MarketMatcher): Head | CoreFailure {
  const at = rows[0]?.text ? 0 : rows.length > 1 ? 1 : -1
  const row = rows[at]
  if (!row?.text) return { header: {}, bodyStart: 0 }
  const pieces = splitPieces(row.raw)
  const text = pieces.length === 1 ? row.text : normalizeLine(pieces[0])
  // 有 Tab 的是游戏复制的分列行，开头的词不会是参数
  const result = parseHeaderLine(text, matchMarket, { header: pieces.length === 1, inline: !row.text.includes('\t') })
  if ('ok' in result) return result
  if (result.kind === 'header') return { header: result.header, bodyStart: at + 1 }
  if (result.kind === 'inline') return { header: result.header, bodyStart: at, inline: { lineNo: row.lineNo, rest: result.rest } }
  return { header: {}, bodyStart: 0 }
}

/** 清单部分重新编号：第一个非空行（第一行带着物品时就是它）是第 1 行 */
function renumber(rows: Row[], head: Head): { body: Row[]; inline?: Inline } {
  const body = rows.slice(head.bodyStart)
  const first = head.inline ? 0 : Math.max(0, body.findIndex((row) => row.text))
  const shift = head.bodyStart + first
  const kept = body.slice(first).map((row) => ({ ...row, lineNo: row.lineNo - shift }))
  return head.inline ? { body: kept, inline: { ...head.inline, lineNo: head.inline.lineNo - shift } } : { body: kept }
}

/** 只处理前 max 个非空行，其余计数 */
function limitRows(rows: Row[], max: number): { kept: Row[]; truncated: number } {
  const kept: Row[] = []
  let count = 0
  let truncated = 0
  for (const row of rows) {
    if (!row.text) {
      if (count < max) kept.push(row)
    } else if (count < max) {
      kept.push(row)
      count++
    } else truncated++
  }
  return { kept, truncated }
}

function detectFormat(rows: Row[]): PasteParse['format'] {
  if (rows.some((row) => eftHeader(row.text))) return 'eft'
  if (rows.some((row) => isIndustryHeader(row.text))) return 'industry-window'
  return 'lines'
}

/** 表头里两个不同的市场、调整超出范围 → BAD_ARGUMENT（reason：two-markets / modifier-range） */
export function parsePaste(text: string, opts: PasteOptions): PasteParse | CoreFailure {
  const rows = toRows(text)
  const head = detectHeader(rows, opts.matchMarket)
  if ('ok' in head) return head
  const { body, inline } = renumber(rows, head)
  const { kept, truncated } = limitRows(body, Math.max(1, opts.maxLines ?? MAX_LINES))
  const b = new Builder()
  const format = detectFormat(kept)
  if (format === 'eft') parseEft(kept, b, inline)
  else if (format === 'industry-window') parseIndustryWindow(kept, b)
  else for (const row of kept) parseListRow(row, b, inline)
  return { header: head.header, format, fittings: b.fittings, lines: b.lines, skipped: b.skipped, truncated }
}
