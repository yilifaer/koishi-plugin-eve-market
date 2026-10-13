import { describe, expect, it } from 'vitest'
import { MAX_SKILL_MANUFACTURING_MULT, MAX_SKILL_REACTION_MULT } from '../../../src/constants'
import {
  estimatedItemValue, facilityTaxPctFor, FORMULA_DEFAULTS, FORMULA_REVISION, formulaConfig, jobCost, jobMaterials, jobsCost,
  jobTime, materialMultiplier, materialQuantity, MAX_SKILL_TIME_MULT, planProduction, productionTime, round2, roundIsk,
  roundSeconds, runsForQuantity, splitJobs, timeMultiplier,
} from '../../../src/core/industry/formulas'
import type { ModifierSet } from '../../../src/core/industry/formulas'
import { NO_BONUS } from '../../../src/core/industry/modifiers'
import { itemByName, loadSnapshotData } from '../../fixtures/data/load'

const NONE: ModifierSet = { structure: NO_BONUS, rigs: NO_BONUS }
const SOTIYO_XL_NULL: ModifierSet = { structure: { me: 0.99, te: 0.7, cost: 0.95 }, rigs: { me: 0.958, te: 0.58, cost: 1 } }
const MATERIALS = [{ typeId: 34, quantity: 5_200_000 }, { typeId: 57479, quantity: 1 }]

describe('formula constants', () => {
  it('has a revision and the documented defaults', () => {
    expect(FORMULA_REVISION).toMatch(/^\S+$/)
    expect(FORMULA_DEFAULTS).toEqual({ sccSurchargePct: 4, npcFacilityTaxPct: 0.25 })
    expect(MAX_SKILL_TIME_MULT).toEqual({ manufacturing: MAX_SKILL_MANUFACTURING_MULT, reaction: MAX_SKILL_REACTION_MULT })
  })

  it('takes the console values when they are finite numbers', () => {
    expect(formulaConfig()).toEqual(FORMULA_DEFAULTS)
    expect(formulaConfig({ sccSurchargePct: 1.5, npcFacilityTaxPct: 0 })).toEqual({ sccSurchargePct: 1.5, npcFacilityTaxPct: 0 })
    expect(formulaConfig({ sccSurchargePct: Number.NaN })).toEqual(FORMULA_DEFAULTS)
  })
})

describe('rounding', () => {
  it('round2 removes floating noise before the ceiling', () => {
    expect(round2(8.53578)).toBe(8.54)
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(Math.ceil(round2(3 * 1.0000000001))).toBe(3)
  })

  it('ISK rounds half away from zero', () => {
    expect(roundIsk(21_208.515)).toBe(21_209)
    expect(roundIsk(2.5)).toBe(3)
    expect(roundIsk(-2.5)).toBe(-3)
    expect(roundIsk(-6_043_512.825)).toBe(-6_043_513)
    expect(roundIsk(1_413_901 * 1.5 / 100)).toBe(21_209)
    expect(Object.is(roundIsk(-0.2), 0)).toBe(true)
  })

  it('seconds round to nearest', () => {
    expect(roundSeconds(5_846.4)).toBe(5_846)
    expect(roundSeconds(4_999.68)).toBe(5_000)
  })
})

