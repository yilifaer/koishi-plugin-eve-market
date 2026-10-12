// 制造、反应的参数（§2.6.1、§2.8）：小数据集上真的物品识别器和工业地点。地点名、建筑名都是编造的；
// 星系用公共星系（NIH-02 是 00、Tama 低安、Jita 高安）。

import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../../../src/config/normalize'
import { DataNotReadyError } from '../../../src/core/data'
import { createIndustryLocations } from '../../../src/core/industry'
import { createMarketRegistry } from '../../../src/core/market'
import { createIndustryArgs, createQueryParser, industryArgsTail, industryArgsText } from '../../../src/core/parse'
import type { Access, CoreFailure, IndustryActivity, IndustryRequest } from '../../../src/core/types'
import { staticDataService } from '../../fixtures/data/load'
import { fixtureResolver } from '../items/helpers'

const PUBLIC: Access = { platform: 'qq', userId: 'u1', channelId: 'g-public', isDirect: false, isAdmin: false, allowed: false }
const ALLOWED: Access = { ...PUBLIC, channelId: 'g-allowed', allowed: true }

const RAVEN = 638
const DAMAGE_CONTROL_II = 2048
const TUNGSTEN_CARBIDE = 16672

const INDUSTRY = {
  locations: [
    { name: 'XX-1', aliases: '一号点', system: 'NIH-02', visibility: 'allowed', isDefault: true },
    { name: '联盟工业点A', system: 'Tama', visibility: 'public' },
    { name: 'XX-2', system: 'Jita', visibility: 'public' },
    { name: '联盟 工业点 B', system: '30000144', visibility: 'allowed' },
  ],
  structures: [
    { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', rigs: '37180', facilityTaxPct: 1 },
    { location: 'XX-1', name: '小厂', structureType: 'Azbel' },
    { location: '联盟工业点A', name: '反应塔', structureType: 'Athanor', activities: 'both', rigs: '46484' },
  ],
}

function setup(industry: Record<string, unknown> = INDUSTRY) {
  const { settings, issues } = normalizeConfig({ industry })
  expect(issues).toEqual([])
  const data = staticDataService()
  const items = fixtureResolver()
  const locations = createIndustryLocations(settings.industry, data)
  const parse = createIndustryArgs({ items, locations })
  return { settings, items, locations, parse }
}

const { parse } = setup()

function ok(text: string, access: Access = ALLOWED, activity: IndustryActivity = 'manufacturing'): Omit<IndustryRequest, 'access'> {
  const r = parse(text, activity, access)
  if ('ok' in r) throw new Error(`「${text}」应该解析成功，实际是 ${r.code}（${r.message ?? r.reason ?? ''}）`)
  const { access: _, ...rest } = r
  return rest
}

function bad(text: string, access: Access = ALLOWED, activity: IndustryActivity = 'manufacturing'): CoreFailure {
  const r = parse(text, activity, access)
  if (!('ok' in r)) throw new Error(`「${text}」应该失败`)
  return r
}

const base = { typeId: RAVEN, activity: 'manufacturing', mode: 'base', materials: false }

describe('industryArgs: item and quantity', () => {
  it('a bare item is the base reference', () => {
    expect(ok('乌鸦级')).toEqual(base)
    expect(ok('Raven')).toEqual(base)
    // 蓝图名换成产品
    expect(ok('乌鸦级蓝图')).toEqual(base)
    expect(ok('#638')).toEqual(base)
  })

  it('*N is the product quantity, N流程 the number of runs', () => {
    for (const text of ['乌鸦级*10', '乌鸦级 * 10', 'Raven x10', '10 乌鸦级', '乌鸦级 10', '乌鸦级*10艘', '乌鸦级＊１０']) {
      expect(ok(text), text).toEqual({ ...base, quantity: 10 })
    }
    for (const text of ['乌鸦级 20流程', '乌鸦级 20 流程', 'Raven 20runs']) {
      expect(ok(text), text).toEqual({ ...base, runs: 20 })
    }
    expect(ok('乌鸦级*3 20流程')).toEqual({ ...base, quantity: 3, runs: 20 })
    // 单独的「*N」写在地点后面也认
    expect(ok('乌鸦级 XX-1 *10')).toEqual({ ...base, mode: 'advanced', location: 'XX-1', quantity: 10 })
    expect(ok('乌鸦级 XX-1 ×1万')).toEqual({ ...base, mode: 'advanced', location: 'XX-1', quantity: 10_000 })
  })

  it('rejects quantities and runs out of range', () => {
    for (const text of ['乌鸦级*0', '乌鸦级*0.5']) expect(bad(text), text).toEqual({ ok: false, code: 'BAD_ARGUMENT', reason: 'quantity' })
    expect(bad('乌鸦级 XX-1 *0')).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'quantity' })
    for (const text of ['乌鸦级 0流程', '乌鸦级 10001流程']) {
      expect(bad(text), text).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'runs-range' })
    }
  })

  it('reports items it cannot use, with what is needed to rebuild the command', () => {
    expect(bad('乌鸦机')).toMatchObject({ code: 'ITEM_NOT_FOUND', token: '乌鸦机', rest: '', resolution: { kind: 'none' } })
    expect(bad('乌鸦机*5 XX-1 ME10 高级')).toMatchObject({ code: 'ITEM_NOT_FOUND', token: '乌鸦机', rest: '*5 XX-1 ME10 高级' })
    expect(bad('乌鸦机 20流程 材料')).toMatchObject({ token: '乌鸦机', rest: ' 20流程 材料' })
    // 反应产物：请用「反应」
    expect(bad('碳化钨*3')).toMatchObject({ code: 'IS_REACTION', token: '碳化钨', rest: '*3', resolution: { kind: 'out-of-scope', item: { typeId: TUNGSTEN_CARBIDE } } })
    // 写的是反应配方：resolution 里是它的产物（提示和按钮里要的是产物）
    expect(bad('碳化钨反应配方*20000 XX-1')).toMatchObject({
      code: 'IS_REACTION', token: '碳化钨反应配方', rest: '*20000 XX-1', resolution: { kind: 'out-of-scope', item: { typeId: TUNGSTEN_CARBIDE } },
    })
    // 原料没有蓝图
    expect(bad('三钛合金')).toMatchObject({ code: 'NOT_MANUFACTURABLE', resolution: { kind: 'out-of-scope', item: { typeId: 34 } } })
  })

  it('lists candidates for an ambiguous or fuzzy name, keeping the quantity and the location', () => {
    expect(bad('扩展装置*2 XX-1')).toMatchObject({
      code: 'ITEM_AMBIGUOUS', token: '扩展装置', rest: '*2 XX-1', resolution: { kind: 'confirm', candidates: [{ typeId: 3841 }] },
    })
    expect(bad('II')).toMatchObject({ code: 'ITEM_AMBIGUOUS', resolution: { kind: 'confirm', total: 4 } })
    // 唯一前缀照样能用
    expect(ok('损伤 XX-1')).toEqual({ ...base, typeId: DAMAGE_CONTROL_II, mode: 'advanced', location: 'XX-1' })
  })

  it('data not loaded yet', () => {
    const notReady = { current: () => { throw new DataNotReadyError() } }
    const unused = () => { throw new DataNotReadyError() }
    const { settings } = normalizeConfig({ industry: INDUSTRY })
    const p = createIndustryArgs({ items: { resolve: unused }, locations: createIndustryLocations(settings.industry, notReady) })
    expect(p('乌鸦级', 'manufacturing', ALLOWED)).toMatchObject({ ok: false, code: 'DATA_NOT_READY' })
  })
})

