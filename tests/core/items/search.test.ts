import { describe, expect, it } from 'vitest'
import { ens, fixtureResolver } from './helpers'

const items = fixtureResolver()
const search = (q: string, offset = 0, limit = 10) => items.search(q, { scope: 'market', offset, limit })

describe('search', () => {
  it('returns the item alone on an exact or unique alias hit', () => {
    expect(search('乌鸦级')).toMatchObject({ exact: { en: 'Raven' }, items: [], total: 1, skins: 0 })
    expect(search('乌鸦')).toMatchObject({ exact: { en: 'Raven' } })
    expect(search('#638')).toMatchObject({ exact: { en: 'Raven' } })
  })

  it('merges prefix, contains and pinyin matches, prefix first, each item once', () => {
    const r = search('rav')
    expect(r.exact).toBeUndefined()
    expect(ens(r.items)).toEqual(['Raven', 'Raven Navy Issue', 'Raven State Issue', 'Raven Blueprint'])
    expect(r.total).toBe(4)
  })

  it('counts SKINs instead of listing them, unless the query asks for SKINs', () => {
    const r = search('乌鸦级 ')
    expect(r.exact?.en).toBe('Raven')
    const rav = search('乌鸦级海')
    expect(rav.skins).toBe(0)
    const all = search('乌鸦级 涂装')
    expect(all.skins).toBe(0)
    expect(ens(all.items).every((en) => en.endsWith('SKIN'))).toBe(true)
    // 夹具里有 3 个乌鸦级涂装，其中 YC117 那个不能上市场
    expect(all.total).toBe(2)
    const plain = search('鸦 级')
    expect(plain.skins).toBe(2)
    expect(ens(plain.items)).not.toContain('Raven Guristas SKIN')
  })

  it('pages through the results', () => {
    const first = search('护盾', 0, 2)
    const second = search('护盾', 2, 2)
    expect(first.items).toHaveLength(2)
    expect(second.total).toBe(first.total)
    expect(ens(second.items)).not.toContain(first.items[0].en)
    expect(search('护盾', 100, 2).items).toEqual([])
  })

  it('lists the members of a glossary group and ambiguous exact names', () => {
    expect(ens(search('无畏').items).sort()).toEqual(['Naglfar', 'Revelation'])
    expect(ens(search('救赎级').items).slice(0, 2).sort()).toEqual(['Absolution', 'Salvation'])
    expect(search('高级水晶').items).toHaveLength(6)
  })

  it('uses pinyin too', () => {
    expect(search('wuya').items[0].zh).toBe('乌鸦级')
  })

  it('returns nothing for an empty query', () => {
    expect(search('  ')).toEqual({ items: [], total: 0, skins: 0 })
    expect(search('完全对不上的东西')).toEqual({ items: [], total: 0, skins: 0 })
  })
})

describe('related', () => {
  it('lists variants, the blueprint, containing names and counts SKINs', () => {
    const r = items.related(638)
    expect(ens(r.variants)).toEqual(['Raven Navy Issue', 'Raven State Issue'])
    expect(r.blueprint?.en).toBe('Raven Blueprint')
    expect(r.product).toBeUndefined()
    expect(r.skins).toBe(2)
    expect(ens(r.containing)).toEqual([])
  })

  it('goes from a variant to its family and from a blueprint to its product', () => {
    expect(ens(items.related(17636).variants)).toEqual(['Raven', 'Raven State Issue'])
    expect(items.related(688).product?.en).toBe('Raven')
    expect(items.related(46207).product?.en).toBe('Tungsten Carbide')
    expect(items.related(16672).blueprint?.en).toBe('Tungsten Carbide Reaction Formula')
  })

  it('finds other items whose name contains this one', () => {
    expect(ens(items.related(9848).containing)).toEqual(['R.A.M.- Robotics'])
    // 名字里包含、但已经算作同系列的不重复列
    expect(ens(items.related(11289).variants)).toEqual(['Navy Cap Booster 800'])
    expect(ens(items.related(11289).containing)).toEqual([])
    // 英文按整词：Raven 不算在 Ravenous 里
    expect(ens(items.related(3829).containing)).toEqual([])
  })

  it('is empty for unknown ids', () => {
    expect(items.related(1)).toEqual({ variants: [], containing: [], skins: 0 })
  })
})

