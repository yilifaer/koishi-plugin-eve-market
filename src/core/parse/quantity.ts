// 数量写法（查价、批量查价、制造、反应通用）和一行文字的几种读法。
// 这里只提出「名字 × 数量」的假设，不识别物品；调用方识别以后用 chooseHypothesis 选。

import { MAX_QUANTITY } from '../../constants'
import { HAN, tokenize } from './text'
import type { Token } from './text'

/** 单位后面有几个 0：k 1e3，m 和 kk 1e6，b 1e9，万 1e4，亿 1e8 */
const UNIT_ZEROS: Record<string, number> = { k: 3, kk: 6, m: 6, b: 9, 万: 4, 亿: 8 }
const UNIT = '(?:kk|k|m|b|万|亿)'
const CLASSIFIER = '[个艘件发颗台只]'
/** 不含空格的数量（紧贴着名字写的时候用） */
const QTY_GLUED = `\\d(?:[\\d.,']*\\d)?${UNIT}?${CLASSIFIER}?`
/** 数字（分隔符可以是 , . ' 空格；是否严格三位一组由 splitNumber 判断）+ 可选单位 + 可选量词 */
const QTY_SHAPE = new RegExp(`^(\\d(?:[\\d.,' ]*\\d)?)(${UNIT})?${CLASSIFIER}?$`, 'i')

/** x 当乘号时前面必须是空格或汉字（Ravenx10 不算，X-Large 不受影响） */
const BEFORE_X = new RegExp(`[\\s${HAN}]`)
/** 「10*Raven」「10万三钛合金」「10x乌鸦级」：数量紧贴着名字 */
const LEADING_GLUED = new RegExp(`^(${QTY_GLUED})(?:\\s*[*×]\\s*|[xX]?(?=[${HAN}]))(\\S.*)$`, 'i')
/** 「三钛合金1000」：汉字后面紧跟数量 */
const TRAILING_GLUED = new RegExp(`^(.*[${HAN}])(${QTY_GLUED})$`, 'i')
const MULTIPLIER_TOKEN = /^[xX×*]$/
/** 游戏里复制的一行在 Tab 被换成单个空格以后，末尾通常是体积或估价 */
const GAME_ROW_TAIL = /\d\s*(?:m3|立方米)(?:\s|$)|\sISK$/i

/** 空格分隔的千分位最多几个词（1 000 000 000 000） */
const MAX_QTY_TOKENS = 5
/** 物品名最多几个词、几个字（数据里最长的是 10 个词、83 个字） */
const MAX_NAME_WORDS = 12
const MAX_NAME_CHARS = 100
/** 更长的行不可能是一种物品（游戏复制的整行也到不了），只当整行是名字，不再拆 */
const MAX_SPLIT_CHARS = 300

/**
 * columns：分列行（Tab 或多个空格）的第 1、2 列；explicit：末尾乘号；leading：数量在前；trailing：末尾数字；
 * flattened：Tab 被换成单个空格的游戏复制行；whole：整行是名字
 */
export type HypothesisKind = 'columns' | 'explicit' | 'leading' | 'trailing' | 'flattened' | 'whole'

/** 字段都可选，PasteLine.hypotheses 里的对象可以直接传给 chooseHypothesis */
export interface Hypothesis {
  name: string
  quantity: number
  kind?: HypothesisKind
  /** 第一行开头的表头参数去掉以后的读法：只有整行当物品认不出时才用 */
  stripped?: boolean
}

export interface LineReading {
  /** 按可能性从高到低，名字和数量都相同的只留一个 */
  hypotheses: Hypothesis[]
  /** 末尾写了乘号和数字，但不是 1 到 10¹² 之间的整数（*0、*0.5）：调用方回复「数量要是正整数」 */
  badQuantity: boolean
}

