// 游戏里复制出来的几种格式，每种都有 Tab、4 个空格、单个空格三份（QQ 会不会把 Tab 换掉要实测），
// 三份必须得到同样的结果。

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePaste, selectHypotheses } from '../../../src/core/parse'
import { isFailure } from '../../../src/core/types'
import type { PasteParse } from '../../../src/core/types'
import { judge, matchMarket } from './fake-items'

const DIR = path.resolve(__dirname, '../../fixtures/pastes')
const VARIANTS = ['tab', 'spaces', 'single'] as const

function load(name: string): PasteParse {
  const parsed = parsePaste(fs.readFileSync(path.join(DIR, name), 'utf8'), { matchMarket })
  if (isFailure(parsed)) throw new Error(`${name}: ${parsed.reason}`)
  return parsed
}

function items(parsed: PasteParse) {
  return selectHypotheses(parsed, judge).lines.map(({ line, choice }) => (choice ? [choice.value, choice.hypothesis.quantity] : ['?', line.raw]))
}

const MINERALS = [
  ['Tritanium', 4457139], ['Pyerite', 1114284], ['Mexallon', 278571], ['Isogen', 69643],
  ['Nocxium', 17410], ['Zydrine', 4352], ['Megacyte', 1088],
]

const CASES: Array<{ name: string; format: PasteParse['format']; items: Array<[string, number]>; skipped: Array<[number, string]> }> = [
  {
    name: 'inventory',
    format: 'lines',
    items: [['Raven', 1], ['Tritanium', 1_000_000], ['Large Shield Extender II', 2], ['Hobgoblin II', 5], ['Scourge Cruise Missile', 2000], ['Nanite Repair Paste', 150]],
    skipped: [],
  },
  {
    name: 'assets',
    format: 'lines',
    items: [['Raven Navy Issue', 1], ['Rifter', 3], ['Tritanium', 250_000], ['Mobile Tractor Unit', 1], ['Large Micro Jump Drive', 2], ['Hammerhead II', 10]],
    skipped: [],
  },
  {
    name: 'contract',
    format: 'lines',
    items: [['Raven', 1], ['Ballistic Control System II', 2], ['Cruise Missile Launcher II', 6], ['Scourge Cruise Missile', 2162], ['Hobgoblin II', 5]],
    skipped: [[6, 'bpc']],
  },
  {
    name: 'industry',
    format: 'industry-window',
    items: MINERALS as Array<[string, number]>,
    skipped: [[1, 'header'], [2, 'header'], [3, 'header']],
  },
]

describe('game copies in every whitespace variant', () => {
  for (const c of CASES) {
    for (const lang of ['en', 'zh']) {
      for (const variant of VARIANTS) {
        it(`${c.name} (${lang}, ${variant})`, () => {
          const parsed = load(`${c.name}-${lang}.${variant}.txt`)
          expect(parsed.format).toBe(c.format)
          expect(parsed.header).toEqual({})
          expect(items(parsed)).toEqual(c.items)
          expect(parsed.skipped.map((s) => [s.lineNo, s.reason])).toEqual(c.skipped)
        })
      }
    }
  }

  for (const variant of VARIANTS) {
    it(`multibuy list (${variant})`, () => {
      expect(items(load(`multibuy-en.${variant}.txt`))).toEqual([
        ['Tritanium', 4457139], ['Pyerite', 1114284], ['Large Shield Extender II', 2], ['Cap Booster 800', 100], ['Navy Cap Booster 800', 10],
      ])
    })
  }
})

