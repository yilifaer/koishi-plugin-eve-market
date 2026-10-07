import { describe, expect, it } from 'vitest'
import { categoryPenalty, metaRank, rankRows } from '../../../src/core/items/rank'
import { ens, fixtureResolver, listOf, uniqueOf } from './helpers'

const items = fixtureResolver()
const market = (q: string, limit?: number) => items.resolve(q, { scope: 'market', limit })

describe('tier 0: #id', () => {
  it('uses the type directly', () => {
    expect(uniqueOf(market('#638'))).toMatchObject({ tier: 'id', item: { en: 'Raven' } })
    expect(uniqueOf(market('id:688'))).toMatchObject({ tier: 'id', item: { en: 'Raven Blueprint' } })
    expect(uniqueOf(market('＃638'))).toMatchObject({ tier: 'id' })
  })

  it('reports unknown ids and ids outside the scope', () => {
    expect(market('#999999')).toEqual({ kind: 'none', suggestions: [] })
    expect(market('#2049')).toMatchObject({ kind: 'out-of-scope', item: { en: 'Damage Control II Blueprint' }, scope: 'market' })
  })
})

describe('tier 1: exact', () => {
  it('matches English and Chinese names in any spelling', () => {
    for (const q of ['Raven', 'raven', 'RAVEN', 'ＲＡＶＥＮ', '乌鸦级']) {
      expect(uniqueOf(market(q))).toMatchObject({ tier: 'exact', item: { typeId: 638 } })
    }
    for (const q of ['Raven Navy Issue', 'ravennavyissue', '乌鸦级 海军型']) {
      expect(uniqueOf(market(q))).toMatchObject({ tier: 'exact', item: { typeId: 17636 } })
    }
    expect(uniqueOf(market('高级水晶—阿尔法型')).item.en).toBe('High-grade Crystal Alpha')
    expect(uniqueOf(market('高级水晶-阿尔法型')).item.en).toBe('High-grade Crystal Alpha')
  })

  it('has no via line for exact hits', () => {
    expect(uniqueOf(market('Raven')).via).toBeUndefined()
  })

  it('lists both items when two share a name', () => {
    const r = market('救赎级')
    expect(r).toMatchObject({ kind: 'ambiguous', tier: 'exact', total: 2 })
    expect(ens(listOf(r).candidates).sort()).toEqual(['Absolution', 'Salvation'])
  })
})

