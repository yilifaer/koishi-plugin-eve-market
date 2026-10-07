import { describe, expect, it } from 'vitest'
import { parsePaste, selectHypotheses } from '../../../src/core/parse'
import type { PasteOptions } from '../../../src/core/parse'
import { isFailure } from '../../../src/core/types'
import type { PasteParse } from '../../../src/core/types'
import { judge, matchMarket } from './fake-items'

function parse(text: string, opts: Partial<PasteOptions> = {}): PasteParse {
  const parsed = parsePaste(text, { matchMarket, ...opts })
  if (isFailure(parsed)) throw new Error(`unexpected failure: ${parsed.reason}`)
  return parsed
}

/** 选好读法以后的结果：[英文名, 数量]，认不出的写 ['?', 原文] */
function resolve(text: string, opts: Partial<PasteOptions> = {}) {
  const parsed = parse(text, opts)
  const selection = selectHypotheses(parsed, judge)
  const items = selection.lines.map(({ line, choice }) => (choice ? [choice.value, choice.hypothesis.quantity] : ['?', line.raw]))
  return { parsed, header: selection.header, items }
}

describe('parsePaste: header', () => {
  it('reads the header on the first line; list line numbers start after the header', () => {
    const { parsed, header, items } = resolve('XX-1 sell -5%\nRaven*2\nTritanium*1000000\nPyerite*500000')
    expect(header).toEqual({ market: 'XX-1', side: 'sell', modifierPct: -5 })
    expect(items).toEqual([['Raven', 2], ['Tritanium', 1_000_000], ['Pyerite', 500_000]])
    expect(parsed.lines.map((l) => l.lineNo)).toEqual([1, 2, 3])
    expect(parsed.format).toBe('lines')
  })

  it('reads the header on the second line when the command line had nothing else', () => {
    const { parsed, header, items } = resolve('\nXX-1 sell\nRaven*2')
    expect(header).toEqual({ market: 'XX-1', side: 'sell' })
    expect(items).toEqual([['Raven', 2]])
    expect(parsed.lines.map((l) => l.lineNo)).toEqual([1])
  })

  it('numbers the same list the same way wherever the header was written', () => {
    const numbers = (text: string) => {
      const parsed = parse(text)
      return [...parsed.lines.map((l) => [l.lineNo, l.raw]), ...parsed.skipped.map((s) => [s.lineNo, s.raw])]
    }
    const list = 'Raven*2\nzzzz qqqq\nRaven Blueprint (Copy)'
    const expected = [[1, 'Raven*2'], [2, 'zzzz qqqq'], [3, 'Raven Blueprint (Copy)']]
    expect(numbers(list)).toEqual(expected)
    expect(numbers(`\n${list}`)).toEqual(expected)
    expect(numbers(`Jita -5%\n${list}`)).toEqual(expected)
    expect(numbers(`\nJita buy\n${list}`)).toEqual(expected)
    expect(numbers(`Jita -5%\n\n${list}`)).toEqual(expected)
    // 第一行开头是参数、后面是物品：那一行就是第 1 行
    expect(parse('Jita Raven*2\nzzzz qqqq').lines.map((l) => l.lineNo)).toEqual([1, 2])
  })

  it('does not look for a header below a list line', () => {
    const { header, items } = resolve('Raven*2\nJita sell')
    expect(header).toEqual({})
    expect(items).toEqual([['Raven', 2], ['?', 'Jita sell']])
  })

  it('a header alone gives an empty list', () => {
    const parsed = parse('XX-1 -5%')
    expect(parsed.header).toEqual({ market: 'XX-1', modifierPct: -5 })
    expect(parsed.lines).toEqual([])
    expect(parse('').lines).toEqual([])
  })

  it('returns BAD_ARGUMENT for two markets or a modifier out of range', () => {
    expect(parsePaste('Jita Amarr\nRaven', { matchMarket })).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'two-markets' })
    expect(parsePaste('\nJita -95%\nRaven', { matchMarket })).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'modifier-range' })
  })

  it('keeps an unknown market word for appraise to report', () => {
    expect(parse('TEST sell\nRaven').header).toEqual({ market: 'TEST', side: 'sell' })
    expect(parse('#K7Q2 Jtia').header).toEqual({ appraisalId: 'K7Q2', market: 'Jtia' })
  })

  it('first line with parameters and an item: parameters count only if the item needs them stripped', () => {
    const raven = resolve('Jita Raven*2\nTritanium*100')
    expect(raven.header).toEqual({ market: 'Jita' })
    expect(raven.items).toEqual([['Raven', 2], ['Tritanium', 100]])
    const shuttle = resolve('Amarr Shuttle*2\nRaven')
    expect(shuttle.parsed.header).toEqual({ market: 'Amarr' })
    expect(shuttle.header).toEqual({})
    expect(shuttle.items).toEqual([['Amarr Shuttle', 2], ['Raven', 1]])
  })

  it('first line with parameters and several items', () => {
    const { header, items, parsed } = resolve('Jita Raven*2、Tritanium*1000')
    expect(header).toEqual({ market: 'Jita' })
    expect(items).toEqual([['Raven', 2], ['Tritanium', 1000]])
    expect(parsed.lines.map((l) => [l.lineNo, l.raw])).toEqual([[1, 'Jita Raven*2'], [1, 'Tritanium*1000']])
  })

  it('a tab-separated first line is never split into parameters', () => {
    expect(parse('Amarr Shuttle\t2').header).toEqual({})
  })
})

