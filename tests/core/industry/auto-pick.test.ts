// 按产品筛地点、自动挑建筑（制造、制造比价、高级第 3 步）：小数据集 + 假的报价、指数。
// 地点名、建筑名都是编造的；星系用公共星系（NIH-02 是 00、Tama 低安、Jita 高安）。
// 小数据集里有舰船分组 659 / 547 / 513 / 941 / 883 的物品但没有蓝图，这里给它们补上简单的蓝图。

import { describe, expect, it } from 'vitest'
import { canBuild, locationCanBuild } from '../../../src/core/industry/capabilities'
import { isFailure } from '../../../src/core/types'
import type { BlueprintActivity, CoreFailure, DataSet, IndustryRequest, IndustryResult, IndustryStep, LocationComparison } from '../../../src/core/types'
import { loadFixtureData } from '../../fixtures/data/load'
import { ALLOWED, FakeIndices, FakePrices, JITA_KEY, PUBLIC, makeService } from './service-fakes'

const RAVEN = 638
const TUNGSTEN_CARBIDE = 16672
const AEON = 23919
const THANATOS = 23911
const CHARON = 20185
const ORCA = 28606
const RORQUAL = 28352
const NIH_02 = 30000900
const TAMA = 30002813
const XL_SHIP_I = 37180

/** 补了蓝图的小数据集：每艘 1000 三钛合金 + 500 类晶体胶矿 */
function withShipBlueprints(base: DataSet, services?: DataSet['industry']['services']): DataSet {
  const manufacturing = new Map(base.industry.manufacturing)
  const ships = [AEON, THANATOS, CHARON, ORCA, RORQUAL]
  ships.forEach((typeId, i) => {
    const bp: BlueprintActivity = {
      blueprintId: 91000 + i, activity: 'm', time: 36_000, maxRuns: 10,
      products: [{ typeId, quantity: 1 }], materials: [{ typeId: 34, quantity: 1000 }, { typeId: 35, quantity: 500 }],
    }
    manufacturing.set(typeId, bp)
  })
  const industry = { ...base.industry, manufacturing, ...(services === undefined ? {} : { services }) }
  return { ...base, industry }
}

const PRICES: Record<number, number> = { 34: 4, 35: 20, 36: 95, 37: 160, 38: 820, 39: 1450, 40: 2600, 57478: 6500, 57479: 3_200_000, 57486: 41_000, 16672: 50 }
const ADJUSTED: Record<number, number> = { 34: 4, 35: 10, 36: 50, 37: 300, 38: 1000, 39: 2500, 40: 2500, 57478: 10_000, 57479: 350_000, 57486: 12_000 }
const INDICES = { systems: { [NIH_02]: { manufacturing: 0.02 }, [TAMA]: { manufacturing: 0.01, reaction: 0.015 } }, adjusted: ADJUSTED }

const LOCATIONS = [
  { name: '星点甲', system: 'NIH-02', visibility: 'public', isDefault: true },
  { name: '星点乙', system: 'Tama', visibility: 'public' },
  { name: '星点丙', system: 'Jita', visibility: 'public' },
  { name: '星点丁', system: 'Jita', visibility: 'public' },
]
const STRUCTURES = [
  { location: '星点甲', name: '甲索迪约', structureType: 'Sotiyo', supercapitalShipyard: true, facilityTaxPct: 1, rigs: String(XL_SHIP_I) },
  { location: '星点甲', name: '甲阿兹贝尔', structureType: 'Azbel', facilityTaxPct: 0.5 },
  { location: '星点甲', name: '甲莱塔卢', structureType: 'Raitaru' },
  { location: '星点乙', name: '乙阿兹贝尔', structureType: 'Azbel' },
  { location: '星点丙', name: '丙莱塔卢', structureType: 'Raitaru' },
  { location: '星点丙', name: '丙阿兹贝尔', structureType: 'Azbel' },
]

