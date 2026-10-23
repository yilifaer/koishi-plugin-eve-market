// K 线：每天的开盘 / 收盘 / 涨跌色、均线（含窗口前的热身历史）、影线裁剪、最高最低标注、两种配色、涨跌色、折线样式不变。
// 历史里的数字都是编造的。

import { describe, expect, it } from 'vitest'
import { CHART_COLORS, CHART_COLORS_LIGHT } from '../../src/constants'
import { createPriceFormatter } from '../../src/core/format'
import type { HistoryPoint } from '../../src/core/types'
import { candles, chartPalette, chartSvg, extremes, movingAverages } from '../../src/render'
import type { ChartInput } from '../../src/render'

const formatter = createPriceFormatter(
  { priceDisplayMode: 'full_and_compact', compactDecimals: 2, thousandSeparator: true, showCurrency: true },
  { now: () => Date.UTC(2026, 9, 9, 6) },
)

const END = '2026-10-09'
const DAY_MS = 86_400_000
const dateBefore = (daysBack: number) => new Date(Date.parse(`${END}T00:00:00Z`) - daysBack * DAY_MS).toISOString().slice(0, 10)

/** 窗口里第几天（0 起）→ 日期（窗口 days 天，最后一天是 END） */
const dayOf = (days: number, slot: number) => dateBefore(days - 1 - slot)

function pt(date: string, average: number, extra: Partial<HistoryPoint> = {}): HistoryPoint {
  return { date, average, highest: average * 1.02, lowest: average * 0.98, volume: 100, orderCount: 10, ...extra }
}

/** 5 天的小窗口：每天一个均价 */
function small(averages: number[], extra: Partial<HistoryPoint> = {}): { points: HistoryPoint[]; days: number; end: string } {
  const days = averages.length
  return { points: averages.map((a, slot) => pt(dayOf(days, slot), a, extra)), days, end: END }
}

describe('candles: open / close / direction', () => {
  it('the body runs from the previous trading day average to this day average', () => {
    const list = candles(small([10, 12, 11, 11, 15]))
    expect(list.map((c) => [c.open, c.close, c.direction])).toEqual([
      [10, 10, 'flat'], // 第一天前面没有历史：一条横线
      [10, 12, 'up'],
      [12, 11, 'down'],
      [11, 11, 'flat'],
      [11, 15, 'up'],
    ])
  })

  it('a day after a gap opens at the last trading day before the gap', () => {
    const w = small([10, 11, 12, 13, 14])
    const points = w.points.filter((_, i) => i !== 2 && i !== 3)
    const list = candles({ ...w, points })
    expect(list.map((c) => c.slot)).toEqual([0, 1, 4])
    expect(list[2]).toMatchObject({ open: 11, close: 14, direction: 'up' })
  })

  it('the first visible day opens at the last trading day before the window when there is one', () => {
    const w = small([10, 12, 11])
    const earlier = pt(dateBefore(10), 9)
    const list = candles({ ...w, points: [earlier, ...w.points] })
    expect(list).toHaveLength(3)
    expect(list[0]).toMatchObject({ open: 9, close: 10, direction: 'up' })
  })

  it('has one candle per trading day with the volume, and none when nothing traded', () => {
    expect(candles(small([5, 6, 7])).map((c) => c.volume)).toEqual([100, 100, 100])
    expect(candles({ points: [], days: 30, end: END })).toEqual([])
  })
})

