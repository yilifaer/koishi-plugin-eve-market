// 走势图（§6.8）：星域成交历史 → 自包含的 SVG 字符串。纯函数，同样的输入总是同样的输出，不用浏览器就能做快照测试。
// - 横轴是窗口里的每一个 UTC 日；没有成交的日子没有柱子，折线用虚线跨过去；
// - 主线是每天的 average；最高–最低的阴影带裁到窗口内 average 中位数的 [0.5×, 2×]（每天的极值里常有手滑和骗局成交）；
// - 纵轴只按 average 缩放，上下留 3%；成交量里个别特别大的日子封顶画，换成深色；
// - 价格、数量都用 core 的 PriceFormatter，写法和卡片一致。
// 走势图样式有两种：K 线（默认）和折线（上面说的这种）；配色分深色 / 浅色，涨跌色可以红涨绿跌或绿涨红跌。
// K 线：每个有成交的日子一根蜡烛，实体从前一个有成交日的均价到当天均价（ESI 没有开盘 / 收盘），影线是当天最高 / 最低（同样裁掉离谱成交），
// 叠 5 / 20 / 60 日均线（用窗口前最多 59 个有成交的日子热身），标出区间最高 / 最低，下面的成交量柱跟着当天涨跌上色。
// 另有没有图时用的文字走势条（sparkline）和统计数字（trendStats），卡片也用它们，数字和图上一致。

import {
  CHART_COLORS, CHART_COLORS_LIGHT, CHART_FONT, CHART_HEIGHT, CHART_WIDTH, DAY_MS, KLINE_PADDING, SPARKLINE_SEGMENTS,
  TREND_BAND_CLAMP, TREND_MA_PERIODS, TREND_MA_WARMUP, TREND_MIN_DAYS, TREND_PADDING,
} from '../constants'
import { formatChange } from '../core/format'
import type { HistoryPoint, ImageTheme, PriceFormatter, TrendStyle, UpColor } from '../core/types'

type BaseColors = { readonly [K in keyof typeof CHART_COLORS]: string }
export type ChartPalette = { readonly [K in Exclude<keyof BaseColors, 'red' | 'green'> | 'up' | 'down']: string }

/** 主题 + 涨跌色 → 一套配色：red 是红涨绿跌时的涨色 */
export function chartPalette(theme: ImageTheme = 'dark', upColor: UpColor = 'red'): ChartPalette {
  const { red, green, ...rest } = (theme === 'light' ? CHART_COLORS_LIGHT : CHART_COLORS) as BaseColors
  return { ...rest, up: upColor === 'red' ? red : green, down: upColor === 'red' ? green : red }
}

export const DEFAULT_PALETTE: ChartPalette = chartPalette()

/** 一段窗口里的历史 */
export interface TrendSeries {
  /** HistoryService 的结果；窗口以外、日期重复（取后一条）、均价不是正数的点不算 */
  points: readonly HistoryPoint[]
  /** 窗口天数：30 / 90 / 365 */
  days: number
  /** 窗口最后一天（YYYY-MM-DD，UTC），一般是今天 */
  end: string
}

export interface ChartInput extends TrendSeries {
  /** 物品名，例如「乌鸦级 Raven」 */
  item: string
  /** 地点，例如「伏尔戈（Jita）」 */
  place: string
  /** 标题后面的补充，例如「缺 1 件」 */
  note?: string
  /** 页脚「截至」的日期；不写用最后一个有成交的日子 */
  asOf?: string
}

export interface ChartOptions {
  formatter: PriceFormatter
  /** 样式，默认 K 线 */
  trendStyle?: TrendStyle
  /** 配色，默认深色；写了 palette 时以 palette 为准 */
  theme?: ImageTheme
  upColor?: UpColor
  palette?: ChartPalette
  font?: string
}

export interface TrendStats {
  /** 有成交的天数 */
  tradingDays: number
  first: HistoryPoint
  last: HistoryPoint
  /** 最近一天的均价 */
  latest: number
  /** 区间涨跌（百分数）：第一个到最后一个有成交的日子的均价 */
  changePct: number
  /** 区间最高、最低均价 */
  high: number
  low: number
  /** 日均成交量、日均成交额（ISK）：没有成交的日子算 0；窗口最后一天还没有数据时不算这一天；套装的成交额按件相加 */
  avgVolume: number
  avgTurnover: number
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD → 从 1970-01-01 算起的第几天；格式不对时 NaN */
function dayNumber(date: string): number {
  if (!DATE_PATTERN.test(date)) return NaN
  const ms = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(ms) ? Math.round(ms / DAY_MS) : NaN
}

function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

interface Slotted extends HistoryPoint {
  /** 窗口里的第几天（0 起） */
  slot: number
}

interface Window {
  start: number
  days: number
  points: Slotted[]
  /** 窗口前面最多 TREND_MA_WARMUP 个有成交的日子（slot 为负），只给 K 线的开盘价和均线用 */
  prior: Slotted[]
}

function windowOf(series: TrendSeries): Window {
  const days = series.days
  const endDay = dayNumber(series.end)
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`窗口天数不对：${days}`)
  if (!Number.isFinite(endDay)) throw new RangeError(`窗口最后一天不对：${series.end}`)
  const start = endDay - days + 1
  const bySlot = new Map<number, Slotted>()
  for (const p of series.points) {
    const slot = dayNumber(p.date) - start
    if (!(slot < days) || !Number.isFinite(p.average) || p.average <= 0) continue
    const finite = (v: number) => (Number.isFinite(v) ? v : p.average)
    bySlot.set(slot, {
      ...p,
      highest: Math.max(finite(p.highest), p.average),
      lowest: Math.min(finite(p.lowest), p.average),
      volume: Number.isFinite(p.volume) && p.volume > 0 ? p.volume : 0,
      slot,
    })
  }
  const all = [...bySlot.values()].sort((a, b) => a.slot - b.slot)
  const prior = all.filter((p) => p.slot < 0)
  return { start, days, points: all.filter((p) => p.slot >= 0), prior: prior.slice(Math.max(0, prior.length - TREND_MA_WARMUP)) }
}

