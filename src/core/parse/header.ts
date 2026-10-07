// 批量查价的表头（§2.3.1）：市场、价格类型、±N% / N% / N折、#估价编号、全部、行号=#typeID，顺序任意。
// 市场由调用方的 matcher 认（本群看不到的市场和不存在的一样）；这里不识别物品。

import {
  APPRAISAL_ID_ALPHABET, APPRAISAL_ID_LENGTH, BARE_PCT_MAX, BARE_PCT_MIN, MAX_MODIFIER_PCT, PRICE_TYPE_WORDS,
} from '../../constants'
import type { CoreFailure, FailureReason, PasteHeader, PriceSide } from '../types'
import { explicitQuantity, looksLikeQuantity } from './quantity'
import { normalizeWord, tokenize } from './text'

/** 表头里的市场写法 → 本群可见的市场的 key（同一个市场的不同写法返回同一个 key）；看不到或不存在 → null */
export type MarketMatcher = (phrase: string) => string | null | undefined

/** 多词的市场名（Jita 4-4）最多几个词 */
const MAX_MARKET_WORDS = 4
/** N折：N 在 50–99 时 ×N/100，N 在 5–9.9 时 ×N/10 */
const DISCOUNT_PERCENT = { min: 50, max: 100 }
const DISCOUNT_TENTHS = { min: 5, max: 10 }

const ALL_WORD = '全部'
const APPRAISAL_ID = new RegExp(`^#([A-Za-z0-9]{${APPRAISAL_ID_LENGTH}})$`)
const REPLACE = /^(\d{1,4})=#(\d{1,10})$/

type Param =
  | { kind: 'market'; key: string; phrase: string; words: number }
  | { kind: 'side'; side: PriceSide }
  | { kind: 'modifier'; pct: number; word: string }
  | { kind: 'bad-modifier'; word: string }
  | { kind: 'appraisal'; id: string }
  | { kind: 'all' }
  | { kind: 'replace'; lineNo: number; typeId: number }

/** 表头行（全是参数）；inline = 开头是参数、后面是物品（「Jita Raven*2」），rest 是物品那部分 */
export type HeaderLine =
  | { kind: 'header'; header: PasteHeader }
  | { kind: 'inline'; header: PasteHeader; rest: string }
  | { kind: 'none' }

const NONE: HeaderLine = { kind: 'none' }
/** 第一行开头能拆出来的参数（估价编号、全部、行号替换只在单独的表头行里出现） */
const LEADING_KINDS = new Set<Param['kind']>(['market', 'side', 'modifier', 'bad-modifier'])

const roundPct = (value: number) => {
  const rounded = Math.round(value * 1e4) / 1e4
  return rounded === 0 ? 0 : rounded
}

/** 「-5%」「+10%」→ ±N；「95%」「95折」「9.5折」→ -5；看得出是调整但超出范围 → 'out-of-range'；不是调整 → undefined */
export function parseModifier(word: string): number | 'out-of-range' | undefined {
  const w = normalizeWord(word)
  const signed = /^([+-])(\d+(?:\.\d+)?)%$/.exec(w)
  const bare = /^(\d+(?:\.\d+)?)%$/.exec(w)
  const discount = /^(\d+(?:\.\d+)?)折$/.exec(w)
  let pct: number
  if (signed) pct = (signed[1] === '-' ? -1 : 1) * Number(signed[2])
  else if (bare) {
    const n = Number(bare[1])
    if (n < BARE_PCT_MIN || n > BARE_PCT_MAX) return 'out-of-range'
    pct = n - 100
  } else if (discount) {
    const n = Number(discount[1])
    if (n >= DISCOUNT_PERCENT.min && n < DISCOUNT_PERCENT.max) pct = n - 100
    else if (n >= DISCOUNT_TENTHS.min && n < DISCOUNT_TENTHS.max) pct = n * 10 - 100
    else return 'out-of-range'
  } else return undefined
  return Math.abs(pct) <= MAX_MODIFIER_PCT ? roundPct(pct) : 'out-of-range'
}

/** sell / 出售 / 卖单 …（不区分大小写） */
export function parseSide(word: string): PriceSide | undefined {
  const w = word.toLowerCase()
  return (['sell', 'buy', 'mid'] as const).find((side) => PRICE_TYPE_WORDS[side].includes(w))
}

/** #K7Q2：4 位，至少一个字母，只用不容易看错的字符（和物品的 #638 区分开） */
export function parseAppraisalId(word: string): string | undefined {
  const m = APPRAISAL_ID.exec(word)
  if (!m) return undefined
  const id = m[1].toUpperCase()
  if (![...id].every((c) => APPRAISAL_ID_ALPHABET.includes(c)) || !/[A-Z]/.test(id)) return undefined
  return id
}

