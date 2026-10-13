// 炼金术：低级反应产物走「粗糙配方 → 废料提炼」。黄金向量 G1：铁磁流体 1,000 个，废料处理 V 级，不加建筑加成。

import { describe, expect, it } from 'vitest'
import { chooseRoute } from '../../../../src/core/industry/chain/alchemy'
import { reprocessOut, scrapYield } from '../../../../src/core/industry/reprocess'
import type { ChainResult } from '../../../../src/core/types'
import { loadFixtureData } from '../../../fixtures/data/load'
import { ChainPrices, STRUCTURES, chainResult, setup, withRecipes, withReprocessing } from './chain-fakes'

const RAVEN = 638
const HOUND = 12034
const FERROFLUID = 16669
const HAFNIUM = 16648
const CADMIUM = 16643
const DYSPROSIUM = 16650
const HYDROGEN_BLOCK = 4246
const TRITANIUM = 34
const UNREFINED = 29663

const node = (r: ChainResult, typeId: number) => r.nodes.find((n) => n.item.typeId === typeId)!
const leaf = (r: ChainResult, typeId: number) => r.leaves.find((l) => l.item.typeId === typeId)
const inputs = (r: ChainResult, typeId: number) => Object.fromEntries(node(r, typeId).inputs.map((i) => [i.typeId, i.quantity]))

/** 乌鸦级 = 1,000 个铁磁流体；反应堆是没有加成的阿塔诺，另配一座提炼税 2% 的提炼厂 */
const STATIONS = [...STRUCTURES, { location: '星点甲', name: '甲提炼厂', structureType: 'Athanor', activities: 'reprocessing', reprocessingTaxPct: 2 }]

function ferrofluid(opts: { data?: ReturnType<typeof loadFixtureData>; prices?: ChainPrices; industry?: Record<string, unknown>; qty?: number } = {}) {
  const base = withRecipes(opts.data ?? loadFixtureData(), { manufacturing: { [RAVEN]: [[FERROFLUID, opts.qty ?? 1000]] } })
  const env = setup({ data: base, ...(opts.prices ? { prices: opts.prices } : {}), industry: { structures: STATIONS, ...opts.industry } })
  return { ...env, go: (chain: Parameters<typeof env.run>[1]) => env.run(RAVEN, chain, { structure: 'none', me: 0, te: 0 }) }
}

describe('alchemy: golden vector G1', () => {
  it('forced alchemy: 25 units, 25 runs, inputs and byproduct offset, 540,000 s', async () => {
    const { go } = ferrofluid()
    const r = chainResult(await go({ on: true, alchemy: 'alchemy' }))
    const n = node(r, FERROFLUID)
    expect(n).toMatchObject({ route: 'alchemy', demand: 1000, runs: 25, output: 1000, surplus: 0, timeSeconds: 540000, layer: 'reaction1' })
    expect(n.alchemy).toMatchObject({ perUnit: 40, units: 25, runs: 25, yieldPct: 55, byproducts: [{ typeId: HAFNIUM, quantity: 2375 }] })
    expect(n.alchemy?.unrefined.typeId).toBe(UNREFINED)
    expect(inputs(r, FERROFLUID)).toEqual({ [CADMIUM]: 2500, [HAFNIUM]: 2500, [HYDROGEN_BLOCK]: 125 })
    // 副产品铪 2,375 抵掉要买的铪：2,500 - 2,375 = 125
    expect(leaf(r, HAFNIUM)).toMatchObject({ quantity: 2500, offset: 2375 })
    expect(leaf(r, CADMIUM)).toMatchObject({ quantity: 2500, offset: 0 })
    expect(leaf(r, HAFNIUM)!.total).toBeCloseTo(125 * leaf(r, HAFNIUM)!.unit!, 2)
    expect(r.surplusByproducts).toEqual([])
    // 另一条路线（正常）的成本和时间在 other 里
    expect(n.alchemy?.other).toMatchObject({ route: 'normal', timeSeconds: 54000 })
    // 按整批取整是 1,003，0 级技能每单位 36 个
    expect(reprocessOut(73, 25, scrapYield(5), 'batch')).toBe(1003)
    expect(reprocessOut(73, 1, scrapYield(0), 'per-unit')).toBe(36)
  })

  it('normal route: 5 runs, hafnium 500, dysprosium 500, fuel blocks 25, 54,000 s', async () => {
    const { go } = ferrofluid()
    const r = chainResult(await go({ on: true, alchemy: 'normal' }))
    expect(node(r, FERROFLUID)).toMatchObject({ runs: 5, output: 1000, timeSeconds: 54000 })
    expect(node(r, FERROFLUID).route).toBeUndefined()
    expect(node(r, FERROFLUID).alchemy).toBeUndefined()
    expect(inputs(r, FERROFLUID)).toEqual({ [HAFNIUM]: 500, [DYSPROSIUM]: 500, [HYDROGEN_BLOCK]: 25 })
    expect(leaf(r, HAFNIUM)).toMatchObject({ quantity: 500, offset: 0 })
  })

  it('skill level 0: 36 per unit, so 28 units', async () => {
    const { go } = ferrofluid({ industry: { scrapmetalLevel: 0 } })
    const r = chainResult(await go({ on: true, alchemy: 'alchemy' }))
    expect(node(r, FERROFLUID).alchemy).toMatchObject({ perUnit: 36, units: 28, runs: 28, yieldPct: 50 })
    expect(node(r, FERROFLUID)).toMatchObject({ output: 1008, surplus: 8 })
  })
})

