import { describe, expect, it } from 'vitest'
import { columnQuantity, explicitQuantity, looksLikeQuantity, normalizeLine, parseQuantity, readLine } from '../../../src/core/parse'
import type { Hypothesis } from '../../../src/core/parse'

const pairs = (hypotheses: Hypothesis[]) => hypotheses.map((h) => [h.name, h.quantity])

describe('parseQuantity', () => {
  it('reads plain integers and classifiers', () => {
    expect(parseQuantity('10')).toBe(10)
    expect(parseQuantity('10艘')).toBe(10)
    for (const classifier of ['个', '艘', '件', '发', '颗', '台', '只']) expect(parseQuantity(`3${classifier}`)).toBe(3)
  })

  it('reads units: k, m, kk, b, 万, 亿 (any case) with decimals', () => {
    expect(parseQuantity('10k')).toBe(10_000)
    expect(parseQuantity('10K')).toBe(10_000)
    expect(parseQuantity('2.5m')).toBe(2_500_000)
    expect(parseQuantity('1.5M')).toBe(1_500_000)
    expect(parseQuantity('1kk')).toBe(1_000_000)
    expect(parseQuantity('3b')).toBe(3_000_000_000)
    expect(parseQuantity('3万')).toBe(30_000)
    expect(parseQuantity('1.5万')).toBe(15_000)
    expect(parseQuantity('1亿')).toBe(100_000_000)
    expect(parseQuantity('1.1m')).toBe(1_100_000)
    expect(parseQuantity('2万发')).toBe(20_000)
  })

  it('reads strict three-digit thousand separators: , . \' and spaces (NBSP after normalization)', () => {
    expect(parseQuantity('1,000,000')).toBe(1_000_000)
    expect(parseQuantity('1.000.000')).toBe(1_000_000)
    expect(parseQuantity('1 000 000')).toBe(1_000_000)
    expect(parseQuantity("1'000'000")).toBe(1_000_000)
    expect(parseQuantity(normalizeLine('1 000 000'))).toBe(1_000_000)
    expect(parseQuantity(normalizeLine('1 000'))).toBe(1_000)
    expect(parseQuantity('1,500.5k')).toBe(1_500_500)
    expect(parseQuantity('1.000')).toBe(1_000)
    expect(parseQuantity('2,162')).toBe(2_162)
  })

  it('treats a dot with a unit as a decimal point', () => {
    expect(parseQuantity('1.500k')).toBe(1_500)
  })

  it('rejects separators that are not strict groups of three, or mixed', () => {
    expect(parseQuantity('1,00')).toBeUndefined()
    expect(parseQuantity('10,0000')).toBeUndefined()
    expect(parseQuantity('1,000.000.000')).toBeUndefined()
    expect(parseQuantity('1,000 000')).toBeUndefined()
  })

  it('accepts only integers from 1 to 10^12', () => {
    expect(parseQuantity('0')).toBeUndefined()
    expect(parseQuantity('0.5')).toBeUndefined()
    expect(parseQuantity('1.5')).toBeUndefined()
    expect(parseQuantity('1.2345k')).toBeUndefined()
    expect(parseQuantity('1.0000k')).toBe(1_000)
    expect(parseQuantity('5.0')).toBe(5)
    expect(parseQuantity('1000000000000')).toBe(1e12)
    expect(parseQuantity('1000000000001')).toBeUndefined()
    expect(parseQuantity('1001b')).toBeUndefined()
  })

  it('is not fooled by names that start with digits', () => {
    expect(parseQuantity('5MN')).toBeUndefined()
    expect(parseQuantity('125mm')).toBeUndefined()
    expect(parseQuantity('m3')).toBeUndefined()
    expect(parseQuantity('')).toBeUndefined()
  })

  it('looksLikeQuantity tells a wrong number from something that is not a number', () => {
    expect(looksLikeQuantity('0.5')).toBe(true)
    expect(looksLikeQuantity('1,00')).toBe(true)
    expect(looksLikeQuantity('0')).toBe(true)
    expect(looksLikeQuantity('Battleship')).toBe(false)
    expect(looksLikeQuantity('50,000 m3')).toBe(false)
  })
})

