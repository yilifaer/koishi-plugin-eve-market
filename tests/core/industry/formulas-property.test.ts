// 公式的性质：随机输入（固定种子，结果可复现）下 ME/TE 越高越省、数量不少于流程数、拆工作不丢流程、费用各项相加等于合计。

import { describe, expect, it } from 'vitest'
import { MAX_ME, MAX_TE } from '../../../src/constants'
import {
  estimatedItemValue, jobCost, jobTime, materialMultiplier, materialQuantity, splitJobs, timeMultiplier,
} from '../../../src/core/industry/formulas'
import type { ModifierSet } from '../../../src/core/industry/formulas'

/** mulberry32：小而稳定的伪随机数 */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CASES = 2000
const random = rng(20261007)
const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1))
const pick = <T>(list: readonly T[]) => list[int(0, list.length - 1)]

/** 数据里出现过的建筑系数和改装件百分比 × 安等倍率 */
const STRUCTURE_ME = [1, 0.99]
const STRUCTURE_TE = [1, 0.85, 0.8, 0.75, 0.7]
const RIG_PCT = [0, -2, -2.4, -3.7, -20, -24]
const SEC_MULT = [0.1, 1, 1.1, 1.9, 2.1]

function randomMods(): ModifierSet {
  const r = (pct: number) => 1 + pct / 100 * pick(SEC_MULT)
  return {
    structure: { me: pick(STRUCTURE_ME), te: pick(STRUCTURE_TE), cost: pick([1, 0.97, 0.96, 0.95]) },
    rigs: { me: r(pick(RIG_PCT.slice(0, 4))), te: r(pick([0, -20, -24])), cost: r(pick([0, -10, -12])) },
  }
}

const randomBase = () => pick([1, int(1, 10), int(10, 1000), int(1000, 10_000_000)])
const randomRuns = () => pick([1, int(1, 20), int(20, 10_000)])

describe('material quantity properties', () => {
  it('never below runs, never above runs × base', () => {
    for (let i = 0; i < CASES; i++) {
      const base = randomBase()
      const runs = randomRuns()
      const mult = materialMultiplier('manufacturing', int(0, MAX_ME), randomMods())
      const q = materialQuantity(base, runs, mult)
      expect(Number.isInteger(q)).toBe(true)
      expect(q).toBeGreaterThanOrEqual(runs)
      expect(q).toBeLessThanOrEqual(runs * base)
    }
  })

  it('a higher ME never needs more material', () => {
    for (let i = 0; i < CASES; i++) {
      const base = randomBase()
      const runs = randomRuns()
      const mods = randomMods()
      let previous = Infinity
      for (let me = 0; me <= MAX_ME; me++) {
        const q = materialQuantity(base, runs, materialMultiplier('manufacturing', me, mods))
        expect(q).toBeLessThanOrEqual(previous)
        previous = q
      }
    }
  })

  it('more runs never need less material', () => {
    for (let i = 0; i < CASES; i++) {
      const base = randomBase()
      const runs = randomRuns()
      const mult = materialMultiplier('manufacturing', int(0, MAX_ME), randomMods())
      expect(materialQuantity(base, runs + 1, mult)).toBeGreaterThanOrEqual(materialQuantity(base, runs, mult))
    }
  })

  it('base mode is exact', () => {
    const none: ModifierSet = { structure: { me: 1, te: 1, cost: 1 }, rigs: { me: 1, te: 1, cost: 1 } }
    for (let i = 0; i < CASES; i++) {
      const base = randomBase()
      const runs = randomRuns()
      expect(materialQuantity(base, runs, materialMultiplier('manufacturing', 0, none))).toBe(runs * base)
    }
  })

  it('reactions give the same quantity for any ME', () => {
    for (let i = 0; i < 200; i++) {
      const mods = randomMods()
      const base = randomBase()
      const runs = randomRuns()
      const q0 = materialQuantity(base, runs, materialMultiplier('reaction', 0, mods))
      expect(materialQuantity(base, runs, materialMultiplier('reaction', int(1, MAX_ME), mods))).toBe(q0)
    }
  })
})

describe('time properties', () => {
  it('a higher TE is never slower; skills never slow it down', () => {
    for (let i = 0; i < CASES; i++) {
      const baseTime = pick([60, int(60, 300_000)])
      const runs = randomRuns()
      const mods = randomMods()
      let previous = Infinity
      for (let te = 0; te <= MAX_TE; te += 2) {
        const mult = timeMultiplier('manufacturing', te, mods)
        const t = jobTime(baseTime, runs, mult)
        expect(t).toBeLessThanOrEqual(previous)
        expect(jobTime(baseTime, runs, mult, 0.68)).toBeLessThanOrEqual(t)
        previous = t
      }
    }
  })
})

describe('job split properties', () => {
  it('keeps every run, each job within the copy limit, all but the last full', () => {
    for (let i = 0; i < CASES; i++) {
      const runs = randomRuns()
      const maxRuns = pick([1, 10, int(1, 500)])
      const jobs = splitJobs(runs, maxRuns, 2)
      expect(jobs.reduce((a, b) => a + b, 0)).toBe(runs)
      expect(Math.max(...jobs)).toBeLessThanOrEqual(maxRuns)
      expect(jobs.length).toBe(Math.ceil(runs / maxRuns))
      expect(jobs.slice(0, -1).every((r) => r === maxRuns)).toBe(true)
      expect(splitJobs(runs, maxRuns, 1)).toEqual([runs])
    }
  })
})

describe('installation cost properties', () => {
  it('the parts add up; discounts never turn into surcharges; taxes grow with the rate', () => {
    for (let i = 0; i < CASES; i++) {
      const eiv = int(0, 50_000_000_000)
      const mods = randomMods()
      const params = {
        sci: random() * 0.15,
        mods,
        sysCostBonusPct: pick([0, -50]),
        facilityTaxPct: int(0, 100) / 10,
        sccSurchargePct: pick([0, 4]),
        extraFeePct: pick([0, 0.5]),
        extraFeeIsk: pick([0, 1_000_000]),
      }
      const cost = jobCost(eiv, params)
      expect(cost.total).toBe(cost.grossSci + cost.bonuses + cost.facility + cost.scc + cost.extra)
      expect(cost.bonuses).toBeLessThanOrEqual(0)
      expect(cost.grossSci + cost.bonuses).toBeGreaterThanOrEqual(0)
      for (const v of Object.values(cost)) expect(Number.isInteger(v)).toBe(true)
      expect(jobCost(eiv, { ...params, facilityTaxPct: params.facilityTaxPct + 1 }).facility).toBeGreaterThanOrEqual(cost.facility)
    }
  })

  it('estimated item value is an integer within 1 ISK of runs × value per run', () => {
    for (let i = 0; i < CASES; i++) {
      const materials = Array.from({ length: int(1, 12) }, (_, k) => ({ typeId: k + 1, quantity: randomBase() }))
      const prices = materials.map(() => random() * 100_000)
      const runs = randomRuns()
      const { eiv, missing } = estimatedItemValue(materials, runs, (id) => prices[id - 1])
      const exact = runs * materials.reduce((s, m, k) => s + m.quantity * prices[k], 0)
      expect(missing).toEqual([])
      expect(Number.isInteger(eiv)).toBe(true)
      expect(Math.abs(eiv - exact)).toBeLessThanOrEqual(Math.max(1, exact * 1e-12))
    }
  })
})