/** 有成交的天数够不够画图（少于 TREND_MIN_DAYS 天时回答「成交太少，无法绘图」） */
export function enoughData(series: TrendSeries): boolean {
  return windowOf(series).points.length >= TREND_MIN_DAYS
}

/** 当天的成交额：套装用各件分别算好再相加的 turnover，其他按成交量 × 均价 */
function turnoverOf(p: HistoryPoint): number {
  return p.turnover !== undefined && Number.isFinite(p.turnover) && p.turnover >= 0 ? p.turnover : p.volume * p.average
}

function statsOf(w: Window): TrendStats | null {
  const pts = w.points
  if (!pts.length) return null
  const first = pts[0]
  const last = pts[pts.length - 1]
  const averages = pts.map((p) => p.average)
  // ESI 第二天才给前一天的数据：最后一天没有数据时不算进日均
  const divisor = last.slot === w.days - 1 ? w.days : Math.max(1, w.days - 1)
  const volume = pts.reduce((sum, p) => sum + p.volume, 0)
  const turnover = pts.reduce((sum, p) => sum + turnoverOf(p), 0)
  const strip = ({ slot: _, ...p }: Slotted): HistoryPoint => p
  return {
    tradingDays: pts.length,
    first: strip(first),
    last: strip(last),
    latest: last.average,
    changePct: ((last.average - first.average) / first.average) * 100,
    high: Math.max(...averages),
    low: Math.min(...averages),
    avgVolume: volume / divisor,
    avgTurnover: turnover / divisor,
  }
}

/**
 * 日均成交量的取舍（图和卡片一样）：100 以上取整，以下保留 1 位小数，不到 0.1 保留 2 位，
 * 一年只成交几次的冷门物品不会显示成 0
 */
export function roundVolume(avg: number): number {
  if (!(avg > 0)) return 0
  if (avg >= 100) return Math.round(avg)
  return avg >= 0.1 ? Math.round(avg * 10) / 10 : Math.max(0.01, Math.round(avg * 100) / 100)
}

/** 统计行的数字；窗口里一天成交都没有时返回 null */
export function trendStats(series: TrendSeries): TrendStats | null {
  return statsOf(windowOf(series))
}

// ------------------------------------------------------------------ K 线

export type CandleDirection = 'up' | 'down' | 'flat'

export interface Candle {
  slot: number
  date: string
  /** 前一个有成交日的均价；第一天（前面没有历史）等于 close，画成一条横线 */
  open: number
  /** 当天均价 */
  close: number
  /** 影线：当天最高 / 最低，裁到窗口里均价中位数的 [0.5×, 2×] 和「实体范围外再多半个实体范围」以内，且不进实体 */
  high: number
  low: number
  /** 影线被裁掉了 */
  clippedHigh: boolean
  clippedLow: boolean
  volume: number
  direction: CandleDirection
}

export interface MovingAverage {
  period: number
  /** 每个有成交的窗口日一个点；前面不够 period 个有成交日的没有 */
  points: Array<{ slot: number; value: number }>
  /** 最后一天的值；一个点都没有时 null */
  latest: number | null
}

/** 每个有成交的日子一根蜡烛 */
export function candles(series: TrendSeries): Candle[] {
  return candlesOf(windowOf(series))
}

function candlesOf(w: Window): Candle[] {
  if (!w.points.length) return []
  const med = median(w.points.map((p) => p.average))
  let previous = w.prior.length ? w.prior[w.prior.length - 1].average : null
  const bodies = w.points.map((p) => {
    const open = previous ?? p.average
    previous = p.average
    return { open, close: p.average }
  })
  // 影线的上下限：均价中位数的 [0.5×, 2×]；再收到实体范围外加半个范围（至少 5%），一两个离谱成交不把整张图压扁
  const bodyHi = Math.max(...bodies.map((b) => Math.max(b.open, b.close)))
  const bodyLo = Math.min(...bodies.map((b) => Math.min(b.open, b.close)))
  const room = Math.max((bodyHi - bodyLo) * WICK_ROOM, med * WICK_MIN_ROOM)
  const bandHi = Math.min(med * TREND_BAND_CLAMP.max, bodyHi + room)
  const bandLo = Math.max(med * TREND_BAND_CLAMP.min, bodyLo - room)
  return w.points.map((p, i) => {
    const { open, close } = bodies[i]
    const bodyTop = Math.max(open, close)
    const bodyBottom = Math.min(open, close)
    return {
      slot: p.slot,
      date: p.date,
      open,
      close,
      high: Math.max(Math.min(p.highest, bandHi), bodyTop),
      low: Math.min(Math.max(p.lowest, bandLo), bodyBottom),
      clippedHigh: p.highest > bandHi && bandHi >= bodyTop,
      clippedLow: p.lowest < bandLo && bandLo <= bodyBottom,
      volume: p.volume,
      direction: close > open ? 'up' : close < open ? 'down' : 'flat',
    }
  })
}

