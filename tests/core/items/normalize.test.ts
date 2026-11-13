import { describe, expect, it } from 'vitest'
import { caseKey, hanChars, letterCount, nameKey, normalizeName, romanToDigit, stripNote, tokensOf } from '../../../src/core/items/normalize'
import { editDistance } from '../../../src/core/items/fuzzy'
import { hullNames, withoutJi, expandBlueprintWords, oldBlueprintName } from '../../../src/core/items/variants'
import { loadFixtureData } from '../../fixtures/data/load'

describe('normalizeName', () => {
  it('folds full-width text, case and spaces', () => {
    expect(normalizeName('ＲＡＶＥＮ')).toBe('raven')
    expect(normalizeName('  Raven　 Navy\tIssue ')).toBe('raven navy issue')
  })

  it('unifies dashes and drops quotes', () => {
    for (const dash of ['—', '–', '‒', '−', '‑', '－']) expect(normalizeName(`高级水晶${dash}阿尔法型`)).toBe('高级水晶-阿尔法型')
    expect(normalizeName("'Firewall' Signal Amplifier")).toBe('firewall signal amplifier')
    expect(normalizeName('「"莫罗"铁壁」')).toBe('莫罗铁壁')
    expect(normalizeName('『测试』“引号”‘单引号’')).toBe('测试引号单引号')
  })

  it('drops the trailing * that the game setting 高亮重要名字 adds', () => {
    expect(normalizeName('散热槽 II*')).toBe('散热槽 ii')
    expect(normalizeName('Heat Sink II **')).toBe('heat sink ii')
    expect(normalizeName('乌鸦级＊')).toBe('乌鸦级')
    expect(normalizeName('*Sneaks in a classic*')).toBe('*sneaks in a classic')
    expect(nameKey('散热槽 II*')).toBe(nameKey('散热槽 II'))
  })

  it('turns middle dots into spaces and removes zero-width characters', () => {
    expect(normalizeName('乌鸦级·海军型')).toBe('乌鸦级 海军型')
    expect(normalizeName('乌鸦级・海军型•x')).toBe('乌鸦级 海军型 x')
    expect(normalizeName(`Ra${String.fromCharCode(0x200b)}ven`)).toBe('raven')
  })
})

describe('nameKey', () => {
  it('gives the same key for the usual ways of writing a name', () => {
    const key = nameKey('Raven Navy Issue')
    expect(nameKey('ravennavyissue')).toBe(key)
    expect(nameKey('RAVEN-NAVY_ISSUE')).toBe(key)
    expect(nameKey('乌鸦级 海军型')).toBe(nameKey('乌鸦级海军型'))
    expect(nameKey('聚合高密度克洛基石（4级）')).toBe('聚合高密度克洛基石4级')
    expect(nameKey('R.A.M.- Robotics')).toBe('ramrobotics')
    expect(nameKey('a,b:c;d(e)[f]/g\\h')).toBe('abcdefgh')
  })

  it('keeps case in caseKey', () => {
    expect(caseKey('J F')).toBe('JF')
    expect(caseKey('ＬＯ')).toBe('LO')
  })
})

describe('tokensOf', () => {
  it('splits Latin words, digit runs and single Han characters', () => {
    expect(tokensOf(normalizeName('5MN Microwarpdrive II'))).toEqual(['5', 'mn', 'microwarpdrive', 'ii'])
    expect(tokensOf(normalizeName('护盾扩展装置 II'))).toEqual(['护', '盾', '扩', '展', '装', '置', 'ii'])
    expect(tokensOf('cap booster 800 800')).toEqual(['cap', 'booster', '800'])
  })

  it('collects distinct Han characters', () => {
    expect(hanChars('乌鸦乌 x')).toEqual(['乌', '鸦'])
  })
})

describe('small helpers', () => {
  it('writes trailing Roman numerals as digits', () => {
    expect(romanToDigit('Warrior II')).toBe('Warrior 2')
    expect(romanToDigit('武士 III')).toBe('武士 3')
    expect(romanToDigit('大型护盾扩充器I')).toBe('大型护盾扩充器1')
    expect(romanToDigit('Raven')).toBeNull()
    expect(romanToDigit('Mobile Tractor Unit')).toBeNull()
  })

  it('counts English letters', () => {
    expect(letterCount('JF')).toBe(2)
    expect(letterCount('T3巡洋')).toBe(1)
    expect(letterCount('jump freighter')).toBe(13)
  })

  it('drops a trailing note in brackets', () => {
    expect(stripNote('毁电（也常指本地中立玩家）')).toBe('毁电')
    expect(stripNote('Raven (old)')).toBe('Raven')
    expect(stripNote('乌鸦')).toBe('乌鸦')
  })

  it('expands bp words in Latin queries', () => {
    expect(expandBlueprintWords('raven bpo')).toBe('raven blueprint')
    expect(expandBlueprintWords('bpc raven')).toBe('blueprint raven')
    expect(expandBlueprintWords('raven bp')).toBe('raven blueprint')
    expect(expandBlueprintWords('bpm thing')).toBeNull()
  })

  it('measures Damerau-Levenshtein distance with a cutoff', () => {
    expect(editDistance('raven', 'raven', 1)).toBe(0)
    expect(editDistance('ravn', 'raven', 1)).toBe(1)
    expect(editDistance('arven', 'raven', 1)).toBe(1)
    expect(editDistance('syhj', 'sthj', 1)).toBe(1)
    expect(editDistance('rvaen', 'raven', 2)).toBe(1)
    expect(editDistance('abc', 'xyz', 1)).toBe(2)
    expect(editDistance('a', 'abcd', 1)).toBe(2)
  })
})

describe('old blueprint names', () => {
  it('moves the size or tech level back behind 蓝图', () => {
    expect(oldBlueprintName('灼烧 S 蓝图')).toBe('灼烧蓝图 S')
    expect(oldBlueprintName('散热槽 II 蓝图')).toBe('散热槽蓝图 II')
    expect(oldBlueprintName('采矿器I蓝图')).toBe('采矿器蓝图 I')
    expect(oldBlueprintName('超光速粒子集束激光器 XL 蓝图')).toBe('超光速粒子集束激光器蓝图 XL')
    expect(oldBlueprintName('磁力ECM I 蓝图')).toBe('磁力ECM蓝图 I')
  })

  it('leaves other names alone', () => {
    expect(oldBlueprintName('乌鸦级蓝图')).toBeNull()
    expect(oldBlueprintName('灼烧蓝图 S')).toBeNull()
    expect(oldBlueprintName('XML蓝图')).toBeNull()
    expect(oldBlueprintName('电容注电器装料 25 蓝图')).toBeNull()
  })
})

describe('without 级', () => {
  const hulls = hullNames(loadFixtureData().types)

  it('only strips the 级 of a hull name', () => {
    expect(hulls.has('乌鸦级')).toBe(true)
    expect(withoutJi('乌鸦级', hulls)).toBe('乌鸦')
    expect(withoutJi('乌鸦级海军型', hulls)).toBe('乌鸦海军型')
    expect(withoutJi('乌鸦级蓝图', hulls)).toBe('乌鸦蓝图')
    expect(withoutJi('高级水晶—阿尔法型', hulls)).toBeNull()
    expect(withoutJi('中级仿生- 阿尔法型', hulls)).toBeNull()
    expect(withoutJi('超大型辅助护盾回充增量器', hulls)).toBeNull()
  })
})
