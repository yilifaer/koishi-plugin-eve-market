import { describe, expect, it } from 'vitest'
import { createModuleStore } from '../../../src/core/ports'
import {
  PendingStore, applyChoice, choicesOf, parseChoiceReply, pendingKey, pendingStore, withQuantity,
} from '../../../src/bot/pending'
import type { ChoicesPending } from '../../../src/bot/pending'
import { COMMAND_NAMES } from '../../../src/constants'

function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

const KEY = 'qq:GROUP:MEMBER'

describe('PendingStore', () => {
  it('keys by platform, channel and user', () => {
    expect(pendingKey({ platform: 'qq', channelId: 'G1', userId: 'U1' })).toBe('qq:G1:U1')
    expect(pendingKey({ platform: 'qq', channelId: 'U1', userId: 'U1' })).toBe('qq:U1:U1')
  })

  it('keeps only the latest pending per person', () => {
    const store = new PendingStore()
    store.setChoices(KEY, [{ no: 1, command: '查价 乌鸦级' }])
    store.setList(KEY, '联盟市场A -5%')
    expect(store.get(KEY)).toEqual({ kind: 'list', header: '联盟市场A -5%' })
    store.setChoices(KEY, [{ no: 1, command: '查价 乌鸦级' }])
    expect(store.get(KEY)?.kind).toBe('choices')
    expect(store.get('qq:GROUP:OTHER')).toBeUndefined()
  })

  it('expires after 5 minutes', () => {
    const time = clock()
    const store = new PendingStore({ now: time.now })
    store.setList(KEY, '')
    time.advance(5 * 60_000 - 1)
    expect(store.get(KEY)).toBeDefined()
    time.advance(1)
    expect(store.get(KEY)).toBeUndefined()
    expect(store.clear(KEY)).toBe(false)
  })

  it('clear reports whether there was something to clear', () => {
    const store = new PendingStore()
    expect(store.clear(KEY)).toBe(false)
    store.setList(KEY, 'Jita')
    expect(store.clear(KEY)).toBe(true)
    expect(store.get(KEY)).toBeUndefined()
  })

  it('drops numbers outside 1–99 and empty commands; records nothing when none are left', () => {
    const store = new PendingStore()
    store.setChoices(KEY, [{ no: 0, command: 'x' }, { no: 100, command: 'y' }, { no: 2, command: '  ' }])
    expect(store.get(KEY)).toBeUndefined()
    store.setChoices(KEY, [{ no: 1, command: ' 查价 乌鸦级 ' }, { no: 100, command: 'y' }], { quantity: true, meTe: ' 制造 乌鸦级 XX-1 高级 ' })
    expect(store.get(KEY)).toEqual({ kind: 'choices', choices: [{ no: 1, command: '查价 乌鸦级' }], quantity: true, meTe: '制造 乌鸦级 XX-1 高级' })
  })

  it('a list pending can carry the numbered candidates of the card that asked for it', () => {
    const store = new PendingStore()
    store.setList(KEY, ' Jita sell ', [{ no: 1, command: ' 批量查价 #K7Q2 1=#380 ' }, { no: 100, command: 'x' }])
    expect(store.get(KEY)).toEqual({ kind: 'list', header: 'Jita sell', choices: [{ no: 1, command: '批量查价 #K7Q2 1=#380' }] })
    store.setList(KEY, 'Jita', [{ no: 0, command: 'x' }])
    expect(store.get(KEY)).toEqual({ kind: 'list', header: 'Jita' })
  })

  it('forgets the least recently used people beyond the limit', () => {
    const store = new PendingStore({ max: 2 })
    store.setList('a', '')
    store.setList('b', '')
    store.get('a')
    store.setList('c', '')
    expect(store.get('b')).toBeUndefined()
    expect(store.get('a')).toBeDefined()
  })

  it('lives in the module store, so it survives a plugin reload', () => {
    const store = createModuleStore()
    pendingStore(store).setList(KEY, 'Jita')
    expect(pendingStore(store).get(KEY)).toEqual({ kind: 'list', header: 'Jita' })
  })

  it('builds the pending commands from a card with the current command names', () => {
    const card = { choices: [
      { no: 1, label: '大型', command: { id: 'price' as const, args: 'Jita 大型护盾扩展装置 II*4' } },
      { no: 2, label: '帮助', command: { id: 'help' as const, args: '查价' } },
    ] }
    const namer = { commandName: (id: keyof typeof COMMAND_NAMES) => id === 'price' ? '估价' : COMMAND_NAMES[id] }
    expect(choicesOf(card, namer)).toEqual([
      { no: 1, command: '估价 Jita 大型护盾扩展装置 II*4' },
      { no: 2, command: '帮助 查价' },
    ])
    expect(choicesOf({}, namer)).toEqual([])
  })
})

