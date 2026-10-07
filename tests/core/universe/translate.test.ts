import { describe, expect, it } from 'vitest'
import { TRANSLATE_LIMIT } from '../../../src/constants'
import { DataNotReadyError } from '../../../src/core/data'
import { caseKey, isCaseSensitive, stripNote } from '../../../src/core/universe/lookup'
import { brief, universe } from './helpers'

const ADMIN = [{ row: 1, alias: '大鸟', target: 'Raven' }]

describe('translate: exact names', () => {
  const u = universe({ aliases: ADMIN })

  it('items by Chinese name, English name or type ID, with group and category', () => {
    for (const q of ['三钛合金', 'Tritanium', 'tritanium', '#34']) {
      const r = u.translate(q, TRANSLATE_LIMIT)
      expect(r.total, q).toBe(1)
      expect(r.entries[0], q).toMatchObject({
        kind: 'item', id: 34, zh: '三钛合金', en: 'Tritanium', aliases: [],
        group: { zh: '矿物', en: 'Mineral' }, category: { zh: '材料', en: 'Material' },
      })
    }
  })

  it('an alias finds the item and the item lists its aliases (console first, then slang)', () => {
    expect(u.translate('大鸟', 10).entries.map((e) => [e.en, e.aliases])).toEqual([['Raven', ['大鸟']]])
    // fort 是黑话表接成的别名：不另列一条黑话
    const fort = u.translate('fort', 10)
    expect(fort.entries.map(brief)).toEqual(['item:铁壁|Fortizar'])
    expect(fort.entries[0].aliases).toEqual(['fort', '中堡'])
    expect(u.translate('铁壁', 10).entries[0].aliases).toEqual(['fort', '中堡'])
  })

  it('two items with the same name are both listed', () => {
    const r = u.translate('救赎级', 10)
    expect([r.total, r.entries.map((e) => e.en)]).toEqual([2, ['Absolution', 'Salvation']])
  })

  it('systems with region and true security; code-named systems have no Chinese name', () => {
    for (const q of ['吉他', 'Jita', 'jita']) {
      expect(u.translate(q, 10).entries).toEqual([{
        kind: 'system', id: 30000142, zh: '吉他', en: 'Jita', aliases: [], region: { zh: '伏尔戈', en: 'The Forge' }, security: 0.945913,
      }])
    }
    expect(u.translate('NIH-02', 10).entries[0]).toMatchObject({ kind: 'system', zh: '', en: 'NIH-02', region: { en: 'Great Wildlands' }, security: -0.044546 })
  })

  it('regions, constellations and categories', () => {
    expect(u.translate('伏尔戈', 10).entries).toEqual([{ kind: 'region', id: 10000002, zh: '伏尔戈', en: 'The Forge', aliases: [] }])
    expect(u.translate('Kimotoro', 10).entries[0]).toMatchObject({ kind: 'constellation', zh: '木本呂', region: { zh: '伏尔戈' } })
    expect(u.translate('舰船', 10).entries).toEqual([{ kind: 'category', id: 6, zh: '舰船', en: 'Ship', aliases: [] }])
    // 没发布的大类不收
    expect(u.translate('#星系', 10).total).toBe(0)
  })

  it('a slang group name shows the group once, with the slang writings as aliases', () => {
    for (const q of ['无畏舰', 'Dreadnought', 'dread', '无畏']) {
      const r = u.translate(q, 10)
      expect(r.entries.map(brief), q).toEqual(['group:无畏舰|Dreadnought'])
      expect(r.entries[0], q).toMatchObject({ category: { zh: '舰船', en: 'Ship' }, aliases: ['dread', '无畏'] })
    }
    expect(u.translate('损伤控制', 10).entries[0]).toMatchObject({ kind: 'group', aliases: ['DCU', '损控', 'damage control unit'] })
  })

  it('slang: note, other writings, notes in brackets stripped from the name', () => {
    expect(u.translate('打X', 10).entries).toEqual([{
      kind: 'slang', id: null, zh: '打X', en: 'x up', slang: { category: 'fleet', note: '聊天中报X报名' }, aliases: ['报X', '上X'],
    }])
    expect(u.translate('集结', 10).entries.map(brief)).toEqual(['slang:集结|form up'])
    expect(u.translate('neut', 10).entries[0]).toMatchObject({ zh: '毁电', en: 'neut' })
  })

  it('short English slang only matches the exact case, like the glossary itself', () => {
    expect(u.translate('x up', 10).total).toBe(1)
    expect(u.translate('X UP', 10).total).toBe(0)
    expect(u.translate('CTA', 10).total).toBe(1)
    expect(u.translate('cta', 10).total).toBe(1)
    expect(u.translate('Cta', 10).total).toBe(0)
  })

  it('a skill and a slang word with the same English name are both listed', () => {
    expect(u.translate('afterburner', 10).entries.map(brief)).toEqual(['item:加力燃烧器原理|Afterburner', 'slang:加力|AB'])
  })

  it('implant sets list their pieces; without a grade every grade, cut to the limit', () => {
    const set = u.translate('高级水晶', 10)
    expect([set.total, set.entries[0].en]).toEqual([6, 'High-grade Crystal Alpha'])
    const all = u.translate('水晶', TRANSLATE_LIMIT)
    expect([all.total, all.entries.length]).toEqual([18, TRANSLATE_LIMIT])
    expect(u.translate('水晶', 3).entries).toHaveLength(3)
  })
})

