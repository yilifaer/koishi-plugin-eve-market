// core 里唯一的金额格式化。版式（行内代码、粗体、括号）由 bot/view 决定，这里只出文字。
//
// 完整价格：绝对值 ≥ 100,000 取整，否则 2 位小数（5.40 ISK、12,345.67 ISK、258,400,000 ISK）。
// 简写：K / M / B / T，compactDecimals 位小数；不到 1,000 时和完整价格一样是 2 位小数，不带单位。

import { TIMEZONE } from '../../constants'
import type { Clock } from '../ports'
import type { DisplaySettings, FormattedPrice, PriceDisplayMode, PriceFormatOptions, PriceFormatter } from '../types'
import { formatDuration } from './duration'
import { formatFixed, formatTrimmed, roundHalfAway } from './number'
import { formatClock } from './time'

/** 完整价格从这里开始取整 */
const INTEGER_FROM = 100_000
/** 小于这个数时没有简写（简写和完整价格一样） */
const COMPACT_FROM = 1_000
/** 数量小于这个数时简写也写完整数字 */
const QUANTITY_COMPACT_FROM = 10_000
/** 体积小于这个数时保留 2 位小数 */
const VOLUME_INTEGER_FROM = 100
const MAX_COMPACT_DECIMALS = 4

const UNITS = [
  { suffix: 'K', size: 1e3 },
  { suffix: 'M', size: 1e6 },
  { suffix: 'B', size: 1e9 },
  { suffix: 'T', size: 1e12 },
] as const

export type FormatterDisplay = Pick<DisplaySettings, 'priceDisplayMode' | 'compactDecimals' | 'thousandSeparator' | 'showCurrency'>

function clampDecimals(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_COMPACT_DECIMALS, Math.max(0, Math.round(value))) : 2
}

/**
 * 1.25K / 1.25M / 1.25B / 1.25T。四舍五入后进位到 1000 时换下一个单位（999,999 → 1.00M）。
 * small：不到 1,000 时怎么写（价格 2 位小数；数量写整数）
 */
function compactNumber(value: number, decimals: number, grouping: boolean, trim: boolean, small: (v: number) => string): string {
  const abs = Math.abs(value)
  let unit = UNITS.length - 1
  while (unit >= 0 && abs < UNITS[unit].size) unit--
  if (unit < 0) {
    const text = small(value)
    if (Math.abs(roundHalfAway(value, 2)) < COMPACT_FROM) return text
    unit = 0
  }
  for (;; unit++) {
    const mantissa = roundHalfAway(value / UNITS[unit].size, decimals)
    if (Math.abs(mantissa) < 1000 || unit === UNITS.length - 1) {
      const text = trim ? formatTrimmed(mantissa, decimals, grouping) : formatFixed(mantissa, decimals, grouping)
      return `${text}${UNITS[unit].suffix}`
    }
  }
}

/** 完整价格（不带 ISK）：≥ 100,000 取整，否则 2 位小数。按 2 位小数四舍五入后的值判断，99,999.996 算 100,000 */
export function fullPrice(value: number, grouping: boolean, forceInteger = false): string {
  const integer = forceInteger || Math.abs(roundHalfAway(value, 2)) >= INTEGER_FROM
  return formatFixed(value, integer ? 0 : 2, grouping)
}

export function compactPrice(value: number, decimals: number, grouping = true): string {
  return compactNumber(value, clampDecimals(decimals), grouping, false, (v) => formatFixed(v, 2, grouping))
}

/** 列表行（批量查价每一行、材料清单、制造比价、套装每一件、搜索结果）用哪种显示方式 */
export function listPriceMode(display: Pick<DisplaySettings, 'priceDisplayMode' | 'listPriceDisplayMode'>): PriceDisplayMode {
  return display.listPriceDisplayMode === 'inherit' ? display.priceDisplayMode : 'compact_only'
}

export function createPriceFormatter(display: FormatterDisplay, clock: Clock, timeZone: string = TIMEZONE): PriceFormatter {
  const defaults: PriceFormatOptions = {
    mode: display.priceDisplayMode,
    compactDecimals: clampDecimals(display.compactDecimals),
    thousandSeparator: display.thousandSeparator,
    showCurrency: display.showCurrency,
  }

  function isk(value: number | null, overrides?: Partial<PriceFormatOptions>): FormattedPrice {
    // 没有价格（或算出了非数字）一律当成「没有」，绝不显示 0 ISK
    if (value === null || !Number.isFinite(value)) return { na: true }
    const o = { ...defaults, ...overrides }
    const compact = compactPrice(value, o.compactDecimals, o.thousandSeparator)
    if (o.mode === 'compact_only') return { na: false, compact }
    const full = `${fullPrice(value, o.thousandSeparator, o.integer)}${o.showCurrency ? ' ISK' : ''}`
    if (o.mode === 'full_only') return { na: false, full }
    const hasCompact = Math.abs(roundHalfAway(value, 2)) >= COMPACT_FROM
    return hasCompact ? { na: false, full, compact } : { na: false, full }
  }

  function quantity(n: number, compact = false): string {
    const grouping = defaults.thousandSeparator
    const whole = (v: number) => formatTrimmed(v, 2, grouping)
    if (!compact || Math.abs(n) < QUANTITY_COMPACT_FROM) return whole(n)
    return compactNumber(n, defaults.compactDecimals, grouping, true, whole)
  }

  return {
    isk,
    compact: (value) => compactPrice(value, defaults.compactDecimals, defaults.thousandSeparator),
    quantity,
    percent: formatPercent,
    volume: (m3) => formatVolume(m3, defaults.thousandSeparator),
    duration: formatDuration,
    clock: (ms) => formatClock(ms, clock.now(), timeZone),
  }
}

/**
 * p 是百分数（4.5 → 4.5%）。绝对值 ≥ 1 时 1 位小数，更小时 2 位（税率 0.25%），末尾的 0 去掉。
 * signed：正数前面加 +；负数总是带 -
 */
export function formatPercent(p: number, signed = false): string {
  if (!Number.isFinite(p)) return '—'
  const digits = Math.abs(p) >= 1 ? 1 : 2
  const text = formatTrimmed(p, digits, true)
  const plus = signed && roundHalfAway(p, digits) > 0 ? '+' : ''
  return `${plus}${text}%`
}

/** 50,328 m³；不到 100 m³ 时最多 2 位小数（1.35 m³） */
export function formatVolume(m3: number, grouping = true): string {
  if (!Number.isFinite(m3)) return '—'
  const text = Math.abs(m3) >= VOLUME_INTEGER_FROM ? formatFixed(m3, 0, grouping) : formatTrimmed(m3, 2, grouping)
  return `${text} m³`
}
