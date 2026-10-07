import { describe, expect, it } from 'vitest'
import { chooseHypothesis, primaryHypothesis, readLine, selectHypotheses } from '../../../src/core/parse'
import type { Hypothesis, Judge } from '../../../src/core/parse'
import { judge } from './fake-items'

const pick = (hypotheses: Hypothesis[], j: Judge<string> = judge) => {
  const choice = chooseHypothesis(hypotheses, j)
  return choice && [choice.value, choice.hypothesis.quantity, choice.approx]
}

const read = (line: string) => readLine(line).hypotheses

describe('chooseHypothesis', () => {
  it('prefers the explicit multiplier when it is recognised', () => {
    expect(pick(read('Raven x 10'))).toEqual(['Raven', 10, false])
    expect(pick(read('乌鸦级*10艘'))).toEqual(['Raven', 10, false])
  })

  it('takes the longest recognised name among equally good readings', () => {
    expect(pick(read('Cap Booster 800 100'))).toEqual(['Cap Booster 800', 100, false])
    expect(pick(read('Navy Cap Booster 800 10'))).toEqual(['Navy Cap Booster 800', 10, false])
    expect(pick(read('Tritanium 1 000 000'))).toEqual(['Tritanium', 1_000_000, false])
  })

  it('prefers an exact match over a unique prefix (≈)', () => {
    expect(pick(read('Raven Navy 2'))).toEqual(['Raven Navy Issue', 2, true])
    const hypotheses: Hypothesis[] = [{ name: 'Raven Nav', quantity: 1 }, { name: 'Raven', quantity: 1 }]
    expect(pick(hypotheses)).toEqual(['Raven', 1, false])
  })

  it('keeps names that contain numbers whole', () => {
    expect(pick(read('Cap Booster 800'))).toEqual(['Cap Booster 800', 1, false])
    expect(pick(read('10MN Afterburner II'))).toEqual(['10MN Afterburner II', 1, false])
    expect(pick(read('X-Large Ancillary Shield Booster'))).toEqual(['X-Large Ancillary Shield Booster', 1, false])
  })

  it('does not treat Ravenx10 as a multiplier', () => {
    expect(pick(read('Ravenx10'))).toBeUndefined()
  })

  it('accepts flattened rows only on exact names', () => {
    expect(pick(read('Raven 2 Battleship Ship 50,000 m3'))).toEqual(['Raven', 2, false])
    expect(pick(read('Raven Navy Issue Battleship Ship 50,000 m3'))).toEqual(['Raven Navy Issue', 1, false])
    // 「Mobile」是 Mobile Tractor Unit 的唯一前缀，但压平的分列行不接受 ≈
    const flattened: Hypothesis[] = [{ name: 'Mobile', quantity: 1, kind: 'flattened' }]
    expect(pick(flattened)).toBeUndefined()
    expect(pick([{ name: 'Mobile', quantity: 1, kind: 'whole' }])).toEqual(['Mobile Tractor Unit', 1, true])
  })

  it('uses stripped readings only when the whole line is not recognised', () => {
    const shuttle: Hypothesis[] = [{ name: 'Amarr Shuttle', quantity: 2, kind: 'explicit' }, { name: 'Shuttle', quantity: 2, kind: 'explicit', stripped: true }]
    expect(pick(shuttle)).toEqual(['Amarr Shuttle', 2, false])
    const raven: Hypothesis[] = [{ name: 'Jita Raven', quantity: 2, kind: 'explicit' }, { name: 'Raven', quantity: 2, kind: 'explicit', stripped: true }]
    expect(chooseHypothesis(raven, judge)?.hypothesis.stripped).toBe(true)
  })

  it('asks the judge once per name', () => {
    const asked: string[] = []
    const counting: Judge<string> = (name) => {
      asked.push(name)
      return judge(name)
    }
    chooseHypothesis([...read('Raven 2 Battleship Ship 50,000 m3'), { name: 'Raven', quantity: 3 }], counting)
    expect(asked.length).toBe(new Set(asked).size)
  })
})

describe('primaryHypothesis and selectHypotheses', () => {
  it('primary is the most likely reading, or the stripped one on the first line', () => {
    expect(primaryHypothesis({ hypotheses: read('Raven Navvy 2') })).toMatchObject({ name: 'Raven Navvy', quantity: 2 })
    const inline = [{ name: 'Jita Raven Navvy', quantity: 2 }, { name: 'Raven Navvy', quantity: 2, stripped: true }]
    expect(primaryHypothesis({ hypotheses: inline })).toMatchObject({ name: 'Raven Navvy', stripped: true })
    expect(primaryHypothesis({ hypotheses: [] })).toBeUndefined()
  })

  it('drops the leading parameters when the whole first line is an item', () => {
    const lines = [{ lineNo: 1, raw: 'Amarr Shuttle*2', hypotheses: [{ name: 'Amarr Shuttle', quantity: 2, kind: 'explicit' as const }, { name: 'Shuttle', quantity: 2, kind: 'explicit' as const, stripped: true }] }]
    const selection = selectHypotheses({ header: { market: 'Amarr' }, lines }, judge)
    expect(selection.header).toEqual({})
    expect(selection.lines[0].choice?.value).toBe('Amarr Shuttle')
  })

  it('keeps them when the stripped reading wins or nothing is recognised', () => {
    const raven = [{ lineNo: 1, raw: 'Jita Raven*2', hypotheses: [{ name: 'Jita Raven', quantity: 2 }, { name: 'Raven', quantity: 2, stripped: true }] }]
    expect(selectHypotheses({ header: { market: 'Jita' }, lines: raven }, judge).header).toEqual({ market: 'Jita' })
    const unknown = [{ lineNo: 1, raw: 'Jita Foo*2', hypotheses: [{ name: 'Jita Foo', quantity: 2 }, { name: 'Foo', quantity: 2, stripped: true }] }]
    const selection = selectHypotheses({ header: { market: 'Jita' }, lines: unknown }, judge)
    expect(selection.header).toEqual({ market: 'Jita' })
    expect(selection.lines[0].choice).toBeUndefined()
    expect(selection.lines[0].primary).toMatchObject({ name: 'Foo' })
  })
})
