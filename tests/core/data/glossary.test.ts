import { describe, expect, it } from 'vitest'
import { checkGlossarySize, DataError, glossaryKey, parseGlossary } from '../../../src/core/data'
import { loadFixtureGlossary } from '../../fixtures/data/load'

describe('parseGlossary', () => {
  it('reads the eve-cn-slang glossary into entries usable for aliases', () => {
    const g = loadFixtureGlossary()
    expect(g.entries.length).toBeGreaterThan(300)
    const navy = g.entries.find((e) => e.zh === '海万王')
    expect(navy).toMatchObject({ en: 'Megathron Navy Issue', category: expect.any(String) })
    const asb = g.entries.find((e) => e.en === 'ASB')
    expect(asb).toMatchObject({ zh: '注盾', category: 'module', mode: expect.any(String), dir: expect.any(String) })
    expect(asb?.enAliases).toContain('ancillary shield booster')
    expect(asb?.zhAliases).toContain('辅助盾修')
    expect(Object.isFrozen(g.entries)).toBe(true)
  })

  it('skips broken entries and fills defaults', () => {
    const yaml = [
      '- en: "fort"',
      '  zh: "铁壁"',
      '  category: structure',
      '- en: "no zh"',
      '- zh: "没有英文"',
      '- just a string',
      '- en: 404',
      '  zh: 四零四',
      '  en_aliases: ["x", 5, null, ["nested"]]',
      '  zh_aliases: "not a list"',
    ].join('\n')
    const { data, skipped } = parseGlossary(yaml, 'online', 7)
    expect(skipped).toBe(3)
    expect(data.entries).toEqual([
      { en: 'fort', zh: '铁壁', mode: '', dir: 'both', enAliases: [], zhAliases: [], category: 'structure', note: '' },
      { en: '404', zh: '四零四', mode: '', dir: 'both', enAliases: ['x', '5'], zhAliases: [], category: '', note: '' },
    ])
    expect(data).toMatchObject({ origin: 'online', loadedAt: 7, key: glossaryKey(yaml) })
  })

  it('rejects files that are not a YAML list', () => {
    expect(() => parseGlossary('en: x\nzh: y', 'online', 0)).toThrow(DataError)
    expect(() => parseGlossary('- en: "x\n  zh: [', 'online', 0)).toThrow(/不是有效的 YAML/)
    expect(() => parseGlossary('<html></html>', 'online', 0)).toThrow(/不是词条列表/)
  })

  it('gives the same key for the same content only', () => {
    expect(glossaryKey('- en: a\n  zh: b')).toBe(glossaryKey(Buffer.from('- en: a\n  zh: b')))
    expect(glossaryKey('- en: a\n  zh: b')).not.toBe(glossaryKey('- en: a\n  zh: c'))
  })
})

describe('checkGlossarySize', () => {
  it('needs at least half of the bundled entries', () => {
    expect(() => checkGlossarySize(150, 300)).not.toThrow()
    expect(() => checkGlossarySize(149, 300)).toThrow(/至少要 150 条/)
    // 没有自带的黑话表时至少要 1 条
    expect(() => checkGlossarySize(1, 0)).not.toThrow()
    expect(() => checkGlossarySize(0, 0)).toThrow(DataError)
  })
})