function setup(industry: Record<string, unknown> = {}, opts: { data?: DataSet; indices?: FakeIndices } = {}) {
  const prices = new FakePrices().set(JITA_KEY, PRICES)
  const indices = opts.indices ?? new FakeIndices(INDICES)
  const env = makeService({ industry: { locations: LOCATIONS, structures: STRUCTURES, ...industry } }, { prices, indices, data: opts.data ?? withShipBlueprints(loadFixtureData()) })
  expect(env.issues.filter((i) => i.section === 'industry')).toEqual([])
  const req = (typeId: number, extra: Partial<IndustryRequest> = {}): IndustryRequest =>
    ({ typeId, activity: 'manufacturing', mode: 'advanced', materials: false, access: ALLOWED, ...extra })
  return { ...env, req, plan: (typeId: number, extra: Partial<IndustryRequest> = {}) => env.service.plan(req(typeId, extra)) }
}

function result(r: IndustryResult | IndustryStep | CoreFailure): IndustryResult {
  if (isFailure(r)) throw new Error(`应该出结果，实际是 ${r.code}（${r.message ?? r.reason ?? ''}）`)
  if ('step' in r) throw new Error(`应该出结果，实际是第「${r.step}」步`)
  return r
}
function step(r: IndustryResult | IndustryStep | CoreFailure): IndustryStep {
  if (isFailure(r) || !('step' in r)) throw new Error('应该是一步')
  return r
}
function failed(r: unknown): CoreFailure {
  if (!isFailure(r)) throw new Error('应该失败')
  return r
}

/** 自动挑的标记和「默认」列表之外，别的都要和写了 建筑: 的结果一样 */
function sameAs(auto: IndustryResult, explicit: IndustryResult) {
  const { autoPicked: _, ...autoApplied } = auto.applied
  expect({ ...auto, applied: autoApplied }).toEqual(explicit)
}

