// §6.7.12 的黄金向量走一遍完整的服务（解析命令 → 地点和建筑 → 修正 → 材料、时间、安装费用）。
// 数据用插件自带的快照；调整价和星系成本指数来自 eve-ref 的测试源码（MIT-0，经游戏截图验证），星系成本指数用完整精度。
// 地点名、建筑名是编造的；星系用公共星系（NIH-02 是 00、Tama 低安）。

import { describe, expect, it } from 'vitest'
import { isFailure } from '../../../src/core/types'
import type { CoreFailure, IndustryActivity, IndustryResult, IndustryStep } from '../../../src/core/types'
import { loadSnapshotData } from '../../fixtures/data/load'
import { ALLOWED, FakeIndices, FakePrices, makeService } from './service-fakes'

const NIH_02 = 30000900
const TAMA = 30002813

const data = loadSnapshotData()

function result(r: IndustryResult | IndustryStep | CoreFailure): IndustryResult {
  if (isFailure(r)) throw new Error(`应该出结果，实际是 ${r.code}（${r.message ?? r.reason ?? ''}）`)
  if ('step' in r) throw new Error(`应该出结果，实际是第「${r.step}」步`)
  return r
}

const quantities = (r: IndustryResult) => Object.fromEntries(r.materials.map((m) => [m.item.typeId, m.quantity]))

function env(industry: Record<string, unknown>, indices: FakeIndices) {
  const made = makeService({ industry }, { data, prices: new FakePrices(), indices })
  expect(made.issues).toEqual([])
  expect(made.locations.issues()).toEqual([])
  return async (text: string, activity: IndustryActivity = 'manufacturing') => {
    const req = made.parse(text, activity, ALLOWED)
    if (isFailure(req)) throw new Error(`「${text}」解析失败：${req.code}`)
    return result(await made.service.plan(req))
  }
}

describe('golden vector 1 through the service: Raven, Sotiyo, XL ship rig, nullsec', () => {
  const industry = (rig: number) => ({
    locations: [{ name: 'XX-1', system: 'NIH-02' }],
    structures: [{ location: 'XX-1', name: '大厂', structureType: 'Sotiyo', rigs: String(rig) }],
  })
  const indices = new FakeIndices({ systems: { [NIH_02]: { manufacturing: 0.0231 } } })

  it('T1 rig: multiplier 0.853578, 5,846 s; 10 runs keep one per run', async () => {
    const run = env(industry(37180), indices)
    const r = await run('乌鸦级 XX-1 ME10 TE20')
    expect(quantities(r)).toEqual({
      34: 4_438_606, 35: 2_219_303, 36: 332_896, 37: 110_966, 38: 13_316, 39: 3_329, 40: 1_665, 57486: 65, 57478: 129, 57479: 1,
    })
    expect(r.timeSeconds).toBe(5_846)
    expect(r.applied.rigs.map((x) => [x.item.en, x.me, x.te])).toEqual([['Standup XL-Set Ship Manufacturing Efficiency I', -4.2, -42]])
    expect(quantities(await run('乌鸦级 XX-1 ME10 TE20 10流程'))[57479]).toBe(10)
  })

  it('T2 rig: Nocxium 13,200, Tritanium 4,399,687, 5,000 s (the §2.6.4 card)', async () => {
    const run = env(industry(37181), indices)
    const r = await run('乌鸦级 XX-1 ME10 TE20')
    expect(quantities(r)).toMatchObject({ 34: 4_399_687, 35: 2_199_844, 38: 13_200 })
    expect(r.timeSeconds).toBe(5_000)
    expect(r.applied.rigs.map((x) => [x.me, x.te])).toEqual([[-5.04, -50.4]])
  })
})

describe('golden vector 2 through the service: Dominix, Sotiyo, lowsec, three rigs, -50%, tax 2%', () => {
  const run = env({
    locations: [{ name: 'XX-1', system: 'Tama', sysCostBonusPct: -50 }],
    structures: [{ location: 'XX-1', name: '大厂', structureType: 'Sotiyo', rigs: '45548, 37180, 37183', facilityTaxPct: 2 }],
  }, new FakeIndices({
    systems: { [TAMA]: { manufacturing: 0.07461088416212872945 } },
    adjusted: {
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
    },
  }))

  it('materials, job cost and time match the in-game window', async () => {
    const r = await run('Dominix XX-1 ME10 TE20')
    expect(r.product.en).toBe('Dominix')
    expect(quantities(r)).toEqual({
      34: 4_457_139, 35: 2_228_570, 36: 334_286, 37: 111_429, 38: 13_372, 39: 3_343, 40: 1_672, 57478: 129, 57479: 1, 57486: 65,
    })
    expect(r.jobCost).toEqual({
      eiv: 154_286_511, grossSci: 11_511_453, bonuses: -6_043_513, facility: 3_085_730, scc: 6_171_460, extra: 0, total: 14_725_130,
      missingAdjusted: 0,
    })
    expect(r.applied).toMatchObject({ secClass: 'low', facilityTaxPct: 2, sccPct: 4 })
    // 只有舰船改装件对战列舰生效
    expect(r.applied.rigs.map((x) => x.item.typeId)).toEqual([37180])
    expect(r.timeSecondsMaxSkill).toBe(4_250)
  })
})

describe('golden vector 3 through the service: Carbon Fiber reaction, 10 runs, Athanor, lowsec, tax 1.5%', () => {
  const run = env({
    locations: [{ name: '联盟工业点A', system: 'Tama' }],
    structures: [{ location: '联盟工业点A', name: '反应塔', structureType: 'Athanor', activities: 'reaction', rigs: '46487, 46485', facilityTaxPct: 1.5 }],
  }, new FakeIndices({
    systems: { [TAMA]: { reaction: 0.05909748985254271692 } },
    adjusted: { 4246: 17916.711094983475, 16633: 121.77992379543394, 16635: 396.2854648423164 },
  }))

  it('materials, job cost, time with Reactions IV', async () => {
    const r = await run('#57453 10流程 联盟工业点A', 'reaction')
    expect(r.blueprint.typeId).toBe(57490)
    expect(quantities(r)).toEqual({ 4246: 49, 16633: 976, 16635: 976 })
    expect(r.jobCost).toEqual({
      eiv: 1_413_901, grossSci: 83_558, bonuses: 0, facility: 21_209, scc: 56_556, extra: 0, total: 161_323, missingAdjusted: 0,
    })
    // 游戏窗口是 Reactions IV（每级 -4%）：68,947 秒
    expect(Math.round(r.timeSeconds * (1 - 4 * 0.04))).toBe(68_947)
  })
})
