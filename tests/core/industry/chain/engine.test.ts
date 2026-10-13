// 拆到原料的引擎：小数据集里的真实物品当角色（猎犬级 ← 组件 ← 高级反应 ← 低级反应 ← 原料），
// 需要精确数字的地方用 withRecipes 换成几行小配方。地点、建筑名都是编造的。

import { describe, expect, it } from 'vitest'
import { CHAIN_QUERY_DEADLINE_MS } from '../../../../src/constants'
import { roundIsk } from '../../../../src/core/industry'
import type { ChainResult } from '../../../../src/core/types'
import { loadFixtureData } from '../../../fixtures/data/load'
import { JITA_KEY } from '../service-fakes'
import { ChainPrices, STRUCTURES, chainResult, setup, withRecipes } from './chain-fakes'

const HOUND = 12034
const RAVEN = 638
const BREACHER = 598
const TRITANIUM = 34
const MORPHITE = 11399
const THANATOS = 23911
const FERNITE_ALLOY = 16656
const FERNITE_CARBIDE = 16673
const PLASMONIC = 33361
const FERROGEL = 16683
const PLASMA_THRUSTER = 11530
const HYDROGEN_BLOCK = 4246

const node = (r: ChainResult, typeId: number) => r.nodes.find((n) => n.item.typeId === typeId)
const layer = (r: ChainResult, name: ChainResult['layers'][number]['layer']) => r.layers.find((l) => l.layer === name)!
const leaf = (r: ChainResult, typeId: number) => r.leaves.find((l) => l.item.typeId === typeId)

/** 成品 = 乌鸦级，配方换成 materials；不用建筑加成、ME 0，数量就是配方里写的 */
function ravenOf(materials: Array<[number, number]>, reactions?: Record<number, Array<[number, number]>>) {
  const data = withRecipes(loadFixtureData(), { manufacturing: { [RAVEN]: materials }, reactions })
  const env = setup({ data })
  return { ...env, plain: () => env.run(RAVEN, { on: true }, { structure: 'none', me: 0, te: 0 }) }
}

describe('chain: whole batches and surplus', () => {
  it('G2: demand 250, 200 per batch -> 2 runs, 150 left over (and the cost is not reduced)', async () => {
    const { plain } = ravenOf([[FERNITE_ALLOY, 250]])
    const r = chainResult(await plain())
    expect(node(r, FERNITE_ALLOY)).toMatchObject({ layer: 'reaction1', demand: 250, runs: 2, output: 400, surplus: 150 })
    expect(node(r, RAVEN)).toMatchObject({ layer: 'product', demand: 1, runs: 1, output: 1, surplus: 0 })
    // 两批的原料：每批 氢燃料块 5、两种月矿元素各 100
    expect(leaf(r, HYDROGEN_BLOCK)).toMatchObject({ quantity: 10, kind: 'bought' })
    expect(leaf(r, 16639)?.quantity).toBe(200)
    expect(leaf(r, 16642)?.quantity).toBe(200)
  })

  it('a shared intermediate is aggregated across consumers before rounding to whole batches', async () => {
    // 碳化菲尔金属和等离子体超材料各需要 100 个菲尔合金：合起来 200 个 = 1 批（分开取整会是 2 批）
    const { plain } = ravenOf([[FERNITE_CARBIDE, 1], [PLASMONIC, 1]])
    const r = chainResult(await plain())
    expect(node(r, FERNITE_CARBIDE)).toMatchObject({ runs: 1, demand: 1 })
    expect(node(r, PLASMONIC)).toMatchObject({ runs: 1, demand: 1 })
    expect(node(r, FERNITE_ALLOY)).toMatchObject({ demand: 200, runs: 1, output: 200, surplus: 0 })
    // 每个节点只出现一次，并且消费者在生产者前面
    const ids = r.nodes.map((n) => n.item.typeId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.indexOf(FERNITE_CARBIDE)).toBeLessThan(ids.indexOf(FERNITE_ALLOY))
    expect(ids.indexOf(PLASMONIC)).toBeLessThan(ids.indexOf(FERNITE_ALLOY))
    expect(ids[0]).toBe(RAVEN)
  })

  it('totals add up: leaves + job fees; time is summed per layer, one line in series', async () => {
    const prices = new ChainPrices({ [HYDROGEN_BLOCK]: 10, 16639: 3, 16642: 4 })
    const data = withRecipes(loadFixtureData(), { manufacturing: { [RAVEN]: [[FERNITE_ALLOY, 250]] } })
    const env = setup({ data, prices })
    const r = chainResult(await env.run(RAVEN, { on: true }, { structure: 'none', me: 0, te: 0 }))
    expect(r.totals.leaves).toBe(10 * 10 + 200 * 3 + 200 * 4)
    expect(r.totals.jobs).toBe(r.nodes.reduce((s, n) => s + (n.jobCost?.total ?? 0), 0))
    expect(r.totals).toMatchObject({ reprocessTax: 0, missingPrices: 0 })
    expect(r.totals.total).toBe(r.totals.leaves + r.totals.jobs)
    // 反应层：2 批 × 10800 秒，一条线串行（甲反应堆没有时间加成）
    expect(layer(r, 'reaction1').timeSeconds).toBe(2 * 10800)
    expect(layer(r, 'reaction1')).toMatchObject({ used: true, mode: 'build', where: '甲反应堆' })
    // 「直接买约」= 需求 × 市场单价（这里是 250 个菲尔合金，单价 flat）
    expect(layer(r, 'reaction1').buy).toBeCloseTo(250 * (100 + (FERNITE_ALLOY % 17)), 2)
    // 建造成本 = 本节点的材料（市场价）+ 安装费
    const alloy = node(r, FERNITE_ALLOY)!
    expect(alloy.buildCost).toBe(10 * 10 + 200 * 3 + 200 * 4 + alloy.jobCost!.total)
  })
})