describe('translate: partial names', () => {
  const u = universe()

  it('items through search: contains and pinyin', () => {
    const r = u.translate('护盾扩展装置 II', 10)
    expect(r.entries.map((e) => e.en)).toEqual([
      'Small Shield Extender II', 'Medium Shield Extender II', 'Large Shield Extender II', 'Large Shield Extender II Blueprint',
    ])
    expect(r.total).toBe(4)
    expect(u.translate('sthj', 10).entries.map(brief)).toEqual(['item:三钛合金|Tritanium'])
  })

  it('places by part of the name, items first', () => {
    expect(u.translate('Kimo', 10).entries.map(brief)).toEqual(['constellation:木本呂|Kimotoro'])
    const ji = u.translate('ji', 10)
    expect(ji.entries.at(-1)).toMatchObject({ kind: 'system', en: 'Jita' })
    expect(ji.entries.slice(0, -1).every((e) => e.kind === 'item')).toBe(true)
  })

  it('skins are listed only when asked for', () => {
    expect(u.translate('Raven Wiy', 10).entries.map((e) => e.en)).toEqual([])
    expect(u.translate('skin', 10).entries.map(brief)).toEqual([
      'item:乌鸦级维克米涂装|Raven Wiyrkomi SKIN', 'item:乌鸦级古斯塔斯涂装|Raven Guristas SKIN',
      'item:乌鸦级YC117年涂装|Raven Serenity YC117 SKIN', 'item:万王宝座级短途物流涂装|Megathron Inner Zone Shipping SKIN',
      'group:永久涂装|Permanent SKIN', 'category:涂装|SKINs',
    ])
  })

  it('one Latin letter does not scan the star map', () => {
    expect(u.translate('j', 10).entries.every((e) => e.kind === 'item')).toBe(true)
  })

  it('nothing, empty or punctuation only', () => {
    expect(u.translate('完全不存在的东西', 10)).toEqual({ entries: [], total: 0 })
    expect(u.translate('  ', 10)).toEqual({ entries: [], total: 0 })
    expect(u.translate('!!!', 10)).toEqual({ entries: [], total: 0 })
  })
})

describe('translate: glossary switched off, data not ready', () => {
  it('without the glossary only official names', () => {
    const u = universe({ useGlossary: false })
    expect(u.translate('打X', 10).total).toBe(0)
    // 只剩名字前缀命中，没有黑话表接的别名
    expect(u.translate('fort', 10).entries.map((e) => [e.en, e.aliases])).toEqual([['Fortizar', []]])
    expect(universe({ glossary: null }).translate('集结', 10).total).toBe(0)
  })

  it('throws like DataService.current before the data is loaded', () => {
    const notReady = { current: () => { throw new DataNotReadyError() }, glossary: () => null }
    expect(() => universe({ data: notReady }).translate('Raven', 10)).toThrow(DataNotReadyError)
  })
})

describe('slang name helpers', () => {
  it('strips a bracketed note at the end', () => {
    expect(stripNote('毁电（也常指本地中立玩家）')).toBe('毁电')
    expect(stripNote('abc (note)')).toBe('abc')
    expect(stripNote('三钛合金')).toBe('三钛合金')
  })

  it('three Latin letters or fewer are case-sensitive, unless there are Chinese characters', () => {
    expect(['AB', 'x up', 'C1', 'K162'].map(isCaseSensitive)).toEqual([true, true, true, true])
    expect(['fort', 'call to arms', '打X', '中堡'].map(isCaseSensitive)).toEqual([false, false, false, false])
    expect(caseKey('X up')).toBe('Xup')
    expect(caseKey('Ｘ－ｕｐ')).toBe('Xup')
  })
})
