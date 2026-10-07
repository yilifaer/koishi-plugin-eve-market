import { describe, expect, it } from 'vitest'
import type { GlossaryData, GlossaryEntry, ItemAliasSetting } from '../../../src/core/types'
import { fixtureResolver, uniqueOf } from './helpers'

const row = (n: number, alias: string, target: string): ItemAliasSetting => ({ row: n, alias, target })

function glossaryOf(entries: Array<Partial<GlossaryEntry> & Pick<GlossaryEntry, 'en' | 'zh'>>): GlossaryData {
  return {
    key: `test-${entries.length}`,
    origin: 'bundled',
    loadedAt: 0,
    entries: entries.map((e) => ({ mode: 'force', dir: 'both', enAliases: [], zhAliases: [], category: 'chat', note: '', ...e })),
  }
}

describe('admin aliases', () => {
  it('accept names, #typeID, typeID and generated names as targets', () => {
    const items = fixtureResolver({
      aliases: [row(1, '大鸟', '乌鸦级'), row(2, '海乌鸦', '#17636'), row(3, 'rsi', '26840'), row(4, '小黄', '乌鸦'), row(5, '老万', 'megathron')],
    })
    const market = (q: string) => items.resolve(q, { scope: 'market' })
    expect(uniqueOf(market('大鸟'))).toMatchObject({ tier: 'alias', item: { en: 'Raven' }, via: '乌鸦级' })
    expect(uniqueOf(market('海乌鸦')).item.en).toBe('Raven Navy Issue')
    expect(uniqueOf(market('RSI')).item.en).toBe('Raven State Issue')
    expect(uniqueOf(market('小黄')).item.en).toBe('Raven')
    expect(uniqueOf(market('老万')).item.en).toBe('Megathron')
    expect(items.issues()).toEqual([])
    expect(items.stats().adminAliases).toBe(5)
    expect(items.aliasesOf(638)).toEqual(['大鸟', '小黄'])
  })

  it('report bad rows and skip them', () => {
    const items = fixtureResolver({
      aliases: [
        row(1, '不存在', 'No Such Item'),
        row(2, '救赎', '救赎级'),
        row(3, 'Raven', 'Megathron'),
        row(4, '大鸟', '乌鸦级'),
        row(5, '大 鸟', 'Megathron'),
        row(6, '---', 'Raven'),
        row(7, '坏号', '#999999'),
        row(8, '乌鸦级', 'Raven'),
      ],
    })
    const issues = items.issues()
    expect(issues.map((i) => [i.row, i.field])).toEqual([[1, 'target'], [2, 'target'], [3, 'alias'], [5, 'alias'], [6, 'alias'], [7, 'target']])
    expect(issues.every((i) => i.section === 'aliases')).toBe(true)
    expect(issues[1].message).toContain('#typeID')
    expect(issues[2].message).toContain('Raven')
    // 第 3 行没生效：Raven 还是 Raven
    expect(uniqueOf(items.resolve('Raven', { scope: 'market' })).item.en).toBe('Raven')
    expect(uniqueOf(items.resolve('大鸟', { scope: 'market' })).item.en).toBe('Raven')
    expect(items.stats().adminAliases).toBe(1)
  })

  it('win over glossary aliases', () => {
    const items = fixtureResolver({ aliases: [row(1, '海万王', 'Megathron')] })
    expect(uniqueOf(items.resolve('海万王', { scope: 'market' })).item.en).toBe('Megathron')
  })

  it('rebuild when the alias table changes', () => {
    const a = fixtureResolver({ aliases: [row(1, '大鸟', 'Raven')] })
    const b = fixtureResolver({ aliases: [row(1, '大鸟', 'Megathron')] })
    expect(uniqueOf(a.resolve('大鸟', { scope: 'market' })).item.en).toBe('Raven')
    expect(uniqueOf(b.resolve('大鸟', { scope: 'market' })).item.en).toBe('Megathron')
  })
})