describe('chain: layers', () => {
  it('组件:买 -> components are bought, the reaction layers below are not used', async () => {
    const { run } = setup()
    const r = chainResult(await run(HOUND, { on: true, layers: { component: 'buy' } } as never))
    expect(layer(r, 'component')).toMatchObject({ mode: 'buy', used: false, build: null })
    expect(layer(r, 'reaction2')).toMatchObject({ used: false, build: null, buy: null, timeSeconds: 0 })
    expect(layer(r, 'reaction1')).toMatchObject({ used: false })
    expect(leaf(r, PLASMA_THRUSTER)).toMatchObject({ kind: 'bought' })
    expect(r.nodes.map((n) => n.layer)).toEqual(['product'])
  })

  it('其他:造 expands the T1 hull down to minerals; by default it is bought', async () => {
    const { run } = setup()
    const bought = chainResult(await run(HOUND))
    expect(leaf(bought, BREACHER)).toMatchObject({ kind: 'bought' })
    expect(leaf(bought, MORPHITE)).toMatchObject({ kind: 'raw' })
    expect(leaf(bought, TRITANIUM)).toBeUndefined()
    expect(layer(bought, 'other').used).toBe(false)

    const built = chainResult(await run(HOUND, { on: true, layers: { other: 'build' } } as never))
    expect(node(built, BREACHER)).toMatchObject({ layer: 'other', demand: 1 })
    expect(leaf(built, BREACHER)).toBeUndefined()
    expect(leaf(built, TRITANIUM)?.quantity).toBeGreaterThan(0)
    expect(layer(built, 'other')).toMatchObject({ mode: 'build', used: true })
  })

  it('a reaction as the product: only the reaction layers', async () => {
    const { run } = setup()
    const r = chainResult(await run(FERROGEL, { on: true }, { activity: 'reaction', me: undefined, te: undefined }))
    expect(r.nodes.map((n) => n.layer).filter((l) => l !== 'reaction1')).toEqual(['product'])
    expect(r.layers.filter((l) => l.used).map((l) => l.layer)).toEqual(['product', 'reaction1'])
    expect(r.nodes[0]).toMatchObject({ activity: 'reaction', demand: 400, runs: 1 })
  })

  it('a recipe that loops back is cut at the loop: that edge is bought, with a warning', async () => {
    const { run } = ravenOf([[FERNITE_ALLOY, 10]], { [FERNITE_ALLOY]: [[16660, 1]], 16660: [[FERNITE_ALLOY, 1]] })
    const r = chainResult(await run(RAVEN, { on: true }, { structure: 'none', me: 0, te: 0 }))
    expect(r.nodes.map((n) => n.item.typeId)).toEqual([RAVEN, FERNITE_ALLOY, 16660])
    expect(leaf(r, FERNITE_ALLOY)).toMatchObject({ kind: 'bought', quantity: 1 })
    expect(r.warnings.some((w) => w.includes('绕回了自己') && w.includes('菲尔合金'))).toBe(true)
  })
})