function splitNumber(body: string, hasUnit: boolean): { int: string; frac: string } | undefined {
  if (/^\d+$/.test(body)) return { int: body, frac: '' }
  // 同一种分隔符、严格三位一组，可以再带小数：1,000,000、1 000 000、1'000.5
  const grouped = /^(\d{1,3}(?:([,' ])\d{3})(?:\2\d{3})*)(?:\.(\d+))?$/.exec(body)
  if (grouped) return { int: grouped[1].replace(/[,' ]/g, ''), frac: grouped[3] ?? '' }
  // 点作千分位：1.000.000；只有一组（1.000）且没有单位时也算千分位，带单位时是小数（1.500k）
  if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(body) || (!hasUnit && /^\d{1,3}\.\d{3}$/.test(body))) {
    return { int: body.replace(/\./g, ''), frac: '' }
  }
  const decimal = /^(\d+)\.(\d+)$/.exec(body)
  return decimal ? { int: decimal[1], frac: decimal[2] } : undefined
}

/** 「10」「1,000,000」「2.5m」「3万」「10艘」→ 数量；不是 1 到 10¹² 之间的整数或者根本不是数量 → undefined */
export function parseQuantity(text: string): number | undefined {
  const m = QTY_SHAPE.exec(text.trim())
  if (!m) return undefined
  const zeros = m[2] ? UNIT_ZEROS[m[2].toLowerCase()] : 0
  const parts = splitNumber(m[1], zeros > 0)
  if (!parts) return undefined
  // 按十进制数字拼，不经过浮点乘法（1.1m 正好是 1,100,000）；超出单位位数的小数必须都是 0
  if (/[^0]/.test(parts.frac.slice(zeros))) return undefined
  const value = Number(parts.int + parts.frac.slice(0, zeros).padEnd(zeros, '0'))
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_QUANTITY ? value : undefined
}

/** 看起来是在写数量（数字开头，可带单位和量词），不管值对不对：用来区分「写错了数量」和「不是数量」 */
export function looksLikeQuantity(text: string): boolean {
  return QTY_SHAPE.test(text.trim())
}

/** 最后一个 * 或 ×：「Raven*10」「Raven * 10」 */
function splitAtStar(text: string): [string, string] | undefined {
  const at = Math.max(text.lastIndexOf('*'), text.lastIndexOf('×'))
  return at > 0 ? [text.slice(0, at).trim(), text.slice(at + 1).trim()] : undefined
}

/** 最后一个当乘号用的 x：前面是空格或汉字，后面（可以隔空格）是数字 */
function splitAtX(text: string): [string, string] | undefined {
  for (let at = text.length - 1; at > 0; at--) {
    if (text[at] !== 'x' && text[at] !== 'X') continue
    if (!BEFORE_X.test(text[at - 1])) continue
    const tail = text.slice(at + 1).trim()
    if (/^\d/.test(tail)) return [text.slice(0, at).trim(), tail]
  }
  return undefined
}

/** 末尾的乘号：「Raven*10」「Raven x 10」「乌鸦级×10艘」。数量写错 → 'bad' */
export function explicitQuantity(text: string): { name: string; quantity: number } | 'bad' | undefined {
  for (const split of [splitAtStar, splitAtX]) {
    const parts = split(text)
    if (!parts) continue
    const [name, tail] = parts
    const quantity = parseQuantity(tail)
    if (quantity !== undefined && name) return { name, quantity }
    if (name && looksLikeQuantity(tail)) return 'bad'
  }
  return undefined
}

const joinTokens = (tokens: Token[]) => tokens.map((t) => t.text).join(' ')

/** 从第 from 个词开始的数量；空格分隔的千分位有几种切法时全部给出，最长的在前 */
function quantitiesAt(tokens: Token[], from: number): number[] {
  const out: number[] = []
  for (let k = Math.min(MAX_QTY_TOKENS, tokens.length - from); k >= 1; k--) {
    const quantity = parseQuantity(joinTokens(tokens.slice(from, from + k)))
    if (quantity !== undefined && !out.includes(quantity)) out.push(quantity)
  }
  return out
}

/** 数量在前：「2 Raven」「2x Raven」「2 x Raven」「1 000 000 Tritanium」「10*Raven」「10万三钛合金」 */
function leadingReadings(text: string, tokens: Token[]): Hypothesis[] {
  const out: Hypothesis[] = []
  const glued = LEADING_GLUED.exec(text)
  const gluedQuantity = glued ? parseQuantity(glued[1]) : undefined
  if (glued && gluedQuantity !== undefined) out.push({ name: glued[2].trim(), quantity: gluedQuantity, kind: 'leading' })
  for (let k = Math.min(MAX_QTY_TOKENS, tokens.length - 1); k >= 1; k--) {
    let qtyText = joinTokens(tokens.slice(0, k))
    let next = k
    const multiplied = k === 1 ? /^(.+?)[xX×*]$/.exec(qtyText) : null
    if (multiplied) qtyText = multiplied[1]
    else if (MULTIPLIER_TOKEN.test(tokens[k].text)) next++
    if (next >= tokens.length) continue
    const quantity = parseQuantity(qtyText)
    if (quantity !== undefined) out.push({ name: text.slice(tokens[next].start).trim(), quantity, kind: 'leading' })
  }
  return out
}

/** 名字后面空格加数字：「Raven 2」「Cap Booster 800 100」「Tritanium 1 000 000」；汉字后面紧跟数字：「三钛合金1000」 */
function trailingReadings(text: string, tokens: Token[]): Hypothesis[] {
  const out: Hypothesis[] = []
  for (let k = 1; k <= Math.min(MAX_QTY_TOKENS, tokens.length - 1); k++) {
    const first = tokens[tokens.length - k]
    const quantity = parseQuantity(joinTokens(tokens.slice(tokens.length - k)))
    if (quantity !== undefined) out.push({ name: text.slice(0, first.start).trim(), quantity, kind: 'trailing' })
  }
  const glued = TRAILING_GLUED.exec(text)
  const gluedQuantity = glued ? parseQuantity(glued[2]) : undefined
  if (glued && gluedQuantity !== undefined) out.push({ name: glued[1].trim(), quantity: gluedQuantity, kind: 'trailing' })
  return out
}

/**
 * Tab 被换成单个空格的分列行：「Raven 2 Battleship Ship 50,000 m3」。名字是开头的几个词，后面紧跟的词是数量，
 * 再后面的忽略。每种切法都给出，由识别结果选（只接受 0–2 档，名字最长的优先）。
 * 行尾是体积或估价（明显是游戏复制的）时，数量那一列可能是空的（组装好的船），也给出数量 1 的切法。
 */
function flattenedReadings(text: string, tokens: Token[]): Hypothesis[] {
  if (tokens.length < 3) return []
  const gameRow = GAME_ROW_TAIL.test(text)
  const out: Hypothesis[] = []
  for (let i = 1; i < tokens.length && i <= MAX_NAME_WORDS; i++) {
    const name = text.slice(0, tokens[i - 1].end)
    if (name.length > MAX_NAME_CHARS) break
    const quantities = quantitiesAt(tokens, i)
    for (const quantity of quantities) out.push({ name, quantity, kind: 'flattened' })
    if (!quantities.length && gameRow) out.push({ name, quantity: 1, kind: 'flattened' })
  }
  return out
}

/** 名字和数量都相同的只留第一个 */
export function dedupeHypotheses(list: Hypothesis[]): Hypothesis[] {
  const seen = new Set<string>()
  return list.filter((h) => {
    const key = `${h.stripped ? 1 : 0}\u0000${h.quantity}\u0000${h.name}`
    if (!h.name || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 一行（已经规范化、不含换行）的几种读法：末尾乘号、数量在前、末尾数字、压平的分列行、整行是名字。
 * flattened：要不要试「Tab 被换成单个空格」的读法（批量查价要，查价不要）
 */
export function readLine(text: string, opts: { flattened?: boolean } = {}): LineReading {
  if (text.length > MAX_SPLIT_CHARS) return { hypotheses: [{ name: text, quantity: 1, kind: 'whole' }], badQuantity: false }
  const tokens = tokenize(text)
  const explicit = explicitQuantity(text)
  const list: Hypothesis[] = []
  if (explicit && explicit !== 'bad') list.push({ ...explicit, kind: 'explicit' })
  list.push(...leadingReadings(text, tokens), ...trailingReadings(text, tokens))
  if (opts.flattened !== false) list.push(...flattenedReadings(text, tokens))
  list.push({ name: text, quantity: 1, kind: 'whole' })
  return { hypotheses: dedupeHypotheses(list), badQuantity: explicit === 'bad' }
}

/** 分列行的数量列：「2」「1,000」「x2」→ 数量；写错的数字 → 'bad'；空的或者是别的文字（分组名、体积）→ undefined（按 1 件） */
export function columnQuantity(cell: string | undefined): number | 'bad' | undefined {
  const text = (cell ?? '').trim().replace(/^[xX×*]\s*/, '')
  if (!text) return undefined
  const quantity = parseQuantity(text)
  if (quantity !== undefined) return quantity
  return looksLikeQuantity(text) ? 'bad' : undefined
}