describe('tier 2: aliases', () => {
  it('drops the 级 of hull names', () => {
    expect(uniqueOf(market('乌鸦'))).toMatchObject({ tier: 'alias', item: { en: 'Raven' }, via: '乌鸦级' })
    expect(uniqueOf(market('乌鸦海军型'))).toMatchObject({ tier: 'alias', item: { en: 'Raven Navy Issue' } })
    expect(uniqueOf(market('乌鸦蓝图'))).toMatchObject({ tier: 'alias', item: { en: 'Raven Blueprint' } })
  })

  it('reads trailing digits as Roman numerals', () => {
    expect(uniqueOf(market('Warrior 2'))).toMatchObject({ tier: 'alias', item: { en: 'Warrior II' }, via: 'Warrior II' })
    expect(uniqueOf(market('warrior2'))).toMatchObject({ item: { en: 'Warrior II' } })
    expect(uniqueOf(market('武士2'))).toMatchObject({ tier: 'alias', item: { en: 'Warrior II' }, via: '武士 II' })
    expect(uniqueOf(market('Hammerhead 1')).item.en).toBe('Hammerhead I')
  })

  it('treats bp, bpo and bpc as blueprint', () => {
    expect(uniqueOf(market('raven bpo'))).toMatchObject({ tier: 'alias', item: { en: 'Raven Blueprint' } })
    expect(uniqueOf(market('Raven BP'))).toMatchObject({ tier: 'alias', item: { en: 'Raven Blueprint' } })
  })

  it('attaches glossary item aliases', () => {
    expect(uniqueOf(market('海万王'))).toMatchObject({ tier: 'alias', item: { en: 'Megathron Navy Issue' }, via: '万王宝座级海军型' })
    expect(uniqueOf(market('臭氧'))).toMatchObject({ tier: 'alias', item: { en: 'Liquid Ozone' } })
    expect(uniqueOf(market('fort'))).toMatchObject({ tier: 'alias', item: { en: 'Fortizar' }, via: 'Fortizar' })
    expect(uniqueOf(market('中堡')).item.en).toBe('Fortizar')
    expect(uniqueOf(market('伊甸币')).tier).toBe('exact')
  })

  it('lists the market items of a glossary group name and never picks one', () => {
    const dread = market('无畏')
    expect(dread).toMatchObject({ kind: 'group', groupName: '无畏舰', total: 2 })
    expect(ens(listOf(dread).candidates).sort()).toEqual(['Naglfar', 'Revelation'])
    expect(market('跳货')).toMatchObject({ kind: 'group', groupName: '战略货舰', total: 2 })
    expect(market('jump freighter')).toMatchObject({ kind: 'group', groupName: 'Jump Freighter' })
    const asb = market('注盾')
    expect(asb.kind).toBe('group')
    expect(ens(listOf(asb).candidates)).toEqual(['Large Ancillary Shield Booster', 'X-Large Ancillary Shield Booster'])
  })

  it('matches short English glossary words only in their exact case', () => {
    expect(market('JF').kind).toBe('group')
    expect(market('jf').kind).toBe('group')
    expect(market('Jf').kind).not.toBe('group')
    expect(uniqueOf(market('LO')).item.en).toBe('Liquid Ozone')
    expect(market('lo').kind).not.toBe('unique')
  })

  it('does not turn glossary words into skills', () => {
    expect(market('caps')).not.toMatchObject({ item: { en: 'Capital Ships' } })
    expect(market('AB')).not.toMatchObject({ item: { en: 'Afterburner' } })
    // 「reactions」正好是技能 Reactions 的官方名：精确匹配，不是别名；「反应」只是前缀命中，也不是别名
    expect(uniqueOf(market('reactions'))).toMatchObject({ tier: 'exact', item: { en: 'Reactions' } })
    expect(uniqueOf(market('反应')).tier).toBe('prefix')
  })

  it('resolves implant sets with and without 套装 / set', () => {
    const cases: Array<[string, string]> = [
      ['高级水晶', 'High-grade Crystal'],
      ['高级水晶套装', 'High-grade Crystal'],
      ['high-grade crystal set', 'High-grade Crystal'],
      ['高级九头蛇', 'High-grade Hydra'],
      ['中级仿生', 'Mid-grade Mimesis'],
      ['低级强势', 'Low-grade Edge'],
      ['低级分裂', 'Low-grade Wedge'],
      ['低级圣杯', 'Low-grade Grail'],
    ]
    for (const [q, en] of cases) {
      const r = market(q)
      if (r.kind !== 'set') throw new Error(`${q} 应该命中套装，实际是 ${r.kind}`)
      expect(r.set.name.en).toBe(en)
      expect(r.set.items).toHaveLength(6)
      expect(r.set.items[0].en).toMatch(/ Alpha$/)
      expect(r.set.items[5].en).toMatch(/ Omega$/)
    }
  })

  it('lists every grade for a set name without a grade', () => {
    for (const q of ['水晶', '水晶套装', 'crystal set']) {
      const r = market(q)
      if (r.kind !== 'sets') throw new Error(`${q} 应该列出各等级，实际是 ${r.kind}`)
      expect(r.sets.map((s) => s.name.zh)).toEqual(['高级水晶', '中级水晶', '低级水晶'])
    }
  })

  it('puts sets ahead of prefix matches but only in market and any scopes', () => {
    expect(items.resolve('高级水晶', { scope: 'any' }).kind).toBe('set')
    expect(items.resolve('高级水晶', { scope: 'industry' }).kind).not.toBe('set')
  })
})