describe('chain: where things are made', () => {
  const THREE = [
    ...STRUCTURES,
    { location: '星点丙', name: '丙反应堆', structureType: 'Athanor', activities: 'reaction' },
  ]
  const places = [
    { name: '星点甲', system: 'NIH-02', visibility: 'public', isDefault: true },
    { name: '星点乙', system: 'Tama', visibility: 'public' },
    { name: '星点丙', system: 'NIH-02', visibility: 'public' },
  ]
  /** 星点甲只有制造厂，反应在别处 */
  const noReactorHere = THREE.filter((s) => s.name !== '甲反应堆')

  it('the command location has no refinery: the first location that can react is used (fallback), with a note', async () => {
    const { run } = setup({ industry: { locations: places, structures: noReactorHere } })
    const r = chainResult(await run(HOUND))
    const reaction = r.nodes.filter((n) => n.activity === 'reaction')
    expect(reaction.length).toBeGreaterThan(5)
    expect(reaction.every((n) => n.location === '星点乙' && n.structure === '乙塔塔拉' && n.fallbackLocation === true)).toBe(true)
    expect(r.nodes.filter((n) => n.activity === 'manufacturing').every((n) => n.location === '星点甲' && !n.fallbackLocation)).toBe(true)
    // 换了地点由节点的 fallbackLocation 表达，不再写进警告
    expect(r.warnings.some((w) => w.includes('命令里的地点'))).toBe(false)
  })

  it('the console setting beats "first location that can react"', async () => {
    const { run } = setup({ industry: { locations: places, structures: noReactorHere, chainReactionLocation: '星点丙' } })
    const r = chainResult(await run(HOUND))
    const reaction = r.nodes.filter((n) => n.activity === 'reaction')
    expect(reaction.every((n) => n.location === '星点丙' && n.fallbackLocation === true)).toBe(true)
  })

  it('the command location is used when it can react (no fallback flag)', async () => {
    const { run } = setup({ industry: { locations: places, structures: THREE } })
    const r = chainResult(await run(HOUND))
    expect(r.nodes.filter((n) => n.activity === 'reaction').every((n) => n.location === '星点甲' && n.fallbackLocation === undefined)).toBe(true)
  })

  it('nobody can react: reaction products are bought, with a warning', async () => {
    const { run } = setup({ industry: { structures: STRUCTURES.filter((s) => s.activities !== 'reaction') } })
    const r = chainResult(await run(HOUND))
    expect(r.nodes.some((n) => n.activity === 'reaction')).toBe(false)
    expect(leaf(r, FERROGEL)).toMatchObject({ kind: 'unbuildable' })
    expect(r.warnings.some((w) => w.startsWith('没有能做') && w.endsWith('的反应建筑，改成直接买'))).toBe(true)
    expect(layer(r, 'reaction1').used).toBe(false)
  })

  it('several refineries at the location: the cheapest one is picked per node', async () => {
    const cheap = [...STRUCTURES, { location: '星点甲', name: '甲备用反应堆', structureType: 'Athanor', activities: 'reaction', reactionTaxPct: 0.1 }]
    const { run } = setup({ industry: { structures: cheap } })
    const r = chainResult(await run(HOUND))
    const reaction = r.nodes.filter((n) => n.activity === 'reaction')
    expect(reaction.every((n) => n.structure === '甲备用反应堆' && n.autoPicked)).toBe(true)
    expect(node(r, HOUND)).toMatchObject({ structure: '甲莱塔卢', autoPicked: false })
  })

  it('no location (base mode): no fees, no refinery, everything else made without bonuses', async () => {
    const { service, req } = setup()
    const r = chainResult(await service.chain({ ...req(HOUND, { on: true, layers: { other: 'build' } } as never), mode: 'base', location: undefined, me: undefined, te: undefined }))
    expect(r.location).toBeUndefined()
    expect(r.nodes.map((n) => n.activity)).not.toContain('reaction')
    expect(r.nodes.every((n) => n.jobCost === null && n.location === '' && n.structure === null)).toBe(true)
    expect(r.totals.jobs).toBe(0)
    expect(r.warnings).toContain('没有选工业地点，整条链按没有建筑加成算，安装费和税没有计入')
  })
})

