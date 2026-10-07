// 从查询开头切出市场名（§2.0.5）。市场名只写在物品前面；多词名字和别名按最长匹配。
// 冲突时分别按 A「开头是市场，后面是物品」和 B「整句都是物品」解析：
//   只有一种精确命中就用那一种；两种都精确命中时用 A，另给 B（「查所有市场」）；都不精确时用 A。
// 「未知市场」只按结构判断，不看「像不像地名」：第一个词不是本群可见的市场、去掉它以后剩下的能在 0–3 档识别、
// 整句不能在 0–3 档识别。数量还没切掉，所以每段文字按 readLine 的几种读法分别识别，取最好的；
// 只是一个数量的读法（「1000」「10」）不算物品，免得「Tritanum 1000」被当成未知市场。

import { looksLikeQuantity, normalizeLine, readLine } from '../parse'
import type { ItemResolver, MarketDef, MarketSplit, Resolution, Scope } from '../types'

/** 识别得多好：none 认不出（含必须确认的档位）；prefix 前缀档；exact 0–2 档（编号、精确、别名） */
export type Recognition = 'none' | 'prefix' | 'exact'

const RANK: Record<Recognition, number> = { none: 0, prefix: 1, exact: 2 }

export interface SplitContext {
  /** 本群可见的市场；看不到或不存在返回 null */
  match(phrase: string): MarketDef | null
  /** 市场名和别名最多几个词 */
  maxWords: number
  items: Pick<ItemResolver, 'resolve'>
  scope: Scope
}

interface Token {
  text: string
  start: number
  end: number
}

function tokenize(text: string): Token[] {
  return [...text.matchAll(/\S+/g)].map((m) => {
    const start = m.index ?? 0
    return { text: m[0], start, end: start + m[0].length }
  })
}

export function recognitionOf(res: Resolution): Recognition {
  switch (res.kind) {
    case 'unique':
    case 'ambiguous':
      if (res.tier === 'prefix') return 'prefix'
      return res.tier === 'id' || res.tier === 'exact' || res.tier === 'alias' || res.tier === 'remote' ? 'exact' : 'none'
    // 套装和黑话里的组名都是别名档；不能上市场的物品是在别的范围里精确命中
    case 'set':
    case 'group':
    case 'out-of-scope':
      return 'exact'
    default:
      return 'none'
  }
}

/** 一段文字（可能还带着数量）最好能识别到哪一档；名字只是一个数量的读法不算 */
export function recognize(text: string, items: Pick<ItemResolver, 'resolve'>, scope: Scope): Recognition {
  if (!text) return 'none'
  let best: Recognition = 'none'
  for (const { name } of readLine(text, { flattened: false }).hypotheses) {
    if (looksLikeQuantity(name)) continue
    const found = recognitionOf(items.resolve(name, { scope, limit: 1 }))
    if (RANK[found] > RANK[best]) best = found
    if (best === 'exact') break
  }
  return best
}

/** 开头最长的、本群可见的市场名 */
function leadingMarket(text: string, tokens: Token[], ctx: SplitContext): { market: MarketDef; rest: string } | undefined {
  for (let n = Math.min(ctx.maxWords, tokens.length); n >= 1; n--) {
    const market = ctx.match(text.slice(0, tokens[n - 1].end))
    if (market) return { market, rest: n < tokens.length ? text.slice(tokens[n].start).trim() : '' }
  }
  return undefined
}

export function splitMarket(raw: string, ctx: SplitContext): MarketSplit {
  const text = normalizeLine(raw)
  const tokens = tokenize(text)
  if (!tokens.length) return { rest: '' }

  const lead = leadingMarket(text, tokens, ctx)
  const whole = () => recognize(text, ctx.items, ctx.scope)
  if (lead) {
    const a = recognize(lead.rest, ctx.items, ctx.scope) === 'exact'
    const b = whole() === 'exact'
    if (b && !a) return { rest: text }
    return a && b ? { market: lead.market, rest: lead.rest, alt: text } : { market: lead.market, rest: lead.rest }
  }

  if (tokens.length >= 2) {
    const rest = text.slice(tokens[1].start).trim()
    if (recognize(rest, ctx.items, ctx.scope) !== 'none' && whole() === 'none') return { rest, unknown: tokens[0].text }
  }
  return { rest: text }
}
