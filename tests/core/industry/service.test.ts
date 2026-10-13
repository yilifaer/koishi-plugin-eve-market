// IndustryService（§2.6–§2.8、§6.7.9、§6.7.10）：小数据集 + 假的报价、星系成本指数和调整价。
// 地点名、建筑名、价格、指数都是编造的；星系用公共星系（NIH-02 是 00、Tama 低安、Jita 高安）。

import { describe, expect, it } from 'vitest'
import { MAX_RUNS } from '../../../src/constants'
import { DataNotReadyError } from '../../../src/core/data'
import { chunkLines, createIndustryService, materialQuantity, multibuyBlocks } from '../../../src/core/industry'
import { isFailure } from '../../../src/core/types'
import type {
  CoreFailure, IndustryRequest, IndustryResult, IndustryStep, LocationComparison,
} from '../../../src/core/types'
import { STRUCTURE_ROWS } from '../market/helpers'
import { ALLOWED, FakeIndices, FakePrices, INDICES_TIME, JITA_KEY, PUBLIC, QUOTE_TIME, UNAVAILABLE, makeService } from './service-fakes'

const RAVEN = 638
const DAMAGE_CONTROL_II = 2048
const TUNGSTEN_CARBIDE = 16672
const NIH_02 = 30000900
const TAMA = 30002813
const XL_SHIP_I = 37180
const COMPOSITE_TE_I = 46484

/** Jita 出售价（编造） */
const JITA: Record<number, number> = {
  34: 4, 35: 20, 36: 95, 37: 160, 38: 820, 39: 1450, 40: 2600, 57478: 6500, 57479: 3_200_000, 57486: 41_000,
  [RAVEN]: 258_400_000, [DAMAGE_CONTROL_II]: 600_000, [TUNGSTEN_CARBIDE]: 50,
}
/** 调整价（编造，便于手算） */
const ADJUSTED: Record<number, number> = {
  34: 4, 35: 10, 36: 50, 37: 300, 38: 1000, 39: 2500, 40: 2500, 57478: 10_000, 57479: 350_000, 57486: 12_000,
}

