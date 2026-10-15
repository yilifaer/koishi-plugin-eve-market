import { describe, expect, it } from 'vitest'
import { compactPrice, createPriceFormatter, formatCount, formatPercent, formatVolume, fullPrice, listPriceMode } from '../../../src/core/format'
import type { FormatterDisplay } from '../../../src/core/format'
import type { PriceDisplayMode } from '../../../src/core/types'
import { FakeTime } from '../../fakes/fake-time'

const DISPLAY: FormatterDisplay = {
  priceDisplayMode: 'full_and_compact',
  compactDecimals: 2,
  thousandSeparator: true,
  showCurrency: true,
}

function formatter(overrides: Partial<FormatterDisplay> = {}) {
  return createPriceFormatter({ ...DISPLAY, ...overrides }, new FakeTime())
}

describe('full price', () => {
  it('rounds to an integer from 100,000 ISK and keeps 2 decimals below', () => {
    expect(fullPrice(258_400_000, true)).toBe('258,400,000')
    expect(fullPrice(875_699_999.5, true)).toBe('875,700,000')
    expect(fullPrice(100_000, true)).toBe('100,000')
    expect(fullPrice(99_999.99, true)).toBe('99,999.99')
    expect(fullPrice(12_345.67, true)).toBe('12,345.67')
    expect(fullPrice(12_345.675, true)).toBe('12,345.68')
    expect(fullPrice(5.4, true)).toBe('5.40')
    expect(fullPrice(0.01, true)).toBe('0.01')
  })

  it('decides the boundary on the value rounded to cents', () => {
    expect(fullPrice(99_999.996, true)).toBe('100,000')
    expect(fullPrice(99_999.994, true)).toBe('99,999.99')
  })

  it('rounds halves away from zero on the decimal value, not the binary one', () => {
    expect(fullPrice(1.005, true)).toBe('1.01')
    expect(fullPrice(1.045, true)).toBe('1.05')
    expect(fullPrice(-1.005, true)).toBe('-1.01')
    expect(fullPrice(100_000.5, true)).toBe('100,001')
  })

  it('writes negative values (losses) and never a negative zero', () => {
    expect(fullPrice(-258_400_000, true)).toBe('-258,400,000')
    expect(fullPrice(-0.001, true)).toBe('0.00')
  })

  it('can drop the thousand separator', () => {
    expect(fullPrice(258_400_000, false)).toBe('258400000')
    expect(fullPrice(12_345.67, false)).toBe('12345.67')
  })

  it('handles totals beyond what toFixed prints plainly', () => {
    expect(fullPrice(2.5e21, true)).toBe('2,500,000,000,000,000,000,000')
  })
})

describe('compact price', () => {
  it('uses K, M, B and T with the configured decimals', () => {
    expect(compactPrice(258_400_000, 2)).toBe('258.40M')
    expect(compactPrice(12_345.67, 2)).toBe('12.35K')
    expect(compactPrice(2_700_000_000, 2)).toBe('2.70B')
    expect(compactPrice(1_250_000_000_000, 2)).toBe('1.25T')
    expect(compactPrice(1_000, 2)).toBe('1.00K')
    expect(compactPrice(258_400_000, 0)).toBe('258M')
    expect(compactPrice(258_456_789, 3)).toBe('258.457M')
  })

  it('writes small amounts like the full price, without a unit', () => {
    expect(compactPrice(5.4, 2)).toBe('5.40')
    expect(compactPrice(999.99, 2)).toBe('999.99')
    expect(compactPrice(13.2, 0)).toBe('13.20')
  })

  it('moves to the next unit when rounding reaches 1000', () => {
    expect(compactPrice(999_999, 2)).toBe('1.00M')
    expect(compactPrice(999_994, 2)).toBe('999.99K')
    expect(compactPrice(999.996, 2)).toBe('1.00K')
    expect(compactPrice(999_999_999_999, 2)).toBe('1.00T')
  })

  it('rounds half away from zero', () => {
    expect(compactPrice(1_005, 2)).toBe('1.01K')
    expect(compactPrice(1_235_000, 2)).toBe('1.24M')
    expect(compactPrice(-1_235_000, 2)).toBe('-1.24M')
  })

  it('stays in T for very large values and groups the mantissa', () => {
    expect(compactPrice(1_234_000_000_000_000, 2)).toBe('1,234.00T')
    expect(compactPrice(1_234_000_000_000_000, 2, false)).toBe('1234.00T')
  })

  it('clamps the decimals to 0–4', () => {
    expect(compactPrice(258_456_789, 9)).toBe('258.4568M')
    expect(compactPrice(258_456_789, -1)).toBe('258M')
  })
})