describe('tier 3: prefix', () => {
  it('uses a unique prefix and says which full name it used', () => {
    expect(uniqueOf(market('Raven N'))).toMatchObject({ tier: 'prefix', item: { en: 'Raven Navy Issue' }, via: 'Raven Navy Issue' })
    expect(uniqueOf(market('乌鸦级政'))).toMatchObject({ tier: 'prefix', via: '乌鸦级政府型' })
  })

  it('lists several prefix matches without SKINs', () => {
    const r = market('rav')
    expect(r).toMatchObject({ kind: 'ambiguous', tier: 'prefix' })
    expect(ens(listOf(r).candidates)).toEqual(['Raven', 'Raven Navy Issue', 'Raven State Issue', 'Raven Blueprint'])
  })

  it('keeps SKINs when the query asks for them', () => {
    const r = market('raven skin')
    expect(r.kind).toBe('confirm')
    expect(ens(listOf(r).candidates).every((en) => en.endsWith('SKIN'))).toBe(true)
  })

  it('cuts the list at limit but keeps the total', () => {
    const r = listOf(market('rav', 2))
    expect(r.candidates).toHaveLength(2)
    expect(r.total).toBe(4)
  })
})

describe('tier 4: contains, pinyin, near', () => {
  it('always asks to confirm a contains match, even a single one', () => {
    const one = market('导弹 鞭挞')
    expect(one).toMatchObject({ kind: 'confirm', tier: 'contains', total: 1 })
    expect(ens(listOf(one).candidates)).toEqual(['Scourge Cruise Missile'])
    const shields = market('护盾扩展装置 II')
    expect(shields).toMatchObject({ kind: 'confirm', tier: 'contains' })
    expect(ens(listOf(shields).candidates)).toEqual(['Small Shield Extender II', 'Medium Shield Extender II', 'Large Shield Extender II'])
  })

  it('always asks to confirm pinyin matches', () => {
    const wuya = market('wuya')
    expect(wuya).toMatchObject({ kind: 'confirm', tier: 'pinyin' })
    expect(listOf(wuya).candidates[0].zh).toBe('乌鸦级')
    expect(market('sthj')).toMatchObject({ kind: 'confirm', tier: 'pinyin', total: 1, candidates: [{ zh: '三钛合金' }] })
    expect(market('santaihejin')).toMatchObject({ kind: 'confirm', tier: 'pinyin', candidates: [{ zh: '三钛合金' }] })
  })

  it('reads every pronunciation of polyphonic names', () => {
    expect(market('kp')).toMatchObject({ kind: 'confirm', tier: 'pinyin', candidates: [{ en: 'Astrahus' }] })
  })

  it('offers close names when nothing matches', () => {
    expect(market('syhj')).toMatchObject({ kind: 'none', suggestions: [{ zh: '三钛合金' }] })
    const r = market('乌鸦机')
    if (r.kind !== 'none') throw new Error(r.kind)
    expect(ens(r.suggestions)).toEqual(['Raven', 'Raven Navy Issue', 'Raven State Issue'])
    expect(market('Ravne')).toMatchObject({ kind: 'none', suggestions: [{ en: 'Raven' }] })
    expect(market('Tritanuim')).toMatchObject({ kind: 'none', suggestions: [{ en: 'Tritanium' }] })
    expect(market('完全对不上的东西')).toEqual({ kind: 'none', suggestions: [] })
    expect(market('...')).toEqual({ kind: 'none', suggestions: [] })
  })
})