const INDUSTRY = {
  locations: [
    { name: 'XX-1', system: 'NIH-02', visibility: 'allowed', isDefault: true },
    { name: '联盟工业点A', system: 'Tama', visibility: 'public', defaultME: 8, defaultTE: 16 },
    { name: 'XX-2', system: 'Jita', visibility: 'public' },
  ],
  structures: [
    { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', rigs: String(XL_SHIP_I), facilityTaxPct: 1, isDefault: true },
    { location: 'XX-1', name: '小厂', structureType: 'Azbel', facilityTaxPct: 0.5, extraFeePct: 1, extraFeeIsk: 1000, extraFeeLabel: '联盟附加费' },
    { location: '联盟工业点A', name: '反应塔', structureType: 'Athanor', activities: 'both', rigs: String(COMPOSITE_TE_I), facilityTaxPct: 2 },
  ],
}

function setup(raw: Record<string, unknown> = {}, indices = new FakeIndices({ systems: { [NIH_02]: { manufacturing: 0.02 }, [TAMA]: { manufacturing: 0.01, reaction: 0.015 } }, adjusted: ADJUSTED })) {
  const prices = new FakePrices().set(JITA_KEY, JITA)
  const env = makeService({ industry: INDUSTRY, ...raw }, { prices, indices })
  expect(env.issues.filter((i) => i.section === 'industry')).toEqual([])
  /** 像群里那样：解析命令再计算 */
  const run = async (text: string, access = ALLOWED, activity: IndustryRequest['activity'] = 'manufacturing') => {
    const req = env.parse(text, activity, access)
    if (isFailure(req)) return req
    return env.service.plan(req)
  }
  return { ...env, run }
}

function result(r: IndustryResult | IndustryStep | CoreFailure): IndustryResult {
  if (isFailure(r)) throw new Error(`应该出结果，实际是 ${r.code}（${r.message ?? r.reason ?? ''}）`)
  if ('step' in r) throw new Error(`应该出结果，实际是第「${r.step}」步`)
  return r
}

function step(r: IndustryResult | IndustryStep | CoreFailure): IndustryStep {
  if (isFailure(r)) throw new Error(`应该是一步，实际是 ${r.code}（${r.message ?? r.reason ?? ''}）`)
  if (!('step' in r)) throw new Error('应该是一步，实际出了结果')
  return r
}

function failed(r: unknown): CoreFailure {
  if (!isFailure(r)) throw new Error('应该失败')
  return r
}

const quantities = (r: IndustryResult) => Object.fromEntries(r.materials.map((m) => [m.item.typeId, m.quantity]))

describe('IndustryService: base reference', () => {
  const { run } = setup()

  it('ME 0 / TE 0, no structure, no index or tax, materials at Jita sell', async () => {
    const r = result(await run('乌鸦级'))
    expect(quantities(r)).toEqual({
      34: 5_200_000, 35: 2_600_000, 36: 390_000, 37: 130_000, 38: 15_600, 39: 3_900, 40: 1_950, 57478: 150, 57479: 1, 57486: 75,
    })
    expect(r.materialCost).toBe(161_417_000)
    expect(r.missingPrices).toBe(0)
    // 金额高的在前；一样多的按数据里的顺序
    expect(r.materials.map((m) => m.item.typeId)).toEqual([35, 36, 37, 34, 38, 39, 40, 57479, 57486, 57478])
    expect(r.materials[0]).toEqual({
      item: expect.objectContaining({ typeId: 35, en: 'Pyerite' }), baseQuantity: 2_600_000, quantity: 2_600_000, unit: 20, total: 52_000_000,
      manufacturable: false,
    })
    expect(r).toMatchObject({
      product: { typeId: RAVEN }, blueprint: { typeId: 688 }, runs: 1, jobs: [1], outputQuantity: 1,
      applied: { rigs: [], me: 0, te: 0, defaulted: [] },
      timeSeconds: 18_000, timeSecondsMaxSkill: 12_240,
      productValue: { marketKey: JITA_KEY, side: 'sell', unit: 258_400_000, total: 258_400_000 },
      materialPrices: { marketKey: JITA_KEY, side: 'sell' },
      pricesAt: QUOTE_TIME,
      formulaRevision: '1',
      warnings: [],
    })
    expect(r.applied.location).toBeUndefined()
    expect(r.jobCost).toBeUndefined()
    expect(r.profit).toBeUndefined()
  })

  it('uses ME/TE when written', async () => {
    const r = result(await run('乌鸦级 ME10 TE20'))
    expect(r.applied).toMatchObject({ me: 10, te: 20, defaulted: [] })
    expect(quantities(r)[34]).toBe(4_680_000)
    expect(r.timeSeconds).toBe(14_400)
  })

  it('*N is the number of products, N流程 the number of runs', async () => {
    expect(result(await run('乌鸦级*3'))).toMatchObject({ runs: 3, outputQuantity: 3, jobs: [3], timeSeconds: 54_000 })
    const tc = result(await run('碳化钨*25000', ALLOWED, 'reaction'))
    expect(tc).toMatchObject({ runs: 3, outputQuantity: 30_000, productValue: { unit: 50, total: 1_500_000 } })
    expect(result(await run('碳化钨 2流程', ALLOWED, 'reaction'))).toMatchObject({ runs: 2, outputQuantity: 20_000 })
  })

  it('T2: invention note, and a copy holds at most maxRuns runs (one job each, rounded per job)', async () => {
    const r = result(await run('Damage Control II*25'))
    expect(r.jobs).toEqual([10, 10, 5])
    expect(r.warnings).toEqual(['T2 蓝图一般来自发明（常见 ME 2 / TE 4），发明成本暂不计入', '单张蓝图最多 10 流程，按 3 个工作计算'])
    const adv = result(await run('Damage Control II*25 XX-1 ME2 TE4'))
    expect(adv.jobs).toEqual([10, 10, 5])
    const bp = adv.blueprint
    expect(bp.typeId).toBe(2049)
    // 每个工作分别取整再相加
    const mult = 0.98 * 0.99
    for (const m of adv.materials) {
      const base = m.baseQuantity / 25
      expect(m.quantity, m.item.en).toBe(materialQuantity(base, 10, mult) * 2 + materialQuantity(base, 5, mult))
    }
  })

  it('refuses more runs than MAX_RUNS, and products without a blueprint', async () => {
    const { service } = setup()
    const req = { typeId: RAVEN, activity: 'manufacturing' as const, mode: 'base' as const, materials: false, access: ALLOWED }
    expect(await service.plan({ ...req, quantity: MAX_RUNS + 1 })).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'runs-range' })
    expect(await service.plan({ ...req, runs: MAX_RUNS })).toMatchObject({ runs: MAX_RUNS })
    expect(await service.plan({ ...req, typeId: TUNGSTEN_CARBIDE })).toMatchObject({ ok: false, code: 'IS_REACTION', resolution: { kind: 'out-of-scope' } })
    expect(await service.plan({ ...req, typeId: 34 })).toMatchObject({ ok: false, code: 'NOT_MANUFACTURABLE' })
    expect(await service.plan({ ...req, typeId: RAVEN, activity: 'reaction' })).toMatchObject({ ok: false, code: 'OUT_OF_SCOPE' })
    expect(await service.plan({ ...req, typeId: 999_999_999 })).toMatchObject({ ok: false, code: 'ITEM_NOT_FOUND' })
  })

  it('data not loaded yet', async () => {
    const env = setup()
    const notReady = { current: () => { throw new DataNotReadyError() } }
    const service = createIndustryService({
      data: notReady, items: env.items, markets: env.markets, prices: env.prices, locations: env.locations, indices: env.indices,
      settings: env.settings.industry, clock: { now: () => Date.now() }, scheduler: { timeout: () => () => undefined },
    })
    const req = { typeId: RAVEN, activity: 'manufacturing' as const, mode: 'base' as const, materials: false, access: ALLOWED }
    expect(await service.plan(req)).toMatchObject({ ok: false, code: 'DATA_NOT_READY' })
    expect(await service.compare(req)).toMatchObject({ ok: false, code: 'DATA_NOT_READY' })
  })
})

