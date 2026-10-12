import { describe, expect, it } from 'vitest'
import { displaySec } from '../../../src/core/format'
import {
  filterMatches, jobModifiers, NO_BONUS, REFINERY_GROUP, rigEffectPct, rigFits, rigProblems, rigSecMultiplier, SEC_KEY,
  structureMultipliers, structureProblems, structureSupports, systemSecClass,
} from '../../../src/core/industry/modifiers'
import type { RigInfo, StructureTypeInfo, TargetFilter } from '../../../src/core/types'
import { itemByName, loadSnapshotData } from '../../fixtures/data/load'

const data = loadSnapshotData()
const { industry } = data
const { filters } = industry

function structure(en: string): StructureTypeInfo {
  for (const s of industry.structures.values()) if (s.en === en) return s
  throw new Error(`快照里没有建筑「${en}」`)
}

function rig(id: number): RigInfo {
  const r = industry.rigs.get(id)
  if (!r) throw new Error(`快照里没有改装件 ${id}`)
  return r
}

const RAVEN = itemByName(data, 'Raven')
const TRITANIUM = itemByName(data, 'Tritanium')
const CAPITAL_ARMOR_PLATES = itemByName(data, 'Capital Armor Plates')
const CORE_TEMPERATURE_REGULATOR = itemByName(data, 'Core Temperature Regulator')
const CARBON_FIBER = itemByName(data, 'Carbon Fiber')

const XL_SHIP_T1 = 37180
const XL_SHIP_T2 = 37181
const XL_LAB_T1 = 37183
const THUKKER_XL = 45548
const M_COMPOSITE_ME_T2 = 46487
const M_COMPOSITE_TE_T2 = 46485

describe('security class', () => {
  const sys = (security: number, regionId = 10000002) => systemSecClass({ security, regionId })

  it('splits at 0.45 and 0 on the true security', () => {
    expect(sys(1)).toBe('high')
    expect(sys(0.45)).toBe('high')
    expect(sys(0.449999)).toBe('low')
    expect(sys(0.04)).toBe('low')
    expect(sys(0.000001)).toBe('low')
    expect(sys(0)).toBe('null')
    expect(sys(-0.04)).toBe('null')
    expect(sys(-1)).toBe('null')
  })

  it('wormhole space and Pochven are nullsec whatever the security says', () => {
    expect(sys(0.7, 11000001)).toBe('null')
    expect(sys(0.7, 10000070)).toBe('null')
  })

  it('agrees with every system in the data', () => {
    const counts = { high: 0, low: 0, null: 0 }
    for (const s of data.universe.systems.values()) counts[systemSecClass(s)]++
    expect(counts.high).toBeGreaterThan(1000)
    expect(counts.low).toBeGreaterThan(500)
    expect(counts.null).toBeGreaterThan(3000)
    const jita = data.universe.systems.get(30000142)!
    expect(systemSecClass(jita)).toBe('high')
  })

  it('never contradicts the displayed security (no 「0.0 · 低安」)', () => {
    const shown = (sec: number) => Number(displaySec(sec))
    // 虫洞、深渊等特殊星域（ID ≥ 11000000）不管安全等级都算 00，不在这里比较
    const consistent = (sec: number, regionId = 10000002) => {
      const cls = systemSecClass({ security: sec, regionId })
      const d = shown(sec)
      if (regionId >= 11000000) return cls === 'null'
      return cls === 'high' ? d >= 0.5 : cls === 'low' ? d >= 0.1 && d <= 0.4 : d <= 0
    }
    for (let i = -100_000; i <= 100_000; i += 7) expect(consistent(i / 100_000)).toBe(true)
    for (const s of data.universe.systems.values()) expect(consistent(s.security, s.regionId)).toBe(true)
  })

  it('maps to the rig security keys', () => {
    expect(SEC_KEY).toEqual({ high: 'h', low: 'l', null: 'n' })
  })
})