describe('alchemy: picking the route', () => {
  it('auto picks the cheaper route; the other one is kept for comparison', async () => {
    // 镉便宜、铪和镝贵：炼金（用 2,500 镉，铪被副产品抵掉）比正常（500 铪 + 500 镝）便宜
    const cheapCadmium = ferrofluid({ prices: new ChainPrices({ [CADMIUM]: 10, [HAFNIUM]: 1000, [DYSPROSIUM]: 1000, [HYDROGEN_BLOCK]: 100, [FERROFLUID]: 5000 }) })
    const a = chainResult(await cheapCadmium.go({ on: true }))
    expect(node(a, FERROFLUID)).toMatchObject({ route: 'alchemy', runs: 25 })
    expect(node(a, FERROFLUID).alchemy?.other.route).toBe('normal')
    expect(node(a, FERROFLUID).alchemy!.other.cost!).toBeGreaterThan(node(a, FERROFLUID).buildCost!)

    const dearCadmium = ferrofluid({ prices: new ChainPrices({ [CADMIUM]: 1000, [HAFNIUM]: 10, [DYSPROSIUM]: 10, [HYDROGEN_BLOCK]: 100, [FERROFLUID]: 5000 }) })
    const b = chainResult(await dearCadmium.go({ on: true }))
    expect(node(b, FERROFLUID)).toMatchObject({ route: 'normal', runs: 5 })
    expect(node(b, FERROFLUID).alchemy?.other).toMatchObject({ route: 'alchemy', timeSeconds: 540000 })
    // 合计用的是选中的路线
    expect(leaf(b, CADMIUM)).toBeUndefined()
  })

  it('chooseRoute: forced, missing costs, ties go to the faster one', () => {
    const slow = { cost: 100, time: 900 }
    const fast = { cost: 100.5, time: 100 }
    expect(chooseRoute('alchemy', { cost: 1, time: 1 }, { cost: 999, time: 999 })).toBe('alchemy')
    expect(chooseRoute('auto', { cost: 1000, time: 1 }, { cost: 10, time: 999 })).toBe('alchemy')
    expect(chooseRoute('auto', { cost: 10, time: 999 }, { cost: 1000, time: 1 })).toBe('normal')
    expect(chooseRoute('auto', slow, fast)).toBe('alchemy')
    expect(chooseRoute('auto', fast, slow)).toBe('normal')
    expect(chooseRoute('auto', { cost: 5, time: 5 }, { cost: 5, time: 5 })).toBe('normal')
    expect(chooseRoute('auto', { cost: 5, time: 5 }, { cost: null, time: 1 })).toBe('normal')
    expect(chooseRoute('auto', { cost: null, time: 5 }, { cost: 5, time: 9 })).toBe('alchemy')
  })

  it('a missing price makes the alchemy route unknown: auto keeps the normal route; forced shows an incomplete result', async () => {
    const prices = new ChainPrices()
    prices.omit = new Set([CADMIUM])
    const { go } = ferrofluid({ prices })
    const auto = chainResult(await go({ on: true }))
    expect(node(auto, FERROFLUID)).toMatchObject({ route: 'normal' })
    expect(node(auto, FERROFLUID).alchemy?.other.cost).toBeNull()
    const forced = chainResult(await go({ on: true, alchemy: 'alchemy' }))
    expect(leaf(forced, CADMIUM)).toMatchObject({ unit: null, total: null })
    // 镉既是缺价格的原料、又让提炼税算不出来：只算一项
    expect(forced.totals.missingPrices).toBe(1)
  })

  it('forced alchemy where most reactions have no unrefined recipe: those stay normal, with a note', async () => {
    const { run } = setup()
    const r = chainResult(await run(HOUND, { on: true, alchemy: 'alchemy' }))
    const reactions = r.nodes.filter((n) => n.layer === 'reaction1')
    expect(reactions.filter((n) => n.route === 'alchemy').map((n) => n.item.typeId)).toEqual([FERROFLUID])
    expect(r.warnings).toContain(`炼金只适用于 1 种低级反应，其余 ${reactions.length - 1} 种没有炼金配方，按正常路线算`)
  })

  it('a reaction whose unrefined item has its own reprocessing skill gets no alchemy, with a warning', async () => {
    const data = withReprocessing(loadFixtureData(), UNREFINED, (row) => ({ ...row, skill: 12196 }))
    const { go } = ferrofluid({ data })
    const r = chainResult(await go({ on: true, alchemy: 'alchemy' }))
    expect(node(r, FERROFLUID)).toMatchObject({ runs: 5, timeSeconds: 54000 })
    expect(node(r, FERROFLUID).route).toBeUndefined()
    expect(r.warnings).toContain('铁磁流体 在数据里有专用提炼技能，炼金暂不计算')
  })

  it('a reprocessing row without a main product gives no alchemy, with a warning', async () => {
    const data = withReprocessing(loadFixtureData(), UNREFINED, (row) => ({ ...row, main: null }))
    const { go } = ferrofluid({ data })
    const r = chainResult(await go({ on: true }))
    expect(node(r, FERROFLUID).route).toBeUndefined()
    expect(r.warnings).toContain('铁磁流体 的提炼数据不完整（找不到主产物），炼金暂不计算')
  })
})