describe('IndustryService: advanced result', () => {
  it('location given: defaults for the rest, golden vector 1 materials, job cost, profit', async () => {
    const { run } = setup()
    const r = result(await run('乌鸦级 XX-1'))
    // §6.7.12 第 1 个向量：Sotiyo、XL 舰船改装件 T1、00、ME10
    expect(quantities(r)).toEqual({
      34: 4_438_606, 35: 2_219_303, 36: 332_896, 37: 110_966, 38: 13_316, 39: 3_329, 40: 1_665, 57486: 65, 57478: 129, 57479: 1,
    })
    expect(r.timeSeconds).toBe(5_846)
    expect(r.applied).toEqual({
      location: 'XX-1', systemId: NIH_02, secClass: 'null', structure: '大厂', structureBonus: { me: -1, te: -30, cost: -5 },
      rigs: [{ item: expect.objectContaining({ typeId: XL_SHIP_I, zh: '屹立超大型舰船制造效率 I' }), me: -4.2, te: -42, cost: 0 }],
      me: 10, te: 20, sci: 0.02, facilityTaxPct: 1, sccPct: 4,
      defaulted: ['me', 'te', 'structure', 'rigs', 'tax'], rigState: 'applied',
    })
    expect(r.materialCost).toBe(138_298_834)
    // EIV 138,275,000 × 2% = 2,765,500；Sotiyo 费用 -5%；设施税 1%；SCC 4%
    expect(r.jobCost).toEqual({
      eiv: 138_275_000, grossSci: 2_765_500, bonuses: -138_275, facility: 1_382_750, scc: 5_531_000, extra: 0, total: 9_540_975, missingAdjusted: 0,
    })
    expect(r.profit!.value).toBeCloseTo(258_400_000 - 138_298_834 - 9_540_975, 6)
    expect(r.profit!.marginPct).toBeCloseTo(42.786, 3)
    expect(r.indicesAt).toBe(INDICES_TIME)
    expect(r.warnings).toEqual([])
  })

  it('written ME/TE, structure, rigs and tax are not defaulted', async () => {
    const { run } = setup()
    const r = result(await run('乌鸦级 XX-1 ME10 TE20 建筑:大厂 改装:默认 税:2%'))
    expect(r.applied).toMatchObject({ me: 10, te: 20, structure: '大厂', facilityTaxPct: 2, defaulted: [] })
    expect(r.jobCost).toMatchObject({ facility: 2_765_500 })
  })

  it('no rigs, no structure (NPC tax), another structure with an extra fee', async () => {
    const { run } = setup()
    const noRigs = result(await run('乌鸦级 XX-1 ME10 TE20 改装:无'))
    expect(noRigs.applied.rigs).toEqual([])
    expect(noRigs.timeSeconds).toBe(18_000 * 0.8 * 0.7)
    expect(noRigs.applied.defaulted).toEqual(['structure', 'tax'])

    const none = result(await run('乌鸦级 XX-1 ME10 TE20 建筑:无'))
    expect(none.applied.structure).toBeUndefined()
    expect(none.applied).toMatchObject({ rigs: [], facilityTaxPct: 0.25, defaulted: ['tax'] })
    expect(quantities(none)[34]).toBe(4_680_000)
    expect(none.jobCost).toMatchObject({ grossSci: 2_765_500, bonuses: 0, facility: 345_688, scc: 5_531_000 })

    const small = result(await run('乌鸦级 XX-1 ME10 TE20 建筑:小厂'))
    expect(small.applied).toMatchObject({ structure: '小厂', rigs: [], facilityTaxPct: 0.5 })
    // 其他费用：EIV 的 1% + 每个工作 1,000 ISK
    expect(small.jobCost).toMatchObject({ extra: 1_382_750 + 1000, extraLabel: '联盟附加费' })
    // 按建筑类型的名字也认
    expect(result(await run('乌鸦级 XX-1 ME10 TE20 建筑:Azbel')).applied.structure).toBe('小厂')
  })

  it('the only structure for the activity is chosen; the location default ME/TE is used', async () => {
    const { run } = setup()
    const r = result(await run('乌鸦级 联盟工业点A'))
    expect(r.applied).toMatchObject({ location: '联盟工业点A', secClass: 'low', structure: '反应塔', me: 8, te: 16, sci: 0.01, facilityTaxPct: 2 })
    // 反应改装件对乌鸦级不生效
    expect(r.applied.rigs).toEqual([])
    // T2 产品的默认 ME/TE 是发明出来的拷贝常见的 2/4，不是地点的 10/20
    const t2 = result(await run('Damage Control II XX-1'))
    expect(t2.applied).toMatchObject({ me: 2, te: 4 })
  })

  it('a reaction: no ME/TE, refinery and reactor rig, reaction index', async () => {
    const { run } = setup()
    const r = result(await run('碳化钨 联盟工业点A', ALLOWED, 'reaction'))
    expect(r.applied).toMatchObject({
      location: '联盟工业点A', structure: '反应塔', me: 0, te: 0, sci: 0.015,
      rigs: [{ item: expect.objectContaining({ typeId: COMPOSITE_TE_I }), me: 0, te: -20, cost: 0 }],
      defaulted: ['structure', 'rigs', 'tax'],
    })
    // 10,800 秒 × 改装件 0.8（低安 1.0）；阿塔诺没有加成
    expect(r.timeSeconds).toBe(8_640)
    expect(r.timeSecondsMaxSkill).toBe(Math.round(8_640 * 0.8))
  })

  it('missing prices are never zero; the fallback market is marked', async () => {
    const env = setup()
    env.prices.books.get(JITA_KEY)!.delete(57479)
    const r = result(await env.run('乌鸦级 XX-1'))
    expect(r.missingPrices).toBe(1)
    expect(r.materialCost).toBe(138_298_834 - 3_200_000)
    expect(r.materials.at(-1)).toMatchObject({ item: { typeId: 57479 }, unit: null, total: null })

    const fb = setup({ industry: { ...INDUSTRY, fallbackMarket: 'Amarr' } })
    fb.prices.books.get(JITA_KEY)!.delete(57479)
    fb.prices.set('amarr', { 57479: 3_300_000 })
    const r2 = result(await fb.run('乌鸦级 XX-1'))
    expect(r2.missingPrices).toBe(0)
    expect(r2.materials.find((m) => m.item.typeId === 57479)).toMatchObject({ unit: 3_300_000, total: 3_300_000, fallback: true })
    expect(r2.materialPrices).toEqual({ marketKey: JITA_KEY, side: 'sell', fallbackKey: 'amarr' })
    expect(fb.prices.calls.filter((c) => c.market === 'amarr')).toEqual([{ market: 'amarr', typeIds: [57479] }])
  })

  it('a whole market that is unavailable: say so, use the fallback market or mark the cost incomplete', async () => {
    const raw = { markets: undefined, industry: { ...INDUSTRY, materialMarket: '联盟市场A' } }
    const markets = { markets: [...(await import('../../../src/config/presets')).PRESET_MARKETS, ...STRUCTURE_ROWS] }
    const env = setup({ ...raw, ...markets })
    env.prices.status.set('联盟市场a', { status: 'auth_error', reason: 'auth' })
    const r = result(await env.run('乌鸦级 XX-1'))
    expect(r.missingPrices).toBe(10)
    expect(r.materialCost).toBe(0)
    expect(r.materialPrices).toEqual({ marketKey: '联盟市场a', side: 'sell', unavailable: true })
    expect(r.warnings).toEqual(['材料市场 联盟市场A 暂时不可用，材料成本不完整'])
    // 不能用的市场不去要报价
    expect(env.prices.calls.map((c) => c.market)).not.toContain('联盟市场a')

    const fb = setup({ ...markets, industry: { ...INDUSTRY, materialMarket: '联盟市场A', fallbackMarket: 'Jita' } })
    fb.prices.status.set('联盟市场a', { status: 'auth_error', reason: 'auth' })
    const r2 = result(await fb.run('乌鸦级 XX-1'))
    expect(r2.missingPrices).toBe(0)
    expect(r2.materialCost).toBe(138_298_834)
    expect(r2.materials.every((m) => m.fallback)).toBe(true)
    expect(r2.materialPrices).toEqual({ marketKey: '联盟市场a', side: 'sell', unavailable: true, fallbackKey: JITA_KEY })
    expect(r2.warnings).toEqual(['材料市场 联盟市场A 暂时不可用，改用 Jita 4-4（标 †）'])
    // 群里看不到的市场悄悄改用基准市场
    const hidden = result(await fb.run('乌鸦级 联盟工业点A', PUBLIC))
    expect(hidden.materialPrices).toEqual({ marketKey: JITA_KEY, side: 'sell' })
  })

  it('product value at the configured market and side, sell fees, no value → no profit', async () => {
    const env = setup({ industry: { ...INDUSTRY, productPriceType: 'buy', sellFeesPct: 5 } })
    env.prices.set(JITA_KEY, { [RAVEN]: { sell: 258_400_000, buy: 250_000_000 } })
    const r = result(await env.run('乌鸦级 XX-1'))
    expect(r.productValue).toEqual({ marketKey: JITA_KEY, side: 'buy', unit: 250_000_000, total: 250_000_000 })
    expect(r.profit!.value).toBeCloseTo(250_000_000 - 138_298_834 - 9_540_975 - 12_500_000, 6)

    const none = setup()
    none.prices.books.get(JITA_KEY)!.delete(RAVEN)
    const r2 = result(await none.run('乌鸦级 XX-1'))
    expect(r2.productValue).toEqual({ marketKey: JITA_KEY, side: 'sell', unit: null, total: null })
    expect(r2.profit).toBeNull()
  })

  it('index and adjusted prices: missing system, missing adjusted price, unavailable lists', async () => {
    const notListed = setup({}, new FakeIndices({ systems: {}, adjusted: ADJUSTED }))
    const r = result(await notListed.run('乌鸦级 XX-1'))
    expect(r.applied.sci).toBe(0)
    expect(r.jobCost).toMatchObject({ grossSci: 0, bonuses: 0 })
    expect(r.warnings).toEqual(['NIH-02 不在星系成本指数列表里，安装费用按指数 0 计算'])

    const { 57479: _, ...partial } = ADJUSTED
    const missing = setup({}, new FakeIndices({ systems: { [NIH_02]: { manufacturing: 0.02 } }, adjusted: partial }))
    const r2 = result(await missing.run('乌鸦级 XX-1'))
    expect(r2.jobCost).toMatchObject({ eiv: 138_275_000 - 350_000, missingAdjusted: 1 })
    expect(r2.warnings).toEqual(['部分材料缺少调整价，安装费偏低'])

    const noIndices = setup({}, new FakeIndices({ systems: UNAVAILABLE, adjusted: ADJUSTED }))
    const r3 = result(await noIndices.run('乌鸦级 XX-1'))
    expect(r3.applied.sci).toBeUndefined()
    expect(r3.indicesAt).toBeUndefined()
    expect(r3.jobCost).toMatchObject({ grossSci: 0, facility: 1_382_750 })
    expect(r3.warnings).toEqual(['星系成本指数暂时取不到，安装费用没有计入星系成本指数（偏低）'])

    const noAdjusted = setup({}, new FakeIndices({ systems: { [NIH_02]: { manufacturing: 0.02 } }, adjusted: UNAVAILABLE }))
    const r4 = result(await noAdjusted.run('乌鸦级 XX-1'))
    expect(r4.jobCost).toBeUndefined()
    expect(r4.applied).toMatchObject({ sci: 0.02, facilityTaxPct: 1, sccPct: 4 })
    expect(r4.warnings).toEqual(['调整价暂时取不到，安装费用、设施税和 SCC 附加费没有计入'])
  })

  it('SCC surcharge and NPC facility tax come from the console', async () => {
    const { run } = setup({ industry: { ...INDUSTRY, sccSurchargePct: 5, npcFacilityTaxPct: 1 } })
    const r = result(await run('乌鸦级 XX-1 建筑:无'))
    expect(r.applied).toMatchObject({ sccPct: 5, facilityTaxPct: 1 })
    expect(r.jobCost).toMatchObject({ scc: 6_913_750, facility: 1_382_750 })
  })
})