/** 均价的简单移动平均（按有成交的天数数，不是日历天）；窗口前面的历史用来热身 */
export function movingAverages(series: TrendSeries, periods: readonly number[] = TREND_MA_PERIODS): MovingAverage[] {
  return movingAveragesOf(windowOf(series), periods)
}

function movingAveragesOf(w: Window, periods: readonly number[]): MovingAverage[] {
  const all = [...w.prior, ...w.points]
  return periods.map((period) => {
    const points: MovingAverage['points'] = []
    let sum = 0
    all.forEach((p, i) => {
      sum += p.average
      if (i >= period) sum -= all[i - period].average
      if (i >= period - 1 && p.slot >= 0) points.push({ slot: p.slot, value: sum / period })
    })
    return { period, points, latest: points.length ? points[points.length - 1].value : null }
  })
}

/** 区间最高 / 最低的那根蜡烛（同高取靠前的）；被裁掉的影线端点不算（那不是真的价格），全被裁掉时才用 */
export function extremes(list: readonly Candle[]): { high: Candle; low: Candle } | null {
  if (!list.length) return null
  const pick = (pool: readonly Candle[], better: (a: Candle, b: Candle) => boolean) => pool.reduce((best, c) => (better(c, best) ? c : best))
  const highPool = list.filter((c) => !c.clippedHigh)
  const lowPool = list.filter((c) => !c.clippedLow)
  return {
    high: pick(highPool.length ? highPool : list, (a, b) => a.high > b.high),
    low: pick(lowPool.length ? lowPool : list, (a, b) => a.low < b.low),
  }
}

const SPARK_LEVELS = '▁▂▃▄▅▆▇█'

/**
 * 文字走势条：窗口平均分成 segments 段，每段取成交量加权的均价，按最低到最高分 8 级。
 * 没有成交的段沿用前一段（开头的沿用后面第一段）。有成交的天数不够画图时返回 null。
 */
export function sparkline(series: TrendSeries, segments = SPARKLINE_SEGMENTS): string | null {
  const w = windowOf(series)
  if (w.points.length < TREND_MIN_DAYS) return null
  const count = Math.max(1, Math.min(Math.floor(segments), w.days))
  const sums = Array.from({ length: count }, () => ({ value: 0, weight: 0, plain: 0, n: 0 }))
  for (const p of w.points) {
    const s = sums[Math.min(count - 1, Math.floor((p.slot * count) / w.days))]
    s.value += p.average * p.volume
    s.weight += p.volume
    s.plain += p.average
    s.n++
  }
  const values: Array<number | null> = sums.map((s) => (s.n ? (s.weight > 0 ? s.value / s.weight : s.plain / s.n) : null))
  const firstValue = values.find((v): v is number => v !== null)!
  let previous = firstValue
  const filled = values.map((v) => (previous = v ?? previous))
  const lo = Math.min(...filled)
  const hi = Math.max(...filled)
  const flat = hi - lo <= Math.abs(hi) * 1e-9
  return filled
    .map((v) => SPARK_LEVELS[flat ? 3 : Math.round(((v - lo) / (hi - lo)) * (SPARK_LEVELS.length - 1))])
    .join('')
}

// ------------------------------------------------------------------ SVG 小工具

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** 坐标保留 1 位小数，输出稳定 */
function n(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return String(rounded === 0 ? 0 : rounded)
}

/**
 * 估算文字宽度（像素）。中文、全角、几何符号按 1 个字宽，英文数字按常见无衬线字体的平均宽度；
 * 只用来排版（标题缩字号、刻度留宽、图例靠右），宁可估宽一点。
 */
export function textWidth(text: string, size: number, bold = false): number {
  let em = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code >= 0x2000) em += 1
    else if (ch === ' ') em += 0.3
    else if ('.,:;!|\'·'.includes(ch) || ch === 'i' || ch === 'l' || ch === 'j') em += 0.32
    else if (ch === 'm' || ch === 'w' || ch === 'M' || ch === 'W') em += 0.85
    else if (ch >= 'A' && ch <= 'Z') em += 0.68
    else em += 0.58
  }
  return em * size * (bold ? 1.06 : 1)
}

interface TextAttrs {
  x: number
  y: number
  size: number
  fill: string
  anchor?: 'start' | 'middle' | 'end'
  weight?: number
}

function text(content: string, a: TextAttrs): string {
  const anchor = a.anchor && a.anchor !== 'start' ? ` text-anchor="${a.anchor}"` : ''
  const weight = a.weight ? ` font-weight="${a.weight}"` : ''
  return `<text x="${n(a.x)}" y="${n(a.y)}" font-size="${a.size}" fill="${a.fill}"${anchor}${weight}>${escapeXml(content)}</text>`
}

// ------------------------------------------------------------------ 刻度

const NICE_STEPS = [1, 2, 2.5, 5]
/** 2.5 的刻度要多一位小数（252.5M），只在 1 / 2 / 5 都不合适时用 */
const ODD_STEP_PENALTY = 0.75

function ticksFor(lo: number, hi: number, step: number): number[] {
  const ticks: number[] = []
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) ticks.push(Number((k * step).toPrecision(12)))
  return ticks
}