describe('candles: wick clipping', () => {
  const base = [100, 101, 99, 100, 102, 98, 100, 101, 99, 100]

  it('keeps ordinary wicks and flags nothing', () => {
    const list = candles(small(base))
    expect(list.every((c) => !c.clippedHigh && !c.clippedLow)).toBe(true)
    expect(list[1]).toMatchObject({ high: 101 * 1.02, low: 101 * 0.98 })
  })

  it('clips an absurd high and low, flags them, and never cuts into the body', () => {
    const w = small(base)
    const points = w.points.map((p, i) => (i === 4 ? { ...p, highest: p.average * 40, lowest: 0.01 } : p))
    const list = candles({ ...w, points })
    const c = list[4]
    expect(c.clippedHigh).toBe(true)
    expect(c.clippedLow).toBe(true)
    // 影线上限：实体范围（98–102）外再多 5%（中位数的 5%）
    expect(c.high).toBeCloseTo(102 + 5, 6)
    expect(c.low).toBeCloseTo(98 - 5, 6)
    expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close))
    expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close))
    expect(list.filter((x) => x.clippedHigh || x.clippedLow)).toHaveLength(1)
  })

  it('never clips beyond [0.5×, 2×] of the median average', () => {
    const wide = [10, 30, 10, 30, 10, 30, 10, 30, 10, 30]
    const w = small(wide)
    const points = w.points.map((p, i) => (i === 3 ? { ...p, highest: 1000 } : p))
    const c = candles({ ...w, points })[3]
    expect(c.high).toBeLessThanOrEqual(2 * 20)
    expect(c.clippedHigh).toBe(true)
  })
})

describe('extremes: the high / low labels', () => {
  it('picks the highest wick top and the lowest wick bottom', () => {
    const w = small([100, 101, 99, 100, 102, 98, 100, 101, 99, 100])
    const points = w.points.map((p, i) => (i === 6 ? { ...p, highest: 106 } : i === 2 ? { ...p, lowest: 94 } : p))
    const e = extremes(candles({ ...w, points }))!
    expect(e.high.slot).toBe(6)
    expect(e.high.high).toBe(106)
    expect(e.low.slot).toBe(2)
    expect(e.low.low).toBe(94)
  })

  it('ignores clipped tips: they are not real prices', () => {
    const w = small([100, 101, 99, 100, 102, 98, 100, 101, 99, 100])
    const points = w.points.map((p, i) => (i === 6 ? { ...p, highest: 5000 } : i === 3 ? { ...p, highest: 106 } : p))
    const e = extremes(candles({ ...w, points }))!
    expect(e.high.slot).toBe(3)
    expect(e.high.high).toBe(106)
    expect(extremes([])).toBeNull()
  })

  it('the SVG labels them with the plugin price formatter and keeps them inside the plot', () => {
    const days = 30
    const points = Array.from({ length: days - 1 }, (_, slot) => pt(dayOf(days, slot), 30 + (slot % 5), { highest: 30 + (slot % 5) + (slot === 0 ? 5.4 : 0.4), lowest: slot === days - 2 ? 28.5 : 29 }))
    const out = chartSvg({ item: '三钛合金 Tritanium', place: '伏尔戈（Jita）', days, end: END, points }, { formatter })
    expect(out).toMatch(/>高 35\.40</)
    expect(out).toMatch(/>低 28\.50</)
    // 第一天和倒数第二天靠边：标注的中心被收回绘图区，文字整个在区内
    for (const m of out.matchAll(/<text x="([\d.]+)"[^>]*text-anchor="middle">([高低] [^<]+)</g)) {
      const x = Number(m[1])
      expect(x).toBeGreaterThan(40)
      expect(x).toBeLessThan(780)
    }
    // 大额 ISK 用简写
    const big = chartSvg({ item: 'X', place: 'Y', days, end: END, points: points.map((p) => ({ ...p, average: p.average * 1e7, highest: p.highest * 1e7, lowest: p.lowest * 1e7 })) }, { formatter })
    expect(big).toMatch(/>高 354\.00M</)
  })
})