describe('IndustryService: locations and failures', () => {
  it('lists the locations the group can use, by activity', () => {
    const { service } = setup()
    expect(service.locations(ALLOWED)).toEqual([
      { name: 'XX-1', isDefault: true }, { name: '联盟工业点A', isDefault: false }, { name: 'XX-2', isDefault: false },
    ])
    expect(service.locations(PUBLIC).map((l) => l.name)).toEqual(['联盟工业点A', 'XX-2'])
    expect(service.locations(ALLOWED, 'reaction').map((l) => l.name)).toEqual(['联盟工业点A'])
  })

  it('unknown or hidden location, highsec reaction, a location that cannot do the activity', async () => {
    const { service } = setup()
    const req = { typeId: RAVEN, activity: 'manufacturing' as const, mode: 'advanced' as const, materials: false }
    expect(await service.plan({ ...req, location: 'XX-1', access: PUBLIC })).toEqual({
      ok: false, code: 'UNKNOWN_LOCATION', token: 'XX-1', locations: ['联盟工业点A', 'XX-2'], message: 'XX-1 尚未配置为工业地点',
    })
    const reaction = { ...req, typeId: TUNGSTEN_CARBIDE, activity: 'reaction' as const, access: ALLOWED }
    expect(await service.plan({ ...reaction, location: 'XX-2' })).toMatchObject({
      ok: false, code: 'HIGHSEC_REACTION', token: 'XX-2', locations: ['联盟工业点A'],
    })
    expect(await service.plan({ ...reaction, location: 'XX-1' })).toMatchObject({
      ok: false, code: 'UNKNOWN_LOCATION', reason: 'activity', token: 'XX-1', locations: ['联盟工业点A'], message: 'XX-1 没有能反应的建筑',
    })
  })

  it('no location for this group', async () => {
    const { run } = setup({ industry: { locations: [{ name: 'XX-1', system: 'NIH-02' }] } })
    expect(failed(await run('乌鸦级 高级', PUBLIC))).toMatchObject({ code: 'NOT_CONFIGURED', locations: [] })
  })
})