describe('runs and jobs', () => {
  it('product quantity → runs', () => {
    expect(runsForQuantity(1000, 100)).toBe(10)
    expect(runsForQuantity(1001, 100)).toBe(11)
    expect(runsForQuantity(1, 200)).toBe(1)
    expect(runsForQuantity(5, 1)).toBe(5)
  })

  it('splits only T2 products over the copy limit', () => {
    expect(splitJobs(25, 10, 1)).toEqual([25])
    expect(splitJobs(25, 10, null)).toEqual([25])
    expect(splitJobs(25, 10, 2)).toEqual([10, 10, 5])
    expect(splitJobs(20, 10, 2)).toEqual([10, 10])
    expect(splitJobs(10, 10, 2)).toEqual([10])
    expect(splitJobs(7, 0, 2)).toEqual([7])
  })

  it('rounds materials inside each job, then adds up', () => {
    const data = loadSnapshotData()
    const dc = itemByName(data, 'Damage Control II')
    const bp = data.industry.manufacturing.get(dc.typeId)!
    expect(dc.techLevel).toBe(2)
    expect(bp.maxRuns).toBeGreaterThan(3)
    const runs = bp.maxRuns * 2 + 3
    const plan = planProduction({ activity: 'manufacturing', blueprint: bp, runs, techLevel: 2, me: 2, te: 4, mods: SOTIYO_XL_NULL })
    expect(plan.jobs).toEqual([bp.maxRuns, bp.maxRuns, 3])
    for (const [i, m] of bp.materials.entries()) {
      const perJob = plan.jobs.map((r) => materialQuantity(m.quantity, r, plan.materialMultiplier))
      expect(plan.materials[i]).toEqual({ typeId: m.typeId, baseQuantity: m.quantity * runs, quantity: perJob.reduce((a, b) => a + b) })
    }
    expect(plan.timeSeconds).toBe(plan.jobs.reduce((s, r) => s + jobTime(bp.time, r, plan.timeMultiplier), 0))
  })

  it('T2 ship copies hold one run each in the data, so every run is its own job', () => {
    const data = loadSnapshotData()
    const sabre = itemByName(data, 'Sabre')
    const bp = data.industry.manufacturing.get(sabre.typeId)!
    expect(bp.maxRuns).toBe(1)
    expect(splitJobs(5, bp.maxRuns, sabre.techLevel)).toEqual([1, 1, 1, 1, 1])
  })
})

describe('materials', () => {
  it('base mode is exactly runs × base', () => {
    const mult = materialMultiplier('manufacturing', 0, NONE)
    expect(mult).toBe(1)
    expect(jobMaterials(MATERIALS, [3], mult)).toEqual([
      { typeId: 34, baseQuantity: 15_600_000, quantity: 15_600_000 },
      { typeId: 57479, baseQuantity: 3, quantity: 3 },
    ])
  })

  it('applies ME, structure and rigs; never fewer than one per run', () => {
    const mult = materialMultiplier('manufacturing', 10, SOTIYO_XL_NULL)
    expect(mult).toBeCloseTo(0.853578, 12)
    expect(materialQuantity(1, 1, mult)).toBe(1)
    expect(materialQuantity(1, 10, mult)).toBe(10)
    expect(materialQuantity(5_200_000, 1, mult)).toBe(4_438_606)
  })

  it('reactions ignore ME and TE', () => {
    expect(materialMultiplier('reaction', 10, NONE)).toBe(1)
    expect(timeMultiplier('reaction', 20, NONE)).toBe(1)
    expect(materialMultiplier('manufacturing', 10, NONE)).toBeCloseTo(0.9, 12)
    expect(timeMultiplier('manufacturing', 20, NONE)).toBeCloseTo(0.8, 12)
  })
})

describe('time', () => {
  it('reports unskilled and max-skill times', () => {
    const bp = { time: 18_000, maxRuns: 10, materials: MATERIALS }
    const m = planProduction({ activity: 'manufacturing', blueprint: bp, runs: 2, techLevel: 1, me: 0, te: 0, mods: NONE })
    expect(m.timeSeconds).toBe(36_000)
    expect(m.timeSecondsMaxSkill).toBe(Math.round(36_000 * MAX_SKILL_MANUFACTURING_MULT))
    const r = planProduction({ activity: 'reaction', blueprint: { ...bp, time: 10_800 }, runs: 1, techLevel: null, me: 0, te: 0, mods: NONE })
    expect(r.timeSecondsMaxSkill).toBe(Math.round(10_800 * MAX_SKILL_REACTION_MULT))
  })

  it('adds jobs on one production line', () => {
    expect(productionTime(100, [10, 10, 5], 0.5)).toBe(500 + 500 + 250)
    expect(productionTime(3, [1, 1], 0.5)).toBe(2 + 2)
  })
})