describe('chain: the 税 argument only changes the final product', () => {
  it('top job uses the command tax; intermediate jobs use each structure tax', async () => {
    const { run } = setup()
    const r = chainResult(await run(HOUND, { on: true }, { facilityTaxPct: 5 }))
    const top = node(r, HOUND)!.jobCost!
    expect(top.facility).toBe(roundIsk(top.eiv * 5 / 100))
    // 组件在甲莱塔卢（制造税 1%）、反应在甲反应堆（反应税 2%）
    const component = node(r, PLASMA_THRUSTER)!.jobCost!
    expect(component.facility).toBe(roundIsk(component.eiv * 1 / 100))
    const reaction = node(r, FERROGEL)!.jobCost!
    expect(reaction.facility).toBe(roundIsk(reaction.eiv * 2 / 100))
    // 没写「税:」时顶层也用建筑自己的
    const plain = chainResult(await run(HOUND))
    expect(node(plain, HOUND)!.jobCost!.facility).toBe(roundIsk(node(plain, HOUND)!.jobCost!.eiv * 1 / 100))
  })
})

describe('chain: prices', () => {
  it('the whole tree is priced with ONE getQuotes call on the material market (plus the product on its own)', async () => {
    const { run, prices, indices } = setup()
    const r = chainResult(await run(HOUND, { on: true, layers: { other: 'build' } } as never))
    expect(prices.calls.map((c) => c.market)).toEqual([JITA_KEY, JITA_KEY])
    const [closure, product] = prices.calls
    expect(product.typeIds).toEqual([HOUND])
    expect(new Set(closure.typeIds).size).toBe(closure.typeIds.length)
    // 每个节点和每个叶子都在里面
    for (const id of [...r.nodes.map((n) => n.item.typeId), ...r.leaves.map((l) => l.item.typeId)]) expect(closure.typeIds).toContain(id)
    // 时限用 12 秒，指数和调整价各取一次
    expect(prices.opts[0]?.deadlineMs).toBeGreaterThan(CHAIN_QUERY_DEADLINE_MS - 1000)
    expect(prices.opts[0]?.deadlineMs).toBeLessThanOrEqual(CHAIN_QUERY_DEADLINE_MS)
    expect(indices.systemCalls).toBe(1)
    expect(indices.adjustedCalls).toBe(1)
  })

  it('prices that did not arrive in time are missing: the result is marked incomplete, never 0', async () => {
    const prices = new ChainPrices()
    prices.omit = new Set([MORPHITE, 3828])
    const { run } = setup({ prices })
    const r = chainResult(await run(HOUND))
    expect(leaf(r, MORPHITE)).toMatchObject({ unit: null, total: null })
    expect(r.totals.missingPrices).toBeGreaterThan(0)
    expect(r.warnings.some((w) => w.includes('总成本不完整'))).toBe(true)
  })

  it('product value and profit come from the product market', async () => {
    const prices = new ChainPrices({ [HOUND]: 9_000_000 })
    const { run } = setup({ prices })
    const r = chainResult(await run(HOUND))
    expect(r.productValue).toMatchObject({ marketKey: JITA_KEY, unit: 9_000_000, total: 9_000_000 })
    expect(r.profit?.value).toBeLessThan(9_000_000)
    expect(r.profit!.marginPct).toBeCloseTo(r.profit!.value / 9_000_000 * 100, 6)
  })

  it('too many different items: BAD_ARGUMENT chain-size, nothing is priced', async () => {
    const ids = [...loadFixtureData().industry.manufacturing.keys(), ...Array.from({ length: 400 }, (_, i) => 100000 + i)].slice(0, 260)
    const data = withRecipes(loadFixtureData(), { manufacturing: { [RAVEN]: ids.map((id) => [id, 1] as [number, number]) } })
    const { run, prices } = setup({ data })
    const r = await run(RAVEN, { on: true })
    expect(r).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'chain-size' })
    expect(prices.calls).toEqual([])
  })
})