describe('IndustryService: steps (location → ME/TE → structure)', () => {
  it('step 1: location, with the system index; the default location runs the rest by default', async () => {
    const { run } = setup()
    const s = step(await run('乌鸦级 高级'))
    expect(s).toEqual({
      step: 'location',
      options: [
        { label: 'XX-1', detail: '00 · 大厂 · 星系成本指数 2.00%', command: '乌鸦级 XX-1 高级' },
        { label: '联盟工业点A', detail: '低安 · 反应塔 · 星系成本指数 1.00%', command: '乌鸦级 联盟工业点A 高级' },
        { label: 'XX-2', detail: '高安 · 无建筑加成', command: '乌鸦级 XX-2 高级' },
      ],
      summary: [],
      defaults: '乌鸦级 XX-1',
    })
    // 数量、ME/TE、改装件、税、材料都带着；地点看不到的群里没有「其余默认」
    const p = step(await run('乌鸦级*10 ME5 TE10 改装:无 税:1% 高级 材料', PUBLIC))
    expect(p.options.map((o) => o.command)).toEqual([
      '乌鸦级*10 联盟工业点A ME5 TE10 改装:无 税:1% 高级 材料',
      '乌鸦级*10 XX-2 ME5 TE10 改装:无 税:1% 高级 材料',
    ])
    expect(p.summary).toEqual(['ME 5', 'TE 10', '数量 10', '不用改装件', '设施税 1%'])
    expect(p.defaults).toBeUndefined()
  })

  it('a single visible location is chosen without asking', async () => {
    const { run } = setup({ industry: { locations: [{ name: 'XX-2', system: 'Jita', visibility: 'public' }] } })
    const s = step(await run('乌鸦级 高级', PUBLIC))
    expect(s).toMatchObject({ step: 'mete', summary: ['XX-2（本群唯一的地点）'] })
  })

  it('step 2: ME/TE pairs from the console, T2 pairs for T2, a custom entry and the defaults', async () => {
    const { run } = setup()
    const s = step(await run('乌鸦级 XX-1 高级'))
    expect(s).toEqual({
      step: 'mete',
      options: [
        { label: 'ME10/TE20', button: '10/20', command: '乌鸦级 XX-1 ME10 TE20 高级' },
        { label: 'ME5/TE10', button: '5/10', command: '乌鸦级 XX-1 ME5 TE10 高级' },
        { label: 'ME0/TE0', button: '0/0', command: '乌鸦级 XX-1 ME0 TE0 高级' },
      ],
      summary: ['XX-1'],
      defaults: '乌鸦级 XX-1',
      custom: '乌鸦级 XX-1 高级 ME',
    })
    const t2 = step(await run('Damage Control II XX-1 高级'))
    expect(t2.options.map((o) => o.label)).toEqual(['ME2/TE4', 'ME3/TE6', 'ME4/TE8'])
    expect(t2.options[0].command).toBe('损伤控制 II XX-1 ME2 TE4 高级')
    const custom = setup({ industry: { ...INDUSTRY, meTeChoices: '10/20, 8/16' } })
    expect(step(await custom.run('乌鸦级 XX-1 高级')).options.map((o) => o.label)).toEqual(['ME10/TE20', 'ME8/TE16'])
    // 「修改ME/TE」：建筑、改装件、税照样带着
    const keep = step(await run('乌鸦级 XX-1 建筑:大厂 改装:默认 税:1% 高级'))
    expect(keep.options[0].command).toBe('乌鸦级 XX-1 ME10 TE20 建筑:大厂 改装:默认 税:1% 高级')
  })

  it('step 3: structure, only when there are two or more; 建筑:? lists them all; an unknown name asks again', async () => {
    const { run } = setup()
    const s = step(await run('乌鸦级 XX-1 ME10 TE20 高级'))
    expect(s).toEqual({
      step: 'structure',
      options: [
        { label: '大厂', detail: '材料 -1%，时间 -30%，费用 -5% · 改装件 屹立超大型舰船制造效率 I', command: '乌鸦级 XX-1 ME10 TE20 建筑:大厂' },
        { label: '小厂', detail: '材料 -1%，时间 -20%，费用 -4% · 没有装改装件', command: '乌鸦级 XX-1 ME10 TE20 建筑:小厂' },
      ],
      summary: ['XX-1', 'ME 10', 'TE 20'],
      defaults: '乌鸦级 XX-1 ME10 TE20',
    })
    // 「建筑:?」（不是高级模式也行）列出全部，包括「无建筑加成」
    const list = step(await run('乌鸦级 XX-1 ME10 TE20 建筑:?'))
    expect(list.options.map((o) => o.label)).toEqual(['大厂', '小厂', '无建筑加成'])
    expect(list.options[2]).toEqual({ label: '无建筑加成', detail: '按 NPC 空间站算 · 设施税 0.25%', command: '乌鸦级 XX-1 ME10 TE20 建筑:无' })
    const unknown = step(await run('乌鸦级 XX-1 ME10 TE20 建筑:不存在'))
    expect(unknown).toMatchObject({ step: 'structure', notice: 'XX-1 没有叫「不存在」的建筑，请重新选择' })
    expect(unknown.options.map((o) => o.label)).toEqual(['大厂', '小厂', '无建筑加成'])
    // 只有一座建筑的地点：「建筑:?」照样能选「无建筑加成」
    const one = step(await run('乌鸦级 联盟工业点A 建筑:?'))
    expect(one.options.map((o) => o.label)).toEqual(['反应塔', '无建筑加成'])
    // 改装件不用时写明
    const noRigs = step(await run('乌鸦级 XX-1 ME10 TE20 改装:无 高级'))
    expect(noRigs.options[0].detail).toBe('材料 -1%，时间 -30%，费用 -5% · 不用改装件')
    expect(noRigs.options[0].command).toBe('乌鸦级 XX-1 ME10 TE20 建筑:大厂 改装:无')
  })

  it('a rig that does not apply to the product is named as such', async () => {
    const { run } = setup()
    const s = step(await run('损伤控制 II XX-1 ME2 TE4 高级'))
    expect(s.options[0].detail).toBe('材料 -1%，时间 -30%，费用 -5% · 没有对损伤控制 II生效的改装件')
  })

  it('a reaction goes location → structure, without ME/TE', async () => {
    const two = {
      ...INDUSTRY,
      structures: [
        ...INDUSTRY.structures,
        { location: '联盟工业点A', name: '大反应塔', structureType: 'Tatara', activities: 'reaction', facilityTaxPct: 3 },
      ],
    }
    const { run } = setup({ industry: two })
    const s = step(await run('碳化钨 高级', ALLOWED, 'reaction'))
    expect(s).toMatchObject({ step: 'structure', summary: ['联盟工业点A（本群唯一的地点）'] })
    expect(s.options).toEqual([
      { label: '反应塔', detail: '没有建筑加成 · 改装件 屹立中型复合反应堆时间效率 I', command: '碳化钨 联盟工业点A 建筑:反应塔' },
      { label: '大反应塔', detail: '时间 -25% · 没有装改装件', command: '碳化钨 联盟工业点A 建筑:大反应塔' },
    ])
    const r = result(await run(s.options[1].command, ALLOWED, 'reaction'))
    expect(r.applied).toMatchObject({ structure: '大反应塔', facilityTaxPct: 3 })
    expect(r.timeSeconds).toBe(10_800 * 0.75)
  })

  it('every option is a complete command: clicking through gives the result', async () => {
    const { run } = setup()
    const first = step(await run('乌鸦级*2 高级'))
    const second = step(await run(first.options[0].command))
    expect(second.step).toBe('mete')
    const third = step(await run(second.options[0].command))
    expect(third.step).toBe('structure')
    const r = result(await run(third.options[0].command))
    expect(r).toMatchObject({ runs: 2, applied: { location: 'XX-1', structure: '大厂', me: 10, te: 20, defaulted: ['rigs', 'tax'] } })
    // 「其余默认」直接出结果
    expect(result(await run(first.defaults!))).toMatchObject({ applied: { location: 'XX-1', structure: '大厂' } })
    expect(result(await run(second.defaults!))).toMatchObject({ applied: { me: 10, te: 20 } })
    // 「自定义」补上数字
    expect(step(await run(`${second.custom!}7 TE14`))).toMatchObject({ step: 'structure', summary: ['XX-1', 'ME 7', 'TE 14', '数量 2'] })
  })
})