describe('scopes', () => {
  it('reports items that exist but cannot be traded', () => {
    expect(market('Damage Control II Blueprint')).toMatchObject({ kind: 'out-of-scope', scope: 'market', item: { typeId: 2049 } })
    expect(market('损伤控制装备蓝图 II')).toMatchObject({ kind: 'out-of-scope' })
  })

  it('maps blueprints to their products for industry', () => {
    const industry = (q: string) => items.resolve(q, { scope: 'industry' })
    expect(uniqueOf(industry('Raven'))).toMatchObject({ tier: 'exact', item: { en: 'Raven' } })
    expect(uniqueOf(industry('乌鸦级蓝图'))).toMatchObject({ tier: 'exact', item: { en: 'Raven' } })
    expect(uniqueOf(industry('#2489')).item.en).toBe('Warrior II')
    expect(industry('Tritanium')).toMatchObject({ kind: 'out-of-scope', scope: 'industry', item: { en: 'Tritanium' } })
    expect(industry('Tungsten Carbide')).toMatchObject({ kind: 'out-of-scope', scope: 'industry' })
  })

  it('maps reaction formulas to their products for reactions', () => {
    const reaction = (q: string) => items.resolve(q, { scope: 'reaction' })
    expect(uniqueOf(reaction('Tungsten Carbide')).item.en).toBe('Tungsten Carbide')
    expect(uniqueOf(reaction('碳化钨反应配方')).item.en).toBe('Tungsten Carbide')
    expect(reaction('Raven')).toMatchObject({ kind: 'out-of-scope', scope: 'reaction' })
  })
})

describe('ordering inside a tier', () => {
  const cols = {
    // 行号就是数组下标（物品表按 typeID 排序，行号小 = typeID 小）：0 物品、1 蓝图、2 涂装、3 服饰、4 T2、5 势力、6 官员、7 名字更短的物品
    category: Int32Array.from([7, 9, 91, 30, 7, 7, 7, 7]),
    meta: Uint8Array.from([0, 0, 0, 0, 1, 2, 3, 0]),
    enLength: Uint16Array.from([10, 10, 10, 10, 10, 10, 10, 5]),
    zhLength: Uint16Array.from([4, 4, 4, 4, 4, 4, 4, 9]),
  }
  const order = (blueprint: boolean, skin: boolean, lang: 'zh' | 'en' = 'en') =>
    rankRows([0, 1, 2, 3, 4, 5, 6, 7], cols, { blueprint, skin, lang })

  it('sorts by category penalty, meta level, name length and typeID', () => {
    expect(order(false, false)).toEqual([7, 0, 4, 5, 6, 3, 1, 2])
  })

  it('lifts the blueprint or SKIN penalty when the query mentions them', () => {
    expect(order(true, false)).toEqual([7, 0, 1, 4, 5, 6, 3, 2])
    expect(order(false, true)).toEqual([7, 0, 2, 4, 5, 6, 3, 1])
  })

  it('compares the length of the name in the language of the query', () => {
    expect(order(false, false, 'zh')).toEqual([0, 7, 4, 5, 6, 3, 1, 2])
  })

  it('gives the rank of each meta group and category', () => {
    expect([null, 1, 2, 4, 5, 6, 14, 15, 52, 53, 54].map((m) => metaRank(m ?? -1))).toEqual([0, 0, 1, 2, 3, 3, 2, 2, 2, 1, 0])
    expect([91, 9, 30, 63, 2118, 6, 7].map(categoryPenalty)).toEqual([3, 2, 1, 1, 1, 0, 0])
  })

  it('applies the rules to real results', () => {
    const rav = listOf(market('rav'))
    expect(rav.candidates[rav.candidates.length - 1].en).toBe('Raven Blueprint')
    expect(ens(listOf(market('extender large')).candidates))
      .toEqual(['Large Shield Extender I', 'Large Shield Extender II', 'Caldari Navy Large Shield Extender'])
    expect(listOf(market('乌鸦级 型')).candidates.map((i) => i.zh)).toEqual(['乌鸦级海军型', '乌鸦级政府型'])
  })
})