describe('installation cost', () => {
  const adjusted = (prices: Record<number, number | null>) => (id: number) => prices[id]

  it('estimated item value uses ME0 quantities and skips missing adjusted prices', () => {
    expect(estimatedItemValue(MATERIALS, 2, adjusted({ 34: 4, 57479: 1000.25 }))).toEqual({ eiv: 41_602_001, missing: [] })
    expect(estimatedItemValue(MATERIALS, 1, adjusted({ 34: 4, 57479: null }))).toEqual({ eiv: 20_800_000, missing: [57479] })
    expect(estimatedItemValue(MATERIALS, 1, adjusted({ 34: Number.NaN }))).toEqual({ eiv: 0, missing: [34, 57479] })
  })

  it('no structure: no cost bonus, NPC facility tax', () => {
    const tax = facilityTaxPctFor({ activity: 'manufacturing', structure: null }, formulaConfig())
    expect(tax).toBe(0.25)
    expect(jobCost(100_000_000, { sci: 0.02, mods: NONE, sysCostBonusPct: 0, facilityTaxPct: tax, sccSurchargePct: 4 })).toEqual({
      eiv: 100_000_000, grossSci: 2_000_000, bonuses: 0, facility: 250_000, scc: 4_000_000, extra: 0, total: 6_250_000,
    })
  })

  it('structure bonus, system bonus and the extra fee', () => {
    const cost = jobCost(10_000_000, {
      sci: 0.05, mods: SOTIYO_XL_NULL, sysCostBonusPct: -50, facilityTaxPct: 1, sccSurchargePct: 4, extraFeePct: 0.5, extraFeeIsk: 1000,
    })
    expect(cost).toEqual({
      eiv: 10_000_000, grossSci: 500_000, bonuses: -262_500, facility: 100_000, scc: 400_000, extra: 51_000, total: 788_500,
    })
  })

  it('a missing system index costs nothing for that part', () => {
    const cost = jobCost(10_000_000, { sci: 0, mods: SOTIYO_XL_NULL, sysCostBonusPct: 0, facilityTaxPct: 0, sccSurchargePct: 4 })
    expect(cost).toMatchObject({ grossSci: 0, bonuses: 0, scc: 400_000, total: 400_000 })
  })

  it('the SCC surcharge follows the console value', () => {
    const base = { sci: 0.01, mods: NONE, sysCostBonusPct: 0, facilityTaxPct: 0 }
    expect(jobCost(1_000_000, { ...base, sccSurchargePct: 0 }).scc).toBe(0)
    expect(jobCost(1_000_000, { ...base, sccSurchargePct: formulaConfig({ sccSurchargePct: 5 }).sccSurchargePct }).scc).toBe(50_000)
  })

  it('charges each job separately; the fixed fee once per job', () => {
    const params = { sci: 0.01, mods: NONE, sysCostBonusPct: 0, facilityTaxPct: 0, sccSurchargePct: 0, extraFeeIsk: 7 }
    const cost = jobsCost(MATERIALS, [10, 10, 5], adjusted({ 34: 1, 57479: null }), params)
    expect(cost.eiv).toBe(25 * 5_200_000)
    expect(cost.extra).toBe(21)
    expect(cost.grossSci).toBe(520_000 + 520_000 + 260_000)
    expect(cost.missingAdjusted).toEqual([57479])
    expect(cost.total).toBe(cost.grossSci + cost.bonuses + cost.facility + cost.scc + cost.extra)
  })

  it('facility tax: the command overrides, then the structure (per activity), then the NPC default', () => {
    const config = formulaConfig({ npcFacilityTaxPct: 0.5 })
    const structure = { taxPct: { manufacturing: 2, reaction: 3 } }
    expect(facilityTaxPctFor({ override: 0, activity: 'manufacturing', structure }, config)).toBe(0)
    expect(facilityTaxPctFor({ override: 1.5, activity: 'manufacturing', structure: null }, config)).toBe(1.5)
    expect(facilityTaxPctFor({ activity: 'manufacturing', structure }, config)).toBe(2)
    expect(facilityTaxPctFor({ activity: 'reaction', structure }, config)).toBe(3)
    expect(facilityTaxPctFor({ activity: 'reaction', structure: null }, config)).toBe(0.5)
  })
})