describe('IndustryService: compare locations', () => {
  it('every visible location with its own structure, rigs, tax and index; sorted by total cost', async () => {
    const env = setup()
    const c = await env.service.compare({ typeId: RAVEN, activity: 'manufacturing', materials: false, access: ALLOWED }) as LocationComparison
    expect(isFailure(c)).toBe(false)
    expect(c).toMatchObject({ product: { typeId: RAVEN }, runs: 1, me: 10, te: 20, materialMarketKey: JITA_KEY, materialSide: 'sell' })
    const total = (r: IndustryResult) => r.materialCost + (r.jobCost?.total ?? 0)
    expect(c.rows.map((r) => [r.location, r.structure, r.noRigs, r.cheapest, r.fastest])).toEqual([
      ['XX-1', '大厂', false, true, true],
      // XX-2 没有建筑：按 NPC 空间站的设施税 0.25%，表里也没有它的星系成本指数
      ['XX-2', undefined, true, false, false],
      ['联盟工业点A', '反应塔', true, false, false],
    ])
    const totals = c.rows.map((r) => total(r.result))
    expect([...totals].sort((a, b) => a - b)).toEqual(totals)
    expect(c.rows[0].result.applied).toMatchObject({ me: 10, te: 20, defaulted: ['me', 'te', 'structure', 'rigs', 'tax'] })
    expect(c.rows[1].result.warnings).toEqual(['吉他 不在星系成本指数列表里，安装费用按指数 0 计算'])
    // 星系成本指数、调整价、材料报价都只取一次
    expect([env.indices.systemCalls, env.indices.adjustedCalls]).toEqual([1, 1])
    expect(env.prices.calls.filter((call) => call.typeIds.includes(34))).toHaveLength(1)
  })

  it('needs two locations; T2 defaults to ME 2 / TE 4', async () => {
    const one = setup({ industry: { locations: [{ name: 'XX-2', system: 'Jita', visibility: 'public' }] } })
    expect(await one.service.compare({ typeId: RAVEN, activity: 'manufacturing', materials: false, access: PUBLIC }))
      .toMatchObject({ ok: false, code: 'NOT_CONFIGURED', locations: ['XX-2'] })
    const { service } = setup()
    const t2 = await service.compare({ typeId: DAMAGE_CONTROL_II, activity: 'manufacturing', materials: false, access: PUBLIC }) as LocationComparison
    expect([t2.me, t2.te, t2.rows.length]).toEqual([2, 4, 2])
    const written = await service.compare({ typeId: RAVEN, activity: 'manufacturing', materials: false, access: PUBLIC, me: 5, te: 10, runs: 3 }) as LocationComparison
    expect([written.me, written.te, written.runs]).toEqual([5, 10, 3])
    expect(written.rows[0].result.applied.defaulted).not.toContain('me')
  })
})

