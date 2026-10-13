// §6.7.12 的黄金向量：数据用插件自带的快照，调整价和星系成本指数来自 eve-ref 的测试源码（MIT-0，经游戏截图验证）。
// 星系成本指数用测试源码里的完整精度；ESI 的指数比游戏界面显示的位数多。

import { describe, expect, it } from 'vitest'
import {
  estimatedItemValue, FORMULA_DEFAULTS, jobCost, jobsCost, jobTime, materialMultiplier, planProduction, timeMultiplier,
} from '../../../src/core/industry/formulas'
import { jobModifiers } from '../../../src/core/industry/modifiers'
import type { IndustryActivity, SecClass } from '../../../src/core/types'
import { loadSnapshotData } from '../../fixtures/data/load'

const data = loadSnapshotData()
const { industry } = data

function item(id: number) {
  const row = data.types.rowOf(id)
  if (row < 0) throw new Error(`快照里没有 ${id}`)
  return data.types.item(row)
}

function mods(activity: IndustryActivity, productId: number, structureId: number, rigIds: number[], secClass: SecClass) {
  const structure = industry.structures.get(structureId)
  if (!structure) throw new Error(`快照里没有建筑 ${structureId}`)
  const rigs = rigIds.map((id) => {
    const rig = industry.rigs.get(id)
    if (!rig) throw new Error(`快照里没有改装件 ${id}`)
    return rig
  })
  return jobModifiers({ activity, product: item(productId), secClass, structure, rigs, filters: industry.filters })
}

function blueprintOf(activity: IndustryActivity, productId: number) {
  const bp = (activity === 'manufacturing' ? industry.manufacturing : industry.reactions).get(productId)
  if (!bp) throw new Error(`快照里没有 ${productId} 的蓝图`)
  return bp
}

const quantities = (plan: { materials: Array<{ typeId: number; quantity: number }> }) =>
  Object.fromEntries(plan.materials.map((m) => [m.typeId, m.quantity]))

const RAVEN = 638
const DOMINIX = 645
const CARBON_FIBER = 57453
const FULLERIDES = 16679
const SILICON_DIBORITE = 16658
const SOTIYO = 35827
const ATHANOR = 35835
const TATARA = 35836
const XL_SHIP_T1 = 37180
const XL_SHIP_T2 = 37181

describe('golden vector 1: Raven ME10, Sotiyo, XL ship rig, nullsec', () => {
  const t1 = mods('manufacturing', RAVEN, SOTIYO, [XL_SHIP_T1], 'null')
  const t2 = mods('manufacturing', RAVEN, SOTIYO, [XL_SHIP_T2], 'null')
  const bp = blueprintOf('manufacturing', RAVEN)
  const plan = (runs: number, m = t1) => planProduction({ activity: 'manufacturing', blueprint: bp, runs, techLevel: 1, me: 10, te: 20, mods: m })

  it('uses the blueprint from the data', () => {
    expect(bp).toMatchObject({ blueprintId: 688, time: 18000 })
  })

  it('material multiplier 0.853578 with the T1 rig', () => {
    expect(t1.rigs.me).toBeCloseTo(1 - 0.02 * 2.1, 12)
    expect(materialMultiplier('manufacturing', 10, t1)).toBeCloseTo(0.853578, 12)
    expect(t1.applied).toEqual([{ rigId: XL_SHIP_T1, me: -4.2, te: -42, cost: 0 }])
  })

  it('materials for 1 run', () => {
    expect(quantities(plan(1))).toEqual({
      34: 4_438_606, 35: 2_219_303, 36: 332_896, 37: 110_966, 38: 13_316, 39: 3_329, 40: 1_665,
      57486: 65, 57478: 129, 57479: 1,
    })
  })

  it('10 runs never go below one per run (ceil(8.54) = 9 < 10)', () => {
    expect(quantities(plan(10))[57479]).toBe(10)
  })

  it('T2 rig: multiplier 0.8460936, Nocxium 13,200', () => {
    expect(materialMultiplier('manufacturing', 10, t2)).toBeCloseTo(0.8460936, 12)
    const q = quantities(plan(1, t2))
    expect(q[38]).toBe(13_200)
    // §2.6.4、§2.6.5 的示例数字
    expect(q[34]).toBe(4_399_687)
    expect(q[35]).toBe(2_199_844)
    expect(t2.applied).toEqual([{ rigId: XL_SHIP_T2, me: -5.04, te: -50.4, cost: 0 }])
  })

  it('time TE20 without skills: 5,846 s (T1 rig), 5,000 s (T2 rig)', () => {
    expect(plan(1).timeSeconds).toBe(5_846)
    expect(plan(1, t2).timeSeconds).toBe(5_000)
  })
})