describe('PriceFormatter.isk', () => {
  it('returns na for a missing price and never formats 0 for it', () => {
    const f = formatter()
    expect(f.isk(null)).toEqual({ na: true })
    expect(f.isk(Number.NaN)).toEqual({ na: true })
    expect(f.isk(Number.POSITIVE_INFINITY)).toEqual({ na: true })
  })

  it('full_and_compact: full price plus the compact form from 1,000 ISK', () => {
    const f = formatter()
    expect(f.isk(258_400_000)).toEqual({ na: false, full: '258,400,000 ISK', compact: '258.40M' })
    expect(f.isk(12_345.67)).toEqual({ na: false, full: '12,345.67 ISK', compact: '12.35K' })
    expect(f.isk(5.4)).toEqual({ na: false, full: '5.40 ISK' })
  })

  it('full_only and compact_only', () => {
    const full = formatter({ priceDisplayMode: 'full_only' })
    expect(full.isk(258_400_000)).toEqual({ na: false, full: '258,400,000 ISK' })
    expect(full.isk(5.4)).toEqual({ na: false, full: '5.40 ISK' })
    const compact = formatter({ priceDisplayMode: 'compact_only' })
    expect(compact.isk(258_400_000)).toEqual({ na: false, compact: '258.40M' })
    expect(compact.isk(5.4)).toEqual({ na: false, compact: '5.40' })
  })

  it('takes per-call overrides (list rows use compact_only)', () => {
    const f = formatter()
    expect(f.isk(256_500_000, { mode: 'compact_only' })).toEqual({ na: false, compact: '256.50M' })
    expect(f.isk(256_500_000, { compactDecimals: 1 })).toEqual({ na: false, full: '256,500,000 ISK', compact: '256.5M' })
    expect(f.isk(256_500_000, { showCurrency: false, thousandSeparator: false })).toEqual({ na: false, full: '256500000', compact: '256.50M' })
  })

  it('follows the display settings it was created with', () => {
    const f = formatter({ compactDecimals: 1, thousandSeparator: false, showCurrency: false })
    expect(f.isk(258_400_000)).toEqual({ na: false, full: '258400000', compact: '258.4M' })
    expect(f.compact(258_400_000)).toBe('258.4M')
  })

  it('formats every price of a card in each display mode', () => {
    // 查价卡片的出售价、合计（×10）和缺价的收购价
    const values: Array<number | null> = [270_000_000, 2_700_000_000, null, 13.2]
    const expected: Record<PriceDisplayMode, unknown[]> = {
      full_and_compact: [
        { na: false, full: '270,000,000 ISK', compact: '270.00M' },
        { na: false, full: '2,700,000,000 ISK', compact: '2.70B' },
        { na: true },
        { na: false, full: '13.20 ISK' },
      ],
      full_only: [
        { na: false, full: '270,000,000 ISK' },
        { na: false, full: '2,700,000,000 ISK' },
        { na: true },
        { na: false, full: '13.20 ISK' },
      ],
      compact_only: [
        { na: false, compact: '270.00M' },
        { na: false, compact: '2.70B' },
        { na: true },
        { na: false, compact: '13.20' },
      ],
    }
    for (const mode of Object.keys(expected) as PriceDisplayMode[]) {
      const f = formatter({ priceDisplayMode: mode })
      expect(values.map((v) => f.isk(v)), mode).toEqual(expected[mode])
    }
  })
})

