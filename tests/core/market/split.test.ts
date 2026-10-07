import { describe, expect, it } from 'vitest'
import { marketKey, recognitionOf, recognize, splitMarket } from '../../../src/core/market'
import type { SplitContext } from '../../../src/core/market'
import type { ImplantSet, MarketDef, Resolution } from '../../../src/core/types'
import { ambiguous, confirm, fakeItems, item, unique } from './helpers'

function market(name: string): MarketDef {
  return { key: marketKey(name), name, aliases: [], shortAlias: name, type: 'npc-station', regionId: 10000002, inDefaultList: false, sortOrder: 0, visibility: 'public' }
}

const JITA = market('Jita')
const JITA_4_4 = market('Jita 4-4')
const AMARR = market('Amarr')
const MARKETS = new Map([['jita', JITA], ['jita 4-4', JITA_4_4], ['amarr', AMARR]])

const raven = item(638, 'Raven', '乌鸦级')
const shuttle = item(11129, 'Amarr Shuttle', '艾玛穿梭机')
const extenders = [item(3841, 'Large Shield Extender II'), item(3831, 'Medium Shield Extender II')]
const set: ImplantSet = { name: { en: 'High-grade Crystal', zh: '高级水晶' }, grade: 'high', items: [] }

const TABLE: Record<string, Resolution> = {
  乌鸦级: unique(raven),
  raven: unique(raven),
  'amarr shuttle': unique(shuttle),
  shuttle: ambiguous('prefix', shuttle, item(672, 'Caldari Shuttle')),
  护盾扩展: ambiguous('prefix', ...extenders),
  'large shield extender ii': unique(extenders[0]),
  'shield extender ii': ambiguous('prefix', ...extenders),
  护盾: confirm(...extenders),
  wuya: { kind: 'confirm', tier: 'pinyin', candidates: [raven], total: 1 },
  伊什塔级蓝图: { kind: 'out-of-scope', item: item(12006, 'Ishtar Blueprint', '伊什塔级蓝图'), scope: 'market' },
  高级水晶: { kind: 'set', set },
  无畏: { kind: 'group', groupName: 'Dreadnought', candidates: [], total: 0 },
  '10': ambiguous('prefix', item(12076, '10MN Afterburner II')),
}

function ctx(table: Record<string, Resolution> = TABLE, scope: SplitContext['scope'] = 'market') {
  const items = fakeItems(table)
  const context: SplitContext = { match: (phrase) => MARKETS.get(marketKey(phrase)) ?? null, maxWords: 2, items, scope }
  return { context, items }
}

const split = (text: string, table?: Record<string, Resolution>) => splitMarket(text, ctx(table).context)

describe('splitMarket: a market written before the item', () => {
  it('cuts the leading market, longest name first', () => {
    expect(split('Jita 乌鸦级')).toEqual({ market: JITA, rest: '乌鸦级' })
    expect(split('Jita 4-4 乌鸦级*10')).toEqual({ market: JITA_4_4, rest: '乌鸦级*10' })
    expect(split('Ｊｉｔａ　乌鸦级 x 10')).toEqual({ market: JITA, rest: '乌鸦级 x 10' })
  })

  it('only the market: nothing left to resolve', () => {
    expect(split('Jita')).toEqual({ market: JITA, rest: '' })
    expect(split('Jita 4-4')).toEqual({ market: JITA_4_4, rest: '' })
  })

  it('no market at all', () => {
    expect(split('乌鸦级')).toEqual({ rest: '乌鸦级' })
    expect(split('  ')).toEqual({ rest: '' })
    // 写在末尾的不当市场
    expect(split('乌鸦级 Jita')).toEqual({ rest: '乌鸦级 Jita' })
  })
})