describe('EFT fittings', () => {
  for (const lang of ['en', 'zh']) {
    it(`reads hull, modules, loaded charges, drones and cargo (${lang})`, () => {
      const parsed = load(`eft-${lang}.txt`)
      expect(parsed.format).toBe('eft')
      expect(parsed.fittings).toEqual([{ ship: lang === 'en' ? 'Raven' : '乌鸦级', name: '刷怪乌鸦' }])
      expect(parsed.lines.every((l) => l.fitting === 0)).toBe(true)

      const resolved = selectHypotheses(parsed, judge).lines.map(({ line, choice }) => ({
        role: line.role,
        item: choice?.value,
        quantity: choice?.hypothesis.quantity,
        charge: line.loadedCharge && judge(line.loadedCharge)?.value,
        mutated: line.mutated ?? false,
      }))
      const module = (item: string, extra: { charge?: string; mutated?: boolean } = {}) => ({ role: 'module', item, quantity: 1, charge: extra.charge, mutated: extra.mutated ?? false })
      const cargo = (item: string, quantity: number) => ({ role: 'cargo', item, quantity, charge: undefined, mutated: false })
      expect(resolved).toEqual([
        { role: 'hull', item: 'Raven', quantity: 1, charge: undefined, mutated: false },
        module('Ballistic Control System II'),
        module('Ballistic Control System II'),
        module('Drone Damage Amplifier II'),
        module('Damage Control II', { mutated: true }),
        module('Large Shield Extender II'),
        module('Large Shield Extender II'),
        module('Multispectrum Shield Hardener II'),
        module('Pithum C-Type Multispectrum Shield Hardener'),
        module('Large Micro Jump Drive'),
        ...Array.from({ length: 6 }, () => module('Cruise Missile Launcher II', { charge: 'Scourge Cruise Missile' })),
        cargo('Hobgoblin II', 5),
        cargo('Hammerhead II', 3),
        cargo('Scourge Cruise Missile', 2000),
        cargo('Inferno Cruise Missile', 1000),
        cargo('Nanite Repair Paste', 50),
        cargo('Mobile Tractor Unit', 1),
      ])

      const skipped = parsed.skipped.map((s) => s.reason)
      expect(skipped.filter((r) => r === 'slot')).toHaveLength(5)
      expect(skipped.filter((r) => r === 'mutaplasmid')).toHaveLength(3)
      expect(skipped).toHaveLength(8)
    })
  }
})

describe('hand-written list', () => {
  it('reads every common way of writing an item and a quantity', () => {
    const parsed = load('list-mixed.txt')
    expect(items(parsed)).toEqual([
      ['Raven', 2],
      ['Raven Navy Issue', 1],
      ['Tritanium', 1_000_000],
      ['Hobgoblin II', 2],
      ['Warrior II', 10],
      ['Tritanium', 10_000],
      ['Pyerite', 1_500_000],
      ['Cap Booster 800', 100],
      ['Navy Cap Booster 800', 10],
      ['Raven', 3],
      ['Mexallon', 250_000],
      ['Isogen', 1_000_000],
      ['Nocxium', 1_000_000],
      ['Zydrine', 1000],
      ['PLEX', 500],
      ['X-Large Ancillary Shield Booster', 1],
      ['?', 'Raven Navvy'],
      ['Large Shield Extender II', 4],
      ['Medium Shield Extender II', 2],
    ])
    expect(parsed.skipped).toEqual([
      { lineNo: 17, raw: 'Raven Blueprint (Copy)', reason: 'bpc' },
      { lineNo: 18, raw: 'Raven*0.5', reason: 'quantity' },
    ])
    expect(parsed.lines.slice(-2).map((l) => l.lineNo)).toEqual([20, 20])
  })
})

// 游戏工业窗口的真实复制：物品名包在 <localized hint="中文名">英文名</localized> 里（QQ 原样送到）
describe('industry window with localized markup', () => {
  for (const variant of ['tab', 'spaces']) {
    it(`reads names inside the tags (${variant})`, () => {
      const parsed = load(`industry-localized.${variant}.txt`)
      expect(parsed.format).toBe('industry-window')
      expect(items(parsed)).toEqual([...MINERALS, ['Morphite', 500], ['Hobgoblin II', 10]])
      expect(parsed.lines.map((l) => l.lineNo)).toEqual([5, 6, 7, 8, 9, 10, 11, 15, 16])
      expect(parsed.lines[0].raw.startsWith('Tritanium')).toBe(true)
      expect(parsed.skipped.map((s) => [s.lineNo, s.reason])).toEqual([[1, 'header'], [2, 'header'], [4, 'header'], [13, 'header']])
    })
  }
})
