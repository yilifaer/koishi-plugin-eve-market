// 走势图 SVG：确定性输出（文件快照，含缺口、离群值、封顶的成交量）、窗口、统计、文字走势条。

import { describe, expect, it } from 'vitest'
import { CHART_COLORS, CHART_COLORS_LIGHT, TREND_MIN_DAYS } from '../../src/constants'
import { createPriceFormatter } from '../../src/core/format'
import type { HistoryPoint } from '../../src/core/types'
import { DEFAULT_PALETTE, chartSvg, enoughData, escapeXml, roundVolume, sparkline, textWidth, trendStats } from '../../src/render'
import type { ChartInput } from '../../src/render'

const formatter = createPriceFormatter(
  { priceDisplayMode: 'full_and_compact', compactDecimals: 2, thousandSeparator: true, showCurrency: true },
  { now: () => Date.UTC(2026, 9, 9, 6) },
)

const END = '2026-10-09'
const DAY_MS = 86_400_000

function dateBefore(end: string, daysBack: number): string {
  return new Date(Date.parse(`${end}T00:00:00Z`) - daysBack * DAY_MS).toISOString().slice(0, 10)
}

interface SeriesOptions {
  /** 窗口里第几天（0 起）没有成交 */
  gaps?: number[]
  /** 第几天的最高价乘多少（手滑、骗局成交） */
  spikes?: Record<number, number>
  /** 第几天的成交量乘多少 */
  volumeSpikes?: Record<number, number>
  /** 每天的涨幅 */
  drift?: number
}

/** 编造的历史：每天一行（最后一天还没有数据），价格按正弦起伏，完全确定 */
function series(days: number, base: number, o: SeriesOptions = {}): HistoryPoint[] {
  const out: HistoryPoint[] = []
  for (let slot = 0; slot < days - 1; slot++) {
    if (o.gaps?.includes(slot)) continue
    const average = base * (1 + Math.sin(slot / 3) * 0.02 + slot * (o.drift ?? 0))
    out.push({
      date: dateBefore(END, days - 1 - slot),
      average,
      highest: average * 1.03 * (o.spikes?.[slot] ?? 1),
      lowest: average * 0.97,
      volume: Math.round((400 + 120 * Math.cos(slot / 2)) * (o.volumeSpikes?.[slot] ?? 1)),
      orderCount: 900 + slot,
    })
  }
  return out
}

function input(days: number, points: HistoryPoint[], extra: Partial<ChartInput> = {}): ChartInput {
  return { item: '乌鸦级 Raven', place: '伏尔戈（Jita）', days, end: END, points, ...extra }
}

const svg = (i: ChartInput) => chartSvg(i, { formatter })

describe('chartSvg snapshots', () => {
  it('30 days with missing days, band outliers and one huge volume day', async () => {
    const points = series(30, 258_000_000, { gaps: [9, 10, 11, 20], spikes: { 4: 40, 15: 3 }, volumeSpikes: { 22: 15 } })
    await expect(svg(input(30, points))).toMatchFileSnapshot('./__snapshots__/chart-month.svg')
  })

  it('90 days of a cheap mineral (prices under 1,000 ISK)', async () => {
    const points = series(90, 3.62, { drift: 0.001 })
    await expect(svg(input(90, points, { item: '三钛合金 Tritanium' }))).toMatchFileSnapshot('./__snapshots__/chart-quarter.svg')
  })

  it('365 days with a week of no trades and a set with a missing part', async () => {
    const points = series(365, 312_000_000, { gaps: [40, 41, 42, 43, 44, 45, 46, 200], drift: 0.0008 })
    await expect(svg(input(365, points, { item: '伊什塔级 Ishtar', place: '多美（Amarr）', note: '缺 1 件' })))
      .toMatchFileSnapshot('./__snapshots__/chart-year.svg')
  })

  it('a thin market: isolated trading days and a flat price', async () => {
    const points = [3, 4, 12, 20, 27].map((slot) => ({
      date: dateBefore(END, 29 - slot), average: 1_500_000_000, highest: 1_500_000_000, lowest: 1_500_000_000, volume: 1, orderCount: 1,
    }))
    await expect(svg(input(30, points, { item: '某种旗舰 Some Capital' }))).toMatchFileSnapshot('./__snapshots__/chart-thin.svg')
  })
})