describe('parsePaste: lines', () => {
  it('splits several items on one line by 、，;|', () => {
    expect(resolve('Raven*2、Tritanium*1000').items).toEqual([['Raven', 2], ['Tritanium', 1000]])
    expect(resolve('Raven*2，Tritanium*1,000；Pyerite 5|Mexallon x3').items).toEqual([['Raven', 2], ['Tritanium', 1000], ['Pyerite', 5], ['Mexallon', 3]])
  })

  it('reads every written form of a quantity', () => {
    const text = [
      'Raven x 10', 'Raven x10', '10 乌鸦级', '10 Raven', '10x Raven', 'Raven ×10', '乌鸦级*10艘', 'Tritanium*10k', 'Tritanium*2.5m', 'Tritanium*1kk',
      'Tritanium*3b', 'Tritanium*3万', 'Tritanium*1亿', 'Tritanium*1,000,000', 'Tritanium*1 000 000', 'Tritanium*1.000.000',
      'PLEX 500', 'Tritanium\t1 000 000',
    ].join('\n')
    expect(resolve(text).items).toEqual([
      ['Raven', 10], ['Raven', 10], ['Raven', 10], ['Raven', 10], ['Raven', 10], ['Raven', 10], ['Raven', 10], ['Tritanium', 10_000], ['Tritanium', 2_500_000],
      ['Tritanium', 1_000_000], ['Tritanium', 3_000_000_000], ['Tritanium', 30_000], ['Tritanium', 100_000_000], ['Tritanium', 1_000_000],
      ['Tritanium', 1_000_000], ['Tritanium', 1_000_000], ['PLEX', 500], ['Tritanium', 1_000_000],
    ])
  })

  it('skips bad quantities, blueprint copies, bracket lines and punctuation-only lines', () => {
    const parsed = parse('Raven*0.5\nRaven\t0\nRaven Blueprint (Copy)\n[Empty High slot]\n------\n\nRaven')
    expect(parsed.skipped).toEqual([
      { lineNo: 1, raw: 'Raven*0.5', reason: 'quantity' },
      { lineNo: 2, raw: 'Raven\t0', reason: 'quantity' },
      { lineNo: 3, raw: 'Raven Blueprint (Copy)', reason: 'bpc' },
      { lineNo: 4, raw: '[Empty High slot]', reason: 'slot' },
      { lineNo: 5, raw: '------', reason: 'empty' },
    ])
    expect(parsed.lines.map((l) => l.lineNo)).toEqual([7])
  })

  it('leaves unrecognised lines for appraise, with the most likely reading first', () => {
    const { parsed, items } = resolve('Raven Navvy 2')
    expect(items).toEqual([['?', 'Raven Navvy 2']])
    expect(parsed.lines[0].hypotheses[0]).toMatchObject({ name: 'Raven Navvy', quantity: 2 })
  })

  it('two spaces typed by accident do not cut a name in half', () => {
    expect(resolve('Raven  Navy Issue').items).toEqual([['Raven Navy Issue', 1]])
    expect(resolve('Mexallon    250,000').items).toEqual([['Mexallon', 250_000]])
    expect(resolve('Raven    x2').items).toEqual([['Raven', 2]])
  })

  it('accepts CRLF and other line breaks', () => {
    expect(resolve('Raven*2\r\nTritanium*3\rPyerite*4').items).toEqual([['Raven', 2], ['Tritanium', 3], ['Pyerite', 4]])
  })

  it('keeps the original text of each line for echoing', () => {
    const [line] = parse('  ＲＡＶＥＮ＊２  ').lines
    expect(line.raw).toBe('ＲＡＶＥＮ＊２')
    expect(line.hypotheses[0]).toMatchObject({ name: 'RAVEN', quantity: 2 })
  })

  it('truncates after maxLines non-empty lines; the header and empty lines do not count', () => {
    const list = Array.from({ length: 205 }, (_, i) => `Tritanium*${i + 1}`)
    const parsed = parse(`Jita sell\n${list.slice(0, 3).join('\n')}\n\n${list.slice(3).join('\n')}`)
    expect(parsed.lines.length).toBe(200)
    expect(parsed.truncated).toBe(5)
    expect(parsed.lines.at(-1)?.raw).toBe('Tritanium*200')
    expect(parse('Raven\nRaven\nRaven', { maxLines: 2 }).truncated).toBe(1)
  })
})