describe('resolveLine', () => {
  it('accepts tiers 0–2 and marks a unique prefix as approximate', () => {
    expect(items.resolveLine('Raven')).toMatchObject({ item: { en: 'Raven' }, approx: false })
    expect(items.resolveLine('乌鸦')).toMatchObject({ item: { en: 'Raven' }, approx: false })
    expect(items.resolveLine('海万王')).toMatchObject({ item: { en: 'Megathron Navy Issue' }, approx: false })
    expect(items.resolveLine('#34')).toMatchObject({ item: { en: 'Tritanium' }, approx: false })
    expect(items.resolveLine('Raven N')).toMatchObject({ item: { en: 'Raven Navy Issue' }, approx: true })
  })

  it('never accepts contains, pinyin or near matches', () => {
    const contains = items.resolveLine('导弹 鞭挞')
    expect('item' in contains).toBe(false)
    expect(contains).toMatchObject({ unresolved: true, suggestion: { en: 'Scourge Cruise Missile' }, total: 1 })
    expect(items.resolveLine('wuya')).toMatchObject({ unresolved: true, suggestion: { zh: '乌鸦级' } })
    expect(items.resolveLine('Ravne')).toMatchObject({ unresolved: true, suggestion: { en: 'Raven' } })
  })

  it('gives candidates for ambiguous names and groups', () => {
    expect(items.resolveLine('rav')).toMatchObject({ unresolved: true, suggestion: { en: 'Raven' }, total: 4 })
    expect(items.resolveLine('无畏')).toMatchObject({ unresolved: true, total: 2 })
    // 名字对得上、但不能上市场的（T2 蓝图、礼包）单独说
    expect(items.resolveLine('Damage Control II Blueprint')).toMatchObject({ unresolved: true, notTradable: { typeId: 2049 }, total: 0 })
  })

  it('works out the suggestion only when it is read, and the fields survive spreading', () => {
    // 什么都没匹配到：total 是 0，容错的建议另给
    const line = items.resolveLine('Tritanuim')
    expect({ ...line }).toMatchObject({ unresolved: true, suggestion: { en: 'Tritanium' }, total: 0 })
    expect(JSON.parse(JSON.stringify(line))).toMatchObject({ unresolved: true, total: 0 })
    const nothing = items.resolveLine('完全对不上的东西')
    expect({ ...nothing }).toEqual({ unresolved: true, suggestion: undefined, candidates: [], total: 0 })
  })
})

describe('names', () => {
  const raven = items.byId(638)!

  it('finds items by id', () => {
    expect(raven.en).toBe('Raven')
    expect(items.byId(1)).toBeUndefined()
  })

  it('shows both names or one language', () => {
    expect(items.displayName(raven)).toBe('Raven / 乌鸦级')
    expect(items.displayName(raven, 'zh')).toBe('乌鸦级')
    expect(items.displayName(raven, 'en')).toBe('Raven')
    expect(items.displayName({ ...raven, zh: '' }, 'zh')).toBe('Raven')
  })

  it('writes commands with the Chinese name when it is unique, else English, else #typeID', () => {
    expect(items.commandName(raven)).toBe('乌鸦级')
    expect(items.commandName(items.byId(22448)!)).toBe('Absolution')
    expect(items.commandName(items.byId(34796)!)).toBe('乌鸦级YC117年涂装')
    expect(items.commandName({ ...raven, typeId: 99999999, en: 'Brand New Ship', zh: '' })).toBe('Brand New Ship')
  })

  it('lists aliases for translation', () => {
    expect(items.aliasesOf(17728)).toEqual(['海万王'])
    expect(items.aliasesOf(34)).toEqual([])
  })

  it('reports counts', () => {
    expect(items.stats()).toMatchObject({ items: 254, adminAliases: 0, sets: 8 })
    expect(items.stats().marketItems).toBeGreaterThan(100)
    expect(items.report().sets).toEqual({ count: 8, skipped: [] })
    expect(items.report().hulls).toBeGreaterThan(5)
  })
})