describe('chartSvg', () => {
  const base = series(30, 258_000_000, { gaps: [9, 10, 11] })

  it('is a self-contained 800×450 SVG with the light palette and no external references', () => {
    const out = svg(input(30, base))
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"')).toBe(true)
    expect(out.endsWith('</svg>')).toBe(true)
    expect(out).toContain(`fill="${CHART_COLORS_LIGHT.background}"`)
    expect(DEFAULT_PALETTE).toBe(CHART_COLORS_LIGHT)
    expect(out.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:|href|<image|<script|@import|url\((?!#plot\))/)
    // 同样的输入，同样的输出
    expect(svg(input(30, base))).toBe(out)
  })

  it('has the title, the stats row and the footer in Chinese', () => {
    const out = svg(input(30, base))
    expect(out).toContain('<tspan font-weight="700">乌鸦级 Raven</tspan><tspan fill="#52514e"> · 伏尔戈（Jita）· 近 30 天</tspan>')
    for (const label of ['最新均价', '区间涨跌', '最高均价', '最低均价', '日均成交量', '日均成交额', '日均价', '每日最高–最低', '成交量']) {
      expect(out).toContain(`>${label}</text>`)
    }
    expect(out).toContain('>ESI 市场历史（星域）· 截至 2026-10-08</text>')
    expect(svg(input(30, base, { asOf: '2026-10-07' }))).toContain('截至 2026-10-07')
  })

  it('labels the price axis compactly through the PriceFormatter', () => {
    const out = svg(input(30, base))
    const labels = [...out.matchAll(/text-anchor="end">([^<]+)</g)].map((m) => m[1])
    expect(labels).toEqual(['254M', '256M', '258M', '260M', '262M', '600', '成交量'])
    const thousands = createPriceFormatter(
      { priceDisplayMode: 'full_and_compact', compactDecimals: 2, thousandSeparator: false, showCurrency: true },
      { now: () => 0 },
    )
    const cheap = series(30, 12_000, { drift: 0.01 })
    const cheapLabels = [...chartSvg(input(30, cheap), { formatter: thousands }).matchAll(/text-anchor="end">([^<]+)</g)].map((m) => m[1])
    expect(cheapLabels.slice(0, -2)).toEqual(['12K', '13K', '14K', '15K'])
  })

  it('scales the price axis by the daily average only: band outliers do not move it', () => {
    const tame = series(30, 258_000_000)
    const wild = tame.map((p, i) => (i === 5 ? { ...p, highest: p.average * 50, lowest: 1 } : p))
    const ticks = (out: string) => [...out.matchAll(/<line x1="\d+" y1="([\d.]+)"[^>]*stroke="#e1e0d9"/g)].map((m) => m[1])
    expect(ticks(svg(input(30, wild)))).toEqual(ticks(svg(input(30, tame))))
  })

  it('clamps the high/low band to [0.5×, 2×] of the median average', () => {
    const tame = series(30, 258_000_000)
    const clamp = (factor: number) => tame.map((p, i) => (i === 5 ? { ...p, highest: 516_000_000 * factor, lowest: 129_000_000 / factor } : p))
    // 中位数附近 258M：2× 以上、0.5× 以下的部分都裁掉，所以 2 倍和 100 倍画出来一样
    // 29 天，中位数是排序后的第 15 个
    const m = [...tame.map((p) => p.average)].sort((a, b) => a - b)[14]
    const exact = tame.map((p, i) => (i === 5 ? { ...p, highest: m * 2, lowest: m * 0.5 } : p))
    expect(svg(input(30, clamp(100)))).toBe(svg(input(30, exact)))
    // 阴影带只在价格面板里画
    expect(svg(input(30, clamp(100)))).toMatch(/<path d="[^"]+" fill="rgba\(42, 120, 214, 0\.12\)" clip-path="url\(#plot\)"\/>/)
  })

  it('leaves gaps on days without trades: no bar, a dashed line across', () => {
    const full = svg(input(30, series(30, 258_000_000)))
    const gappy = svg(input(30, base))
    const bars = (out: string) => (out.match(new RegExp(`<path d="([^"]+)" fill="${CHART_COLORS_LIGHT.volume}"`))?.[1].match(/M/g) ?? []).length
    expect(bars(full)).toBe(29)
    expect(bars(gappy)).toBe(26)
    expect(full).not.toContain('stroke-dasharray')
    expect(gappy).toMatch(/<path d="M[\d.]+ [\d.]+L[\d.]+ [\d.]+" fill="none" stroke="#2a78d6" stroke-width="1.5" stroke-dasharray="3 4"/)
  })

  it('caps one huge volume day so the other bars stay readable, and marks it', () => {
    const points = series(30, 258_000_000, { volumeSpikes: { 22: 15 } })
    const out = svg(input(30, points))
    const peak = out.match(/<path d="([^"]+)" fill="#2a78d6"\/>/)
    expect(peak?.[1].match(/M/g)).toHaveLength(1)
    // 轴顶是普通日子的量级（90 分位的 2 倍以内），不是那一天的 7,000 多
    expect(out).toMatch(/text-anchor="end">1,200</)
  })

  it('marks the change in the stats row with an arrow and the up/down colour', () => {
    const up = svg(input(30, series(30, 100_000_000, { drift: 0.01 })))
    expect(up).toMatch(new RegExp(`fill="${CHART_COLORS_LIGHT.up}" font-weight="600">▲2\\d\\.\\d%<`))
    const down = svg(input(30, series(30, 100_000_000, { drift: -0.01 })))
    expect(down).toMatch(new RegExp(`fill="${CHART_COLORS_LIGHT.down}" font-weight="600">▼2\\d\\.\\d%<`))
  })

  it('shrinks and then shortens a very long title, and escapes names', () => {
    const long = svg(input(30, base, { item: `${'很长的物品名字'.repeat(8)} Very Long English Name` }))
    const title = long.match(/<text x="24" y="36" font-size="(\d+)"[^>]*><tspan font-weight="700">([^<]+)<\/tspan>/)
    expect(Number(title?.[1])).toBe(16)
    expect(title?.[2].endsWith('…')).toBe(true)
    const weird = svg(input(30, base, { item: 'A<B> & "C"', place: "D'E" }))
    expect(weird).toContain('A&lt;B&gt; &amp; &quot;C&quot;')
    expect(weird).toContain('D&#39;E')
    expect(escapeXml('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&#39;')
  })

  it('labels a month by MM/DD and a year by month, with the year on the first label', () => {
    const month = svg(input(30, base))
    expect([...month.matchAll(/text-anchor="middle">([^<]+)</g)].map((m) => m[1])).toEqual(['09/11', '09/18', '09/25', '10/02', '10/09'])
    const year = svg(input(365, series(365, 1000)))
    expect([...year.matchAll(/text-anchor="middle">([^<]+)</g)].map((m) => m[1])).toEqual(['2025年12月', '2月', '4月', '6月', '8月', '10月'])
  })

  it('still draws (empty panels) when there were no trades at all', () => {
    const out = svg(input(30, []))
    expect(out).toContain('这段时间没有成交')
    expect(out).toContain('>—</text>')
  })

  it('accepts the dark palette', () => {
    const out = chartSvg(input(30, base), { formatter, palette: CHART_COLORS })
    expect(out).toContain(`fill="${CHART_COLORS.background}"`)
    expect(out).toContain(`fill="${CHART_COLORS.panel}"`)
  })

  it('rejects a broken window', () => {
    expect(() => svg(input(0, base))).toThrow(RangeError)
    expect(() => svg(input(30, base, { end: '2026/10/09' }))).toThrow(RangeError)
  })
})

describe('trendStats', () => {
  it('latest, change, high/low of the daily average, per-day volume and turnover', () => {
    const points: HistoryPoint[] = [
      { date: '2026-10-01', average: 100, highest: 110, lowest: 90, volume: 10, orderCount: 1 },
      { date: '2026-10-03', average: 120, highest: 130, lowest: 110, volume: 20, orderCount: 1 },
      { date: '2026-10-08', average: 110, highest: 115, lowest: 105, volume: 30, orderCount: 1 },
    ]
    // 窗口 10/03–10/09 共 7 天，最后一天（今天）还没有数据 → 按 6 天平均；10/01 在窗口外
    expect(trendStats({ points, days: 7, end: END })).toEqual({
      tradingDays: 2,
      first: points[1],
      last: points[2],
      latest: 110,
      changePct: (110 - 120) / 120 * 100,
      high: 120,
      low: 110,
      avgVolume: 50 / 6,
      avgTurnover: (20 * 120 + 30 * 110) / 6,
    })
    // 最后一天也有数据时按整个窗口平均
    const today = [...points, { date: END, average: 130, highest: 131, lowest: 129, volume: 4, orderCount: 1 }]
    expect(trendStats({ points: today, days: 7, end: END })?.avgVolume).toBe(54 / 7)
    expect(trendStats({ points: [], days: 30, end: END })).toBeNull()
  })

  it('a set: the turnover is the sum of the pieces\' turnover, not the summed volume times the set price', () => {
    // 6 件，每件每天 10 个、100M：套装价 600M，成交 60 件，成交额 6 × 1B = 6B（不是 60 × 600M = 36B）
    const points: HistoryPoint[] = [3, 2, 1].map((back) => ({
      date: dateBefore(END, back), average: 600e6, highest: 600e6, lowest: 600e6, volume: 60, orderCount: 6, turnover: 6e9,
    }))
    const stats = trendStats({ points, days: 7, end: END })
    expect(stats?.avgVolume).toBe(180 / 6)
    expect(stats?.avgTurnover).toBe(18e9 / 6)
    // 图上的统计行和卡片一致
    expect(svg(input(7, points))).toContain('>3.00B</text>')
    // 没有 turnover 的点按成交量 × 均价算；turnover 不是有限的非负数时也一样
    const plain = points.map(({ turnover: _, ...p }) => p)
    expect(trendStats({ points: plain, days: 7, end: END })?.avgTurnover).toBe(3 * 60 * 600e6 / 6)
    const broken = points.map((p) => ({ ...p, turnover: Number.NaN }))
    expect(trendStats({ points: broken, days: 7, end: END })?.avgTurnover).toBe(3 * 60 * 600e6 / 6)
  })

  it('ignores duplicate dates (the later one wins), broken averages and points outside the window', () => {
    const points: HistoryPoint[] = [
      { date: '2026-10-05', average: 100, highest: 100, lowest: 100, volume: 1, orderCount: 1 },
      { date: '2026-10-05', average: 200, highest: 200, lowest: 200, volume: 2, orderCount: 1 },
      { date: '2026-10-06', average: Number.NaN, highest: 1, lowest: 1, volume: 1, orderCount: 1 },
      { date: '2026-10-07', average: 0, highest: 1, lowest: 1, volume: 1, orderCount: 1 },
      { date: '2026-10-10', average: 300, highest: 300, lowest: 300, volume: 1, orderCount: 1 },
    ]
    const stats = trendStats({ points, days: 30, end: END })
    expect(stats).toMatchObject({ tradingDays: 1, latest: 200, high: 200, low: 200, changePct: 0 })
  })
})

describe('enoughData', () => {
  it(`needs at least ${TREND_MIN_DAYS} trading days inside the window`, () => {
    const points = series(30, 100)
    expect(enoughData({ points: points.slice(-TREND_MIN_DAYS), days: 30, end: END })).toBe(true)
    expect(enoughData({ points: points.slice(-(TREND_MIN_DAYS - 1)), days: 30, end: END })).toBe(false)
    // 窗口外的不算
    expect(enoughData({ points: points.slice(0, 5), days: 3, end: END })).toBe(false)
  })
})

describe('sparkline', () => {
  it('15 levels of the volume-weighted average over the window', () => {
    const rising = series(30, 100, { drift: 0.02 }).map((p) => ({ ...p, average: Number(p.date.slice(8)) + 1000 * Number(p.date.slice(5, 7)) }))
    const line = sparkline({ points: rising, days: 30, end: END })
    expect(line).toHaveLength(15)
    expect([...line!].every((c) => '▁▂▃▄▅▆▇█'.includes(c))).toBe(true)
    expect(line?.[0]).toBe('▁')
    expect(line?.at(-1)).toBe('█')
  })

  it('is flat for a flat price, carries the last value over empty segments, and needs enough days', () => {
    const flat = series(30, 100).map((p) => ({ ...p, average: 100 }))
    expect(sparkline({ points: flat, days: 30, end: END })).toBe('▄'.repeat(15))
    const sparse: HistoryPoint[] = [
      { date: dateBefore(END, 25), average: 10, highest: 10, lowest: 10, volume: 1, orderCount: 1 },
      { date: dateBefore(END, 15), average: 20, highest: 20, lowest: 20, volume: 1, orderCount: 1 },
      { date: dateBefore(END, 2), average: 30, highest: 30, lowest: 30, volume: 1, orderCount: 1 },
    ]
    expect(sparkline({ points: sparse, days: 30, end: END })).toBe('▁▁▁▁▁▁▁▅▅▅▅▅▅██')
    expect(sparkline({ points: sparse.slice(1), days: 30, end: END })).toBeNull()
    expect(sparkline({ points: sparse, days: 30, end: END }, 5)).toHaveLength(5)
  })
})

describe('textWidth', () => {
  it('counts CJK as a full em and Latin narrower', () => {
    expect(textWidth('乌鸦级', 10)).toBe(30)
    expect(textWidth('Raven', 10)).toBeLessThan(40)
    expect(textWidth('Raven', 10, true)).toBeGreaterThan(textWidth('Raven', 10))
  })

  it('takes M and W wider than other capitals (better too wide than too narrow)', () => {
    expect(textWidth('M', 10)).toBeGreaterThan(textWidth('A', 10))
    expect(textWidth('W', 10)).toBe(textWidth('m', 10))
    expect(textWidth('Mw', 10)).toBe(17)
  })
})

describe('the stats row matches the card', () => {
  const three = (last: number, volume = 10): HistoryPoint[] => [3, 2, 1].map((back) => ({
    date: dateBefore(END, back), average: back === 1 ? last : 100, highest: 120, lowest: 80, volume, orderCount: 1,
  }))

  it('change: arrow without a space and one decimal, like the card; under 0.1% it is 持平', () => {
    expect(svg(input(7, three(96)))).toContain('>▼4.0%</text>')
    expect(svg(input(7, three(111.2)))).toContain('>▲11.2%</text>')
    expect(svg(input(7, three(100.05)))).toContain('>持平</text>')
    expect(svg(input(7, three(100)))).toContain('>持平</text>')
  })

  it('daily volume: whole numbers from 100, one decimal below, two decimals under 0.1 (a rare item is never 0)', () => {
    expect(roundVolume(1234.5)).toBe(1235)
    expect(roundVolume(99.94)).toBe(99.9)
    expect(roundVolume(0.17)).toBe(0.2)
    expect(roundVolume(3 / 364)).toBe(0.01)
    expect(roundVolume(0)).toBe(0)
    // 3 天各 1 个，窗口 7 天（最后一天没有数据，按 6 天平均）→ 0.5
    expect(svg(input(7, three(100, 1)))).toContain('>0.5</text>')
  })
})