describe('golden vector 2: Dominix ME10/TE20, Sotiyo, lowsec, three rigs, -50% system bonus', () => {
  // eve-ref dominix-lowsec-sotiyo-rigs
  const ADJUSTED: Record<number, number> = {
    34: 3.1582815355153264,
    35: 13.71620754125981,
    36: 57.73870895220159,
    37: 323.9092640928271,
    38: 1165.0984652320872,
    39: 2890.189326344159,
    40: 2730.496905881359,
    57478: 10471.19336143108,
    57479: 348856.3350660349,
    57486: 11783.038367441452,
  }
  const SCI = 0.07461088416212872945
  const m = mods('manufacturing', DOMINIX, SOTIYO, [45548, XL_SHIP_T1, 37183], 'low')
  const bp = blueprintOf('manufacturing', DOMINIX)
  const plan = planProduction({ activity: 'manufacturing', blueprint: bp, runs: 1, techLevel: 1, me: 10, te: 20, mods: m })
  const params = { sci: SCI, mods: m, sysCostBonusPct: -50, facilityTaxPct: 2, sccSurchargePct: FORMULA_DEFAULTS.sccSurchargePct }

  it('only the ship rig applies to a battleship', () => {
    expect(m.applied.map((r) => r.rigId)).toEqual([XL_SHIP_T1])
    expect(m.applied[0]).toEqual({ rigId: XL_SHIP_T1, me: -3.8, te: -38, cost: 0 })
    expect(m.rigs.cost).toBe(1)
    expect(m.structure).toEqual({ me: 0.99, te: 0.7, cost: 0.95 })
  })

  it('materials match the in-game window', () => {
    expect(quantities(plan)).toEqual({
      34: 4_457_139, 35: 2_228_570, 36: 334_286, 37: 111_429, 38: 13_372, 39: 3_343, 40: 1_672,
      57478: 129, 57479: 1, 57486: 65,
    })
  })

  it('job cost breakdown', () => {
    const { eiv, missing } = estimatedItemValue(bp.materials, 1, (id) => ADJUSTED[id])
    expect(missing).toEqual([])
    expect(eiv).toBe(154_286_511)
    expect(jobCost(eiv, params)).toEqual({
      eiv: 154_286_511,
      grossSci: 11_511_453,
      bonuses: -6_043_513,
      facility: 3_085_730,
      scc: 6_171_460,
      extra: 0,
      total: 14_725_130,
    })
    expect(jobsCost(bp.materials, plan.jobs, (id) => ADJUSTED[id], params)).toMatchObject({ total: 14_725_130, missingAdjusted: [] })
  })

  it('the 7-digit index shown in game is 1–2 ISK off', () => {
    const shown = jobCost(154_286_511, { ...params, sci: 0.0746109 })
    expect(shown.grossSci).toBe(11_511_455)
    expect(Math.abs(shown.total - 14_725_130)).toBeLessThanOrEqual(2)
  })

  it('time with skills at V: 4,250 s', () => {
    expect(plan.timeSecondsMaxSkill).toBe(4_250)
    expect(jobTime(bp.time, 1, timeMultiplier('manufacturing', 20, m), 0.68)).toBe(4_250)
  })
})