describe('industryArgs: parameters', () => {
  it('ME and TE in every accepted form', () => {
    for (const text of ['乌鸦级 ME10 TE20', '乌鸦级 me=10 te=20', '乌鸦级 ME 10 TE 20', '乌鸦级 ME:10 TE:20', '乌鸦级 10/20', '乌鸦级 TE20 ME10', '乌鸦级 ＭＥ１０ ＴＥ２０']) {
      expect(ok(text), text).toEqual({ ...base, me: 10, te: 20 })
    }
    expect(ok('乌鸦级 ME0')).toEqual({ ...base, me: 0 })
    // 「自定义」按钮填进去还没补数字的「ME」：当作没写
    expect(ok('乌鸦级 XX-1 高级 ME')).toEqual({ ...base, mode: 'steps', location: 'XX-1' })
    // 编号待办把 ME7 TE14 接在命令后面
    expect(ok('乌鸦级 XX-1 高级 ME7 TE14')).toEqual({ ...base, mode: 'steps', location: 'XX-1', me: 7, te: 14 })
  })

  it('ME 0–10, TE 0–20', () => {
    expect(bad('乌鸦级 ME11')).toMatchObject({ code: 'BAD_ARGUMENT', reason: 'me-range' })
    expect(bad('乌鸦级 TE21')).toMatchObject({ code: 'BAD_ARGUMENT', reason: 'te-range' })
    expect(bad('乌鸦级 11/20')).toMatchObject({ code: 'BAD_ARGUMENT', reason: 'me-range' })
  })

  it('structure, rigs and tax with any separator', () => {
    const at = { ...base, mode: 'advanced', location: 'XX-1' }
    for (const text of ['乌鸦级 XX-1 建筑:大厂', '乌鸦级 XX-1 建筑：大厂', '乌鸦级 XX-1 建筑=大厂', '乌鸦级 XX-1 建筑: 大厂']) {
      expect(ok(text), text).toEqual({ ...at, structure: '大厂' })
    }
    expect(ok('乌鸦级 XX-1 建筑:无')).toEqual({ ...at, structure: 'none' })
    expect(ok('乌鸦级 XX-1 建筑:?')).toEqual({ ...at, structure: '?' })
    expect(ok('乌鸦级 XX-1 建筑：？ 高级')).toEqual({ ...at, mode: 'steps', structure: '?' })
    expect(ok('乌鸦级 XX-1 建筑: 高级')).toEqual({ ...at, mode: 'steps', structure: '?' })
    for (const text of ['乌鸦级 XX-1 改装:默认', '乌鸦级 XX-1 rig:default', '乌鸦级 XX-1 用改装件']) {
      expect(ok(text), text).toEqual({ ...at, rigs: 'default' })
    }
    for (const text of ['乌鸦级 XX-1 改装:无', '乌鸦级 XX-1 改装件=none', '乌鸦级 XX-1 不用改装', '乌鸦级 XX-1 不用改装件', '乌鸦级 XX-1 无改装']) {
      expect(ok(text), text).toEqual({ ...at, rigs: 'none' })
    }
    expect(bad('乌鸦级 XX-1 改装:随便')).toMatchObject({ code: 'BAD_ARGUMENT', reason: 'rig-option' })
    for (const [text, tax] of [['税:1.5%', 1.5], ['税:1', 1], ['税：2％', 2], ['税率=0', 0], ['tax:0.25%', 0.25], ['税: 3%', 3]] as const) {
      expect(ok(`乌鸦级 XX-1 ${text}`), text).toEqual({ ...at, facilityTaxPct: tax })
    }
    for (const text of ['税:', '税:abc', '税:101%', '税:-1']) {
      expect(bad(`乌鸦级 XX-1 ${text}`), text).toMatchObject({ code: 'BAD_ARGUMENT', reason: 'tax-range' })
    }
  })

  it('advanced steps and the material list', () => {
    expect(ok('乌鸦级 高级')).toEqual({ ...base, mode: 'steps' })
    expect(ok('乌鸦级 材料')).toEqual({ ...base, materials: true })
    expect(ok('乌鸦级 XX-1 材料')).toEqual({ ...base, mode: 'advanced', location: 'XX-1', materials: true })
    // 建筑、改装件、税都要先有地点：从第 1 步问起
    expect(ok('乌鸦级 建筑:大厂')).toEqual({ ...base, mode: 'steps', structure: '大厂' })
    expect(ok('乌鸦级 税:1%')).toEqual({ ...base, mode: 'steps', facilityTaxPct: 1 })
  })

  it('a reaction has no ME/TE', () => {
    const reaction = { typeId: TUNGSTEN_CARBIDE, activity: 'reaction', mode: 'base', materials: false }
    expect(ok('碳化钨 ME10 TE20', ALLOWED, 'reaction')).toEqual(reaction)
    expect(ok('碳化钨反应配方 2流程', ALLOWED, 'reaction')).toEqual({ ...reaction, runs: 2 })
    expect(ok('碳化钨 联盟工业点A', ALLOWED, 'reaction')).toEqual({ ...reaction, mode: 'advanced', location: '联盟工业点A' })
    // 能制造的东西不在反应的范围里
    expect(bad('乌鸦级', ALLOWED, 'reaction')).toMatchObject({ code: 'OUT_OF_SCOPE', resolution: { kind: 'out-of-scope', item: { typeId: RAVEN } } })
    // 写的是蓝图：resolution 里是它的产品
    expect(bad('乌鸦级蓝图*2', ALLOWED, 'reaction')).toMatchObject({ code: 'OUT_OF_SCOPE', token: '乌鸦级蓝图', resolution: { item: { typeId: RAVEN } } })
  })
})