describe('movingAverages', () => {
  const days = 70
  /** 70 天窗口前面再有 80 天：均价就是「第几天」，这样均线的值能手算 */
  function longSeries(): { points: HistoryPoint[]; days: number; end: string } {
    const points = Array.from({ length: 150 }, (_, i) => pt(dateBefore(149 - i), i + 1))
    return { points, days, end: END }
  }

  it('averages the last N trading days, using earlier history so the first visible day already has MA60', () => {
    const [ma5, ma20, ma60] = movingAverages(longSeries())
    expect([ma5.period, ma20.period, ma60.period]).toEqual([5, 20, 60])
    // 窗口第一天是第 81 个点（均价 81）；MA5 = (77+…+81)/5 = 79，MA60 = (22+…+81)/60 = 51.5
    expect(ma5.points[0]).toEqual({ slot: 0, value: 79 })
    expect(ma20.points[0]).toEqual({ slot: 0, value: 71.5 })
    expect(ma60.points[0]).toEqual({ slot: 0, value: 51.5 })
    expect(ma60.points).toHaveLength(70)
    // 最后一天（均价 150）
    expect(ma5.latest).toBe(148)
    expect(ma60.latest).toBe(120.5)
  })

  it('uses at most 59 earlier trading days, no extra request needed', () => {
    const w = longSeries()
    // 只剩 10 个更早的点：MA60 晚一些才开始
    const trimmed = { ...w, points: w.points.slice(80 - 10) }
    const [, , ma60] = movingAverages(trimmed)
    // 窗口第一天前面有 10 个点；第 50 个窗口日才凑够 60 个
    expect(ma60.points[0].slot).toBe(49)
    expect(ma60.points[0].value).toBeCloseTo((71 + 130) / 2, 9)
  })

  it('starts later when the window has no earlier history; a short series has no long average', () => {
    const w = small([10, 11, 12, 13, 14, 15, 16])
    const [ma5, ma20, ma60] = movingAverages(w)
    expect(ma5.points.map((p) => p.slot)).toEqual([4, 5, 6])
    expect(ma5.points[0].value).toBe(12)
    expect(ma20.points).toEqual([])
    expect(ma60.latest).toBeNull()
  })

  it('counts trading days, not calendar days', () => {
    const w = small([10, 20, 30, 40, 50, 60])
    const points = w.points.filter((_, i) => i !== 2)
    const [ma5] = movingAverages({ ...w, points })
    // 5 个有成交的日子：10 20 40 50 60 → 第 6 个日历日（slot 5）的 MA5
    expect(ma5.points).toEqual([{ slot: 5, value: 36 }])
  })

  it('draws the three averages in three colours with the latest values in the legend', () => {
    const w = longSeries()
    const out = chartSvg({ item: 'X', place: 'Y', ...w }, { formatter })
    const p = chartPalette('dark', 'red')
    expect(new Set([p.ma5, p.ma20, p.ma60]).size).toBe(3)
    for (const color of [p.ma5, p.ma20, p.ma60]) expect(out).toContain(`stroke="${color}" stroke-width="1.5"`)
    expect(out).toContain('>MA5 148.00<')
    expect(out).toContain('>MA20 140.50<')
    expect(out).toContain('>MA60 120.50<')
    // 历史不够时图例写 —
    const few = chartSvg({ item: 'X', place: 'Y', ...small([10, 11, 12, 13, 14, 15]) }, { formatter })
    expect(few).toContain('>MA5 13.00<')
    expect(few).toContain('>MA60 —<')
  })
})