describe('structure bonuses (from the data)', () => {
  it('engineering complexes', () => {
    expect(structureMultipliers(structure('Raitaru'), 'manufacturing')).toEqual({ me: 0.99, te: 0.85, cost: 0.97 })
    expect(structureMultipliers(structure('Azbel'), 'manufacturing')).toEqual({ me: 0.99, te: 0.8, cost: 0.96 })
    expect(structureMultipliers(structure('Sotiyo'), 'manufacturing')).toEqual({ me: 0.99, te: 0.7, cost: 0.95 })
    expect(structureMultipliers(structure('Sotiyo'), 'reaction')).toEqual(NO_BONUS)
  })

  it('refineries: Tatara speeds up reactions, Athanor has no bonus', () => {
    expect(structureMultipliers(structure('Tatara'), 'reaction')).toEqual({ me: 1, te: 0.75, cost: 1 })
    expect(structureMultipliers(structure('Tatara'), 'manufacturing')).toEqual(NO_BONUS)
    expect(structureMultipliers(structure('Athanor'), 'reaction')).toEqual(NO_BONUS)
  })

  it('citadels without bonus and no structure at all', () => {
    expect(structureMultipliers(structure('Fortizar'), 'manufacturing')).toEqual(NO_BONUS)
    expect(structureMultipliers(null, 'manufacturing')).toEqual(NO_BONUS)
    expect(structureMultipliers(undefined, 'reaction')).toEqual(NO_BONUS)
  })

  it('reactions only in refineries', () => {
    expect(structure('Athanor').group).toBe(REFINERY_GROUP)
    expect(structureSupports(structure('Athanor'), 'reaction')).toBe(true)
    expect(structureSupports(structure('Tatara'), 'reaction')).toBe(true)
    expect(structureSupports(structure('Sotiyo'), 'reaction')).toBe(false)
    expect(structureSupports(structure('Sotiyo'), 'manufacturing')).toBe(true)
  })
})

describe('rig matching', () => {
  it('matches the product by category or group', () => {
    const ships = filters.get(3)!
    const largeT1 = filters.get(9)!
    expect(filterMatches(ships, RAVEN)).toBe(true)
    expect(filterMatches(largeT1, RAVEN)).toBe(true)
    expect(filterMatches(ships, TRITANIUM)).toBe(false)
  })

  it('reads each effect for [activity, kind, filter]', () => {
    const r = rig(XL_SHIP_T1)
    expect(rigEffectPct(r, 'manufacturing', 'me', RAVEN, filters)).toBe(-2)
    expect(rigEffectPct(r, 'manufacturing', 'te', RAVEN, filters)).toBe(-20)
    expect(rigEffectPct(r, 'manufacturing', 'cost', RAVEN, filters)).toBeNull()
    expect(rigEffectPct(r, 'reaction', 'me', RAVEN, filters)).toBeNull()
    expect(rigEffectPct(r, 'manufacturing', 'me', TRITANIUM, filters)).toBeNull()
    // 实验室改装件只对研究、拷贝、发明生效
    expect(rigEffectPct(rig(XL_LAB_T1), 'manufacturing', 'cost', RAVEN, filters)).toBeNull()
  })

  it('Thukker rigs carry their own percentage per filter', () => {
    const r = rig(THUKKER_XL)
    expect(rigEffectPct(r, 'manufacturing', 'me', CAPITAL_ARMOR_PLATES, filters)).toBe(-3.7)
    expect(rigEffectPct(r, 'manufacturing', 'me', CORE_TEMPERATURE_REGULATOR, filters)).toBe(-2)
    expect(rigEffectPct(r, 'manufacturing', 'te', CAPITAL_ARMOR_PLATES, filters)).toBe(-20)
    expect(rigEffectPct(r, 'manufacturing', 'me', RAVEN, filters)).toBeNull()
  })

  it('a null filter applies to every product of that activity; the first matching entry wins', () => {
    const wide: TargetFilter = { id: 900, name: 'Ships and modules', categories: [6, 7], groups: [] }
    const local = new Map(filters).set(wide.id, wide)
    const fake: RigInfo = {
      ...rig(XL_SHIP_T1),
      id: 1,
      effects: [
        { activity: 'm', kind: 'me', filter: 900, pct: -1 },
        { activity: 'm', kind: 'me', filter: 3, pct: -9 },
        { activity: 'm', kind: 'te', filter: null, pct: -5 },
      ],
    }
    expect(rigEffectPct(fake, 'manufacturing', 'me', RAVEN, local)).toBe(-1)
    expect(rigEffectPct(fake, 'manufacturing', 'te', TRITANIUM, local)).toBe(-5)
    expect(rigEffectPct(fake, 'manufacturing', 'me', TRITANIUM, local)).toBeNull()
  })

  it('reactor rigs do nothing in highsec', () => {
    expect(rigSecMultiplier(rig(M_COMPOSITE_ME_T2), 'high')).toBeNull()
    expect(rigSecMultiplier(rig(M_COMPOSITE_ME_T2), 'low')).toBe(1)
    expect(rigSecMultiplier(rig(M_COMPOSITE_ME_T2), 'null')).toBe(1.1)
    expect(rigSecMultiplier(rig(XL_SHIP_T1), 'null')).toBe(2.1)
  })
})

