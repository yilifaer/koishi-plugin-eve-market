import { describe, expect, it } from 'vitest'
import { familyAliases, findImplantSets, IMPLANT_GROUP, setAliases } from '../../../src/core/items/sets'
import type { ItemInfo, TypeTable } from '../../../src/core/types'
import { loadFixtureData } from '../../fixtures/data/load'

const SLOTS: Array<[string, string]> = [
  ['Alpha', '阿尔法型'], ['Beta', '贝它型'], ['Gamma', '伽玛型'], ['Delta', '德尔塔型'], ['Epsilon', '伊普西隆型'], ['Omega', '欧米伽型'],
]

/** 只有套装用到的几列 */
function tableOf(rows: Array<[string, string]>): TypeTable {
  const stub: Pick<TypeTable, 'size' | 'group' | 'en' | 'zh' | 'item'> = {
    size: rows.length,
    group: Int32Array.from(rows, () => IMPLANT_GROUP),
    en: rows.map((r) => r[0]),
    zh: rows.map((r) => r[1]),
    item: (row: number) => ({ typeId: 1000 + row, en: rows[row][0], zh: rows[row][1] }) as ItemInfo,
  }
  return stub as TypeTable
}

const set = (en: string, zhOf: (slotZh: string, i: number) => string) =>
  SLOTS.map(([slot, slotZh], i): [string, string] => [`${en} ${slot}`, zhOf(slotZh, i)])

describe('implant sets', () => {
  it('group by the English name and strip the Chinese slot suffix whatever the separator', () => {
    const table = tableOf([
      ...set('High-grade Crystal', (s) => `高级水晶—${s}`),
      ...set('Low-grade Edge', (s, i) => (i === 5 ? `低级强势– ${s}` : `低级强势–${s}`)),
      ...set('Low-grade Wedge', (s) => `低级分裂${s}`),
      ...set('Mid-grade Mimesis', (s, i) => (i % 2 ? `中级仿生 - ${s}` : `中级仿生- ${s}`)),
    ])
    const { sets, skipped } = findImplantSets(table)
    expect(skipped).toEqual([])
    expect(sets.map((e) => [e.set.name.en, e.set.name.zh, e.set.grade, e.family.zh])).toEqual([
      ['High-grade Crystal', '高级水晶', 'high', '水晶'],
      ['Low-grade Edge', '低级强势', 'low', '强势'],
      ['Low-grade Wedge', '低级分裂', 'low', '分裂'],
      ['Mid-grade Mimesis', '中级仿生', 'mid', '仿生'],
    ])
    expect(sets[0].set.items.map((i) => i.en.split(' ').pop())).toEqual(SLOTS.map(([s]) => s))
  })

  it('skip a combination whose Chinese names disagree or that misses a slot', () => {
    const table = tableOf([
      ...set('High-grade Halo', (s, i) => (i === 3 ? `高级光环—${s}` : `高级圣光—${s}`)),
      ...set('Low-grade Talon', (s) => `低级魔爪-${s}`).slice(0, 5),
      ...set('Low-grade Snake', (s) => `低级蝰蛇-${s}`),
      ['Low-grade Snake Alpha', '低级蝰蛇-阿尔法型'],
    ])
    const { sets, skipped } = findImplantSets(table)
    expect(sets).toEqual([])
    expect(skipped).toHaveLength(3)
    expect(skipped[0]).toContain('High-grade Halo')
    expect(skipped[1]).toContain('Omega 缺少')
    expect(skipped[2]).toContain('Alpha 有重复')
  })

  it('ignore other implants in the group', () => {
    const table = tableOf([['Genolution Core Augmentation CA-1', '基因核心强化 CA-1'], ['High-grade Crystal Alpha', '高级水晶—阿尔法型']])
    expect(findImplantSets(table)).toEqual({ sets: [], skipped: ['High-grade Crystal：Beta 缺少'] })
  })

  it('register the set names and the names without grade', () => {
    const { sets } = findImplantSets(loadFixtureData().types)
    const crystal = sets.find((e) => e.set.name.en === 'High-grade Crystal')!
    expect(setAliases(crystal)).toEqual(['高级水晶', '高级水晶套装', 'High-grade Crystal set'])
    expect(familyAliases(crystal)).toEqual(['Crystal set', '水晶', '水晶套装'])
  })

  it('find every set in the small data set', () => {
    const { sets, skipped } = findImplantSets(loadFixtureData().types)
    expect(skipped).toEqual([])
    expect(sets.map((e) => e.set.name.zh).sort()).toEqual(
      ['中级仿生', '中级水晶', '低级分裂', '低级圣杯', '低级强势', '低级水晶', '高级九头蛇', '高级水晶'].sort())
  })
})