describe('capability: which locations can build what', () => {
  it('Aeon (supercarrier) only at a nullsec Sotiyo with the switch', async () => {
    const { plan, service } = setup()
    const r = result(await plan(AEON))
    expect(r.applied).toMatchObject({ location: '星点甲', structure: '甲索迪约', structureOnly: true, defaulted: ['location', 'me', 'te', 'structure', 'rigs', 'tax'] })
    expect(service.locationsFor(ALLOWED, 'manufacturing', AEON)).toEqual([{ name: '星点甲', isDefault: true }])
    // 写了别的地点：说清楚缺什么，列出能造的地点
    expect(failed(await plan(AEON, { location: '星点乙' }))).toMatchObject({
      code: 'UNKNOWN_LOCATION', reason: 'capability', token: '星点乙', need: '超级旗舰级船坞', locations: ['星点甲'],
    })
    // 同一个地点里只有勾了开关的索迪约能造
    expect(failed(await plan(AEON, { location: '星点丙' }))).toMatchObject({ reason: 'capability', locations: ['星点甲'] })
    const aza = step(await plan(AEON, { location: '星点甲', structure: '甲阿兹贝尔' }))
    expect(aza).toMatchObject({ step: 'structure', notice: '甲阿兹贝尔 造不了万古级（需要超级旗舰级船坞），请重新选择' })
    expect(aza.options.map((o) => o.label)).toEqual(['甲索迪约'])
    expect(aza.note).toBe('另有 2 座造不了（需要超级旗舰级船坞）')
  })

  it('without the switch nobody can build an Aeon: NOT_CONFIGURED says what is needed', async () => {
    const off = STRUCTURES.map((s) => ({ ...s, supercapitalShipyard: false }))
    const { plan, service } = setup({ structures: off })
    expect(failed(await plan(AEON))).toMatchObject({ code: 'NOT_CONFIGURED', reason: 'capability', need: '超级旗舰级船坞', locations: [] })
    expect(service.locationsFor(ALLOWED, 'manufacturing', AEON)).toEqual([])
  })

  it('a carrier: Azbel in nullsec and lowsec yes, highsec no; Raitaru never', async () => {
    const { plan, service } = setup()
    expect(service.locationsFor(ALLOWED, 'manufacturing', THANATOS).map((l) => l.name)).toEqual(['星点甲', '星点乙'])
    expect(failed(await plan(THANATOS, { location: '星点丙' }))).toMatchObject({
      reason: 'capability', need: '旗舰级船坞 / 超级旗舰级船坞', locations: ['星点甲', '星点乙'],
    })
    // 星点甲里三座：莱塔卢不能造，其余两座里自动挑
    const r = result(await plan(THANATOS, { location: '星点甲' }))
    expect(r.applied.autoPicked).toEqual({ among: 2 })
    expect(r.applied.structure).not.toBe('甲莱塔卢')
    // 低安的单座阿兹贝尔：唯一
    expect(result(await plan(THANATOS, { location: '星点乙' })).applied).toMatchObject({ structure: '乙阿兹贝尔', structureOnly: true })
    const noRaitaru = step(await plan(THANATOS, { location: '星点甲', structure: '甲莱塔卢' }))
    expect(noRaitaru.notice).toBe('甲莱塔卢 造不了绝念级（需要旗舰级船坞 / 超级旗舰级船坞），请重新选择')
  })

  it('the location step lists only the usable locations and counts the others', async () => {
    const { plan } = setup()
    const s = step(await plan(THANATOS, { mode: 'steps' }))
    expect(s.options.map((o) => o.label)).toEqual(['星点甲', '星点乙'])
    expect(s.note).toBe('另有 2 个地点造不了（需要旗舰级船坞 / 超级旗舰级船坞）')
    // 默认地点（星点甲）能造：其余默认；换成造不了的默认地点就不给
    expect(s.defaults).toBe('绝念级 星点甲')
    expect(step(await plan(RAVEN, { mode: 'steps' })).note).toBeUndefined()
  })

  it('a freighter: Raitaru and 建筑:无 can build it; so can Orca; Rorqual needs the capital shipyard', async () => {
    const { plan } = setup()
    expect(result(await plan(CHARON, { location: '星点丙', structure: '丙莱塔卢' })).applied.structure).toBe('丙莱塔卢')
    const none = result(await plan(CHARON, { location: '星点丙', structure: 'none' }))
    expect(none.applied.structure).toBeUndefined()
    expect(result(await plan(ORCA, { location: '星点丁' })).applied.location).toBe('星点丁')
    expect(result(await plan(CHARON, { location: '星点丁' })).applied.structure).toBeUndefined()
    expect(failed(await plan(RORQUAL, { location: '星点丁' }))).toMatchObject({ reason: 'capability', need: '旗舰级船坞 / 超级旗舰级船坞' })
    expect(step(await plan(RORQUAL, { location: '星点甲', structure: 'none' })).notice).toBe('「建筑:无」造不了长须鲸级（需要旗舰级船坞 / 超级旗舰级船坞），请重新选择')
  })

  it('a product no service covers (like group 1194) and data without a services table are not filtered', async () => {
    const data = withShipBlueprints(loadFixtureData(), [])
    const { plan, service } = setup({}, { data })
    expect(service.locationsFor(ALLOWED, 'manufacturing', AEON).map((l) => l.name)).toEqual(['星点甲', '星点乙', '星点丙', '星点丁'])
    expect(result(await plan(AEON, { location: '星点丁' })).applied.location).toBe('星点丁')
    const old = setup({}, { data: withShipBlueprints(loadFixtureData(), null) })
    expect(old.service.locationsFor(ALLOWED, 'manufacturing', AEON)).toHaveLength(4)
    // 小数据集里分组 25 的舰船有服务覆盖，分组 1194 的东西没有：直接问能力
    const env = setup()
    const loc = env.locations.get('星点丁')!
    const odd = { groupId: 1194, categoryId: 99 }
    expect(locationCanBuild(loc, odd, 'manufacturing', env.data.current().industry)).toEqual({ ok: true, known: false })
    expect(canBuild(null, loc, odd, 'manufacturing', env.data.current().industry)).toEqual({ ok: true, known: false })
  })

  it('capability helpers: canBuild per structure, locationCanBuild = any structure', () => {
    const env = setup()
    const industry = env.data.current().industry
    const carrier = { groupId: 547, categoryId: 6 }
    const jita = env.locations.get('星点丙')!
    const null00 = env.locations.get('星点甲')!
    expect(canBuild(jita.structures[1], jita, carrier, 'manufacturing', industry)).toMatchObject({ ok: false, why: 'sec' })
    expect(canBuild(jita.structures[0], jita, carrier, 'manufacturing', industry)).toMatchObject({ ok: false, why: 'service' })
    expect(canBuild(null00.structures[1], null00, carrier, 'manufacturing', industry)).toEqual({ ok: true, known: true })
    expect(locationCanBuild(jita, carrier, 'manufacturing', industry)).toMatchObject({ ok: false, why: 'sec' })
    expect(locationCanBuild(null00, carrier, 'manufacturing', industry)).toEqual({ ok: true, known: true })
  })
})

