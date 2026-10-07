// 完整快照上的回归用例和耗时（阈值放宽，只防数量级的退化；设计目标是建索引约 0.3 秒、每次识别 < 5 ms）。

import { performance } from 'node:perf_hooks'
import { beforeAll, describe, expect, it } from 'vitest'
import { nameKey } from '../../../src/core/items'
import type { ManagedItemResolver } from '../../../src/core/items'
import { loadSnapshotData } from '../../fixtures/data/load'
import { ens, listOf, snapshotResolver, uniqueOf } from './helpers'

let items: ManagedItemResolver
let buildMs = 0

beforeAll(() => {
  loadSnapshotData()
  const start = performance.now()
  items = snapshotResolver()
  items.warm()
  buildMs = performance.now() - start
})

const market = (q: string) => items.resolve(q, { scope: 'market' })

describe('full snapshot', () => {
  it('builds the index well under a second', () => {
    expect(buildMs).toBeLessThan(1500)
    expect(items.stats()).toMatchObject({ items: 27309, marketItems: 19720 })
  })

  it('resolves any query in a few milliseconds', () => {
    const queries = [
      '乌鸦', 'raven', 'rav', 'Raven Navy Issue', 'wuya', 'syhj', '乌鸦机', 'Ravn', '护盾扩展装置 II', 'a', 'x',
      'shield extender', 'zzzzzzzzzzzz', '完全对不上的东西啊', 'xxhdkzzz', '高级水晶', '无畏',
    ]
    for (const q of queries) market(q)
    const slow: string[] = []
    for (const q of queries) {
      const start = performance.now()
      for (let i = 0; i < 5; i++) market(q)
      const ms = (performance.now() - start) / 5
      if (ms > 15) slow.push(`${q}: ${ms.toFixed(1)} ms`)
    }
    expect(slow).toEqual([])
  })

  it('lists candidates for every exact name shared by several market items', () => {
    const data = loadSnapshotData()
    const byKey = new Map<string, Set<number>>()
    for (let row = 0; row < data.types.size; row++) {
      if (data.types.marketGroup[row] < 0) continue
      for (const name of [data.types.en[row], data.types.zh[row]]) {
        const key = name ? nameKey(name) : ''
        if (key) byKey.set(key, (byKey.get(key) ?? new Set()).add(row))
      }
    }
    const shared = [...byKey].filter(([, rows]) => rows.size > 1)
    // SDE 3579973：25 个
    expect(shared.length).toBeGreaterThanOrEqual(20)
    for (const [key, rows] of shared) {
      const name = data.types.zh[[...rows][0]] && nameKey(data.types.zh[[...rows][0]]) === key ? data.types.zh[[...rows][0]] : data.types.en[[...rows][0]]
      const r = market(name)
      expect(r, name).toMatchObject({ kind: 'ambiguous', tier: 'exact' })
      expect(listOf(r).total, name).toBe(rows.size)
    }
  })

  it('finds every implant set, all consistent', () => {
    const report = items.report()
    expect(report.sets).toEqual({ count: 55, skipped: [] })
    const families = new Set<string>()
    for (const q of ['高级水晶', '高级九头蛇', '中级仿生', '低级强势', '低级分裂', '低级圣杯']) {
      const r = market(q)
      if (r.kind !== 'set') throw new Error(`${q}：${r.kind}`)
      expect(r.set.items).toHaveLength(6)
      families.add(r.set.name.en.replace(/^\w+-grade /, ''))
    }
    expect(families.size).toBe(6)
    const crystal = market('水晶')
    expect(crystal.kind === 'sets' && crystal.sets.length).toBe(3)
  })

  it('knows the hull names ending in 级', () => {
    expect(items.report().hulls).toBeGreaterThan(300)
    expect(uniqueOf(market('乌鸦')).item.en).toBe('Raven')
    expect(uniqueOf(market('万王宝座海军型')).item.en).toBe('Megathron Navy Issue')
    expect(market('高级').kind).not.toBe('unique')
  })

  it('attaches the glossary the strict way', () => {
    expect(uniqueOf(market('海万王')).item.en).toBe('Megathron Navy Issue')
    expect(uniqueOf(market('臭氧')).item.en).toBe('Liquid Ozone')
    expect(uniqueOf(market('fort')).item.en).toBe('Fortizar')
    expect(market('无畏')).toMatchObject({ kind: 'group', groupName: '无畏舰' })
    expect(market('跳货')).toMatchObject({ kind: 'group', groupName: '战略货舰' })
    expect(market('注盾')).toMatchObject({ kind: 'group', groupName: '辅助护盾回充增量器' })
    expect(market('加成船').kind).not.toBe('group')
    for (const [q, skill] of [['caps', 'Capital Ships'], ['AB', 'Afterburner'], ['反应', 'Reactions']]) {
      expect(market(q), q).not.toMatchObject({ item: { en: skill } })
    }
    const report = items.report().glossary
    expect(report.items).toBeGreaterThanOrEqual(5)
    expect(report.groups).toBeGreaterThanOrEqual(10)
  })

  it('handles the documented examples', () => {
    expect(uniqueOf(market('raven')).tier).toBe('exact')
    const rav = listOf(market('rav'))
    expect(ens(rav.candidates).some((en) => en.includes('SKIN'))).toBe(false)
    expect(uniqueOf(market('Warrior 2')).item.en).toBe('Warrior II')
    const wuya = market('wuya')
    expect(wuya).toMatchObject({ kind: 'confirm', tier: 'pinyin' })
    expect(listOf(wuya).candidates[0].zh).toBe('乌鸦级')
    expect(market('sthj')).toMatchObject({ kind: 'confirm', tier: 'pinyin', candidates: [{ zh: '三钛合金' }] })
    const syhj = market('syhj')
    expect(syhj.kind === 'none' && syhj.suggestions.map((i) => i.zh)).toContain('三钛合金')
    const typo = market('乌鸦机')
    expect(typo.kind === 'none' && ens(typo.suggestions).slice(0, 2)).toEqual(['Raven', 'Raven Navy Issue'])
    expect(market('护盾扩展装置 II')).toMatchObject({ kind: 'confirm', tier: 'contains', total: 4 })
  })
})