describe('glossary aliases', () => {
  it('only use the allowed categories', () => {
    const items = fixtureResolver({
      glossary: glossaryOf([
        { en: 'Raven', zh: '大鸟', category: 'fleet' },
        { en: 'Megathron', zh: '万王', category: 'ship' },
      ]),
    })
    expect(items.resolve('大鸟', { scope: 'market' }).kind).not.toBe('unique')
    expect(uniqueOf(items.resolve('万王', { scope: 'market' })).item.en).toBe('Megathron')
    expect(items.report().glossary).toMatchObject({ items: 1, groups: 0 })
  })

  it('skip skills, blueprints and SKINs as targets', () => {
    const items = fixtureResolver({
      glossary: glossaryOf([
        { en: 'caps', zh: '旗舰', enAliases: ['capital ships'], category: 'ship' },
        { en: 'AB', zh: '加力', enAliases: ['afterburner'], category: 'module' },
        { en: 'Raven Blueprint', zh: '鸟图', category: 'industry' },
        { en: 'Raven Wiyrkomi SKIN', zh: '鸟皮', category: 'chat' },
      ]),
    })
    for (const q of ['旗舰', '加力', '鸟图', '鸟皮']) expect(items.resolve(q, { scope: 'market' })).not.toMatchObject({ tier: 'alias' })
    expect(items.report().glossary).toMatchObject({ items: 0, groups: 0, aliases: 0 })
  })

  it('bind ship words only to ships', () => {
    // 「加成船」的英文 Booster 也是植入体里的分组名；船型类词条不能接到那里
    const items = fixtureResolver({
      glossary: glossaryOf([{ en: 'Battleship', zh: '战列', category: 'ship' }, { en: 'Cyberimplant', zh: '脑插', category: 'ship' }]),
    })
    expect(items.resolve('战列', { scope: 'market' })).toMatchObject({ kind: 'group', groupName: '战列舰' })
    expect(items.resolve('脑插', { scope: 'market' }).kind).not.toBe('group')
  })

  it('match the Chinese name of an item too', () => {
    const items = fixtureResolver({ glossary: glossaryOf([{ en: 'fort', zh: '铁壁', zhAliases: ['中堡'], category: 'structure' }]) })
    expect(uniqueOf(items.resolve('fort', { scope: 'market' })).item.en).toBe('Fortizar')
    expect(uniqueOf(items.resolve('中堡', { scope: 'market' })).item.en).toBe('Fortizar')
    expect(items.aliasesOf(35833)).toEqual(['fort', '中堡'])
  })

  it('report entries that match several items and writings that are other names', () => {
    const items = fixtureResolver({
      glossary: glossaryOf([
        { en: 'Raven', zh: '大鸟', zhAliases: ['万王宝座级'], category: 'ship' },
        { en: 'Megathron', zh: '老万', enAliases: ['Capital Ships'], category: 'ship' },
      ]),
    })
    const { skipped } = items.report().glossary
    expect(skipped.some((s) => s.includes('大鸟') && s.includes('多个物品'))).toBe(true)
    expect(skipped.some((s) => s.includes('「Capital Ships」'))).toBe(true)
    expect(items.resolve('大鸟', { scope: 'market' })).not.toMatchObject({ tier: 'alias' })
    expect(uniqueOf(items.resolve('老万', { scope: 'market' })).item.en).toBe('Megathron')
    // 技能名照样精确命中技能
    expect(uniqueOf(items.resolve('Capital Ships', { scope: 'market' }))).toMatchObject({ tier: 'exact', item: { en: 'Capital Ships' } })
  })

  it('list candidates when one writing points at two items', () => {
    const items = fixtureResolver({
      glossary: glossaryOf([
        { en: 'Raven', zh: '鸟', category: 'ship' },
        { en: 'Rhea', zh: '鸟', category: 'ship' },
      ]),
    })
    expect(items.resolve('鸟', { scope: 'market' })).toMatchObject({ kind: 'ambiguous', tier: 'alias', total: 2 })
    expect(items.report().glossary.skipped.some((s) => s.includes('多个目标'))).toBe(true)
  })

  it('strip a note in brackets from a writing', () => {
    const items = fixtureResolver({ glossary: glossaryOf([{ en: 'Raven', zh: '大鸟（玩家叫法）', category: 'ship' }]) })
    expect(uniqueOf(items.resolve('大鸟', { scope: 'market' })).item.en).toBe('Raven')
  })

  it('can be turned off', () => {
    const items = fixtureResolver({ useGlossary: false })
    expect(items.resolve('海万王', { scope: 'market' }).kind).not.toBe('unique')
    expect(items.stats().glossaryAliases).toBe(0)
  })

  it('count what the real glossary attaches', () => {
    const stats = fixtureResolver().stats()
    expect(stats.glossaryAliases).toBeGreaterThan(10)
  })
})