describe('auto-pick the structure', () => {
  it('the cheapest total wins and the result equals writing 建筑: with that structure', async () => {
    const { plan } = setup()
    const auto = result(await plan(RAVEN, { location: '星点甲' }))
    expect(auto.applied).toMatchObject({ structure: '甲索迪约', autoPicked: { among: 3 }, defaulted: ['me', 'te', 'rigs', 'tax'] })
    expect(auto.applied.structureOnly).toBeUndefined()
    sameAs(auto, result(await plan(RAVEN, { location: '星点甲', structure: '甲索迪约' })))
  })

  it('a single structure keeps the old 「only」 path; no autoPicked', async () => {
    const { plan } = setup()
    const r = result(await plan(RAVEN, { location: '星点乙' }))
    expect(r.applied).toMatchObject({ structure: '乙阿兹贝尔', structureOnly: true, defaulted: ['me', 'te', 'structure', 'rigs', 'tax'] })
    expect(r.applied.autoPicked).toBeUndefined()
  })

  it('建筑:无, 改装:无 and 税: apply to every candidate', async () => {
    const { plan } = setup()
    const noRigs = result(await plan(RAVEN, { location: '星点甲', rigs: 'none', me: 10, te: 20 }))
    expect(noRigs.applied).toMatchObject({ autoPicked: { among: 3 }, defaulted: ['tax'], rigs: [] })
    // 没有改装件：索迪约时间 -30%、费用 -5%，税 1%，阿兹贝尔税 0.5%、时间 -20%：写 建筑: 的结果要一致
    sameAs(noRigs, result(await plan(RAVEN, { location: '星点甲', rigs: 'none', me: 10, te: 20, structure: noRigs.applied.structure })))
    const taxed = result(await plan(RAVEN, { location: '星点甲', facilityTaxPct: 0 }))
    expect(taxed.applied).toMatchObject({ facilityTaxPct: 0, autoPicked: { among: 3 } })
    expect(taxed.applied.defaulted).not.toContain('tax')
    const none = result(await plan(RAVEN, { location: '星点甲', structure: 'none' }))
    expect(none.applied.autoPicked).toBeUndefined()
  })

  it('high tax with a rig against low tax without one is decided by the total cost', async () => {
    const two = (sotiyoTax: number) => [
      { location: '星点甲', name: '带改装', structureType: 'Sotiyo', rigs: String(XL_SHIP_I), facilityTaxPct: sotiyoTax },
      { location: '星点甲', name: '没改装', structureType: 'Sotiyo', facilityTaxPct: 0 },
    ]
    // 税 0.1%：改装件省的材料更多
    const low = setup({ structures: two(0.1) })
    expect(result(await low.plan(RAVEN, { location: '星点甲' })).applied.structure).toBe('带改装')
    // 税 15%：税把改装件省的都吃掉了
    const high = setup({ structures: two(15) })
    const r = result(await high.plan(RAVEN, { location: '星点甲' }))
    expect(r.applied).toMatchObject({ structure: '没改装', autoPicked: { among: 2 } })
    // 排序依据和结果卡上的总成本是同一个数
    const rig = result(await high.plan(RAVEN, { location: '星点甲', structure: '带改装' }))
    const total = (x: IndustryResult) => x.materialCost + x.jobCost!.total
    expect(total(r)).toBeLessThan(total(rig))
  })

  it('ties go to the faster structure, then the default one, then the table order', async () => {
    // 没有调整价：安装费算不出来，成本只剩材料（两座一样）
    const noAdjusted = new FakeIndices({ systems: INDICES.systems, adjusted: { ok: false, code: 'UPSTREAM_UNAVAILABLE' } as CoreFailure })
    const pick = async (structures: Array<Record<string, unknown>>, indices?: FakeIndices) => {
      const env = setup({ structures: structures.map((s) => ({ location: '星点丙', ...s })) }, { indices })
      return result(await env.plan(RAVEN, { location: '星点丙' })).applied.structure
    }
    // 莱塔卢 TE -15%，阿兹贝尔 TE -20%，材料一样：快的赢，不管谁在前
    expect(await pick([{ name: '一', structureType: 'Raitaru' }, { name: '二', structureType: 'Azbel' }], noAdjusted)).toBe('二')
    // 完全一样：勾了默认的赢
    expect(await pick([{ name: '一', structureType: 'Raitaru' }, { name: '二', structureType: 'Raitaru', isDefault: true }])).toBe('二')
    // 都没勾：表格里靠前的
    expect(await pick([{ name: '一', structureType: 'Raitaru' }, { name: '二', structureType: 'Raitaru' }])).toBe('一')
  })

  it('compare: each location picks its structure, rows say so, and no extra price requests are made', async () => {
    const multi = setup()
    const c = (await multi.service.compare({ typeId: RAVEN, activity: 'manufacturing', materials: false, access: ALLOWED })) as LocationComparison
    expect(isFailure(c)).toBe(false)
    const row = (name: string) => c.rows.find((r) => r.location === name)!
    expect(row('星点甲')).toMatchObject({ structure: '甲索迪约', autoPicked: true, among: 3 })
    expect(row('星点丙')).toMatchObject({ autoPicked: true, among: 2 })
    expect(row('星点乙')).toMatchObject({ structure: '乙阿兹贝尔' })
    expect(row('星点乙').autoPicked).toBeUndefined()
    expect(row('星点丁').structure).toBeUndefined()
    expect(row('星点甲').result.applied.autoPicked).toEqual({ among: 3 })

    // 每个地点只留一座建筑：取报价的调用次数一样
    const one = setup({ structures: [
      { location: '星点甲', name: '甲索迪约', structureType: 'Sotiyo', facilityTaxPct: 1 },
      { location: '星点乙', name: '乙阿兹贝尔', structureType: 'Azbel' },
      { location: '星点丙', name: '丙莱塔卢', structureType: 'Raitaru' },
    ] })
    await one.service.compare({ typeId: RAVEN, activity: 'manufacturing', materials: false, access: ALLOWED })
    expect(multi.prices.calls.length).toBe(one.prices.calls.length)
    expect(multi.prices.calls).toEqual(one.prices.calls)
    expect([multi.indices.systemCalls, multi.indices.adjustedCalls]).toEqual([1, 1])
  })

  it('compare keeps only the locations that can build the product and counts the rest', async () => {
    const { service } = setup()
    const c = (await service.compare({ typeId: THANATOS, activity: 'manufacturing', materials: false, access: ALLOWED })) as LocationComparison
    expect(c.rows.map((r) => r.location).sort()).toEqual(['星点乙', '星点甲'])
    expect(c.unable).toEqual({ count: 2, need: '旗舰级船坞 / 超级旗舰级船坞' })
    const plain = (await service.compare({ typeId: RAVEN, activity: 'manufacturing', materials: false, access: ALLOWED })) as LocationComparison
    expect(plain.unable).toBeUndefined()
    expect(failed(await service.compare({ typeId: AEON, activity: 'manufacturing', materials: false, access: ALLOWED }))).toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  it('structure step: priced once, cheapest first and recommended, 「无建筑加成」 last, unable ones counted', async () => {
    const { plan, prices } = setup()
    const s = step(await plan(RAVEN, { location: '星点甲', mode: 'steps', me: 10, te: 20 }))
    expect(s.options.map((o) => o.label)).toEqual(['甲索迪约', '甲莱塔卢', '甲阿兹贝尔'])
    expect(s.options.map((o) => o.recommended)).toEqual([true, undefined, undefined])
    expect(s.options[0].detail).toMatch(/^预计总成本 \d+(\.\d+)?[KMB] · /)
    const costs = s.options.map((o) => o.cost!)
    expect([...costs].sort((a, b) => a - b)).toEqual(costs)
    // 价格只取一次：材料市场一份，成品一份
    expect(prices.calls).toHaveLength(2)
    const all = step(await plan(RAVEN, { location: '星点甲', structure: '?', me: 10, te: 20 }))
    expect(all.options.map((o) => o.label)).toEqual(['甲索迪约', '甲莱塔卢', '甲阿兹贝尔', '无建筑加成'])
    expect(all.options.at(-1)!.recommended).toBeUndefined()
    // 每个选项的命令都带着建筑：点它得到的就是这座建筑的结果
    const picked = result(await plan(RAVEN, { location: '星点甲', structure: '甲阿兹贝尔', me: 10, te: 20 }))
    expect(picked.applied.structure).toBe('甲阿兹贝尔')

    // 造不了的建筑不列，数量写在 note 里
    const carrier = step(await plan(THANATOS, { location: '星点甲', structure: '?', me: 10, te: 20 }))
    expect(carrier.options.map((o) => o.label)).toEqual(['甲索迪约', '甲阿兹贝尔'])
    expect(carrier.note).toBe('另有 1 座造不了（需要旗舰级船坞 / 超级旗舰级船坞）')
  })
})

describe('tax per activity', () => {
  it('manufacturing uses the manufacturing tax, reaction the reaction tax; a command tax overrides both', async () => {
    const { plan } = setup({
      locations: [{ name: '星点乙', system: 'Tama', visibility: 'public' }],
      structures: [{ location: '星点乙', name: '两用塔', structureType: 'Athanor', activities: 'both', facilityTaxPct: 2, reactionTaxPct: 7 }],
    })
    const make = result(await plan(RAVEN, { location: '星点乙' }))
    expect(make.applied.facilityTaxPct).toBe(2)
    const react = result(await plan(TUNGSTEN_CARBIDE, { location: '星点乙', activity: 'reaction' }))
    expect(react.applied.facilityTaxPct).toBe(7)
    expect(result(await plan(TUNGSTEN_CARBIDE, { location: '星点乙', activity: 'reaction', facilityTaxPct: 1 })).applied.facilityTaxPct).toBe(1)
    // 没填反应税：和制造税一样
    const same = setup({
      locations: [{ name: '星点乙', system: 'Tama', visibility: 'public' }],
      structures: [{ location: '星点乙', name: '两用塔', structureType: 'Athanor', activities: 'both', facilityTaxPct: 2 }],
    })
    expect(result(await same.plan(TUNGSTEN_CARBIDE, { location: '星点乙', activity: 'reaction' })).applied.facilityTaxPct).toBe(2)
  })

  it('a group that cannot see the location gets the same capability answer', async () => {
    const { plan } = setup()
    expect(failed(await plan(AEON, { access: PUBLIC, location: '星点乙' }))).toMatchObject({ reason: 'capability' })
  })
})
