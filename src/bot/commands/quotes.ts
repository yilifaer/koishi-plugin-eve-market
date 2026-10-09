// 报价的显示：每个市场的状态（缓存、同步异常、授权异常、超时……）、和基准市场比较的 ▲▼、页脚的更新时间。

import { SERVER_LABEL, STALE_AFTER_MINUTES } from '../../constants'
import { formatAgo, formatChange } from '../../core/format'
import type { PriceFormatter, PriceQuote } from '../../core/types'
import { QUOTE } from './text'

/** 一个市场这次的结果：badge 写在小标题后面；problem 不为空时不显示价格，只写这一句 */
export interface QuoteView {
  badge?: string
  problem?: string
}

const ago = (quote: PriceQuote, now: number) =>
  formatAgo(quote.dataTime === null ? quote.ageSec ?? 0 : Math.max(0, (now - quote.dataTime) / 1000))

/** 价格能不能用、怎么标；quote 为 null = 等超时了还没回来 */
export function quoteView(quote: PriceQuote | null, now: number, newest: number | null): QuoteView {
  if (!quote) return { problem: QUOTE.timeout }
  switch (quote.status) {
    case 'ok':
      return staleBadge(quote, now, newest)
    case 'stale':
      return { badge: staleText(quote, now) }
    case 'unavailable':
      if (quote.reason === 'sync_error') return { problem: QUOTE.syncDown }
      return { problem: quote.downtime ? QUOTE.downtime : QUOTE.esiDown }
    case 'auth_error':
      return { problem: QUOTE.authDown }
    case 'not_ready':
      if (quote.reason === 'first_sync') return { problem: QUOTE.firstSync }
      if (quote.reason === 'resyncing') return { problem: QUOTE.resyncing }
      return { problem: QUOTE.authDown }
    case 'timeout':
      return { problem: QUOTE.timeout }
  }
}

function staleText(quote: PriceQuote, now: number): string {
  if (quote.reason === 'sync_error') return QUOTE.syncError(ago(quote, now))
  if (quote.reason === 'refreshing') return QUOTE.refreshing(ago(quote, now))
  return quote.downtime ? QUOTE.downtimeCached : QUOTE.cached(ago(quote, now))
}

/** 同一张卡片里比最新的旧超过 10 分钟时写「18 分钟前」 */
function staleBadge(quote: PriceQuote, now: number, newest: number | null): QuoteView {
  if (quote.dataTime === null || newest === null) return {}
  return newest - quote.dataTime > STALE_AFTER_MINUTES * 60_000 ? { badge: ago(quote, now) } : {}
}

/** 有价格可以显示 */
export function usableQuote(quote: PriceQuote | null): quote is PriceQuote {
  return !!quote && (quote.status === 'ok' || quote.status === 'stale')
}

/** 几个报价里最新的数据时间 */
export function newestTime(quotes: ReadonlyArray<PriceQuote | null>): number | null {
  let newest: number | null = null
  for (const q of quotes) {
    if (usableQuote(q) && q.dataTime !== null && (newest === null || q.dataTime > newest)) newest = q.dataTime
  }
  return newest
}

/** (本市场 − 基准) ÷ 基准，百分数；缺一边或基准不是正数时 undefined */
export function diffPct(value: number | null | undefined, base: number | null | undefined): number | undefined {
  if (value === null || value === undefined || base === null || base === undefined || !(base > 0)) return undefined
  return ((value - base) / base) * 100
}

/** 相差多少（「4.5%」，保留 1 位，不带方向）；不到 0.1% 时 undefined */
export function diffText(pct: number): string | undefined {
  return formatChange(pct)
}

/** ▲4.5% / ▼3.6%：同侧比较，保留 1 位；相差不到 0.1% 或缺一边时不写 */
export function diffMark(value: number | null | undefined, base: number | null | undefined): string | undefined {
  const pct = diffPct(value, base)
  const text = pct === undefined ? undefined : diffText(pct)
  return pct !== undefined && text ? `${pct > 0 ? '▲' : '▼'}${text}` : undefined
}

/** 页脚：欧服 · 更新于 14:20 · …（where 是「Jita 4-4 」这种前缀，单个市场时写） */
export function footerText(format: PriceFormatter, dataTime: number | null, extras: string[] = [], where = ''): string {
  const updated = dataTime === null ? '' : `${where}更新于 ${format.clock(dataTime)}`
  return [SERVER_LABEL, updated, ...extras].filter(Boolean).join(' · ')
}