describe('golden vector 3: Carbon Fiber reaction, 10 runs, Athanor, lowsec, reactor rigs', () => {
  // eve-ref carbon-fiber-reaction-formula-athanor-rigs
  const ADJUSTED: Record<number, number> = {
    4246: 17916.711094983475,
    16633: 121.77992379543394,
    16635: 396.2854648423164,
  }
  const SCI = 0.05909748985254271692
  const m = mods('reaction', CARBON_FIBER, ATHANOR, [46487, 46485], 'low')
  const bp = blueprintOf('reaction', CARBON_FIBER)
  // 反应没有 ME/TE：传进来的 10/20 不起作用
  const plan = planProduction({ activity: 'reaction', blueprint: bp, runs: 10, techLevel: null, me: 10, te: 20, mods: m })

  it('materials', () => {
    expect(bp.blueprintId).toBe(57490)
    expect(quantities(plan)).toEqual({ 4246: 49, 16633: 976, 16635: 976 })
  })

  it('job cost breakdown', () => {
    const cost = jobsCost(bp.materials, plan.jobs, (id) => ADJUSTED[id], {
      sci: SCI, mods: m, sysCostBonusPct: 0, facilityTaxPct: 1.5, sccSurchargePct: FORMULA_DEFAULTS.sccSurchargePct,
    })
    expect(cost).toEqual({
      eiv: 1_413_901,
      grossSci: 83_558,
      bonuses: 0,
      facility: 21_209,
      scc: 56_556,
      extra: 0,
      total: 161_323,
      missingAdjusted: [],
    })
  })

  it('time with Reactions IV: 68,947 s', () => {
    expect(jobTime(bp.time, 10, plan.timeMultiplier, 1 - 4 * 0.04)).toBe(68_947)
  })
})

describe('golden vector 4: Silicon Diborite reaction, 1 run, Tatara, nullsec, L-set reactor efficiency I', () => {
  // 车主游戏截图（Tatara、00 -0.50）；调整价按截图里 EIV 136,191 对上，星系成本指数是游戏里的 3878/136191
  const ADJUSTED: Record<number, number> = { 4312: 17719.2, 16635: 168.6, 16636: 307.35 }
  const SCI = 3878 / 136_191
  const m = mods('reaction', SILICON_DIBORITE, TATARA, [46496], 'null')
  const bp = blueprintOf('reaction', SILICON_DIBORITE)
  const plan = planProduction({ activity: 'reaction', blueprint: bp, runs: 1, techLevel: null, me: 0, te: 0, mods: m })

  it('rig and materials', () => {
    expect(bp.blueprintId).toBe(46179)
    expect(m.applied).toEqual([{ rigId: 46496, me: -2.2, te: -22, cost: 0 }])
    expect(quantities(plan)).toEqual({ 4312: 5, 16635: 98, 16636: 98 })
  })

  it('job cost breakdown', () => {
    const cost = jobsCost(bp.materials, plan.jobs, (id) => ADJUSTED[id], {
      sci: SCI, mods: m, sysCostBonusPct: 0, facilityTaxPct: 0.2, sccSurchargePct: FORMULA_DEFAULTS.sccSurchargePct,
    })
    expect(cost).toEqual({
      eiv: 136_191,
      grossSci: 3_878,
      bonuses: 0,
      facility: 272,
      scc: 5_448,
      extra: 0,
      total: 9_598,
      missingAdjusted: [],
    })
  })

  it('the 4-digit index shown in game is 3 ISK off', () => {
    const shown = jobsCost(bp.materials, plan.jobs, (id) => ADJUSTED[id], {
      sci: 0.0285, mods: m, sysCostBonusPct: 0, facilityTaxPct: 0.2, sccSurchargePct: FORMULA_DEFAULTS.sccSurchargePct,
    })
    expect(shown.total).toBe(9_601)
  })

  it('time: 6,318 s un-skilled, 5,054 s with max skills (01:24:14)', () => {
    expect(plan.timeMultiplier).toBeCloseTo(0.585, 6)
    expect(plan.timeSeconds).toBe(6_318)
    expect(plan.timeSecondsMaxSkill).toBe(5_054)
  })
})

describe('worked examples in the command spec stay consistent', () => {
  it('Fullerides, 20 runs, Tatara, L-set reactor rig II, nullsec (§2.8)', () => {
    const m = mods('reaction', FULLERIDES, TATARA, [46497], 'null')
    expect(m.applied).toEqual([{ rigId: 46497, me: -2.64, te: -26.4, cost: 0 }])
    const bp = blueprintOf('reaction', FULLERIDES)
    const plan = planProduction({ activity: 'reaction', blueprint: bp, runs: 20, techLevel: null, me: 0, te: 0, mods: m })
    expect(quantities(plan)).toEqual({ 4051: 98, 16659: 1_948, 16662: 1_948 })
    expect(jobTime(bp.time, 1, plan.timeMultiplier)).toBe(5_962)
    // 共 33 小时 7 分
    expect(plan.timeSeconds).toBe(119_232)
  })
})