describe('parsePaste: EFT', () => {
  it('reads several fittings and keeps lines before the first one as a plain list', () => {
    const parsed = parse('Tritanium*100\n[Rifter, 一号]\nDamage Control II\n\n[Raven, 二号]\nHobgoblin II x5')
    expect(parsed.format).toBe('eft')
    expect(parsed.fittings).toEqual([{ ship: 'Rifter', name: '一号' }, { ship: 'Raven', name: '二号' }])
    expect(parsed.lines.map((l) => [l.lineNo, l.role, l.fitting, l.hypotheses[0].name, l.hypotheses[0].quantity])).toEqual([
      [1, undefined, undefined, 'Tritanium', 100],
      [2, 'hull', 0, 'Rifter', 1],
      [3, 'module', 0, 'Damage Control II', 1],
      [5, 'hull', 1, 'Raven', 1],
      [6, 'cargo', 1, 'Hobgoblin II', 5],
    ])
  })

  it('a bad cargo quantity is skipped', () => {
    expect(parse('[Raven, x]\nHobgoblin II x0').skipped).toEqual([{ lineNo: 2, raw: 'Hobgoblin II x0', reason: 'quantity' }])
  })

  it('cargo names with commas are not loaded charges', () => {
    const parsed = parse('[Raven, x]\nExotic Dancers, Male x10\nCruise Missile Launcher II,Scourge Cruise Missile')
    expect(parsed.lines[1]).toMatchObject({ role: 'cargo', hypotheses: [{ name: 'Exotic Dancers, Male', quantity: 10 }] })
    expect(parsed.lines[2]).toMatchObject({ role: 'module', loadedCharge: 'Scourge Cruise Missile' })
  })

  it('a full-width comma in a hand-written header still counts', () => {
    expect(parse('［乌鸦级，刷怪］\n地精灵 II x5').fittings).toEqual([{ ship: '乌鸦级', name: '刷怪' }])
  })
})
