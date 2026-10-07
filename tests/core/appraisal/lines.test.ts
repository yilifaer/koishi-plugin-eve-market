import { describe, expect, it } from 'vitest'
import { MAX_WARNING_LINES } from '../../../src/constants'
import { chargesPerModule, langOf, readList, replaceLines } from '../../../src/core/appraisal/lines'
import { parsePaste } from '../../../src/core/parse'
import { isFailure } from '../../../src/core/types'
import type { ItemInfo, PasteParse } from '../../../src/core/types'
import { ALLOWED, CML2, fakeItems, fakeRegistry, item, RAVEN, RAVEN_NAVY, SCOURGE_CRUISE, TRITANIUM } from './helpers'

const markets = fakeRegistry()
const items = fakeItems()

function parse(text: string): PasteParse {
  const parsed = parsePaste(text, { matchMarket: (phrase) => markets.match(phrase, ALLOWED)?.key ?? null })
  if (isFailure(parsed)) throw new Error(`unexpected failure: ${parsed.code}`)
  return parsed
}

const fake = (extra: Partial<ItemInfo>): ItemInfo => ({ ...item(CML2), ...extra })

describe('chargesPerModule', () => {
  it('fills the module: capacity ÷ charge volume, rounded down', () => {
    expect(chargesPerModule(item(CML2), item(SCOURGE_CRUISE), 'full')).toBe(27)
    // 0.3 ÷ 0.1 在浮点里是 2.9999999999999996
    expect(chargesPerModule(fake({ capacity: 0.3 }), fake({ volume: 0.1 }), 'full')).toBe(3)
    expect(chargesPerModule(fake({ capacity: 40 }), fake({ volume: 24 }), 'full')).toBe(1)
  })

  it('counts 1 when a value is missing, the module is unknown, or the mode says once', () => {
    expect(chargesPerModule(fake({ capacity: null }), item(SCOURGE_CRUISE), 'full')).toBe(1)
    expect(chargesPerModule(undefined, item(SCOURGE_CRUISE), 'full')).toBe(1)
    expect(chargesPerModule(item(CML2), fake({ volume: 0 }), 'full')).toBe(1)
    expect(chargesPerModule(fake({ capacity: 0.01 }), item(SCOURGE_CRUISE), 'full')).toBe(1)
    expect(chargesPerModule(item(CML2), item(SCOURGE_CRUISE), 'once')).toBe(1)
  })
})