describe('configuration checks', () => {
  it('rig size must match the structure', () => {
    expect(rigFits(rig(XL_SHIP_T1), structure('Sotiyo'))).toBe(true)
    expect(rigFits(rig(XL_SHIP_T1), structure('Raitaru'))).toBe(false)
    expect(rigProblems(rig(XL_SHIP_T1), structure('Raitaru'), 'null')).toEqual([
      expect.objectContaining({ code: 'rig-size', rigId: XL_SHIP_T1, message: expect.stringContaining('超大型') }),
    ])
    expect(rigProblems(rig(M_COMPOSITE_ME_T2), structure('Athanor'), 'high')).toEqual([
      expect.objectContaining({ code: 'rig-sec', message: expect.stringContaining('在此安全等级不生效') }),
    ])
    expect(rigProblems(rig(M_COMPOSITE_ME_T2), structure('Athanor'), 'low')).toEqual([])
  })

  it('Sotiyo and Keepstar are not allowed in highsec; reactions not in highsec and only in refineries', () => {
    expect(structureProblems(structure('Sotiyo'), 'high', ['manufacturing']).map((i) => i.code)).toEqual(['structure-highsec'])
    expect(structureProblems(structure('Keepstar'), 'high', ['manufacturing']).map((i) => i.code)).toEqual(['structure-highsec'])
    expect(structureProblems(structure('Sotiyo'), 'low', ['manufacturing'])).toEqual([])
    expect(structureProblems(structure('Raitaru'), 'high', ['manufacturing'])).toEqual([])
    expect(structureProblems(structure('Athanor'), 'high', ['reaction'])).toEqual([
      { code: 'reaction-highsec', message: '高安不能进行反应' },
    ])
    expect(structureProblems(structure('Azbel'), 'null', ['manufacturing', 'reaction']).map((i) => i.code)).toEqual(['reaction-structure'])
    expect(structureProblems(null, 'high', ['manufacturing'])).toEqual([])
    expect(structureProblems(null, 'high', ['reaction']).map((i) => i.code)).toEqual(['reaction-highsec'])
  })
})