describe('industryArgs: location', () => {
  const at = (location: string) => ({ ...base, mode: 'advanced', location })

  it('after the item (the approved way) or before it, by name, alias or system name', () => {
    expect(ok('乌鸦级 XX-1')).toEqual(at('XX-1'))
    expect(ok('XX-1 乌鸦级')).toEqual(at('XX-1'))
    expect(ok('乌鸦级 一号点')).toEqual(at('XX-1'))
    // 「x1」是数量（整句当物品优先），不是叫 X1 的地点
    expect(ok('乌鸦级 x1')).toEqual({ ...base, quantity: 1 })
    expect(ok('乌鸦级 NIH-02')).toEqual(at('XX-1'))
    expect(ok('乌鸦级 塔玛')).toEqual(at('联盟工业点A'))
    expect(ok('Raven*10 XX-1 ME10 TE20')).toEqual({ ...at('XX-1'), quantity: 10, me: 10, te: 20 })
    expect(ok('10 Raven XX-1')).toEqual({ ...at('XX-1'), quantity: 10 })
    // 多词的地点名按最长匹配，空格写不写都行
    expect(ok('乌鸦级 联盟 工业点 B')).toEqual(at('联盟 工业点 B'))
    expect(ok('乌鸦级 联盟工业点B')).toEqual(at('联盟 工业点 B'))
    expect(ok('联盟 工业点 B 乌鸦级*2')).toEqual({ ...at('联盟 工业点 B'), quantity: 2 })
  })

  it('a location the group cannot see is the same as one that does not exist', () => {
    const visible = ['联盟工业点A', 'XX-2']
    expect(bad('乌鸦级 XX-1', PUBLIC)).toEqual({ ok: false, code: 'UNKNOWN_LOCATION', token: 'XX-1', rest: '乌鸦级', locations: visible })
    expect(bad('乌鸦级 XX-9', PUBLIC)).toEqual({ ok: false, code: 'UNKNOWN_LOCATION', token: 'XX-9', rest: '乌鸦级', locations: visible })
    // 按钮里保留原来的物品、数量和参数
    expect(bad('乌鸦级*10 XX-9 ME10 TE20 高级', PUBLIC)).toMatchObject({ token: 'XX-9', rest: '乌鸦级*10 ME10 TE20 高级' })
    expect(bad('XX-9 乌鸦级', PUBLIC)).toMatchObject({ code: 'UNKNOWN_LOCATION', token: 'XX-9', rest: '乌鸦级' })
    // 建筑名只属于写错的地点，不带；「建筑:无」「建筑:?」带着
    expect(bad('乌鸦级 XX-9 建筑:大工厂 改装:无 税:2%', PUBLIC)).toMatchObject({ token: 'XX-9', rest: '乌鸦级 改装:无 税:2%' })
    expect(bad('乌鸦级 XX-9 建筑:无', PUBLIC)).toMatchObject({ token: 'XX-9', rest: '乌鸦级 建筑:无' })
    // 反应只列能做反应的地点
    expect(bad('碳化钨 XX-9', ALLOWED, 'reaction')).toMatchObject({ code: 'UNKNOWN_LOCATION', locations: ['联盟工业点A'] })
  })

  it('the whole sentence wins when it is an item; a trailing number is a quantity, not a location', () => {
    expect(ok('乌鸦级 10')).toEqual({ ...base, quantity: 10 })
    expect(ok('Damage Control II')).toEqual({ ...base, typeId: DAMAGE_CONTROL_II })
    // 整句认不出、去掉末尾的词也认不出：按物品没找到回答
    expect(bad('完全不存在 XX-9')).toMatchObject({ code: 'ITEM_NOT_FOUND' })
  })
})