/** 价格刻度：步长 1 / 2 / 2.5 / 5 × 10^k（最小 0.01 ISK），刻度数尽量接近 target */
function niceTicks(lo: number, hi: number, target: number): { step: number; ticks: number[] } {
  const mag = 10 ** Math.floor(Math.log10(Math.max((hi - lo) / target, 0.01)))
  let best = { step: 0, ticks: [] as number[], score: Infinity }
  for (const scale of [mag / 10, mag, mag * 10]) {
    for (const s of NICE_STEPS) {
      const step = Number((s * scale).toPrecision(12))
      if (step < 0.01) continue
      const ticks = ticksFor(lo, hi, step)
      const score = Math.abs(ticks.length - target) + (s === 2.5 ? ODD_STEP_PENALTY : 0)
      if (score < best.score) best = { step, ticks, score }
    }
  }
  return { step: best.step, ticks: best.ticks }
}

const NICE_CEILS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

/** 往上取一个好读的数（成交量轴的顶） */
function niceCeil(value: number): number {
  if (!(value > 0)) return 1
  const mag = 10 ** Math.floor(Math.log10(value))
  const m = NICE_CEILS.find((c) => c * mag >= value * 0.999) ?? 10
  return Number((m * mag).toPrecision(12))
}

/** PriceFormatter 的简写在这个数上用的单位 */
function unitOf(value: number): number {
  const abs = Math.abs(value)
  for (const size of [1e12, 1e9, 1e6, 1e3]) if (abs >= size) return size
  return 1
}