describe('explicitQuantity', () => {
  it('reads *, × and x multipliers at the end', () => {
    expect(explicitQuantity('乌鸦级*10')).toEqual({ name: '乌鸦级', quantity: 10 })
    expect(explicitQuantity('乌鸦级 * 10')).toEqual({ name: '乌鸦级', quantity: 10 })
    expect(explicitQuantity('Raven ×10')).toEqual({ name: 'Raven', quantity: 10 })
    expect(explicitQuantity('Raven x10')).toEqual({ name: 'Raven', quantity: 10 })
    expect(explicitQuantity('Raven X10')).toEqual({ name: 'Raven', quantity: 10 })
    expect(explicitQuantity('Raven x 10')).toEqual({ name: 'Raven', quantity: 10 })
    expect(explicitQuantity('乌鸦级x10')).toEqual({ name: '乌鸦级', quantity: 10 })
    expect(explicitQuantity('乌鸦级*10艘')).toEqual({ name: '乌鸦级', quantity: 10 })
    expect(explicitQuantity('PLEX*1.5k')).toEqual({ name: 'PLEX', quantity: 1500 })
  })

  it('only takes x as a multiplier after a space or a Chinese character', () => {
    expect(explicitQuantity('Ravenx10')).toBeUndefined()
    expect(explicitQuantity('X-Large Ancillary Shield Booster')).toBeUndefined()
    expect(explicitQuantity('X-Large Ancillary Shield Booster x2')).toEqual({ name: 'X-Large Ancillary Shield Booster', quantity: 2 })
    expect(explicitQuantity("Zainou 'Snapshot' XL Torpedoes XT-602")).toBeUndefined()
  })

  it('uses the last multiplier', () => {
    expect(explicitQuantity('2×2圆环 - 无限 x3')).toEqual({ name: '2×2圆环 - 无限', quantity: 3 })
    expect(explicitQuantity('2×2圆环 - 无限')).toBeUndefined()
  })

  it('flags a written but invalid quantity', () => {
    expect(explicitQuantity('Raven*0')).toBe('bad')
    expect(explicitQuantity('Raven*0.5')).toBe('bad')
    expect(explicitQuantity('Raven x 0')).toBe('bad')
    expect(explicitQuantity('Raven*1,00')).toBe('bad')
    expect(explicitQuantity('Raven*10000000000000')).toBe('bad')
    expect(explicitQuantity('Raven*abc')).toBeUndefined()
  })
})