describe('industryArgsText', () => {
  it('writes the canonical order used by every button', () => {
    expect(industryArgsText({
      item: '乌鸦级', location: 'XX-1', me: 10, te: 20, structure: '索迪约', rigs: 'default', facilityTaxPct: 1,
    })).toBe('乌鸦级 XX-1 ME10 TE20 建筑:索迪约 改装:默认 税:1%')
    expect(industryArgsText({ item: '乌鸦级', quantity: 10, location: 'XX-1', steps: true })).toBe('乌鸦级*10 XX-1 高级')
    expect(industryArgsText({ item: '乌鸦级', runs: 20, quantity: 10, materials: true })).toBe('乌鸦级 20流程 材料')
    expect(industryArgsText({ item: '#638', structure: 'none', rigs: 'none', facilityTaxPct: 1.25 })).toBe('#638 建筑:无 改装:无 税:1.25%')
    expect(industryArgsText({ item: 'Raven', structure: '?' })).toBe('Raven 建筑:?')
    // 建筑名里的空格去掉（按去掉空格的写法也认得出）
    expect(industryArgsText({ item: 'Raven', structure: '大 厂' })).toBe('Raven 建筑:大厂')
    expect(industryArgsTail({})).toBe('')
  })

  it('every command it writes reads back to the same request', () => {
    const cases: Array<Parameters<typeof industryArgsText>[0]> = [
      { item: '乌鸦级', location: 'XX-1', me: 10, te: 20, structure: '大厂', rigs: 'default', facilityTaxPct: 1 },
      { item: '乌鸦级', quantity: 10, location: 'XX-1', steps: true, materials: true },
      { item: '乌鸦级', runs: 7, location: '联盟 工业点 B', me: 5, te: 10, structure: 'none', rigs: 'none' },
      { item: '#2048', quantity: 25, me: 2, te: 4 },
    ]
    for (const parts of cases) {
      const text = industryArgsText(parts)
      const r = ok(text)
      expect(r.location, text).toBe(parts.location)
      expect([r.quantity, r.runs, r.me, r.te, r.structure, r.rigs, r.facilityTaxPct, r.materials], text)
        .toEqual([parts.quantity, parts.runs, parts.me, parts.te, parts.structure, parts.rigs, parts.facilityTaxPct, !!parts.materials])
      expect(r.mode === 'steps', text).toBe(!!parts.steps)
    }
  })
})

describe('QueryParser.industryArgs', () => {
  it('uses the industry parser when it is wired, NOT_CONFIGURED otherwise', () => {
    const { items, locations } = setup()
    const { settings } = normalizeConfig({})
    const markets = createMarketRegistry(settings, staticDataService())
    const wired = createQueryParser({ items, markets, industry: createIndustryArgs({ items, locations }) })
    expect(wired.industryArgs('乌鸦级 XX-1', 'manufacturing', ALLOWED)).toMatchObject({ typeId: RAVEN, location: 'XX-1', mode: 'advanced' })
    const bare = createQueryParser({ items, markets })
    expect(bare.industryArgs('乌鸦级', 'manufacturing', ALLOWED)).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
  })
})