describe('chain: structured facts the card relies on', () => {
  it('location security class, material market and the T2 invention flag are fields, not warning text', async () => {
    const { run } = setup()
    const r = chainResult(await run(HOUND))
    expect(r.secClass).toBe('null')
    expect(r.materialPrices).toMatchObject({ marketKey: JITA_KEY })
    expect(r.inventionExcluded).toBe(true)
    expect(r.warnings.some((w) => w.includes('发明'))).toBe(false)
    const t1 = chainResult(await setup().run(RAVEN, { on: true }, { structure: 'none' }))
    expect(t1.inventionExcluded).toBe(false)
  })

  it('base mode (no location) has no security class', async () => {
    const { run } = setup()
    const r = chainResult(await run(RAVEN, { on: true }, { location: undefined, mode: 'base' }))
    expect(r.location).toBeUndefined()
    expect(r.secClass).toBeUndefined()
  })

  it('a bought leaf that could be built records its layer; a raw one does not', async () => {
    const { run } = setup()
    const r = chainResult(await run(HOUND))
    expect(leaf(r, BREACHER)).toMatchObject({ kind: 'bought', layer: 'other' })
    expect(leaf(r, MORPHITE)?.layer).toBeUndefined()
    const buy = chainResult(await run(HOUND, { on: true, layers: { component: 'buy' } } as never))
    expect(leaf(buy, PLASMA_THRUSTER)).toMatchObject({ kind: 'bought', layer: 'component' })
  })

  it('a leaf bought because it loops back, or cannot be built here, has no layer', async () => {
    const { run } = ravenOf([[FERNITE_ALLOY, 10]], { [FERNITE_ALLOY]: [[16660, 1]], 16660: [[FERNITE_ALLOY, 1]] })
    const r = chainResult(await run(RAVEN, { on: true }, { structure: 'none', me: 0, te: 0 }))
    expect(leaf(r, FERNITE_ALLOY)).toMatchObject({ kind: 'bought' })
    expect(leaf(r, FERNITE_ALLOY)?.layer).toBeUndefined()
  })
})

describe('chain: asking for the missing steps', () => {
  it('高级 with a complete command goes straight to the chain without an extra single-product price fetch', async () => {
    const { service, req, prices } = setup()
    const r = chainResult(await service.chain({ ...req(HOUND), mode: 'steps', structure: '甲莱塔卢' }))
    expect(r.nodes[0].structure).toBe('甲莱塔卢')
    // 只有整棵树的一次材料报价和一次成品报价
    expect(prices.calls).toHaveLength(2)
  })

  it('高级 (steps) without a location: the location step; every option carries the chain words', async () => {
    const { service, req } = setup({ industry: { structures: [...STRUCTURES, { location: '星点乙', name: '乙莱塔卢', structureType: 'Raitaru' }] } })
    const r = await service.chain({ ...req(HOUND, { on: true, layers: { component: 'buy' } } as never), mode: 'steps', location: undefined })
    expect(r).toMatchObject({ step: 'location' })
    if (!('step' in r)) throw new Error('应该是一步')
    expect(r.options.map((o) => o.command)).toEqual(['猎犬级 星点甲 ME2 TE4 组件:买 高级', '猎犬级 星点乙 ME2 TE4 组件:买 高级'])
    // 只写了「拆到原料」时选项里也带着它
    const plain = await service.chain({ ...req(HOUND), mode: 'steps', location: undefined })
    if (!('step' in plain)) throw new Error('应该是一步')
    expect(plain.options.every((o) => o.command.includes('拆到原料'))).toBe(true)
  })

  it('a wrong structure name asks for the structure instead of failing', async () => {
    const { run } = setup()
    const r = await run(HOUND, { on: true }, { structure: '不存在' })
    expect(r).toMatchObject({ step: 'structure' })
  })

  it('a product no location can build is the same capability failure as 制造', async () => {
    const data = withRecipes(loadFixtureData(), { manufacturing: { [THANATOS]: [[TRITANIUM, 1000]] } })
    const { run } = setup({ data })
    const r = await run(THANATOS, { on: true })
    expect(r).toMatchObject({ ok: false, code: 'UNKNOWN_LOCATION', reason: 'capability' })
  })

  it('the final product honours 建筑: and 数量', async () => {
    const { run } = setup()
    const r = chainResult(await run(HOUND, { on: true }, { structure: '甲莱塔卢', quantity: 3 }))
    expect(r.runs).toBe(3)
    expect(r.outputQuantity).toBe(3)
    expect(node(r, HOUND)).toMatchObject({ structure: '甲莱塔卢', autoPicked: false, demand: 3 })
  })
})