describe('IndustryService: rigs, structures and data age reported to the cards', () => {
  it('rigState: applied, turned off, not installed, not applicable, impossible without a structure bonus', async () => {
    const { run } = setup()
    const state = async (text: string) => result(await run(text)).applied.rigState
    expect(await state('乌鸦级 XX-1')).toBe('applied')
    expect(await state('乌鸦级 XX-1 改装:无')).toBe('disabled')
    expect(await state('乌鸦级 XX-1 建筑:小厂')).toBe('not-installed')
    // XL 舰船改装件对装备不生效
    expect(await state('Damage Control II XX-1')).toBe('not-applicable')
    expect(await state('乌鸦级 XX-1 建筑:无')).toBe('impossible')
    // 基础参考没有地点，不给
    expect((result(await run('乌鸦级'))).applied.rigState).toBeUndefined()
  })

  it('structureBonus: the structure\'s own bonuses, none without a bonus', async () => {
    const { run } = setup()
    // 超级工厂造东西：材料 -1%、时间 -30%、费用 -5%
    expect(result(await run('乌鸦级 XX-1')).applied.structureBonus).toEqual({ me: -1, te: -30, cost: -5 })
    // 反应塔做反应、没有建筑、基础参考都没有
    expect(result(await run('碳化钨 联盟工业点A', ALLOWED, 'reaction')).applied.structureBonus).toBeUndefined()
    expect(result(await run('乌鸦级 XX-1 建筑:无')).applied.structureBonus).toBeUndefined()
    expect(result(await run('乌鸦级')).applied.structureBonus).toBeUndefined()
  })

  it('a structure picked because it is the only one is marked as such', async () => {
    const { run } = setup()
    const only = result(await run('乌鸦级 联盟工业点A'))
    expect(only.applied).toMatchObject({ structure: '反应塔', structureOnly: true })
    expect(only.applied.defaulted).toContain('structure')
    expect(result(await run('乌鸦级 XX-1')).applied.structureOnly).toBeUndefined()
  })

  it('a reaction with 建筑:无 asks for a refinery instead of running without one', async () => {
    const { run } = setup()
    const s = step(await run('碳化钨 联盟工业点A 建筑:无', ALLOWED, 'reaction'))
    expect(s).toMatchObject({ step: 'structure', notice: '反应只能在精炼厂里进行（不能用「建筑:无」），请选择建筑', summary: ['联盟工业点A'] })
    expect(s.options.map((o) => o.label)).toEqual(['反应塔'])
  })

  it('a structure written without a location is carried through the location step', async () => {
    const { run } = setup()
    const s = step(await run('乌鸦级 建筑:小厂'))
    expect(s.summary).toEqual(['建筑 小厂'])
    expect(s.options[0].command).toBe('乌鸦级 XX-1 建筑:小厂 高级')
    expect(s.defaults).toBe('乌鸦级 XX-1 建筑:小厂')
    expect(step(await run('乌鸦级 XX-1 建筑:小厂 高级')).summary).toEqual(['XX-1', '建筑 小厂'])
  })

  it('old system indices and adjusted prices are flagged', async () => {
    const indices = new FakeIndices({ systems: { [NIH_02]: { manufacturing: 0.02 } }, adjusted: ADJUSTED, stale: { indices: true, adjusted: true } })
    const r = result(await setup({}, indices).run('乌鸦级 XX-1'))
    expect(r).toMatchObject({ indicesAt: INDICES_TIME, indicesStale: true, adjustedPricesAt: INDICES_TIME, adjustedStale: true })
    const fresh = result(await setup().run('乌鸦级 XX-1'))
    expect(fresh.indicesStale).toBeUndefined()
    expect(fresh.adjustedStale).toBeUndefined()
    expect(fresh.adjustedPricesAt).toBe(INDICES_TIME)
  })

  it('compare: 改装:无 and 税: apply to every location and are reported once', async () => {
    const { service } = setup()
    const c = await service.compare({ typeId: RAVEN, activity: 'manufacturing', materials: false, access: ALLOWED, rigs: 'none', facilityTaxPct: 3 }) as LocationComparison
    expect([c.rigsOff, c.facilityTaxPct]).toEqual([true, 3])
    expect(c.rows.map((r) => r.result.applied.facilityTaxPct)).toEqual([3, 3, 3])
    expect(c.rows.every((r) => !r.result.applied.defaulted.includes('tax') && !r.result.applied.rigs.length)).toBe(true)
    const plain = await service.compare({ typeId: RAVEN, activity: 'manufacturing', materials: false, access: ALLOWED }) as LocationComparison
    expect([plain.rigsOff, plain.facilityTaxPct]).toEqual([undefined, undefined])
  })
})