describe('splitMarket: market name versus item name', () => {
  it('only the whole sentence is an exact item: no market', () => {
    expect(split('Amarr Shuttle')).toEqual({ rest: 'Amarr Shuttle' })
    expect(split('Amarr Shuttle*3')).toEqual({ rest: 'Amarr Shuttle*3' })
  })

  it('both readings are exact: market first, the whole sentence as the alternative', () => {
    const table = { ...TABLE, shuttle: unique(item(672, 'Caldari Shuttle'), 'alias') }
    expect(split('Amarr Shuttle', table)).toEqual({ market: AMARR, rest: 'Shuttle', alt: 'Amarr Shuttle' })
  })

  it('neither reading is exact: market first', () => {
    expect(split('Amarr 护盾')).toEqual({ market: AMARR, rest: '护盾' })
    expect(split('Jita 乌鸦机')).toEqual({ market: JITA, rest: '乌鸦机' })
  })
})

describe('splitMarket: unknown market (structural rule)', () => {
  it('first word is not a market, the rest is an item, the whole sentence is not', () => {
    expect(split('TEST 乌鸦级')).toEqual({ rest: '乌鸦级', unknown: 'TEST' })
    expect(split('jiat 乌鸦级*10')).toEqual({ rest: '乌鸦级*10', unknown: 'jiat' })
    // 有歧义也算识别
    expect(split('TEST 护盾扩展')).toEqual({ rest: '护盾扩展', unknown: 'TEST' })
    // 套装、组名、不能上市场的物品都算
    expect(split('TEST 高级水晶')).toEqual({ rest: '高级水晶', unknown: 'TEST' })
    expect(split('TEST 无畏')).toEqual({ rest: '无畏', unknown: 'TEST' })
    expect(split('TEST 伊什塔级蓝图')).toEqual({ rest: '伊什塔级蓝图', unknown: 'TEST' })
  })

  it('not an unknown market when the rest cannot be recognized at tiers 0-3', () => {
    expect(split('TEST 乌鸦机')).toEqual({ rest: 'TEST 乌鸦机' })
    // 拼音、包含档要确认，不算
    expect(split('TEST wuya')).toEqual({ rest: 'TEST wuya' })
    expect(split('TEST 护盾')).toEqual({ rest: 'TEST 护盾' })
    // 末尾数量不会被当成物品
    expect(split('PLEX 500')).toEqual({ rest: 'PLEX 500' })
  })

  it('not an unknown market when the whole sentence is an item', () => {
    expect(split('Large Shield Extender II')).toEqual({ rest: 'Large Shield Extender II' })
    // 开头、末尾的数量
    expect(split('10 乌鸦级')).toEqual({ rest: '10 乌鸦级' })
    expect(split('Raven 10')).toEqual({ rest: 'Raven 10' })
  })

  it('passes the scope to the resolver', () => {
    const { context, items } = ctx(TABLE, 'industry')
    splitMarket('TEST 乌鸦级', context)
    expect(new Set(items.calls.map((c) => c.scope))).toEqual(new Set(['industry']))
  })
})

describe('recognition tiers', () => {
  it('maps resolutions to none / prefix / exact', () => {
    expect(recognitionOf(unique(raven, 'id'))).toBe('exact')
    expect(recognitionOf(unique(raven, 'alias'))).toBe('exact')
    expect(recognitionOf(unique(raven, 'prefix'))).toBe('prefix')
    expect(recognitionOf(ambiguous('exact', raven, raven))).toBe('exact')
    expect(recognitionOf(ambiguous('prefix', raven, raven))).toBe('prefix')
    expect(recognitionOf(confirm(raven))).toBe('none')
    expect(recognitionOf({ kind: 'none', suggestions: [raven] })).toBe('none')
    expect(recognitionOf({ kind: 'set', set })).toBe('exact')
  })

  it('tries every reading of the quantity and keeps the best', () => {
    const { items } = ctx()
    expect(recognize('乌鸦级*10', items, 'market')).toBe('exact')
    expect(recognize('10x Raven', items, 'market')).toBe('exact')
    expect(recognize('护盾扩展 2', items, 'market')).toBe('prefix')
    expect(recognize('', items, 'market')).toBe('none')
  })
})
