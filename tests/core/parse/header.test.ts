import { describe, expect, it } from 'vitest'
import { parseAppraisalId, parseHeaderLine, parseModifier, parseSide } from '../../../src/core/parse'
import { matchMarket } from './fake-items'

const header = (line: string) => parseHeaderLine(line, matchMarket, { inline: true })

describe('header words', () => {
  it('price types: every word printed on a card can be typed back', () => {
    for (const w of ['sell', 'SELL', '出售', '出售价', '卖', '卖价', '卖单']) expect(parseSide(w), w).toBe('sell')
    for (const w of ['buy', 'Buy', '收购', '收购价', '买', '买价', '买单']) expect(parseSide(w), w).toBe('buy')
    for (const w of ['mid', '中间', '中间价', '中', 'split']) expect(parseSide(w), w).toBe('mid')
    expect(parseSide('Raven')).toBeUndefined()
  })

  it('modifiers: ±N%, bare N% (50–150), N折 (50–99 or 5–9.9)', () => {
    expect(parseModifier('-5%')).toBe(-5)
    expect(parseModifier('+10%')).toBe(10)
    expect(parseModifier('－5％'.normalize('NFKC'))).toBe(-5)
    expect(parseModifier('−5%')).toBe(-5)
    expect(parseModifier('-0%')).toBe(0)
    expect(parseModifier('95%')).toBe(-5)
    expect(parseModifier('110%')).toBe(10)
    expect(parseModifier('95折')).toBe(-5)
    expect(parseModifier('9.5折')).toBe(-5)
    expect(parseModifier('8折')).toBe(-20)
    expect(parseModifier('8.8折')).toBe(-12)
    expect(parseModifier('5折')).toBe(-50)
  })

  it('modifiers out of range are recognised as such', () => {
    expect(parseModifier('-95%')).toBe('out-of-range')
    expect(parseModifier('+100%')).toBe('out-of-range')
    expect(parseModifier('45%')).toBe('out-of-range')
    expect(parseModifier('151%')).toBe('out-of-range')
    expect(parseModifier('4折')).toBe('out-of-range')
    expect(parseModifier('10折')).toBe('out-of-range')
    expect(parseModifier('30折')).toBe('out-of-range')
    expect(parseModifier('Raven')).toBeUndefined()
    expect(parseModifier('5')).toBeUndefined()
  })

  it('appraisal ids have 4 characters from the safe alphabet and at least one letter', () => {
    expect(parseAppraisalId('#K7Q2')).toBe('K7Q2')
    expect(parseAppraisalId('#k7q2')).toBe('K7Q2')
    expect(parseAppraisalId('#2345')).toBeUndefined()
    expect(parseAppraisalId('#638')).toBeUndefined()
    expect(parseAppraisalId('#K7O2')).toBeUndefined()
    expect(parseAppraisalId('#K7Q21')).toBeUndefined()
  })
})