describe('list price mode', () => {
  it('is compact_only unless the list setting inherits the main one', () => {
    expect(listPriceMode({ priceDisplayMode: 'full_only', listPriceDisplayMode: 'compact_only' })).toBe('compact_only')
    expect(listPriceMode({ priceDisplayMode: 'full_only', listPriceDisplayMode: 'inherit' })).toBe('full_only')
    expect(listPriceMode({ priceDisplayMode: 'full_and_compact', listPriceDisplayMode: 'inherit' })).toBe('full_and_compact')
  })
})

describe('quantity, percent, volume', () => {
  it('quantity: integers with separators; compact from 10,000 without trailing zeros', () => {
    const f = formatter()
    expect(f.quantity(1_500_002)).toBe('1,500,002')
    expect(f.quantity(2_162)).toBe('2,162')
    expect(f.quantity(2.5)).toBe('2.5')
    expect(f.quantity(2_162, true)).toBe('2,162')
    expect(f.quantity(1_000_000, true)).toBe('1M')
    expect(f.quantity(1_500_000, true)).toBe('1.5M')
    expect(f.quantity(12_345, true)).toBe('12.35K')
    expect(f.quantity(999_999, true)).toBe('1M')
    expect(formatter({ thousandSeparator: false }).quantity(1_500_002)).toBe('1500002')
  })

  it('percent: 1 decimal from 1%, 2 below, trailing zeros dropped', () => {
    expect(formatPercent(4.5)).toBe('4.5%')
    expect(formatPercent(4.46)).toBe('4.5%')
    expect(formatPercent(-3.6)).toBe('-3.6%')
    expect(formatPercent(-5)).toBe('-5%')
    expect(formatPercent(0.25)).toBe('0.25%')
    expect(formatPercent(0.1)).toBe('0.1%')
    expect(formatPercent(63.456)).toBe('63.5%')
    expect(formatPercent(1234.5)).toBe('1,234.5%')
  })

  it('percent: signed adds + to positive values only', () => {
    expect(formatPercent(4.5, true)).toBe('+4.5%')
    expect(formatPercent(-5, true)).toBe('-5%')
    expect(formatPercent(0, true)).toBe('0%')
    expect(formatPercent(-0.001, true)).toBe('0%')
    expect(formatPercent(Number.NaN)).toBe('—')
  })

  it('volume: integer m³ from 100, up to 2 decimals below', () => {
    expect(formatVolume(115_000)).toBe('115,000 m³')
    expect(formatVolume(50_328.4)).toBe('50,328 m³')
    expect(formatVolume(1.35)).toBe('1.35 m³')
    expect(formatVolume(0.01)).toBe('0.01 m³')
    expect(formatVolume(50.5)).toBe('50.5 m³')
    expect(formatVolume(0)).toBe('0 m³')
    expect(formatter({ thousandSeparator: false }).volume(115_000)).toBe('115000 m³')
  })
})

describe('formatCount: order quantities in Chinese units', () => {
  const show = (n: number) => {
    const { approx, text } = formatCount(n)
    return `${approx ? '约 ' : ''}${text}`
  }

  it('under 10,000 is the exact number, no approximation', () => {
    expect(show(0)).toBe('0 个')
    expect(show(37)).toBe('37 个')
    expect(show(9_999)).toBe('9999 个')
  })

  it('from 10,000 uses 万 with up to 3 significant digits', () => {
    expect(show(10_000)).toBe('约 1 万个')
    expect(show(12_345)).toBe('约 1.23 万个')
    expect(show(35_000)).toBe('约 3.5 万个')
    expect(show(999_900)).toBe('约 100 万个')
    expect(show(1_200_000)).toBe('约 120 万个')
    expect(show(12_345_678)).toBe('约 1230 万个')
  })

  it('from 1 亿 uses 亿; a value that rounds up to 1 亿 is written in 亿', () => {
    expect(show(100_000_000)).toBe('约 1 亿个')
    expect(show(120_000_000)).toBe('约 1.2 亿个')
    expect(show(1_234_000_000)).toBe('约 12.3 亿个')
    expect(show(99_999_999)).toBe('约 1 亿个')
  })

  it('bad input never makes a negative or NaN count', () => {
    expect(show(-5)).toBe('0 个')
    expect(show(Number.NaN)).toBe('0 个')
  })
})