describe('alchemy: byproducts, tax', () => {
  it('byproducts first offset the same material to buy; the rest is surplus and not valued', async () => {
    // 假设粗糙铁磁流体还提炼出 500 个三钛合金（每单位 275）：乌鸦级自己也要买 1,000 个三钛合金
    const data = withReprocessing(withRecipes(loadFixtureData(), { manufacturing: { [RAVEN]: [[FERROFLUID, 1000], [TRITANIUM, 1000]] } }), UNREFINED,
      (row) => ({ ...row, materials: [...row.materials, { typeId: TRITANIUM, quantity: 500 }] }))
    const env = setup({ data, industry: { structures: STATIONS } })
    const r = chainResult(await env.run(RAVEN, { on: true, alchemy: 'alchemy' }, { structure: 'none', me: 0, te: 0 }))
    // 25 个单位 × floor(500 × 0.55) = 6,875 个三钛合金，抵掉要买的 1,000 个，剩 5,875
    expect(leaf(r, TRITANIUM)).toMatchObject({ quantity: 1000, offset: 1000, total: 0 })
    expect(r.surplusByproducts.map((b) => [b.item.typeId, b.quantity])).toEqual([[TRITANIUM, 5875]])
    // 抵不完的部分不算钱，也不进合计
    const priced = r.leaves.reduce((s, l) => s + (l.total ?? 0), 0)
    expect(r.totals.leaves).toBe(priced)
  })

  it('a fallback-bought item (cannot be built here) is offset by a byproduct too', async () => {
    // 乌鸦级还要 1 艘永恒级超旗：莱塔卢造不了，改成买；粗糙铁磁流体假设提炼出 10 个永恒级，每单位 5 个，共 125 个
    const AEON_HULL = 23919
    const data = withReprocessing(withRecipes(loadFixtureData(), { manufacturing: { [RAVEN]: [[FERROFLUID, 1000], [AEON_HULL, 1]], [AEON_HULL]: [[TRITANIUM, 100]] } }), UNREFINED,
      (row) => ({ ...row, materials: [...row.materials, { typeId: AEON_HULL, quantity: 10 }] }))
    const env = setup({ data, industry: { structures: STATIONS } })
    const r = chainResult(await env.run(RAVEN, { on: true, alchemy: 'alchemy', layers: { other: 'build' } } as never, { structure: 'none', me: 0, te: 0 }))
    expect(leaf(r, AEON_HULL)).toMatchObject({ kind: 'unbuildable', quantity: 1, offset: 1, total: 0 })
    expect(r.surplusByproducts.find((b) => b.item.typeId === AEON_HULL)?.quantity).toBe(124)
  })

  it('a byproduct nobody needs to buy is only surplus', async () => {
    const data = withReprocessing(loadFixtureData(), UNREFINED, (row) => ({ ...row, materials: [...row.materials, { typeId: TRITANIUM, quantity: 500 }] }))
    const { go } = ferrofluid({ data })
    const r = chainResult(await go({ on: true, alchemy: 'alchemy' }))
    expect(r.surplusByproducts.map((b) => [b.item.typeId, b.quantity])).toEqual([[TRITANIUM, 6875]])
    expect(leaf(r, TRITANIUM)).toBeUndefined()
  })

  it('reprocessing tax: % of the outputs at material prices, at the structure with the lowest tax', async () => {
    const stations = [...STATIONS, { location: '星点甲', name: '甲便宜提炼厂', structureType: 'Athanor', activities: 'all', reprocessingTaxPct: 1 }]
    const prices = new ChainPrices({ [FERROFLUID]: 50, [HAFNIUM]: 100 })
    const { go } = ferrofluid({ prices, industry: { structures: stations } })
    const r = chainResult(await go({ on: true, alchemy: 'alchemy' }))
    // 产出：1,000 个铁磁流体（50）+ 2,375 个铪（100）= 287,500 ISK，税 1%
    expect(r.totals.reprocessTax).toBe(2875)
    expect(node(r, FERROFLUID).alchemy).toMatchObject({ reprocessTax: 2875, reprocessAt: '甲便宜提炼厂', reprocessLocation: '星点甲', reprocessPct: 1 })
    expect(r.totals.total).toBe(r.totals.leaves + r.totals.jobs + 2875)
    expect(r.warnings).not.toContain('未配置提炼建筑，提炼税按 0 算')
  })

  it('no reprocessing structure: tax is 0 and the result says so', async () => {
    const { go } = ferrofluid({ industry: { structures: STRUCTURES } })
    const r = chainResult(await go({ on: true, alchemy: 'alchemy' }))
    expect(r.totals.reprocessTax).toBe(0)
    expect(r.warnings).toContain('未配置提炼建筑，提炼税按 0 算')
  })

  it('the 提炼地点 setting is looked at first', async () => {
    const stations = [
      ...STATIONS,
      { location: '星点乙', name: '乙提炼厂', structureType: 'Athanor', activities: 'reprocessing', reprocessingTaxPct: 0.5 },
    ]
    const { go } = ferrofluid({ industry: { structures: stations, reprocessLocation: '星点乙' } })
    const r = chainResult(await go({ on: true, alchemy: 'alchemy' }))
    expect(node(r, FERROFLUID).alchemy?.reprocessAt).toBe('乙提炼厂')
  })

  it('no 提炼地点 and no reprocessing at the command location: the first visible location that has one', async () => {
    const stations = [
      ...STRUCTURES,
      { location: '星点乙', name: '乙提炼厂', structureType: 'Athanor', activities: 'reprocessing', reprocessingTaxPct: 3 },
    ]
    const { go } = ferrofluid({ industry: { structures: stations } })
    const r = chainResult(await go({ on: true, alchemy: 'alchemy' }))
    expect(node(r, FERROFLUID).alchemy?.reprocessAt).toBe('乙提炼厂')
    expect(r.warnings).not.toContain('未配置提炼建筑，提炼税按 0 算')
  })
})