function classify(words: string[], at: number, matchMarket: MarketMatcher): Param | undefined {
  const word = words[at]
  const side = parseSide(word)
  if (side) return { kind: 'side', side }
  const modifier = parseModifier(word)
  if (modifier === 'out-of-range') return { kind: 'bad-modifier', word }
  if (modifier !== undefined) return { kind: 'modifier', pct: modifier, word }
  const id = parseAppraisalId(word)
  if (id) return { kind: 'appraisal', id }
  if (word === ALL_WORD) return { kind: 'all' }
  const replace = REPLACE.exec(word)
  if (replace && Number(replace[1]) >= 1 && Number(replace[2]) >= 1) {
    return { kind: 'replace', lineNo: Number(replace[1]), typeId: Number(replace[2]) }
  }
  // 多词的市场名先按最长的匹配
  for (let n = Math.min(MAX_MARKET_WORDS, words.length - at); n >= 1; n--) {
    const phrase = words.slice(at, at + n).join(' ')
    const key = matchMarket(phrase)
    if (key) return { kind: 'market', key, phrase, words: n }
  }
  return undefined
}

function failure(reason: FailureReason, token: string, message: string): CoreFailure {
  return { ok: false, code: 'BAD_ARGUMENT', reason, token, message }
}

/** 把认出的参数合成表头；两个不同的市场、超出范围或互相矛盾的调整 → BAD_ARGUMENT */
function buildHeader(params: Param[]): PasteHeader | CoreFailure {
  const header: PasteHeader = {}
  let marketKey: string | undefined
  let modifierWord: string | undefined
  for (const param of params) {
    switch (param.kind) {
      case 'market':
        if (marketKey !== undefined && marketKey !== param.key) return failure('two-markets', param.phrase, '表头里有两个不同的市场')
        marketKey = param.key
        header.market ??= param.phrase
        break
      case 'side':
        header.side = param.side
        break
      case 'bad-modifier':
        return failure('modifier-range', param.word, '价格调整超出范围')
      case 'modifier':
        if (header.modifierPct !== undefined && header.modifierPct !== param.pct) {
          return failure('modifier-range', param.word, `表头里有两个不同的价格调整：${modifierWord} 和 ${param.word}`)
        }
        header.modifierPct = param.pct
        modifierWord = param.word
        break
      case 'appraisal':
        header.appraisalId = param.id
        break
      case 'all':
        header.all = true
        break
      case 'replace':
        header.replace = { ...header.replace, [param.lineNo]: param.typeId }
        break
    }
  }
  return header
}

/** 像物品而不像市场名的词：带数量（Raven*2、10）或者是 #typeID */
function looksLikeItem(word: string): boolean {
  return word.startsWith('#') || looksLikeQuantity(word) || explicitQuantity(word) !== undefined
}

export interface HeaderLineOptions {
  /** 整行都是参数时当表头（默认是） */
  header?: boolean
  /** 开头是参数、后面是物品时拆开（只用于第一行） */
  inline?: boolean
}

/**
 * 一行（已经规范化）是不是表头。
 * - 每个词都是参数 → header；
 * - 没有市场、至少有一个别的参数、正好剩下一个不认得的词 X（不像物品）→ header，market = X（由 appraise 回复「未知市场：X」）；
 * - 开头是市场、价格类型、调整，后面还有别的 → inline（第二个不同的市场算物品名的开头：「Jita Amarr Shuttle」）。
 */
export function parseHeaderLine(line: string, matchMarket: MarketMatcher, opts: HeaderLineOptions = {}): HeaderLine | CoreFailure {
  const tokens = tokenize(line)
  const words = tokens.map((t) => t.text)
  const slots: Array<{ at: number; param?: Param }> = []
  let unknownCount = 0
  // 出现第二个不认得的词以后不可能是表头了，只剩「开头是参数」一种可能，后面不用再认
  for (let at = 0; at < words.length && unknownCount < 2;) {
    const param = classify(words, at, matchMarket)
    slots.push({ at, param })
    if (!param) unknownCount++
    at += param?.kind === 'market' ? param.words : 1
  }
  if (!slots.length) return NONE

  const known = slots.flatMap((s) => (s.param ? [s.param] : []))
  const unknown = slots.filter((s) => !s.param)
  if (opts.header !== false && unknown.length < 2) {
    if (!unknown.length) {
      const header = buildHeader(known)
      return 'ok' in header ? header : { kind: 'header', header }
    }
    const word = words[unknown[0].at]
    if (unknown.length === 1 && known.length && !known.some((p) => p.kind === 'market') && !looksLikeItem(word)) {
      const header = buildHeader(known)
      return 'ok' in header ? header : { kind: 'header', header: { ...header, market: word } }
    }
  }
  if (!opts.inline) return NONE

  const leading: Param[] = []
  let next = 0
  for (const slot of slots) {
    const param = slot.param
    if (!param || !LEADING_KINDS.has(param.kind)) break
    if (param.kind === 'market' && leading.some((p) => p.kind === 'market' && p.key !== param.key)) break
    leading.push(param)
    next = slot.at + (param.kind === 'market' ? param.words : 1)
  }
  if (!leading.length || next >= tokens.length) return NONE
  const header = buildHeader(leading)
  return 'ok' in header ? header : { kind: 'inline', header, rest: line.slice(tokens[next].start).trim() }
}
