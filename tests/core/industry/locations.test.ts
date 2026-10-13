// 工业地点和建筑：控制台的两张表 + 小数据集。地点名、建筑名、建筑 ID 都是编造的；
// 星系用小数据集里的公共星系（Jita 高安、Tama 低安、NIH-02 是 00、Thera 是虫洞）。

import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../../../src/config/normalize'
import { DataNotReadyError } from '../../../src/core/data'
import {
  MAX_RIGS, createIndustryLocations, defaultStructure, findStructure, locationSupports, locationVisibleTo, structuresFor,
} from '../../../src/core/industry'
import type { IndustryLocation } from '../../../src/core/industry'
import type { Access, ConfigIssue, DataSet } from '../../../src/core/types'
import { loadFixtureData, loadSnapshotData, staticDataService } from '../../fixtures/data/load'

const PUBLIC: Access = { platform: 'qq', userId: 'u1', channelId: 'g-public', isDirect: false, isAdmin: false, allowed: false }
const ALLOWED: Access = { ...PUBLIC, channelId: 'g-allowed', allowed: true }

const JITA = 30000142
const TAMA = 30002813
const NIH_02 = 30000900
const THERA = 31000005

const XL_SHIP_I = 37180
const M_MEDIUM_ME_I = 37146
const M_MEDIUM_ME_II = 37147
const M_DRONE_TE_I = 37148
const XL_LAB_II = 37182
const XL_THUKKER = 45548
const M_COMPOSITE_TE_I = 46484

const SOTIYO = 35827
const AZBEL = 35826
const ATHANOR = 35835
const TATARA = 35836
const MOREAU = 47512

function build(industry: Record<string, unknown>, data = staticDataService()) {
  const { settings, issues } = normalizeConfig({ industry })
  expect(issues).toEqual([])
  return createIndustryLocations(settings.industry, data)
}

const names = (list: readonly IndustryLocation[]) => list.map((l) => l.name)
const messages = (issues: ConfigIssue[]) => issues.map((i) => `${i.table}#${i.row}.${i.field} ${i.message}`)