describe('IndustryService: multibuy', () => {
  it('English names and a Tab by default, in the order of the material list', async () => {
    const { run, service } = setup()
    const r = result(await run('乌鸦级 XX-1'))
    expect(service.multibuy(r)).toEqual([[
      'Pyerite\t2219303', 'Mexallon\t332896', 'Isogen\t110966', 'Tritanium\t4438606', 'Nocxium\t13316', 'Zydrine\t3329',
      'Megacyte\t1665', 'Core Temperature Regulator\t1', 'Life Support Backup Unit\t65', 'Auto-Integrity Preservation Seal\t129',
    ].join('\n')])
  })

  it('Chinese names when the console says so', async () => {
    const { run, service } = setup({ industry: { ...INDUSTRY, multibuyLanguage: 'zh' } })
    const blocks = service.multibuy(result(await run('乌鸦级')))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].split('\n')[0]).toBe('类晶体胶矿\t2600000')
  })

  it('cuts long lists between lines', async () => {
    const { run } = setup()
    const r = result(await run('乌鸦级'))
    const blocks = multibuyBlocks(r, { maxChars: 40 })
    expect(blocks.length).toBeGreaterThan(1)
    expect(blocks.every((b) => b.length <= 40)).toBe(true)
    expect(blocks.join('\n').split('\n')).toHaveLength(10)
    expect(chunkLines(['a'.repeat(50), 'b'], 10)).toEqual(['a'.repeat(50), 'b'])
    expect(chunkLines([], 10)).toEqual([])
  })
})