describe('chartSvg: style, theme and colours', () => {
  const days = 30
  const points = Array.from({ length: days - 1 }, (_, slot) => pt(dayOf(days, slot), 100 + slot * 2 - (slot % 3) * 5, { volume: 100 + slot }))
  const input: ChartInput = { item: '乌鸦级 Raven', place: '伏尔戈（Jita）', days, end: END, points }
  const svg = (o: Parameters<typeof chartSvg>[1] extends infer T ? Partial<T> : never) => chartSvg(input, { formatter, ...o })

  it('defaults to the dark K line with red for up', () => {
    const out = svg({})
    expect(out).toContain(`fill="${CHART_COLORS.background}"`)
    expect(out).toContain(`stroke="${CHART_COLORS.red}"`)
    expect(out).toContain('>MA5 ')
    expect(out).not.toContain('>日均价<')
    expect(out).not.toContain(`fill="${CHART_COLORS.band}"`)
  })

  it('the light theme uses the light palette in both styles', () => {
    for (const trendStyle of ['kline', 'line'] as const) {
      const out = svg({ theme: 'light', trendStyle })
      expect(out).toContain(`fill="${CHART_COLORS_LIGHT.background}"`)
      expect(out).not.toContain(CHART_COLORS.background)
    }
    expect(svg({ theme: 'dark', trendStyle: 'line' })).toContain(`fill="${CHART_COLORS.background}"`)
  })

  it('upColor swaps the up and down colours on candles, volume bars and the change mark', () => {
    const red = svg({ upColor: 'red' })
    const green = svg({ upColor: 'green' })
    const rp = chartPalette('dark', 'red')
    const gp = chartPalette('dark', 'green')
    expect(rp.up).toBe(CHART_COLORS.red)
    expect(gp.up).toBe(CHART_COLORS.green)
    expect(gp.down).toBe(CHART_COLORS.red)
    // 涨的蜡烛（实体）和成交量柱用涨色
    expect(red).toMatch(new RegExp(`<path d="[^"]+" fill="${rp.up}" clip-path`))
    expect(red).toMatch(new RegExp(`<path d="[^"]+" fill="${rp.up}" fill-opacity="0.6"/>`))
    expect(green).toMatch(new RegExp(`<path d="[^"]+" fill="${gp.up}" clip-path`))
    expect(green).toMatch(new RegExp(`<path d="[^"]+" fill="${gp.up}" fill-opacity="0.6"/>`))
    // ▲ 的颜色
    expect(red).toMatch(new RegExp(`fill="${rp.up}" font-weight="600">▲`))
    expect(green).toMatch(new RegExp(`fill="${gp.up}" font-weight="600">▲`))
    expect(red).not.toBe(green)
  })

  it('upColor also colours the change mark of the line style, and nothing else changes there', () => {
    const red = svg({ trendStyle: 'line', upColor: 'red' })
    const green = svg({ trendStyle: 'line', upColor: 'green' })
    expect(red).toMatch(new RegExp(`fill="${CHART_COLORS.red}" font-weight="600">▲`))
    expect(green).toMatch(new RegExp(`fill="${CHART_COLORS.green}" font-weight="600">▲`))
    expect(red.replaceAll(CHART_COLORS.red, 'A').replaceAll(CHART_COLORS.green, 'B')).toBe(green.replaceAll(CHART_COLORS.green, 'A').replaceAll(CHART_COLORS.red, 'B'))
    // 折线样式没有蜡烛、均线
    expect(red).toContain('>日均价<')
    expect(red).not.toContain('>MA5 ')
  })

  it('the footer notes clipped wicks only when something was clipped', () => {
    expect(svg({})).not.toContain('影线截掉了离谱成交')
    const wild = { ...input, points: points.map((p, i) => (i === 7 ? { ...p, highest: p.average * 60 } : p)) }
    expect(chartSvg(wild, { formatter })).toContain('· 影线截掉了离谱成交</text>')
    // 折线样式不说这句
    expect(chartSvg(wild, { formatter, trendStyle: 'line' })).not.toContain('影线截掉')
  })

  it('keeps every body at least 1px high and wicks visible at 365 days; flat days are a thin line', () => {
    const year = 365
    const flat = Array.from({ length: year - 1 }, (_, slot) => pt(dayOf(year, slot), slot % 2 ? 100 : 100.0001))
    const out = chartSvg({ item: 'X', place: 'Y', days: year, end: END, points: flat }, { formatter })
    const bodies = [...out.matchAll(/M[\d.]+ [\d.]+h([\d.]+)v([\d.]+)h-[\d.]+Z/g)]
    expect(bodies.length).toBeGreaterThan(300)
    for (const b of bodies) {
      expect(Number(b[1])).toBeGreaterThanOrEqual(1)
      expect(Number(b[2])).toBeGreaterThanOrEqual(1)
    }
    expect(out).toMatch(/stroke-width="1" clip-path="url\(#plot\)"/)
  })

  it('is deterministic and self-contained', () => {
    expect(svg({})).toBe(svg({}))
    expect(svg({}).replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:|href|<image|<script|@import/)
  })

  it('an explicit palette wins over theme and upColor', () => {
    const palette = chartPalette('light', 'green')
    expect(chartSvg(input, { formatter, palette, theme: 'dark', upColor: 'red' })).toBe(chartSvg(input, { formatter, palette }))
  })
})