describe('IndustryLocations: locations', () => {
  const industry = {
    locations: [
      { name: 'XX-1', aliases: 'X1, 一号点', system: 'NIH-02', visibility: 'allowed', isDefault: true, defaultME: 10, defaultTE: 20, sysCostBonusPct: -50 },
      { name: '联盟工业点A', system: '塔玛', visibility: 'public', defaultME: 8, defaultTE: 16 },
      { name: 'XX-2', system: String(JITA), visibility: 'public' },
      { name: '虫洞点', system: 'Thera' },
    ],
  }

  it('resolves the system by name (English or Chinese) or ID, with security class', () => {
    const r = build(industry)
    expect(r.issues()).toEqual([])
    expect(names(r.all())).toEqual(['XX-1', '联盟工业点A', 'XX-2', '虫洞点'])
    const xx1 = r.get('xx-1')!
    expect(xx1).toMatchObject({
      row: 1, key: 'xx-1', name: 'XX-1', visibility: 'allowed', isDefault: true, defaultME: 10, defaultTE: 20, sysCostBonusPct: -50,
      structures: [],
    })
    expect(xx1.system).toEqual({ id: NIH_02, en: 'NIH-02', zh: '', regionId: 10000011, security: -0.044546, secClass: 'null' })
    expect(r.get('联盟工业点A')!.system).toMatchObject({ id: TAMA, en: 'Tama', secClass: 'low' })
    expect(r.get('XX-2')!.system).toMatchObject({ id: JITA, secClass: 'high' })
    // 虫洞星域一律算 00
    expect(r.get('虫洞点')!.system).toMatchObject({ id: THERA, secClass: 'null' })
  })

  it('matches names, aliases and system names (auto aliases), only where the group can see the location', () => {
    const r = build(industry)
    expect(r.get('XX-1')!.aliases).toEqual(['X1', '一号点', 'NIH-02'])
    expect(r.get('联盟工业点A')!.aliases).toEqual(['Tama', '塔玛'])
    for (const token of ['XX-1', 'xx-1', 'Ｘ１', '一号点', 'nih-02', 'NIH-02']) expect(r.match(token, ALLOWED)?.name).toBe('XX-1')
    expect(r.match('tama', PUBLIC)?.name).toBe('联盟工业点A')
    expect(r.match('联盟工业点 A', PUBLIC)?.name).toBe('联盟工业点A')
    expect(r.match('吉他', PUBLIC)?.name).toBe('XX-2')
    // 只在授权群的地点：别的群里和不存在一样
    expect(r.match('XX-1', PUBLIC)).toBeNull()
    expect(r.match('NIH-02', PUBLIC)).toBeNull()
    expect(r.match('XX-3', ALLOWED)).toBeNull()
    expect(r.match('', ALLOWED)).toBeNull()
    // 「谁能看到」默认只在授权群
    expect(names(r.visible(PUBLIC))).toEqual(['联盟工业点A', 'XX-2'])
    expect(names(r.visible(ALLOWED))).toEqual(['XX-1', '联盟工业点A', 'XX-2', '虫洞点'])
    expect(locationVisibleTo(r.get('XX-1')!, PUBLIC)).toBe(false)
    expect(r.maxWords()).toBe(1)
  })

  it('a system name is an alias only once and never overrides names or hand-written aliases', () => {
    const r = build({
      locations: [
        { name: 'XX-1', aliases: 'Jita', system: 'NIH-02' },
        { name: 'XX-2', system: 'Jita' },
        { name: 'XX-3', system: 'Jita' },
        { name: '吉他 制造 点', system: '吉他' },
      ],
    })
    expect(r.get('XX-1')!.aliases).toEqual(['Jita', 'NIH-02'])
    // Jita 已经是 XX-1 的手写别名；吉他 由第一个在 Jita 的地点拿走
    expect(r.get('XX-2')!.aliases).toEqual(['吉他'])
    expect(r.get('XX-3')!.aliases).toEqual([])
    expect(r.match('jita', ALLOWED)?.name).toBe('XX-1')
    expect(r.match('吉他', ALLOWED)?.name).toBe('XX-2')
    expect(r.match('吉他制造点', ALLOWED)?.name).toBe('吉他 制造 点')
    expect(r.maxWords()).toBe(3)
  })

  it('skips a location whose system is not in the data, together with its structures', () => {
    const { settings } = normalizeConfig({
      industry: {
        locations: [{ name: 'XX-1', system: 'Nowhere' }, { name: 'XX-2', system: '99999999' }, { name: 'XX-3', system: 'Tama' }],
        structures: [{ location: 'XX-1', name: '大厂', structureType: 'Sotiyo' }, { location: 'XX-3', name: '工厂', structureType: 'Raitaru' }],
      },
    })
    const r = createIndustryLocations(settings.industry, staticDataService())
    expect(names(r.all())).toEqual(['XX-3'])
    expect(r.issues()).toEqual([
      { section: 'industry', table: '工业地点', row: 1, field: 'system', message: '「星系」Nowhere 在数据里找不到，这个地点和它的建筑都不生效' },
      { section: 'industry', table: '工业地点', row: 2, field: 'system', message: '「星系」99999999 在数据里找不到，这个地点和它的建筑都不生效' },
    ])
  })

  it('the default location must be visible and able to do the activity', () => {
    const r = build({
      locations: [{ name: 'XX-2', system: 'Jita', visibility: 'allowed', isDefault: true }, { name: 'XX-1', system: 'NIH-02' }],
      structures: [{ location: 'XX-2', name: '反应塔', structureType: 'Tatara', activities: 'manufacturing' }],
    })
    expect(r.defaultLocation(ALLOWED)?.name).toBe('XX-2')
    expect(r.defaultLocation(ALLOWED, 'manufacturing')?.name).toBe('XX-2')
    expect(r.defaultLocation(PUBLIC)).toBeUndefined()
    // 高安不能做反应
    expect(r.defaultLocation(ALLOWED, 'reaction')).toBeUndefined()
    expect(build({ locations: [{ name: 'XX-1', system: 'NIH-02' }] }).defaultLocation(ALLOWED)).toBeUndefined()
  })

  it('returns frozen results and nothing before the data is loaded', () => {
    const r = build(industry)
    const loc = r.get('XX-1')!
    expect(Object.isFrozen(loc) && Object.isFrozen(loc.system) && Object.isFrozen(loc.aliases) && Object.isFrozen(loc.structures)).toBe(true)
    const notReady = createIndustryLocations(normalizeConfig({ industry }).settings.industry, {
      current: () => { throw new DataNotReadyError() },
    })
    expect(notReady.all()).toEqual([])
    expect(notReady.match('XX-1', ALLOWED)).toBeNull()
    expect(notReady.issues()).toEqual([])
    expect(notReady.maxWords()).toBe(0)
  })

  it('rebuilds after a data update and checks the configuration again', () => {
    const data = staticDataService()
    const r = build(industry, data)
    expect(r.get('XX-1')!.system.id).toBe(NIH_02)
    const fixture = loadFixtureData()
    const systems = new Map(fixture.universe.systems)
    systems.delete(NIH_02)
    const next: DataSet = { ...fixture, key: `${fixture.key}-next`, universe: { ...fixture.universe, systems } }
    data.update(next)
    expect(names(r.all())).toEqual(['联盟工业点A', 'XX-2', '虫洞点'])
    expect(messages(r.issues())).toEqual(['工业地点#1.system 「星系」NIH-02 在数据里找不到，这个地点和它的建筑都不生效'])
  })
})

