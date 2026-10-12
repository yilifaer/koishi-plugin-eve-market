// 控制台「工业」分组（§4.10）：Schema 的字段和默认值、表格的列、写错的行只影响自己，以及 normalize 之后的结果。
// 地点、建筑的名字和 ID 都是编造的。

import { describe, expect, it } from 'vitest'
import { Config } from '../../src/config/schema'
import { formatIssue, INVALID_ROW_KEY, normalizeConfig } from '../../src/config/normalize'
import { FORMULA_DEFAULTS } from '../../src/core/industry'

function industryGroup() {
  const g = (Config as any).list.find((x: any) => 'industry' in x.dict)
  return { schema: g.dict.industry, description: g.meta.description }
}

function columns(schema: any): string[] {
  expect(schema.type).toBe('array')
  expect(schema.meta.role).toBe('table')
  expect(schema.inner.type).toBe('object')
  return Object.keys(schema.inner.dict)
}

const LOCATION = { name: 'XX-1', aliases: '一号点', system: 'XX-1', visibility: 'allowed', isDefault: true, defaultME: 10, defaultTE: 20 }
const STRUCTURE = { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', rigs: '屹立超大型舰船制造效率 II', facilityTaxPct: 1 }

describe('Config schema: industry group', () => {
  it('is the 工业 group with the console defaults', () => {
    const { schema, description } = industryGroup()
    expect(description).toBe('工业')
    expect(Object.keys(schema.dict)).toEqual([
      'materialMarket', 'materialPriceType', 'productMarket', 'productPriceType', 'fallbackMarket', 'meTeChoices',
      'sccSurchargePct', 'npcFacilityTaxPct', 'sellFeesPct', 'multibuyLanguage', 'locations', 'structures',
    ])
    const c = Config({} as any)
    expect(c.industry).toEqual({
      materialMarket: 'Jita 4-4', materialPriceType: 'sell', productMarket: 'Jita 4-4', productPriceType: 'sell', fallbackMarket: '',
      meTeChoices: '10/20, 5/10, 0/0', sccSurchargePct: 4, npcFacilityTaxPct: 0.25, sellFeesPct: 0, multibuyLanguage: 'en',
      locations: [], structures: [],
    })
    // 公式常量的默认值只有一处
    expect(c.industry.sccSurchargePct).toBe(FORMULA_DEFAULTS.sccSurchargePct)
    expect(c.industry.npcFacilityTaxPct).toBe(FORMULA_DEFAULTS.npcFacilityTaxPct)
    const { settings, issues } = normalizeConfig(c)
    expect(issues).toEqual([])
    expect(settings.industry).toMatchObject({ sccSurchargePct: 4, npcFacilityTaxPct: 0.25, locations: [], structures: [] })
  })

  it('has the two flat tables with every column of §4.10', () => {
    const { schema } = industryGroup()
    expect(columns(schema.dict.locations)).toEqual([
      'name', 'aliases', 'system', 'visibility', 'isDefault', 'defaultME', 'defaultTE', 'sysCostBonusPct', 'enabled', 'note',
    ])
    expect(columns(schema.dict.structures)).toEqual([
      'location', 'name', 'structureType', 'structureId', 'activities', 'rigs', 'facilityTaxPct', 'extraFeePct', 'extraFeeIsk',
      'extraFeeLabel', 'isDefault', 'enabled', 'note',
    ])
    const c = Config({ industry: { locations: [{ name: 'XX-1', system: 'XX-1' }], structures: [{ location: 'XX-1', name: '大厂' }] } } as any)
    expect(c.industry.locations[0]).toEqual({
      name: 'XX-1', aliases: '', system: 'XX-1', visibility: 'allowed', isDefault: false, defaultME: 10, defaultTE: 20,
      sysCostBonusPct: 0, enabled: true, note: '',
    })
    expect(c.industry.structures[0]).toEqual({
      location: 'XX-1', name: '大厂', structureType: '', structureId: '', activities: 'manufacturing', rigs: '', facilityTaxPct: 0,
      extraFeePct: 0, extraFeeIsk: 0, extraFeeLabel: '其他费用', isDefault: false, enabled: true, note: '',
    })
  })

  it('wrongly typed group fields fall back to their defaults', () => {
    const c = Config({ industry: { materialPriceType: 'cheapest', multibuyLanguage: 'fr', sccSurchargePct: 'x', locations: 'oops', structures: 5 } } as any)
    expect(c.industry).toMatchObject({ materialPriceType: 'sell', multibuyLanguage: 'en', sccSurchargePct: 4, locations: [], structures: [] })
    for (const raw of [{ industry: 5 }, { industry: 'x' }, { industry: [] }, { industry: { locations: [1, 'x', null] } }]) {
      expect(() => normalizeConfig(Config(raw as any))).not.toThrow()
    }
  })

  it('a bad row only invalidates itself', () => {
    const badLocations: any[] = [{ ...LOCATION, name: '坏行', visibility: 'everyone' }, { ...LOCATION, name: '坏行', isDefault: 'yes' }, 'oops']
    for (const bad of badLocations) {
      const c = Config({ industry: { locations: [LOCATION, bad] } } as any)
      expect((c.industry.locations[1] as any)[INVALID_ROW_KEY]).toBe(true)
      const { settings, issues } = normalizeConfig(c)
      expect(settings.industry.locations.map((l) => l.name)).toEqual(['XX-1'])
      expect(issues.map(formatIssue)).toEqual(['工业地点第 2 行有写错的字段（例如类型、启用写成了别的值），已跳过'])
    }
    const badStructures: any[] = [{ ...STRUCTURE, name: '坏行', activities: 'mining' }, { ...STRUCTURE, name: '坏行', enabled: 'no' }]
    for (const bad of badStructures) {
      const c = Config({ industry: { locations: [LOCATION], structures: [STRUCTURE, bad] } } as any)
      const { settings, issues } = normalizeConfig(c)
      expect(settings.industry.structures.map((s) => s.name)).toEqual(['大厂'])
      expect(issues.map(formatIssue)).toEqual(['工业建筑第 2 行有写错的字段（例如类型、启用写成了别的值），已跳过'])
    }
  })

  it('loose numbers inside a row fall back to their defaults', () => {
    const c = Config({ industry: { locations: [{ ...LOCATION, defaultME: 'x', sysCostBonusPct: 'y' }], structures: [{ ...STRUCTURE, facilityTaxPct: 'z' }] } } as any)
    expect(c.industry.locations[0]).toMatchObject({ defaultME: 10, sysCostBonusPct: 0 })
    expect(c.industry.structures[0]).toMatchObject({ facilityTaxPct: 0 })
  })
})

describe('normalizeConfig: industry tables through the schema', () => {
  it('keeps the rows as typed and lets structure rows name their location by alias', () => {
    const c = Config({
      industry: {
        locations: [LOCATION, { name: '联盟工业点A', system: '30000900', visibility: 'public', sysCostBonusPct: -50 }],
        structures: [
          STRUCTURE,
          { location: '一号点', name: '反应塔', structureType: 'Tatara', activities: 'both', isDefault: true },
          { location: '联盟工业点A', name: '空间站', structureType: 'NPC' },
          { location: '联盟工业点A', name: '无加成', structureType: '无', extraFeePct: 0.5, extraFeeIsk: 2_000_000, extraFeeLabel: '联盟管理费' },
          { location: 'XX-1', name: '停用', structureType: 'Azbel', enabled: false },
        ],
      },
    } as any)
    const { settings, issues } = normalizeConfig(c)
    expect(issues).toEqual([])
    expect(settings.industry.locations.map((l) => [l.name, l.aliases, l.system, l.visibility, l.isDefault, l.sysCostBonusPct])).toEqual([
      ['XX-1', ['一号点'], 'XX-1', 'allowed', true, 0],
      ['联盟工业点A', [], '30000900', 'public', false, -50],
    ])
    expect(settings.industry.structures.map((s) => [s.location, s.name, s.structureType, s.activities, s.rigs, s.facilityTaxPct, s.isDefault])).toEqual([
      ['XX-1', '大厂', 'Sotiyo', ['manufacturing'], ['屹立超大型舰船制造效率 II'], 1, false],
      ['XX-1', '反应塔', 'Tatara', ['manufacturing', 'reaction'], [], 0, true],
      // 「NPC」留给运行时认（NPC 空间站），「无」= 没有建筑加成
      ['联盟工业点A', '空间站', 'NPC', ['manufacturing'], [], 0, false],
      ['联盟工业点A', '无加成', '', ['manufacturing'], [], 0, false],
    ])
    expect(settings.industry.structures[3]).toMatchObject({ extraFeePct: 0.5, extraFeeIsk: 2_000_000, extraFeeLabel: '联盟管理费' })
  })

  it('a disabled location takes its structures with it, without reporting them; an unknown location is still reported', () => {
    const c = Config({
      industry: {
        locations: [LOCATION, { name: 'XX-2', aliases: '二号点', system: 'Tama', enabled: false }],
        structures: [
          STRUCTURE,
          { location: 'XX-2', name: '中厂', structureType: 'Azbel' },
          { location: '二号点', name: '反应塔', structureType: 'Athanor', activities: 'reaction' },
          { location: 'XX-9', name: '别的', structureType: 'Azbel' },
        ],
      },
    } as any)
    const { settings, issues } = normalizeConfig(c)
    expect(settings.industry.structures.map((s) => s.name)).toEqual(['大厂'])
    expect(issues.map(formatIssue)).toEqual(['工业建筑第 4 行地点「XX-9」不在工业地点表里，已跳过'])
  })

  it('reports market references of the group once it is in the console', () => {
    const c = Config({ markets: [{ name: 'Jita', location: '60003760' }], price: { baseMarket: 'Jita' }, appraisal: { defaultMarket: 'Jita' } } as any)
    const { settings } = normalizeConfig(c)
    // 控制台里已经有「工业」分组：Schema 补上的默认材料市场不再算「没配置」
    expect(settings.marketRefs['industry.materialMarket']).toEqual({
      section: 'industry', field: 'materialMarket', label: '材料市场', ref: 'Jita 4-4', whenEmpty: 'base', key: '',
    })
  })
})