describe('job modifiers', () => {
  const base = { activity: 'manufacturing' as const, product: RAVEN, secClass: 'null' as const, filters }

  it('no structure: no bonus, rigs ignored', () => {
    const m = jobModifiers({ ...base, structure: null, rigs: [rig(XL_SHIP_T1)] })
    expect(m).toMatchObject({ me: 1, te: 1, cost: 1, structure: NO_BONUS, rigs: NO_BONUS, applied: [], issues: [] })
  })

  it('structure × rigs; the summary lists only rigs that apply to the product', () => {
    const m = jobModifiers({ ...base, structure: structure('Sotiyo'), rigs: [rig(XL_LAB_T1), rig(XL_SHIP_T2)] })
    expect(m.applied).toEqual([{ rigId: XL_SHIP_T2, me: -5.04, te: -50.4, cost: 0 }])
    expect(m.rigs.me).toBeCloseTo(0.9496, 12)
    expect(m.rigs.te).toBeCloseTo(0.496, 12)
    expect(m.rigs.cost).toBe(1)
    expect(m.me).toBeCloseTo(0.99 * 0.9496, 12)
    expect(m.te).toBeCloseTo(0.7 * 0.496, 12)
    expect(m.cost).toBe(0.95)
    expect(m.issues).toEqual([])
  })

  it('rigs add up', () => {
    const m = jobModifiers({ ...base, structure: structure('Sotiyo'), rigs: [rig(XL_SHIP_T1), rig(XL_SHIP_T2)] })
    expect(m.rigs.me).toBeCloseTo(1 - 0.02 * 2.1 - 0.024 * 2.1, 12)
    expect(m.applied.map((r) => r.rigId)).toEqual([XL_SHIP_T1, XL_SHIP_T2])
  })

  it('「改装:无」 means R = 1', () => {
    const m = jobModifiers({ ...base, structure: structure('Sotiyo'), rigs: [] })
    expect(m.rigs).toEqual(NO_BONUS)
    expect(m.structure).toEqual({ me: 0.99, te: 0.7, cost: 0.95 })
  })

  it('a rig of the wrong size is reported and left out', () => {
    const m = jobModifiers({ ...base, structure: structure('Azbel'), rigs: [rig(XL_SHIP_T1)] })
    expect(m.rigs).toEqual(NO_BONUS)
    expect(m.applied).toEqual([])
    expect(m.issues.map((i) => i.code)).toEqual(['rig-size'])
  })

  it('Thukker rig in lowsec on a capital component', () => {
    const m = jobModifiers({ ...base, product: CAPITAL_ARMOR_PLATES, secClass: 'low', structure: structure('Sotiyo'), rigs: [rig(THUKKER_XL)] })
    expect(m.applied).toEqual([{ rigId: THUKKER_XL, me: -7.03, te: -38, cost: 0 }])
    expect(m.rigs.me).toBeCloseTo(1 - 0.037 * 1.9, 12)
  })

  it('reactions: reactor rigs in lowsec; flagged in highsec', () => {
    const reaction = { activity: 'reaction' as const, product: CARBON_FIBER, filters, structure: structure('Athanor') }
    const low = jobModifiers({ ...reaction, secClass: 'low', rigs: [rig(M_COMPOSITE_ME_T2), rig(M_COMPOSITE_TE_T2)] })
    expect(low.applied).toEqual([
      { rigId: M_COMPOSITE_ME_T2, me: -2.4, te: 0, cost: 0 },
      { rigId: M_COMPOSITE_TE_T2, me: 0, te: -24, cost: 0 },
    ])
    expect(low.me).toBeCloseTo(0.976, 12)
    expect(low.te).toBeCloseTo(0.76, 12)
    expect(low.issues).toEqual([])
    const high = jobModifiers({ ...reaction, secClass: 'high', rigs: [rig(M_COMPOSITE_ME_T2)] })
    expect(high.rigs).toEqual(NO_BONUS)
    expect(high.issues.map((i) => i.code)).toEqual(['reaction-highsec', 'rig-sec'])
  })

  it('rigs that do not touch the product are not reported, even where they would not work', () => {
    const m = jobModifiers({ ...base, secClass: 'high', structure: structure('Athanor'), rigs: [rig(M_COMPOSITE_ME_T2)] })
    expect(m.issues).toEqual([])
    expect(m.applied).toEqual([])
  })
})

describe('modifier properties over the whole data', () => {
  const products = [RAVEN, TRITANIUM, CAPITAL_ARMOR_PLATES, CORE_TEMPERATURE_REGULATOR, CARBON_FIBER]

  it('every rig bonus in the data lowers or keeps the multiplier, never below zero', () => {
    for (const r of industry.rigs.values()) {
      for (const s of industry.structures.values()) {
        if (!rigFits(r, s)) continue
        for (const activity of ['manufacturing', 'reaction'] as const) {
          for (const secClass of ['high', 'low', 'null'] as const) {
            for (const product of products) {
              const m = jobModifiers({ activity, product, secClass, structure: s, rigs: [r], filters })
              for (const k of ['me', 'te', 'cost'] as const) {
                expect(m.rigs[k]).toBeGreaterThan(0)
                expect(m.rigs[k]).toBeLessThanOrEqual(1)
                expect(m[k]).toBeLessThanOrEqual(1)
              }
              for (const a of m.applied) expect(a.rigId).toBe(r.id)
            }
          }
        }
      }
    }
  })

  it('an applied rig always has a matching effect for the product', () => {
    for (const r of industry.rigs.values()) {
      const s = [...industry.structures.values()].find((x) => rigFits(r, x))!
      for (const product of products) {
        const m = jobModifiers({ ...{ activity: 'manufacturing' as const }, product, secClass: 'null', structure: s, rigs: [r], filters })
        const any = (['me', 'te', 'cost'] as const).some((k) => rigEffectPct(r, 'manufacturing', k, product, filters) !== null)
        expect(m.applied.length > 0).toBe(any && r.sec.n !== null)
      }
    }
  })
})