describe('readLine', () => {
  it('whole line first for plain names', () => {
    expect(pairs(readLine('Raven Navy Issue').hypotheses)).toEqual([['Raven Navy Issue', 1]])
  })

  it('leading quantity: 10 乌鸦级, 10x Raven, 2 x Raven, 10*Raven, 10万三钛合金', () => {
    expect(pairs(readLine('10 乌鸦级').hypotheses)[0]).toEqual(['乌鸦级', 10])
    expect(pairs(readLine('10x Raven').hypotheses)[0]).toEqual(['Raven', 10])
    expect(pairs(readLine('2 x Raven').hypotheses)[0]).toEqual(['Raven', 2])
    expect(pairs(readLine('10*Raven').hypotheses)[0]).toEqual(['Raven', 10])
    expect(pairs(readLine('10万三钛合金').hypotheses)[0]).toEqual(['三钛合金', 100_000])
    expect(pairs(readLine('10艘乌鸦级').hypotheses)[0]).toEqual(['乌鸦级', 10])
  })

  it('does not split names that start with digits and units', () => {
    expect(pairs(readLine('10MN Afterburner II').hypotheses)).toEqual([['10MN Afterburner II', 1]])
    expect(pairs(readLine('10MN加力燃烧器 II').hypotheses)).toEqual([['10MN加力燃烧器 II', 1]])
    expect(pairs(readLine('125mm Gatling AutoCannon I').hypotheses)).toEqual([['125mm Gatling AutoCannon I', 1]])
  })

  it('trailing number: tries every grouping, the whole line stays as a reading', () => {
    expect(pairs(readLine('PLEX 500').hypotheses)).toEqual([['PLEX', 500], ['PLEX 500', 1]])
    const booster = pairs(readLine('Cap Booster 800 100').hypotheses)
    expect(booster).toContainEqual(['Cap Booster 800', 100])
    expect(booster).toContainEqual(['Cap Booster', 800_100])
    expect(booster).toContainEqual(['Cap Booster 800 100', 1])
    expect(pairs(readLine('Navy Cap Booster 800 10').hypotheses)).not.toContainEqual(['Navy Cap Booster', 80_010])
    expect(pairs(readLine('Tritanium 1 000 000').hypotheses)[0]).toEqual(['Tritanium', 1_000_000])
    expect(pairs(readLine('三钛合金1000').hypotheses)[0]).toEqual(['三钛合金', 1000])
  })

  it('explicit multiplier comes first', () => {
    const reading = readLine('Raven x 10')
    expect(reading.hypotheses[0]).toEqual({ name: 'Raven', quantity: 10, kind: 'explicit' })
    expect(reading.badQuantity).toBe(false)
  })

  it('flags a bad explicit quantity but still offers the other readings', () => {
    const reading = readLine('Raven*0.5')
    expect(reading.badQuantity).toBe(true)
    expect(pairs(reading.hypotheses)).toEqual([['Raven*0.5', 1]])
  })

  it('flattened game rows: name, then a quantity, then ignored columns', () => {
    const reading = pairs(readLine('Raven 2 Battleship Ship 50,000 m3').hypotheses)
    expect(reading).toContainEqual(['Raven', 2])
    expect(reading.at(-1)).toEqual(['Raven 2 Battleship Ship 50,000 m3', 1])
    // 数量列是空的（组装好的船）：行尾是体积时也给出数量 1 的切法
    expect(pairs(readLine('Raven Battleship Ship 470,000 m3').hypotheses)).toContainEqual(['Raven', 1])
    // 不像游戏复制的行不给这种切法（打错字的名字不能被前半截顶替）
    expect(pairs(readLine('Raven Navvy Issue').hypotheses)).toEqual([['Raven Navvy Issue', 1]])
    expect(pairs(readLine('Raven 2 Battleship', { flattened: false }).hypotheses)).toEqual([['Raven 2 Battleship', 1]])
  })

  it('removes duplicate readings', () => {
    expect(pairs(readLine('Raven 2').hypotheses)).toEqual([['Raven', 2], ['Raven 2', 1]])
  })

  it('does not split very long lines', () => {
    const long = `${'Raven '.repeat(80)}2`
    expect(pairs(readLine(long).hypotheses)).toEqual([[long, 1]])
  })
})

describe('columnQuantity', () => {
  it('reads the quantity column of a copied row', () => {
    expect(columnQuantity('2')).toBe(2)
    expect(columnQuantity('1,000,000')).toBe(1_000_000)
    expect(columnQuantity('x2')).toBe(2)
    expect(columnQuantity('')).toBeUndefined()
    expect(columnQuantity(undefined)).toBeUndefined()
    expect(columnQuantity('Battleship')).toBeUndefined()
    expect(columnQuantity('50,000 m3')).toBeUndefined()
    expect(columnQuantity('0')).toBe('bad')
    expect(columnQuantity('1.5')).toBe('bad')
  })
})

describe('normalizeLine', () => {
  it('folds full-width characters and spaces, keeps tabs, drops zero-width characters', () => {
    expect(normalizeLine('ＲＡＶＥＮ＊１０')).toBe('RAVEN*10')
    expect(normalizeLine('　乌鸦级　x10​ ')).toBe('乌鸦级 x10')
    expect(normalizeLine('Raven\t2')).toBe('Raven\t2')
    expect(normalizeLine('Raven ✕ 2')).toBe('Raven × 2')
    expect(normalizeLine('50,000 m³')).toBe('50,000 m3')
  })
})