describe('IndustryLocations: structures', () => {
  const locations = [
    { name: 'XX-1', system: 'NIH-02', isDefault: true },
    { name: 'XX-2', aliases: '二号点', system: 'Jita' },
    { name: '联盟工业点A', system: 'Tama' },
  ]

  it('finds the structure type by English or Chinese name or typeID, quotes and spaces ignored', () => {
    const r = build({
      locations,
      structures: [
        { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', structureId: '1000000000011', facilityTaxPct: 1, isDefault: true },
        { location: 'XX-1', name: '中厂', structureType: '阿兹贝尔' },
        { location: 'XX-1', name: '反应塔', structureType: String(TATARA), activities: 'reaction' },
        { location: 'XX-1', name: '堡垒', structureType: 'Moreau Fortizar' },
        { location: 'XX-1', name: '堡垒二', structureType: '莫罗铁壁', extraFeePct: 1.5, extraFeeIsk: 1_000_000, extraFeeLabel: '联盟管理费' },
      ],
    })
    expect(r.issues()).toEqual([])
    const xx1 = r.get('XX-1')!
    expect(xx1.structures.map((s) => [s.name, s.type?.id, s.npc, s.activities])).toEqual([
      ['大厂', SOTIYO, false, ['manufacturing']],
      ['中厂', AZBEL, false, ['manufacturing']],
      ['反应塔', TATARA, false, ['reaction']],
      ['堡垒', MOREAU, false, ['manufacturing']],
      ['堡垒二', MOREAU, false, ['manufacturing']],
    ])
    expect(xx1.structures[0]).toMatchObject({
      row: 1, location: 'XX-1', structureId: '1000000000011', facilityTaxPct: 1, extraFeePct: 0, extraFeeIsk: 0,
      extraFeeLabel: '其他费用', isDefault: true, rigs: [],
    })
    expect(xx1.structures[4]).toMatchObject({ extraFeePct: 1.5, extraFeeIsk: 1_000_000, extraFeeLabel: '联盟管理费' })
    expect(Object.isFrozen(xx1.structures[0]) && Object.isFrozen(xx1.structures[0].activities)).toBe(true)
  })

  it('「NPC」is an NPC station (NPC facility tax), 「无」is a structure without bonuses (its own tax)', () => {
    const { settings, issues } = normalizeConfig({
      industry: {
        npcFacilityTaxPct: 0.3,
        locations,
        structures: [
          { location: 'XX-2', name: '空间站', structureType: 'NPC', facilityTaxPct: 2 },
          { location: 'XX-2', name: '空间站二', structureType: 'npc 空间站' },
          { location: '二号点', name: '无加成', structureType: '无', facilityTaxPct: 1.5 },
        ],
      },
    })
    expect(issues).toEqual([])
    const r = createIndustryLocations(settings.industry, staticDataService())
    expect(r.get('XX-2')!.structures.map((s) => [s.name, s.type, s.npc, s.facilityTaxPct])).toEqual([
      ['空间站', null, true, 0.3],
      ['空间站二', null, true, 0.3],
      ['无加成', null, false, 1.5],
    ])
    expect(messages(r.issues())).toEqual(['工业建筑#1.facilityTaxPct NPC 空间站的设施税按「NPC 空间站设施税」（0.3%）算，这一行写的 2% 不生效'])
  })

  it('skips structures whose type is not in the data', () => {
    const { settings } = normalizeConfig({
      industry: { locations, structures: [{ location: 'XX-1', name: '大厂', structureType: 'Sotiyoo' }, { location: 'XX-1', name: '中厂', structureType: '12345' }] },
    })
    const r = createIndustryLocations(settings.industry, staticDataService())
    expect(r.get('XX-1')!.structures).toEqual([])
    expect(messages(r.issues())).toEqual([
      '工业建筑#1.structureType 「建筑类型」Sotiyoo 在数据里找不到（填 Raitaru、阿兹贝尔、Sotiyo、塔塔拉这类名字或 typeID；没有建筑加成填「无」，NPC 空间站填「NPC」），已跳过',
      '工业建筑#2.structureType 「建筑类型」12345 在数据里找不到（填 Raitaru、阿兹贝尔、Sotiyo、塔塔拉这类名字或 typeID；没有建筑加成填「无」，NPC 空间站填「NPC」），已跳过',
    ])
  })

  it('reports structures that cannot be anchored in high-sec but keeps them', () => {
    const { settings } = normalizeConfig({ industry: { locations, structures: [{ location: 'XX-2', name: '大厂', structureType: 'Sotiyo' }] } })
    const r = createIndustryLocations(settings.industry, staticDataService())
    expect(r.get('XX-2')!.structures.map((s) => s.name)).toEqual(['大厂'])
    expect(messages(r.issues())).toEqual(['工业建筑#1.structureType 索迪约不能放在高安，而 XX-2 是高安（0.9），请检查'])
  })

  it('drops reactions in high-sec, at NPC stations and outside refineries', () => {
    const { settings } = normalizeConfig({
      industry: {
        locations,
        structures: [
          { location: 'XX-2', name: '反应塔', structureType: 'Tatara', activities: 'both' },
          { location: 'XX-2', name: '只做反应', structureType: 'Athanor', activities: 'reaction' },
          { location: 'XX-1', name: '中厂', structureType: 'Azbel', activities: 'both' },
          { location: 'XX-1', name: '空间站', structureType: 'NPC', activities: 'both' },
          { location: 'XX-1', name: '反应塔', structureType: 'Tatara', activities: 'reaction' },
          { location: 'XX-1', name: '没有建筑', structureType: '无', activities: 'both' },
          { location: 'XX-1', name: '只写反应', structureType: '无', activities: 'reaction' },
        ],
      },
    })
    const r = createIndustryLocations(settings.industry, staticDataService())
    expect(r.get('XX-2')!.structures.map((s) => [s.name, s.activities])).toEqual([['反应塔', ['manufacturing']]])
    expect(r.get('XX-1')!.structures.map((s) => [s.name, s.activities])).toEqual([
      ['中厂', ['manufacturing']],
      ['空间站', ['manufacturing']],
      ['反应塔', ['reaction']],
      ['没有建筑', ['manufacturing']],
    ])
    expect(messages(r.issues())).toEqual([
      '工业建筑#1.activities XX-2 是高安（0.9），高安不能进行反应，「用途」里的反应不生效',
      '工业建筑#2.activities XX-2 是高安（0.9），高安不能进行反应，已跳过',
      '工业建筑#3.activities 阿兹贝尔不是精炼厂，不能进行反应，「用途」里的反应不生效',
      '工业建筑#4.activities NPC 空间站不能进行反应，「用途」里的反应不生效',
      '工业建筑#6.activities 建筑类型为「无」（没有建筑加成）时不能进行反应，「用途」里的反应不生效',
      '工业建筑#7.activities 建筑类型为「无」（没有建筑加成）时不能进行反应，已跳过',
    ])
  })
})

describe('IndustryLocations: rigs', () => {
  const locations = [
    { name: 'XX-1', system: 'NIH-02' },
    { name: 'XX-2', system: 'Jita' },
    { name: '联盟工业点A', system: 'Tama' },
  ]

  function rigsOf(structures: Array<Record<string, unknown>>) {
    const { settings } = normalizeConfig({ industry: { locations, structures } })
    const r = createIndustryLocations(settings.industry, staticDataService())
    return { r, rigs: (loc: string, i = 0) => r.get(loc)!.structures[i].rigs.map((g) => g.id) }
  }

  it('finds rigs by Chinese or English name, without the Standup prefix, or by typeID', () => {
    const { r, rigs } = rigsOf([
      { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', rigs: '屹立超大型舰船制造效率 I，Standup XL-Set Laboratory Optimization II、45548' },
      { location: 'XX-1', name: '中厂', structureType: 'Raitaru', rigs: 'M-Set Basic Medium Ship Manufacturing Material Efficiency II; 中型无人机和铁骑舰载机制造时间效率 I' },
    ])
    expect(r.issues()).toEqual([])
    expect(rigs('XX-1', 0)).toEqual([XL_SHIP_I, XL_LAB_II, XL_THUKKER])
    expect(rigs('XX-1', 1)).toEqual([M_MEDIUM_ME_II, M_DRONE_TE_I])
  })

  it('drops unknown, duplicate and wrong-size rigs and reports each', () => {
    const { r, rigs } = rigsOf([
      { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', rigs: `不存在的改装件, ${XL_SHIP_I}, 屹立超大型舰船制造效率 I, ${M_MEDIUM_ME_I}, 99999` },
    ])
    expect(rigs('XX-1')).toEqual([XL_SHIP_I])
    expect(messages(r.issues())).toEqual([
      '工业建筑#1.rigs 改装件「不存在的改装件」在数据里找不到，已忽略',
      '工业建筑#1.rigs 改装件「屹立超大型舰船制造效率 I」重复，已忽略',
      '工业建筑#1.rigs 改装件「屹立中型基础中型舰船制造材料效率 I」是中型（M）改装件，索迪约（Sotiyo） 只能装超大型（XL）的，已忽略',
      '工业建筑#1.rigs 改装件「99999」在数据里找不到，已忽略',
    ])
  })

  it('ignores rigs on structures without bonuses', () => {
    const { r, rigs } = rigsOf([
      { location: 'XX-2', name: '空间站', structureType: 'NPC', rigs: String(M_MEDIUM_ME_I) },
      { location: 'XX-2', name: '无加成', structureType: '无', rigs: String(M_MEDIUM_ME_I) },
    ])
    expect(rigs('XX-2', 0)).toEqual([])
    expect(rigs('XX-2', 1)).toEqual([])
    expect(messages(r.issues())).toEqual([
      '工业建筑#1.rigs 没有建筑加成（NPC 空间站）时不能装改装件，「改装件」已忽略',
      '工业建筑#2.rigs 没有建筑加成（建筑类型为「无」）时不能装改装件，「改装件」已忽略',
    ])
  })

  it('keeps rigs that do nothing at this security level but reports them; reactions dropped in high-sec are reported once', () => {
    const { r, rigs } = rigsOf([
      // 反应改装件在高安没有倍率：「用途」里的反应已经去掉，只报那一条
      { location: 'XX-2', name: '反应塔', structureType: 'Athanor', activities: 'both', rigs: String(M_COMPOSITE_TE_I) },
      { location: '联盟工业点A', name: '反应塔', structureType: 'Athanor', activities: 'reaction', rigs: String(M_COMPOSITE_TE_I) },
    ])
    expect(rigs('XX-2')).toEqual([M_COMPOSITE_TE_I])
    expect(rigs('联盟工业点A')).toEqual([M_COMPOSITE_TE_I])
    expect(messages(r.issues())).toEqual(['工业建筑#1.activities XX-2 是高安（0.9），高安不能进行反应，「用途」里的反应不生效'])

    const sec = rigsOf([{ location: 'XX-2', name: '反应塔', structureType: 'Athanor', activities: 'manufacturing', rigs: String(M_COMPOSITE_TE_I) }])
    expect(messages(sec.r.issues())).toEqual(['工业建筑#1.rigs 改装件「屹立中型复合反应堆时间效率 I」是反应用的，这座建筑的「用途」没有选反应'])
  })

  it('reports a rig with no multiplier for the location security class', () => {
    // 把小数据集里 XL 舰船改装件的 00 倍率改成 null
    const fixture = loadFixtureData()
    const rigs = new Map(fixture.industry.rigs)
    const rig = rigs.get(XL_SHIP_I)!
    rigs.set(XL_SHIP_I, { ...rig, sec: { ...rig.sec, n: null } })
    const data: DataSet = { ...fixture, key: `${fixture.key}-nosec`, industry: { ...fixture.industry, rigs } }
    const { settings } = normalizeConfig({ industry: { locations, structures: [{ location: 'XX-1', name: '大厂', structureType: 'Sotiyo', rigs: String(XL_SHIP_I) }] } })
    const r = createIndustryLocations(settings.industry, staticDataService(data))
    expect(r.get('XX-1')!.structures[0].rigs.map((g) => g.id)).toEqual([XL_SHIP_I])
    expect(messages(r.issues())).toEqual(['工业建筑#1.rigs 改装件「屹立超大型舰船制造效率 I」在00（0.0）不生效'])
  })

  it(`reports more than ${MAX_RIGS} rigs without dropping any`, () => {
    const { r, rigs } = rigsOf([
      { location: 'XX-1', name: '中厂', structureType: 'Raitaru', rigs: [M_MEDIUM_ME_I, M_MEDIUM_ME_II, M_DRONE_TE_I, M_COMPOSITE_TE_I].join(',') },
    ])
    expect(rigs('XX-1')).toHaveLength(4)
    expect(messages(r.issues())).toEqual([
      '工业建筑#1.rigs 改装件「屹立中型复合反应堆时间效率 I」是反应用的，这座建筑的「用途」没有选反应',
      '工业建筑#1.rigs 填了 4 个改装件，一座建筑最多装 3 个，请检查',
    ])
  })
})

describe('structure helpers', () => {
  const r = build({
    locations: [
      { name: 'XX-1', system: 'NIH-02' },
      { name: 'XX-2', system: 'Jita' },
      { name: '联盟工业点A', system: 'Tama' },
      { name: '空点', system: 'Tama' },
    ],
    structures: [
      { location: 'XX-1', name: '中厂', structureType: 'Azbel' },
      { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', isDefault: true },
      { location: 'XX-1', name: '反应塔', structureType: 'Tatara', activities: 'both' },
      { location: 'XX-1', name: '反应塔二', structureType: 'Tatara', activities: 'reaction' },
      { location: 'XX-2', name: '工厂', structureType: 'Raitaru' },
      { location: '联盟工业点A', name: '反应塔', structureType: 'Athanor', activities: 'reaction' },
    ],
  })

  it('lists the structures for an activity and picks the default', () => {
    const xx1 = r.get('XX-1')!
    expect(structuresFor(xx1, 'manufacturing').map((s) => s.name)).toEqual(['中厂', '大厂', '反应塔'])
    expect(structuresFor(xx1, 'reaction').map((s) => s.name)).toEqual(['反应塔', '反应塔二'])
    expect(defaultStructure(xx1, 'manufacturing')?.name).toBe('大厂')
    // 默认建筑不能做反应：用第一座能做的
    expect(defaultStructure(xx1, 'reaction')?.name).toBe('反应塔')
    expect(defaultStructure(r.get('空点')!, 'manufacturing')).toBeNull()
    expect(defaultStructure(r.get('联盟工业点A')!, 'manufacturing')).toBeNull()
  })

  it('which locations support which activity', () => {
    const support = (activity: 'manufacturing' | 'reaction') => names(r.all().filter((l) => locationSupports(l, activity)))
    // 一座建筑都没配的地点按没有建筑加成制造；只配了反应建筑的地点不能制造
    expect(support('manufacturing')).toEqual(['XX-1', 'XX-2', '空点'])
    expect(support('reaction')).toEqual(['XX-1', '联盟工业点A'])
    expect(names(r.visible(ALLOWED, 'reaction'))).toEqual(['XX-1', '联盟工业点A'])
    expect(names(r.visible(ALLOWED, 'manufacturing'))).toEqual(['XX-1', 'XX-2', '空点'])
  })

  it('finds a structure by its short name, or by its type when only one has it', () => {
    const xx1 = r.get('XX-1')!
    expect(findStructure(xx1, '大厂', 'manufacturing')?.name).toBe('大厂')
    expect(findStructure(xx1, ' 大 厂 ', 'manufacturing')?.name).toBe('大厂')
    expect(findStructure(xx1, '索迪约', 'manufacturing')?.name).toBe('大厂')
    expect(findStructure(xx1, 'azbel', 'manufacturing')?.name).toBe('中厂')
    // 两座塔塔拉都能做反应：按类型认不出是哪座
    expect(findStructure(xx1, 'Tatara', 'reaction')).toBeUndefined()
    expect(findStructure(xx1, 'Tatara', 'manufacturing')?.name).toBe('反应塔')
    expect(findStructure(xx1, '反应塔二', 'manufacturing')).toBeUndefined()
    expect(findStructure(xx1, '不存在', 'manufacturing')).toBeUndefined()
    expect(findStructure(xx1, '', 'manufacturing')).toBeUndefined()
  })
})

describe('IndustryLocations: taxes, purposes and services', () => {
  const locations = [
    { name: 'XX-1', system: 'NIH-02', isDefault: true },
    { name: 'XX-2', system: 'Jita' },
    { name: '联盟工业点A', system: 'Tama' },
  ]
  const SUPERCAPITAL = 35877
  const MANUFACTURING = 35878
  const CAPITAL = 35881
  const REPROCESSING = 35899
  const ids = (list: readonly { id: number }[] | null) => list?.map((x) => x.id)
  /** 带着配置问题建（问题不要求为空） */
  function make(industry: Record<string, unknown>) {
    const { settings } = normalizeConfig({ industry: { locations, ...industry } })
    return createIndustryLocations(settings.industry, staticDataService())
  }

  it('keeps one tax per activity: reaction falls back to the manufacturing tax, reprocessing to 0', () => {
    const r = make({
      structures: [
        { location: 'XX-1', name: '甲', structureType: 'Athanor', activities: 'all', facilityTaxPct: 2 },
        { location: 'XX-1', name: '乙', structureType: 'Athanor', activities: 'all', facilityTaxPct: 2, reactionTaxPct: 0, reprocessingTaxPct: 1.5 },
        { location: 'XX-2', name: '空间站', structureType: 'NPC', activities: 'manufacturing-reprocessing', facilityTaxPct: 3, reprocessingTaxPct: 0.5 },
      ],
    })
    const [a, b] = r.get('XX-1')!.structures
    expect([a.taxPct, a.facilityTaxPct]).toEqual([{ manufacturing: 2, reaction: 2, reprocessing: 0 }, 2])
    expect(b.taxPct).toEqual({ manufacturing: 2, reaction: 0, reprocessing: 1.5 })
    // NPC 空间站的制造税是「NPC 空间站设施税」，提炼税照填的
    expect(r.get('XX-2')!.structures[0].taxPct).toEqual({ manufacturing: 0.25, reaction: 3, reprocessing: 0.5 })
    expect(Object.isFrozen(a.taxPct)).toBe(true)
  })

  it('services: what the structure really has at this security level', () => {
    const r = make({
      structures: [
        { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', supercapitalShipyard: true },
        { location: 'XX-1', name: '中厂', structureType: 'Sotiyo' },
        { location: 'XX-1', name: '塔', structureType: 'Athanor', activities: 'reaction-reprocessing' },
        { location: 'XX-2', name: '中厂', structureType: 'Azbel' },
        { location: '联盟工业点A', name: '中厂', structureType: 'Azbel' },
      ],
    })
    const at = (location: string, i: number) => r.get(location)!.structures[i]
    expect(ids(at('XX-1', 0).services)).toEqual([SUPERCAPITAL, MANUFACTURING, CAPITAL])
    expect(at('XX-1', 0).supercapitalShipyard).toBe(true)
    expect(ids(at('XX-1', 1).services)).toEqual([MANUFACTURING, CAPITAL])
    expect(at('XX-1', 1).supercapitalShipyard).toBe(false)
    expect(ids(at('XX-1', 2).services)).toEqual([REPROCESSING, 45537, 45538, 45539])
    expect(at('XX-1', 2).purposes).toEqual(['reaction', 'reprocessing'])
    // 高安的阿兹贝尔没有旗舰级船坞，低安的有
    expect(ids(at('XX-2', 0).services)).toEqual([MANUFACTURING])
    expect(ids(at('联盟工业点A', 0).services)).toEqual([MANUFACTURING, CAPITAL])
    expect(r.issues()).toEqual([])
  })

  it('services is null when the data has no services table', () => {
    const data = loadFixtureData()
    const old: DataSet = { ...data, industry: { ...data.industry, services: null } }
    const { settings } = normalizeConfig({
      industry: { locations, structures: [{ location: 'XX-1', name: '大厂', structureType: 'Sotiyo', supercapitalShipyard: true }] },
    })
    const r = createIndustryLocations(settings.industry, staticDataService(old))
    expect(r.get('XX-1')!.structures[0]).toMatchObject({ services: null, supercapitalShipyard: true })
    expect(r.issues()).toEqual([])
  })

  it('the supercapital switch is ignored (and reported) on a type that cannot fit it or outside nullsec', () => {
    const r = make({
      structures: [
        { location: 'XX-1', name: '中厂', structureType: 'Azbel', supercapitalShipyard: true },
        { location: 'XX-1', name: '无加成', structureType: '无', supercapitalShipyard: true },
        { location: '联盟工业点A', name: '大厂', structureType: 'Sotiyo', supercapitalShipyard: true },
      ],
    })
    expect(r.get('XX-1')!.structures.map((s) => s.supercapitalShipyard)).toEqual([false, false])
    expect(r.get('联盟工业点A')!.structures[0].supercapitalShipyard).toBe(false)
    expect(ids(r.get('联盟工业点A')!.structures[0].services)).toEqual([MANUFACTURING, CAPITAL])
    expect(messages(r.issues())).toEqual([
      '工业建筑#1.supercapitalShipyard 阿兹贝尔（Azbel）装不上超级旗舰级船坞，「有超旗舰船坞」不生效',
      '工业建筑#2.supercapitalShipyard 建筑类型为「无」装不上超级旗舰级船坞，「有超旗舰船坞」不生效',
      '工业建筑#3.supercapitalShipyard 超级旗舰级船坞只能在 00 使用，而 联盟工业点A 是低安，「有超旗舰船坞」不生效',
    ])
  })

  it('reprocessing: dropped on 「无」 (a row with nothing left is skipped), allowed at NPC stations', () => {
    const r = make({
      structures: [
        { location: 'XX-1', name: '无加成', structureType: '无', activities: 'manufacturing-reprocessing' },
        { location: 'XX-1', name: '只提炼', structureType: '无', activities: 'reprocessing' },
        { location: 'XX-2', name: '空间站', structureType: 'NPC', activities: 'reprocessing' },
        { location: 'XX-2', name: '塔', structureType: 'Athanor', activities: 'reprocessing' },
      ],
    })
    expect(r.get('XX-1')!.structures.map((s) => [s.name, s.purposes])).toEqual([['无加成', ['manufacturing']]])
    expect(r.get('XX-2')!.structures.map((s) => [s.name, s.activities, s.purposes])).toEqual([
      ['空间站', [], ['reprocessing']],
      ['塔', [], ['reprocessing']],
    ])
    expect(ids(r.get('XX-2')!.structures[1].services)).toEqual([REPROCESSING])
    expect(messages(r.issues())).toEqual([
      '工业建筑#1.activities 建筑类型为「无」（没有建筑加成）时不能提炼，「用途」里的提炼不生效',
      '工业建筑#2.activities 建筑类型为「无」（没有建筑加成）时不能提炼，「用途」里的提炼不生效',
      '工业建筑#2.activities 「用途」里没有能用的用途，已跳过',
    ])
  })

  it('a reactor row that loses the reaction keeps its reprocessing', () => {
    const r = make({ structures: [{ location: 'XX-2', name: '塔', structureType: 'Athanor', activities: 'reaction-reprocessing' }] })
    expect(r.get('XX-2')!.structures[0]).toMatchObject({ activities: [], purposes: ['reprocessing'] })
    expect(messages(r.issues())).toEqual(['工业建筑#1.activities XX-2 是高安（0.9），高安不能进行反应，「用途」里的反应不生效'])
  })

  it('the default reaction and reprocessing locations: unknown or unfit ones count as empty and are reported', () => {
    const structures = [
      { location: 'XX-1', name: '工厂', structureType: 'Azbel' },
      { location: '联盟工业点A', name: '塔', structureType: 'Athanor', activities: 'reaction-reprocessing' },
    ]
    const ok = make({ structures, chainReactionLocation: '联盟工业点A', reprocessLocation: '联盟工业点A' })
    expect(ok.chainReactionLocation(ALLOWED)?.name).toBe('联盟工业点A')
    expect(ok.reprocessLocation(ALLOWED)?.name).toBe('联盟工业点A')
    expect(ok.issues()).toEqual([])

    const none = make({ structures })
    expect([none.chainReactionLocation(ALLOWED), none.reprocessLocation(ALLOWED)]).toEqual([undefined, undefined])
    expect(none.issues()).toEqual([])

    const bad = make({ structures, chainReactionLocation: '不存在', reprocessLocation: 'XX-1' })
    expect([bad.chainReactionLocation(ALLOWED), bad.reprocessLocation(ALLOWED)]).toEqual([undefined, undefined])
    expect(bad.issues()).toEqual([
      { section: 'industry', field: 'chainReactionLocation', message: '「默认反应地点」不存在 不是已配置的工业地点，已当作没填' },
      { section: 'industry', field: 'reprocessLocation', message: '「提炼地点」XX-1 没有用途含「提炼」的建筑，已当作没填' },
    ])
    // 高安的地点不能反应
    const high = make({ structures: [{ location: 'XX-2', name: '塔', structureType: 'Athanor', activities: 'reaction' }], chainReactionLocation: 'XX-2' })
    expect(high.chainReactionLocation(ALLOWED)).toBeUndefined()
    expect(high.issues().some((i) => i.field === 'chainReactionLocation' && i.message.includes('没有能反应的建筑'))).toBe(true)
  })

  it('the default reaction and reprocessing locations are empty for a group that cannot see them', () => {
    const r = make({
      structures: [{ location: 'XX-1', name: '塔', structureType: 'Athanor', activities: 'reaction-reprocessing' }],
      chainReactionLocation: 'XX-1', reprocessLocation: 'XX-1',
    })
    expect(r.chainReactionLocation(ALLOWED)?.name).toBe('XX-1')
    expect([r.chainReactionLocation(PUBLIC), r.reprocessLocation(PUBLIC)]).toEqual([undefined, undefined])
  })
})

describe('IndustryLocations: buildable', () => {
  const FRIGATE = { groupId: 25, categoryId: 6 }
  const CARRIER = { groupId: 547, categoryId: 6 }
  const SUPERCARRIER = { groupId: 659, categoryId: 6 }
  const r = build({
    locations: [
      { name: 'XX-1', system: 'NIH-02', visibility: 'allowed' },
      { name: 'XX-2', system: 'Jita', visibility: 'public' },
      { name: '联盟工业点A', system: 'Tama', visibility: 'public' },
      { name: '空点', system: 'Tama', visibility: 'public' },
    ],
    structures: [
      { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', supercapitalShipyard: true },
      { location: 'XX-2', name: '工厂', structureType: 'Raitaru' },
      { location: '联盟工业点A', name: '中厂', structureType: 'Azbel' },
    ],
  })

  it('filters by what the services cover, and says what is missing', () => {
    expect(names(r.buildable(ALLOWED, 'manufacturing', FRIGATE).usable)).toEqual(['XX-1', 'XX-2', '联盟工业点A', '空点'])
    const carrier = r.buildable(ALLOWED, 'manufacturing', CARRIER)
    expect(names(carrier.usable)).toEqual(['XX-1', '联盟工业点A'])
    expect(carrier).toMatchObject({ unable: 2, need: '旗舰级船坞 / 超级旗舰级船坞' })
    const super_ = r.buildable(ALLOWED, 'manufacturing', SUPERCARRIER)
    expect(names(super_.usable)).toEqual(['XX-1'])
    expect(super_).toMatchObject({ unable: 3, need: '超级旗舰级船坞' })
    expect(r.buildable(ALLOWED, 'manufacturing', FRIGATE).need).toBeUndefined()
  })

  it('only looks at the locations the group can see', () => {
    expect(names(r.buildable(PUBLIC, 'manufacturing', CARRIER).usable)).toEqual(['联盟工业点A'])
    expect(r.buildable(PUBLIC, 'manufacturing', CARRIER).unable).toBe(2)
  })

  it('a location without structures builds with the manufacturing plant only', () => {
    expect(names(r.buildable(ALLOWED, 'manufacturing', { groupId: 513, categoryId: 6 }).usable)).toContain('空点')
    expect(names(r.buildable(ALLOWED, 'manufacturing', CARRIER).usable)).not.toContain('空点')
  })

  it('no services table: nothing is filtered', () => {
    const data = loadFixtureData()
    const old: DataSet = { ...data, industry: { ...data.industry, services: null } }
    const { settings } = normalizeConfig({ industry: { locations: [{ name: 'XX-2', system: 'Jita' }], structures: [{ location: 'XX-2', name: '工厂', structureType: 'Raitaru' }] } })
    const rl = createIndustryLocations(settings.industry, staticDataService(old))
    expect(rl.buildable(ALLOWED, 'manufacturing', SUPERCARRIER)).toEqual({ usable: rl.all(), unable: 0 })
  })
})

describe('IndustryLocations on the full bundled data', () => {
  it('every structure type and rig is found by its own English and Chinese name', () => {
    const data = loadSnapshotData()
    const types = [...data.industry.structures.values()]
    const rigs = [...data.industry.rigs.values()]
    const { settings } = normalizeConfig({
      industry: {
        locations: [{ name: 'XX-1', system: 'NIH-02' }],
        structures: types.flatMap((t, i) => [
          { location: 'XX-1', name: `en${i}`, structureType: t.en },
          { location: 'XX-1', name: `zh${i}`, structureType: t.zh },
        ]),
      },
    })
    const r = createIndustryLocations(settings.industry, staticDataService(data))
    expect(r.issues()).toEqual([])
    expect(r.get('XX-1')!.structures.map((s) => s.type?.id)).toEqual(types.flatMap((t) => [t.id, t.id]))

    // 每个改装件装在尺寸对的建筑上，按英文名、中文名各找一次
    const bySize = new Map(types.filter((t) => t.group === 1404 || t.group === 1406).map((t) => [t.rigSize, t]))
    const { settings: rigSettings } = normalizeConfig({
      industry: {
        locations: [{ name: 'XX-1', system: 'NIH-02' }],
        structures: rigs.flatMap((g, i) => [
          { location: 'XX-1', name: `en${i}`, structureType: String(bySize.get(g.size)!.id), activities: 'both', rigs: g.en },
          { location: 'XX-1', name: `zh${i}`, structureType: String(bySize.get(g.size)!.id), activities: 'both', rigs: g.zh },
        ]),
      },
    })
    const all = createIndustryLocations(rigSettings.industry, staticDataService(data))
    const found = all.get('XX-1')!.structures.map((s) => s.rigs.map((g) => g.id))
    expect(found).toEqual(rigs.flatMap((g) => [[g.id], [g.id]]))
    // 只剩下「不是精炼厂不能做反应」这一类说明，没有找不到、对应多个的
    expect(all.issues().filter((i) => i.field === 'rigs' && /找不到|对应多个/.test(i.message))).toEqual([])
  })
})