describe('parseChoiceReply', () => {
  it('accepts 1–99', () => {
    expect(parseChoiceReply('1')).toEqual({ kind: 'number', no: 1 })
    expect(parseChoiceReply(' 12 ')).toEqual({ kind: 'number', no: 12 })
    expect(parseChoiceReply('99')).toEqual({ kind: 'number', no: 99 })
    for (const bad of ['0', '00', '100', '', '1.5', '一', '#1', '1 2']) expect(parseChoiceReply(bad)).toBeNull()
  })

  it('accepts a quantity after the number', () => {
    expect(parseChoiceReply('2*10')).toEqual({ kind: 'number', no: 2, quantity: '10' })
    expect(parseChoiceReply('2 * 10')).toEqual({ kind: 'number', no: 2, quantity: '10' })
    expect(parseChoiceReply('2x10')).toEqual({ kind: 'number', no: 2, quantity: '10' })
    expect(parseChoiceReply('2 X 10')).toEqual({ kind: 'number', no: 2, quantity: '10' })
    expect(parseChoiceReply('2×1,000')).toEqual({ kind: 'number', no: 2, quantity: '1,000' })
    expect(parseChoiceReply('3*1 000 000')).toEqual({ kind: 'number', no: 3, quantity: '1 000 000' })
    expect(parseChoiceReply('3*2.5m')).toEqual({ kind: 'number', no: 3, quantity: '2.5m' })
    expect(parseChoiceReply('3*3万')).toEqual({ kind: 'number', no: 3, quantity: '3万' })
    expect(parseChoiceReply('3*10艘')).toEqual({ kind: 'number', no: 3, quantity: '10艘' })
    expect(parseChoiceReply('2*')).toBeNull()
    expect(parseChoiceReply('2*abc')).toBeNull()
    expect(parseChoiceReply('2 乌鸦级')).toBeNull()
  })

  it('accepts ME and TE', () => {
    expect(parseChoiceReply('ME7')).toEqual({ kind: 'me-te', tokens: 'ME7' })
    expect(parseChoiceReply('te14')).toEqual({ kind: 'me-te', tokens: 'TE14' })
    expect(parseChoiceReply('me 7 te 14')).toEqual({ kind: 'me-te', tokens: 'ME7 TE14' })
    expect(parseChoiceReply('ME07')).toEqual({ kind: 'me-te', tokens: 'ME7' })
    for (const bad of ['ME', 'ME100', 'ME7 TE14 ME3', 'ME7乌鸦']) expect(parseChoiceReply(bad)).toBeNull()
  })

  it('stays linear on long input', () => {
    const long = `1*${'1 '.repeat(20_000)}x`
    const started = Date.now()
    expect(parseChoiceReply(long)).toBeNull()
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('applyChoice', () => {
  const pending: ChoicesPending = {
    kind: 'choices',
    choices: [{ no: 1, command: '查价 Jita 大型护盾扩展装置 II*4' }, { no: 2, command: '查价 Jita 中型护盾扩展装置 II' }],
    quantity: true,
  }

  it('rewrites a number to the stored command', () => {
    expect(applyChoice(pending, { kind: 'number', no: 2 })).toEqual({ ok: true, command: '查价 Jita 中型护盾扩展装置 II' })
  })

  it('replaces or adds the quantity when the commands accept one', () => {
    expect(applyChoice(pending, { kind: 'number', no: 1, quantity: '10' })).toEqual({ ok: true, command: '查价 Jita 大型护盾扩展装置 II*10' })
    expect(applyChoice(pending, { kind: 'number', no: 2, quantity: '3万' })).toEqual({ ok: true, command: '查价 Jita 中型护盾扩展装置 II*3万' })
    expect(applyChoice({ ...pending, quantity: false }, { kind: 'number', no: 1, quantity: '10' }))
      .toEqual({ ok: true, command: '查价 Jita 大型护盾扩展装置 II*4' })
  })

  it('reports a number that is not in the list', () => {
    expect(applyChoice(pending, { kind: 'number', no: 7 })).toEqual({ ok: false, max: 2 })
  })

  it('takes ME/TE only for the advanced manufacturing steps', () => {
    expect(applyChoice(pending, { kind: 'me-te', tokens: 'ME7' })).toBeNull()
    expect(applyChoice({ ...pending, meTe: '制造 乌鸦级 XX-1 高级' }, { kind: 'me-te', tokens: 'ME7 TE14' }))
      .toEqual({ ok: true, command: '制造 乌鸦级 XX-1 高级 ME7 TE14' })
  })

  it('withQuantity only touches a trailing *N', () => {
    expect(withQuantity('查价 #638', '5')).toBe('查价 #638*5')
    expect(withQuantity('查价 #638 * 4', '5')).toBe('查价 #638*5')
    expect(withQuantity('查价 Cap Booster 800', '5')).toBe('查价 Cap Booster 800*5')
  })
})