describe('readList', () => {
  it('keeps one entry per item on a line, with the chosen quantity and the input language', () => {
    const { list } = readList(parse('Raven*2、三钛合金 1000\nRaven Navy x3'), items)
    expect(list.entries.map((e) => [e.lineNo, e.typeId, e.quantity, e.approx, e.lang])).toEqual([
      [1, RAVEN, 2, false, 'en'],
      [1, TRITANIUM, 1000, false, 'zh'],
      [2, RAVEN_NAVY, 3, true, 'en'],
    ])
  })

  it('keeps the header parameters of a first line only when its item needed them stripped', () => {
    expect(readList(parse('Jita Raven*2'), items).header).toEqual({ market: 'Jita' })
    expect(readList(parse('Jita sell\nRaven'), items).header).toEqual({ market: 'Jita', side: 'sell' })
  })

  it('records unrecognised lines with the most likely quantity and suggestions as ids', () => {
    const { list } = readList(parse('Raven Navvy*3'), items)
    expect(list.entries).toEqual([{
      lineNo: 1, raw: 'Raven Navvy*3', quantity: 3, typeId: null, approx: false, lang: 'en',
      suggestion: RAVEN, candidates: [RAVEN, RAVEN_NAVY], total: 2,
    }])
  })

  it('looks for suggestions only for the unrecognised lines a card can show', () => {
    let lookups = 0
    const counting = {
      resolveLine(name: string) {
        const r = items.resolveLine(name)
        if (!('unresolved' in r)) return r
        // 和真正的识别器一样：第一次读到建议时才去找
        let looked = false
        return {
          unresolved: true as const,
          get suggestion() {
            if (!looked) lookups++
            looked = true
            return r.suggestion
          },
          candidates: r.candidates,
          total: r.total,
        }
      },
    }
    const text = Array.from({ length: 40 }, (_, i) => `Raven Navvy ${i + 1}x`).join('\n')
    const { list } = readList(parse(text), counting)
    expect(list.entries).toHaveLength(40)
    expect(lookups).toBe(MAX_WARNING_LINES)
    expect(list.entries[MAX_WARNING_LINES - 1].suggestion).toBe(RAVEN)
    expect(list.entries[MAX_WARNING_LINES]).not.toHaveProperty('suggestion')
  })

  it('reads EFT roles, loaded charges and mutated modules', () => {
    const { list } = readList(parse('[Raven, 测试]\nCruise Missile Launcher II, Scourge Cruise Missile\nEntropic Radiation Sink II [1]\nHobgoblin II x5'), items)
    expect(list.format).toBe('eft')
    expect(list.fittings).toEqual([{ ship: 'Raven', name: '测试' }])
    expect(list.entries.map((e) => [e.lineNo, e.raw, e.typeId, e.quantity, e.role, e.fitting, e.loadedIn ?? null, !!e.mutated])).toEqual([
      [1, '[Raven, 测试]', RAVEN, 1, 'hull', 0, null, false],
      [2, 'Cruise Missile Launcher II, Scourge Cruise Missile', CML2, 1, 'module', 0, null, false],
      [2, 'Scourge Cruise Missile', SCOURGE_CRUISE, 27, 'charge', 0, CML2, false],
      [3, 'Entropic Radiation Sink II [1]', 47911, 1, 'module', 0, null, true],
      [4, 'Hobgoblin II x5', 2456, 5, 'cargo', 0, null, false],
    ])
  })

  it('a loaded charge that is not recognised gets its own suggestion', () => {
    const { list } = readList(parse('[Raven, x]\nCruise Missile Launcher II, Scourge Cruse Missile'), items)
    expect(list.entries[2]).toMatchObject({ raw: 'Scourge Cruse Missile', typeId: null, role: 'charge', loadedIn: CML2, quantity: 1 })
    expect(list.entries[2].candidates).toContain(SCOURGE_CRUISE)
  })

  it('leaves loaded charges out entirely in ignore mode', () => {
    const { list } = readList(parse('[Raven, x]\nCruise Missile Launcher II, Scourge Cruise Missile'), items, 'ignore')
    expect(list.entries.map((e) => e.role)).toEqual(['hull', 'module'])
  })
})

describe('replaceLines', () => {
  it('replaces the first unrecognised item on the line and keeps its quantity', () => {
    const { list } = readList(parse('Raven*2\nRaven Navvy*3'), items)
    const replaced = replaceLines(list, { 2: RAVEN_NAVY, 1: TRITANIUM }, items)
    expect(replaced.entries.map((e) => [e.lineNo, e.typeId, e.quantity, e.suggestion])).toEqual([
      [1, RAVEN, 2, undefined],
      [2, RAVEN_NAVY, 3, undefined],
    ])
    // 原来的清单不变
    expect(list.entries[1].typeId).toBeNull()
  })

  it('ignores unknown ids and items that cannot be traded on the market', () => {
    const { list } = readList(parse('Raven Navvy'), items)
    expect(replaceLines(list, { 1: 999_999 }, items).entries[0].typeId).toBeNull()
    expect(replaceLines(list, { 1: 688 }, items).entries[0].typeId).toBeNull()
  })

  it('recomputes the loaded charges when the module or the charge is replaced', () => {
    const module = readList(parse('[Raven, x]\nCruise Missle Launcher II, Scourge Cruise Missile'), items).list
    expect(module.entries[2]).toMatchObject({ typeId: SCOURGE_CRUISE, quantity: 1, loadedIn: null })
    expect(replaceLines(module, { 2: CML2 }, items).entries[2]).toMatchObject({ quantity: 27, loadedIn: CML2 })
    const charge = readList(parse('[Raven, x]\nCruise Missile Launcher II, Scourge Cruse Missile'), items).list
    expect(replaceLines(charge, { 2: SCOURGE_CRUISE }, items).entries[2]).toMatchObject({ typeId: SCOURGE_CRUISE, quantity: 27 })
  })
})

describe('langOf', () => {
  it('is zh when the name has any Chinese character', () => {
    expect(langOf('乌鸦级')).toBe('zh')
    expect(langOf('10MN加力燃烧器 II')).toBe('zh')
    expect(langOf('Raven Navy Issue')).toBe('en')
  })
})