describe('alchemy: refinery lookup by the reaction node\'s own location', () => {
  it('the command location and the setting have no refinery: the location the reaction fell back to is used, not the first visible one', async () => {
    const places = [
      { name: '星点甲', system: 'NIH-02', visibility: 'public', isDefault: true },
      { name: '星点乙', system: 'Tama', visibility: 'public' },
      { name: '星点丙', system: 'NIH-02', visibility: 'public' },
    ]
    const stations = [
      { location: '星点甲', name: '甲莱塔卢', structureType: 'Raitaru', facilityTaxPct: 1 },
      // 乙只有提炼厂（税高）：排在丙前面，按「本群第一个有提炼的地点」会先找到它
      { location: '星点乙', name: '乙提炼厂', structureType: 'Athanor', activities: 'reprocessing', reprocessingTaxPct: 5 },
      { location: '星点丙', name: '丙反应堆', structureType: 'Athanor', activities: 'reaction', reactionTaxPct: 2 },
      { location: '星点丙', name: '丙提炼厂', structureType: 'Athanor', activities: 'reprocessing', reprocessingTaxPct: 1 },
    ]
    const prices = new ChainPrices({ [FERROFLUID]: 50, [HAFNIUM]: 100 })
    const { go } = ferrofluid({ prices, industry: { locations: places, structures: stations } })
    const r = chainResult(await go({ on: true, alchemy: 'alchemy' }))
    const n = node(r, FERROFLUID)
    expect(n).toMatchObject({ location: '星点丙', fallbackLocation: true })
    expect(n.alchemy).toMatchObject({ reprocessAt: '丙提炼厂', reprocessLocation: '星点丙', reprocessPct: 1, reprocessTax: 2875 })
    expect(r.warnings).not.toContain('未配置提炼建筑，提炼税按 0 算')
  })
})