/** 刻度够用的最少小数位：步长 2.5M → 1 位（252.5M），50K → 0 位 */
function tickDecimals(step: number, unit: number): number {
  const scaled = step / unit
  for (let d = 0; d < 3; d++) {
    const shifted = scaled * 10 ** d
    if (Math.abs(shifted - Math.round(shifted)) < 1e-6 * Math.max(1, shifted)) return d
  }
  return 3
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** 成交量轴的顶：有一两天特别大（超过 90 分位的 2 倍）时封顶，不让其他柱子都被压扁 */
function volumeCap(volumes: number[]): number {
  const positive = volumes.filter((v) => v > 0).sort((a, b) => a - b)
  if (!positive.length) return 1
  const max = positive[positive.length - 1]
  if (positive.length >= 5) {
    const limit = quantile(positive, 0.9) * 2
    if (limit > 0 && max > limit) return niceCeil(limit)
  }
  return niceCeil(max)
}

// ------------------------------------------------------------------ 横轴

interface XTick {
  slot: number
  label: string
}

function xTicks(start: number, days: number): XTick[] {
  const ticks: XTick[] = []
  if (days <= 100) {
    // 从最后一天往前每隔 step 天一个，MM/DD
    const step = days <= 14 ? 2 : days <= 31 ? 7 : days <= 62 ? 10 : 14
    for (let slot = days - 1; slot >= 0; slot -= step) ticks.unshift({ slot, label: dateOf(start + slot).slice(5).replace('-', '/') })
    return ticks
  }
  // 更长的窗口：每月 1 日；月份多时隔一个月一个（从最近的往前数）
  const firsts: number[] = []
  for (let slot = 0; slot < days; slot++) if (dateOf(start + slot).endsWith('-01')) firsts.push(slot)
  const every = firsts.length > 7 ? 2 : 1
  const kept = firsts.filter((_, i) => (firsts.length - 1 - i) % every === 0)
  kept.forEach((slot, i) => {
    const [year, month] = dateOf(start + slot).split('-').map(Number)
    ticks.push({ slot, label: i === 0 || month === 1 ? `${year}年${month}月` : `${month}月` })
  })
  return ticks
}

// ------------------------------------------------------------------ 版面（800×450 CSS 像素）

const W = CHART_WIDTH
const H = CHART_HEIGHT
const PAD_X = 24
const TITLE_Y = 36
const TITLE_SIZE = 22
const TITLE_MIN_SIZE = 16
const STAT_LABEL_Y = 66
const STAT_VALUE_Y = 91
const STAT_LABEL_SIZE = 13
const STAT_VALUE_SIZE = 19
const RULE_Y = 106
const PRICE_TOP = 124
const PRICE_BOTTOM = 308
const VOLUME_TOP = 332
const VOLUME_BOTTOM = 388
const AXIS_SIZE = 13
const CAPTION_SIZE = 11
const VOLUME_CAPTION = '成交量'
const X_LABEL_Y = 408
const FOOTER_Y = 436
const FOOTER_SIZE = 13
const LINE_WIDTH = 2.5
const MAX_BAR = 24
const MA_LEGEND_Y = 119
const MA_LEGEND_SIZE = 12
const MAX_CANDLE = 14
/** 影线在实体范围外最多多出多少（占实体范围的比例，至少占中位数的比例） */
const WICK_ROOM = 0.5
const WICK_MIN_ROOM = 0.05
const CLIP_NOTE = '影线截掉了离谱成交'
const LABEL_SIZE = 12

/** 标题：物品名加粗，后面的地点、天数用次要颜色；太长时先缩字号，再截短物品名 */
function titleSvg(input: ChartInput, p: ChartPalette): string {
  // 全角括号自带空白，后面的分隔点不再加空格
  let rest = ''
  let previous = input.item
  for (const part of [input.place, `近 ${input.days} 天`, input.note ?? '']) {
    if (!part) continue
    rest += `${/[）」》]$/.test(previous) ? '' : ' '}· ${part}`
    previous = part
  }
  const max = W - PAD_X * 2
  let item = input.item
  let size = TITLE_SIZE
  const width = () => textWidth(item, size, true) + textWidth(rest, size)
  while (size > TITLE_MIN_SIZE && width() > max) size--
  if (width() > max) {
    const chars = [...item]
    while (chars.length > 1 && width() > max) {
      chars.pop()
      item = `${chars.join('')}…`
    }
  }
  return `<text x="${PAD_X}" y="${TITLE_Y}" font-size="${size}" fill="${p.text}"><tspan font-weight="700">${escapeXml(item)}</tspan><tspan fill="${p.muted}">${escapeXml(rest)}</tspan></text>`
}

function statsSvg(stats: TrendStats | null, f: PriceFormatter, p: ChartPalette): string {
  const price = (v: number) => f.compact(v)
  const qty = (v: number) => f.quantity(roundVolume(v), true)
  let change = { text: '—', fill: p.text }
  if (stats) {
    // 和卡片一样：▲11.2%（1 位小数），不到 0.1% 算持平
    const pct = formatChange(stats.changePct)
    change = !pct ? { text: '持平', fill: p.text } : stats.changePct > 0 ? { text: `▲${pct}`, fill: p.up } : { text: `▼${pct}`, fill: p.down }
  }
  const tiles: Array<[string, string, string]> = [
    ['最新均价', stats ? price(stats.latest) : '—', p.text],
    ['区间涨跌', change.text, change.fill],
    ['最高均价', stats ? price(stats.high) : '—', p.text],
    ['最低均价', stats ? price(stats.low) : '—', p.text],
    ['日均成交量', stats ? qty(stats.avgVolume) : '—', p.text],
    ['日均成交额', stats ? price(stats.avgTurnover) : '—', p.text],
  ]
  const width = (W - PAD_X * 2) / tiles.length
  return tiles.map(([label, value, fill], i) => {
    const x = PAD_X + i * width
    return text(label, { x, y: STAT_LABEL_Y, size: STAT_LABEL_SIZE, fill: p.muted })
      + text(value, { x, y: STAT_VALUE_Y, size: STAT_VALUE_SIZE, fill, weight: 600 })
  }).join('')
}

/** 圆角只在柱顶；太窄的柱子画成直角 */
function barPath(x: number, top: number, width: number, bottom: number): string {
  const r = Math.min(3, width / 2, bottom - top)
  if (width < 6 || r < 1) return `M${n(x)} ${n(bottom)}V${n(top)}H${n(x + width)}V${n(bottom)}Z`
  return `M${n(x)} ${n(bottom)}V${n(top + r)}Q${n(x)} ${n(top)} ${n(x + r)} ${n(top)}H${n(x + width - r)}`
    + `Q${n(x + width)} ${n(top)} ${n(x + width)} ${n(top + r)}V${n(bottom)}Z`
}

/** 页脚右边的图例；从右往左排 */
function legendSvg(p: ChartPalette): string {
  const items: Array<[string, (x: number) => string]> = [
    ['日均价', (x) => `<line x1="${n(x)}" y1="${n(FOOTER_Y - 4.5)}" x2="${n(x + 16)}" y2="${n(FOOTER_Y - 4.5)}" stroke="${p.line}" stroke-width="${LINE_WIDTH}" stroke-linecap="round"/>`],
    ['每日最高–最低', (x) => `<rect x="${n(x)}" y="${n(FOOTER_Y - 11)}" width="16" height="12" rx="2" fill="${p.band}"/>`],
    ['成交量', (x) => `<rect x="${n(x + 4)}" y="${n(FOOTER_Y - 11)}" width="8" height="12" rx="1.5" fill="${p.volume}"/>`],
  ]
  let right = W - PAD_X
  const out: string[] = []
  for (const [label, key] of [...items].reverse()) {
    const tw = textWidth(label, FOOTER_SIZE)
    const textX = right - tw
    out.unshift(key(textX - 22) + text(label, { x: textX, y: FOOTER_Y, size: FOOTER_SIZE, fill: p.muted }))
    right = textX - 22 - 16
  }
  return out.join('')
}

/** K 线页脚右边的图例：涨、跌 */
function candleLegendSvg(p: ChartPalette): string {
  let right = W - PAD_X
  const out: string[] = []
  for (const [label, fill] of [['跌', p.down], ['涨', p.up]] as const) {
    const textX = right - textWidth(label, FOOTER_SIZE)
    out.unshift(`<rect x="${n(textX - 16)}" y="${n(FOOTER_Y - 11)}" width="10" height="12" rx="1.5" fill="${fill}"/>` + text(label, { x: textX, y: FOOTER_Y, size: FOOTER_SIZE, fill: p.muted }))
    right = textX - 16 - 14
  }
  return out.join('')
}

/** 标题和统计线下面一行：每条均线的颜色和最新值 */
function maLegendSvg(mas: MovingAverage[], f: PriceFormatter, p: ChartPalette, x0: number): string {
  const colors: Record<number, string> = { 5: p.ma5, 20: p.ma20, 60: p.ma60 }
  let x = x0
  const out: string[] = []
  for (const ma of mas) {
    const label = `MA${ma.period} ${ma.latest === null ? '—' : f.compact(ma.latest)}`
    const color = colors[ma.period] ?? p.line
    out.push(`<line x1="${n(x)}" y1="${MA_LEGEND_Y - 4}" x2="${n(x + 14)}" y2="${MA_LEGEND_Y - 4}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`)
    out.push(text(label, { x: x + 19, y: MA_LEGEND_Y, size: MA_LEGEND_SIZE, fill: p.muted }))
    x += 19 + textWidth(label, MA_LEGEND_SIZE) + 16
  }
  return out.join('')
}

interface KlineLayout {
  p: ChartPalette
  f: PriceFormatter
  xOf: (slot: number) => number
  yOf: (price: number) => number
  bodyWidth: number
  slotWidth: number
  left: number
  right: number
}

/** 价格区的 K 线：均线图例、均线、影线、实体、被裁影线的小帽、区间最高 / 最低标注 */
function klineSvg(list: Candle[], mas: MovingAverage[], l: KlineLayout): string[] {
  const { p, f, xOf, yOf } = l
  const out: string[] = []
  out.push(maLegendSvg(mas, f, p, l.left))

  const wicks: Record<CandleDirection, string[]> = { up: [], down: [], flat: [] }
  const bodies: Record<CandleDirection, string[]> = { up: [], down: [], flat: [] }
  const caps: string[] = []
  const capHalf = Math.max(2.5, Math.min(l.bodyWidth, 8) / 2)
  for (const c of list) {
    const x = xOf(c.slot)
    wicks[c.direction].push(`M${n(x)} ${n(yOf(c.high))}V${n(yOf(c.low))}`)
    // 实体至少 1 像素高，持平的画成一条横线
    const top = yOf(Math.max(c.open, c.close))
    const bottom = yOf(Math.min(c.open, c.close))
    const height = Math.max(1, bottom - top)
    const y = top - (height - (bottom - top)) / 2
    bodies[c.direction].push(`M${n(x - l.bodyWidth / 2)} ${n(y)}h${n(l.bodyWidth)}v${n(height)}h${n(-l.bodyWidth)}Z`)
    if (c.clippedHigh) caps.push(`M${n(x - capHalf)} ${n(yOf(c.high))}H${n(x + capHalf)}`)
    if (c.clippedLow) caps.push(`M${n(x - capHalf)} ${n(yOf(c.low))}H${n(x + capHalf)}`)
  }
  const wickWidth = l.slotWidth < 3 ? 1 : 1.3
  const maColors = [p.ma5, p.ma20, p.ma60]
  // 均线在蜡烛下面，别盖住实体
  mas.forEach((ma, i) => {
    if (ma.points.length < 2) return
    const d = `M${ma.points.map((pt) => `${n(xOf(pt.slot))} ${n(yOf(pt.value))}`).join('L')}`
    out.push(`<path d="${d}" fill="none" stroke="${maColors[i] ?? p.line}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#plot)"/>`)
  })
  for (const d of ['up', 'down', 'flat'] as const) {
    const color = d === 'up' ? p.up : d === 'down' ? p.down : p.flat
    if (wicks[d].length) out.push(`<path d="${wicks[d].join('')}" fill="none" stroke="${color}" stroke-width="${wickWidth}" clip-path="url(#plot)"/>`)
    if (bodies[d].length) out.push(`<path d="${bodies[d].join('')}" fill="${color}" clip-path="url(#plot)"/>`)
  }
  if (caps.length) out.push(`<path d="${caps.join('')}" fill="none" stroke="${p.muted}" stroke-width="1.5" clip-path="url(#plot)"/>`)

  // 区间最高 / 最低：标在影线端点外侧，水平方向收在绘图区里
  const ext = extremes(list)
  if (ext) {
    const label = (content: string, slot: number, y: number) => {
      const half = textWidth(content, LABEL_SIZE) / 2
      const cx = Math.min(Math.max(xOf(slot), l.left + half + 2), l.right - half - 2)
      return text(content, { x: cx, y, size: LABEL_SIZE, fill: p.text, anchor: 'middle' })
    }
    out.push(label(`高 ${f.compact(ext.high.high)}`, ext.high.slot, yOf(ext.high.high) - 5))
    // 暴跌时纵轴下限压得很低，「低」不要掉出价格区
    out.push(label(`低 ${f.compact(ext.low.low)}`, ext.low.slot, Math.min(yOf(ext.low.low) + LABEL_SIZE + 1, PRICE_BOTTOM - 2)))
  }
  return out
}

/** 走势图的 SVG（800×450）。有成交的天数少于 TREND_MIN_DAYS 时也能画，但调用方应该先用 enoughData 判断 */
export function chartSvg(input: ChartInput, options: ChartOptions): string {
  const p = options.palette ?? (options.theme || options.upColor ? chartPalette(options.theme, options.upColor) : DEFAULT_PALETTE)
  const kline = (options.trendStyle ?? 'kline') === 'kline'
  const f = options.formatter
  const font = options.font ?? CHART_FONT
  const w = windowOf(input)
  const pts = w.points
  const stats = statsOf(w)
  const candleList = kline ? candlesOf(w) : []
  const mas = kline ? movingAveragesOf(w, TREND_MA_PERIODS) : []

  // 纵轴：折线只按 average；K 线按裁过的影线和均线；上下留一点
  const averages = pts.map((pt) => pt.average)
  const scaled = kline
    ? [...candleList.flatMap((c) => [c.high, c.low]), ...mas.flatMap((m) => m.points.map((pt) => pt.value))]
    : averages
  let lo = scaled.length ? Math.min(...scaled) : 0
  let hi = scaled.length ? Math.max(...scaled) : 1
  const span = hi - lo
  if (span <= Math.abs(hi) * 1e-6) {
    const half = Math.max(Math.abs(hi) * 0.02, 0.01)
    lo -= half
    hi += half
  } else {
    const pad = kline ? KLINE_PADDING : TREND_PADDING
    lo -= span * pad
    hi += span * pad
  }
  lo = Math.max(0, lo)
  const { step, ticks } = niceTicks(lo, hi, 4.5)
  const tickLabels = ticks.map((v) => {
    const unit = unitOf(v)
    return f.isk(v, { mode: 'compact_only', compactDecimals: tickDecimals(step, unit) }).compact ?? ''
  })
  const cap = volumeCap(pts.map((pt) => pt.volume))
  const capLabel = f.quantity(cap, true)

  const labelWidth = Math.max(...tickLabels.map((t) => textWidth(t, AXIS_SIZE)), textWidth(capLabel, AXIS_SIZE), textWidth(VOLUME_CAPTION, CAPTION_SIZE))
  const left = Math.ceil(PAD_X + labelWidth + 10)
  const right = W - PAD_X
  const slotWidth = (right - left) / w.days
  const xOf = (slot: number) => left + (slot + 0.5) * slotWidth
  const yOf = (v: number) => PRICE_BOTTOM - ((v - lo) / (hi - lo)) * (PRICE_BOTTOM - PRICE_TOP)
  const volHeight = VOLUME_BOTTOM - VOLUME_TOP

  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${escapeXml(font)}">`)
  out.push(`<defs><clipPath id="plot"><rect x="${left}" y="${PRICE_TOP}" width="${n(right - left)}" height="${PRICE_BOTTOM - PRICE_TOP}"/></clipPath></defs>`)
  out.push(`<rect width="${W}" height="${H}" fill="${p.background}"/>`)
  if (p.panel !== p.background) {
    out.push(`<rect x="${left}" y="${PRICE_TOP}" width="${n(right - left)}" height="${PRICE_BOTTOM - PRICE_TOP}" fill="${p.panel}"/>`)
    out.push(`<rect x="${left}" y="${VOLUME_TOP}" width="${n(right - left)}" height="${volHeight}" fill="${p.panel}"/>`)
  }
  out.push(titleSvg(input, p))
  out.push(statsSvg(stats, f, p))
  out.push(`<line x1="${PAD_X}" y1="${RULE_Y}" x2="${right}" y2="${RULE_Y}" stroke="${p.grid}" stroke-width="1"/>`)

  // 价格网格和刻度
  ticks.forEach((v, i) => {
    const y = yOf(v)
    out.push(`<line x1="${left}" y1="${n(y)}" x2="${right}" y2="${n(y)}" stroke="${p.grid}" stroke-width="1"/>`)
    out.push(text(tickLabels[i], { x: left - 10, y: y + AXIS_SIZE * 0.35, size: AXIS_SIZE, fill: p.muted, anchor: 'end' }))
  })

  // 连续有成交的日子分成一段一段
  const runs: Slotted[][] = []
  for (const pt of pts) {
    const run = runs[runs.length - 1]
    if (run && pt.slot === run[run.length - 1].slot + 1) run.push(pt)
    else runs.push([pt])
  }

  const colorOf = (d: CandleDirection) => (d === 'up' ? p.up : d === 'down' ? p.down : p.flat)
  const barWidth = Math.max(1, Math.min(MAX_BAR, slotWidth * 0.6))
  const bodyWidth = Math.max(1, Math.min(MAX_CANDLE, slotWidth * (slotWidth < 4 ? 0.85 : 0.7)))
  if (pts.length && kline) {
    out.push(...klineSvg(candleList, mas, { p, f, xOf, yOf, bodyWidth, slotWidth, left, right }))
  } else if (pts.length) {
    const median_ = median(averages)
    const bandLo = median_ * TREND_BAND_CLAMP.min
    const bandHi = median_ * TREND_BAND_CLAMP.max
    const band = (pt: Slotted) => ({
      top: Math.max(Math.min(pt.highest, bandHi), pt.average),
      bottom: Math.min(Math.max(pt.lowest, bandLo), pt.average),
    })
    const bandPaths = runs.map((run) => {
      if (run.length === 1) {
        const pt = run[0]
        const { top, bottom } = band(pt)
        const half = Math.min(3, slotWidth * 0.3)
        return `M${n(xOf(pt.slot) - half)} ${n(yOf(top))}H${n(xOf(pt.slot) + half)}V${n(yOf(bottom))}H${n(xOf(pt.slot) - half)}Z`
      }
      const upper = run.map((pt) => `${n(xOf(pt.slot))} ${n(yOf(band(pt).top))}`)
      const lower = [...run].reverse().map((pt) => `${n(xOf(pt.slot))} ${n(yOf(band(pt).bottom))}`)
      return `M${upper.join('L')}L${lower.join('L')}Z`
    })
    out.push(`<path d="${bandPaths.join('')}" fill="${p.band}" clip-path="url(#plot)"/>`)

    // 跨过没有成交的日子：虚线
    const gaps: string[] = []
    for (let i = 1; i < runs.length; i++) {
      const a = runs[i - 1][runs[i - 1].length - 1]
      const b = runs[i][0]
      gaps.push(`M${n(xOf(a.slot))} ${n(yOf(a.average))}L${n(xOf(b.slot))} ${n(yOf(b.average))}`)
    }
    if (gaps.length) {
      out.push(`<path d="${gaps.join('')}" fill="none" stroke="${p.line}" stroke-width="1.5" stroke-dasharray="3 4" stroke-linecap="round" opacity="0.7"/>`)
    }
    const lines = runs.filter((run) => run.length > 1)
      .map((run) => `M${run.map((pt) => `${n(xOf(pt.slot))} ${n(yOf(pt.average))}`).join('L')}`)
    if (lines.length) {
      out.push(`<path d="${lines.join('')}" fill="none" stroke="${p.line}" stroke-width="${LINE_WIDTH}" stroke-linejoin="round" stroke-linecap="round"/>`)
    }
    // 前后都没有成交的单独一天画成小圆点；最后一天画端点
    for (const run of runs) {
      if (run.length === 1 && run[0] !== pts[pts.length - 1]) {
        out.push(`<circle cx="${n(xOf(run[0].slot))}" cy="${n(yOf(run[0].average))}" r="3" fill="${p.line}"/>`)
      }
    }
    const last = pts[pts.length - 1]
    out.push(`<circle cx="${n(xOf(last.slot))}" cy="${n(yOf(last.average))}" r="4.5" fill="${p.line}" stroke="${p.background}" stroke-width="2"/>`)
  } else {
    out.push(text('这段时间没有成交', { x: (left + right) / 2, y: (PRICE_TOP + PRICE_BOTTOM) / 2, size: 16, fill: p.muted, anchor: 'middle' }))
  }

  // 成交量
  out.push(text(capLabel, { x: left - 10, y: VOLUME_TOP + AXIS_SIZE * 0.35, size: AXIS_SIZE, fill: p.muted, anchor: 'end' }))
  out.push(text(VOLUME_CAPTION, { x: left - 10, y: VOLUME_TOP + 22, size: CAPTION_SIZE, fill: p.muted, anchor: 'end' }))
  out.push(`<line x1="${left}" y1="${VOLUME_TOP}" x2="${right}" y2="${VOLUME_TOP}" stroke="${p.grid}" stroke-width="1"/>`)
  const normal: string[] = []
  const peaks: string[] = []
  // K 线的成交量柱按当天涨跌上色（封顶的那几天颜色更实）
  const volumeColor = new Map(candleList.map((c) => [c.slot, c.direction]))
  const byDirection: Record<CandleDirection, { normal: string[]; peaks: string[] }> = {
    up: { normal: [], peaks: [] }, down: { normal: [], peaks: [] }, flat: { normal: [], peaks: [] },
  }
  for (const pt of pts) {
    if (!(pt.volume > 0)) continue
    const height = Math.max(1, Math.min(1, pt.volume / cap) * volHeight)
    const path = barPath(xOf(pt.slot) - barWidth / 2, VOLUME_BOTTOM - height, barWidth, VOLUME_BOTTOM)
    if (kline) byDirection[volumeColor.get(pt.slot) ?? 'flat'][pt.volume > cap ? 'peaks' : 'normal'].push(path)
    else if (pt.volume > cap) peaks.push(path)
    else normal.push(path)
  }
  if (normal.length) out.push(`<path d="${normal.join('')}" fill="${p.volume}"/>`)
  if (peaks.length) out.push(`<path d="${peaks.join('')}" fill="${p.line}"/>`)
  for (const d of ['up', 'down', 'flat'] as const) {
    const { normal: a, peaks: b } = byDirection[d]
    if (a.length) out.push(`<path d="${a.join('')}" fill="${colorOf(d)}" fill-opacity="0.6"/>`)
    if (b.length) out.push(`<path d="${b.join('')}" fill="${colorOf(d)}"/>`)
  }
  out.push(`<line x1="${left}" y1="${VOLUME_BOTTOM}" x2="${right}" y2="${VOLUME_BOTTOM}" stroke="${p.muted}" stroke-width="1"/>`)

  // 横轴日期
  for (const tick of xTicks(w.start, w.days)) {
    const x = xOf(tick.slot)
    const half = textWidth(tick.label, AXIS_SIZE) / 2
    const cx = Math.min(Math.max(x, PAD_X + half), W - PAD_X - half)
    out.push(`<line x1="${n(x)}" y1="${VOLUME_BOTTOM}" x2="${n(x)}" y2="${VOLUME_BOTTOM + 4}" stroke="${p.muted}" stroke-width="1"/>`)
    out.push(text(tick.label, { x: cx, y: X_LABEL_Y, size: AXIS_SIZE, fill: p.muted, anchor: 'middle' }))
  }

  // 页脚
  const asOf = input.asOf ?? (pts.length ? pts[pts.length - 1].date : input.end)
  const clipped = candleList.some((c) => c.clippedHigh || c.clippedLow)
  out.push(text(`ESI 市场历史（星域）· 截至 ${asOf}${clipped ? ` · ${CLIP_NOTE}` : ''}`, { x: PAD_X, y: FOOTER_Y, size: FOOTER_SIZE, fill: p.muted }))
  out.push(kline ? candleLegendSvg(p) : legendSvg(p))
  out.push('</svg>')
  return out.join('\n')
}