describe('parseHeaderLine', () => {
  it('takes parameters in any order', () => {
    expect(header('XX-1 sell -5%')).toEqual({ kind: 'header', header: { market: 'XX-1', side: 'sell', modifierPct: -5 } })
    expect(header('-5% 收购价 xx')).toEqual({ kind: 'header', header: { market: 'xx', side: 'buy', modifierPct: -5 } })
    expect(header('95折 卖单')).toEqual({ kind: 'header', header: { side: 'sell', modifierPct: -5 } })
    expect(header('买单 9.5折 吉他')).toEqual({ kind: 'header', header: { market: '吉他', side: 'buy', modifierPct: -5 } })
  })

  it('matches multi-word market names first', () => {
    expect(header('Jita 4-4 mid')).toEqual({ kind: 'header', header: { market: 'Jita 4-4', side: 'mid' } })
  })

  it('accepts the same market written twice, rejects two different markets', () => {
    expect(header('Jita 吉他 sell')).toEqual({ kind: 'header', header: { market: 'Jita', side: 'sell' } })
    expect(header('Jita Amarr')).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'two-markets', token: 'Amarr' })
    expect(header('sell Jita XX-1')).toMatchObject({ ok: false, reason: 'two-markets' })
  })

  it('rejects modifiers out of range and conflicting modifiers', () => {
    expect(header('Jita -95%')).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'modifier-range', token: '-95%' })
    expect(header('Jita 4折')).toMatchObject({ ok: false, reason: 'modifier-range', token: '4折' })
    expect(header('-5% -10%')).toMatchObject({ ok: false, reason: 'modifier-range', token: '-10%' })
    expect(header('-5% 95折')).toEqual({ kind: 'header', header: { modifierPct: -5 } })
  })

  it('reads saved appraisals, 全部 and line replacements', () => {
    expect(header('#K7Q2 buy')).toEqual({ kind: 'header', header: { appraisalId: 'K7Q2', side: 'buy' } })
    expect(header('#K7Q2 全部')).toEqual({ kind: 'header', header: { appraisalId: 'K7Q2', all: true } })
    // 「下一页」按钮：从第 81 项接着列
    expect(header('#K7Q2 全部 从81')).toEqual({ kind: 'header', header: { appraisalId: 'K7Q2', all: true, from: 81 } })
    expect(header('#K7Q2 从0')).toEqual({ kind: 'header', header: { appraisalId: 'K7Q2', market: '从0' } })
    expect(header('#K7Q2 7=#17636 9=#638')).toEqual({ kind: 'header', header: { appraisalId: 'K7Q2', replace: { 7: 17636, 9: 638 } } })
    expect(header('#K7Q2 Jita')).toEqual({ kind: 'header', header: { appraisalId: 'K7Q2', market: 'Jita' } })
  })

  it('one unknown word next to known parameters is an unknown market', () => {
    expect(header('TEST sell')).toEqual({ kind: 'header', header: { market: 'TEST', side: 'sell' } })
    // 按表头规则，「Raven sell」也是未知市场（物品要写在下一行，或者带上数量）
    expect(header('Raven sell')).toEqual({ kind: 'header', header: { market: 'Raven', side: 'sell' } })
    expect(header('jiat -5%')).toEqual({ kind: 'header', header: { market: 'jiat', modifierPct: -5 } })
    expect(header('#K7Q2 Jtia')).toEqual({ kind: 'header', header: { appraisalId: 'K7Q2', market: 'Jtia' } })
  })

  it('a word that looks like an item is not taken for a market', () => {
    expect(header('sell Raven*2')).toEqual({ kind: 'inline', header: { side: 'sell' }, rest: 'Raven*2' })
    expect(header('sell 500')).toEqual({ kind: 'inline', header: { side: 'sell' }, rest: '500' })
  })

  it('splits leading parameters from items on the first line', () => {
    expect(header('Jita Raven*2')).toEqual({ kind: 'inline', header: { market: 'Jita' }, rest: 'Raven*2' })
    expect(header('XX-1 sell -5% Raven Navy Issue x2')).toEqual({ kind: 'inline', header: { market: 'XX-1', side: 'sell', modifierPct: -5 }, rest: 'Raven Navy Issue x2' })
    // 第二个不同的市场算物品名的开头
    expect(header('Jita Amarr Shuttle*2')).toEqual({ kind: 'inline', header: { market: 'Jita' }, rest: 'Amarr Shuttle*2' })
    expect(header('Jita -95% Raven')).toMatchObject({ ok: false, reason: 'modifier-range' })
  })

  it('is not a header when the line starts with an item', () => {
    expect(header('Raven*2')).toEqual({ kind: 'none' })
    expect(header('Raven Navy Issue sell')).toEqual({ kind: 'none' })
    expect(header('[Raven, 刷怪乌鸦]')).toEqual({ kind: 'none' })
    expect(header('')).toEqual({ kind: 'none' })
  })

  it('options turn off header or inline detection', () => {
    expect(parseHeaderLine('Jita Raven', matchMarket)).toEqual({ kind: 'none' })
    expect(parseHeaderLine('Jita sell', matchMarket, { header: false, inline: true })).toEqual({ kind: 'none' })
    expect(parseHeaderLine('Jita sell Raven', matchMarket, { header: false, inline: true })).toEqual({ kind: 'inline', header: { market: 'Jita', side: 'sell' }, rest: 'Raven' })
  })

  it('a hidden market is just an unknown word', () => {
    const visible = (phrase: string) => (phrase.toLowerCase() === 'jita' ? 'jita' : null)
    expect(parseHeaderLine('XX-1 sell', visible, { inline: true })).toEqual({ kind: 'header', header: { market: 'XX-1', side: 'sell' } })
  })
})
