import { describe, expect, it } from 'vitest'
import { PRESET_MARKETS } from '../../../src/config/presets'
import { DataNotReadyError, loadDataSet } from '../../../src/core/data'
import { createMarketRegistry } from '../../../src/core/market'
import type { MarketDef } from '../../../src/core/types'
import { loadFixtureData, staticDataService } from '../../fixtures/data/load'
import { makeVersion } from '../data/helpers'
import {
  ALLOWED, AMARR_STATION, DOMAIN, JITA, JITA_4_4, PERIMETER, PUBLIC, STRUCTURE_A, STRUCTURE_B, STRUCTURE_ROWS, THE_FORGE,
  ambiguous, fakeResolver, item, settingsOf, unique,
} from './helpers'

const GREAT_WILDLANDS = 10000011
const NIH_02 = 30000900

function registry(raw: Record<string, unknown> = {}, data = staticDataService()) {
  return createMarketRegistry(settingsOf(raw), data)
}

const keys = (list: MarketDef[]) => list.map((m) => m.key)

describe('MarketRegistry: rows resolved through universe data', () => {
  it('fills system and region for the preset trade hubs and adds system names as aliases', () => {
    const r = registry()
    expect(r.issues()).toEqual([])
    expect(keys(r.all())).toEqual(['jita 4-4', 'amarr', 'dodixie', 'rens', 'hek'])
    expect(r.get('jita 4-4')).toEqual({
      key: 'jita 4-4', name: 'Jita 4-4', aliases: ['4-4', 'Jita', '吉他'], shortAlias: 'Jita', type: 'npc-station',
      regionId: THE_FORGE, systemId: JITA, locationId: JITA_4_4, inDefaultList: true, sortOrder: 0, visibility: 'public',
    })
    // 名称和星系英文名相同时，星系名不重复算别名
    expect(r.get('amarr')).toMatchObject({ aliases: ['艾玛'], shortAlias: 'Amarr', regionId: DOMAIN, locationId: AMARR_STATION, inDefaultList: false })
    expect(Object.isFrozen(r.get('amarr'))).toBe(true)
  })

  it('resolves system and region markets by Chinese name, English name or ID', () => {
    const r = registry({
      markets: [
        PRESET_MARKETS[0],
        { name: '伏尔戈', type: 'region', location: 'The Forge' },
        { name: 'Domain 星域', type: 'region', location: String(DOMAIN) },
        { name: '皮尔米特', type: 'system', location: '皮尔米特' },
        { name: 'Jita 星系', type: 'system', location: String(JITA) },
      ],
    })
    expect(r.issues()).toEqual([])
    expect(r.get('伏尔戈')).toMatchObject({ type: 'region', regionId: THE_FORGE, aliases: [] })
    expect(r.get('domain 星域')).toMatchObject({ regionId: DOMAIN })
    expect(r.get('皮尔米特')).toMatchObject({ type: 'system', systemId: PERIMETER, regionId: THE_FORGE, aliases: ['Perimeter'] })
    // 星系名已经是第 1 行 Jita 4-4 的自动别名：先到先得
    expect(r.get('jita 星系')).toMatchObject({ systemId: JITA, aliases: [] })
  })

  it('skips rows whose location is not in the data and reports them', () => {
    const r = registry({
      markets: [
        ...PRESET_MARKETS.slice(0, 1),
        { name: '不存在的站', type: 'npc-station', location: '60099999' },
        { name: '不存在的星系', type: 'system', location: 'Nowhere' },
        { name: '不存在的星域', type: 'region', location: 'Atlantis' },
        { name: '建筑甲', type: 'structure', location: String(STRUCTURE_A), system: 'Nowhere', authProfile: '' },
        { name: '建筑乙', type: 'structure', location: String(STRUCTURE_B), system: 'Nowhere' },
      ],
    })
    expect(keys(r.all())).toEqual(['jita 4-4', '建筑乙'])
    expect(r.issues()).toEqual([
      { section: 'markets', row: 2, field: 'location', message: '「位置」空间站 60099999 在数据里找不到，已跳过' },
      { section: 'markets', row: 3, field: 'location', message: '「位置」星系「Nowhere」在数据里找不到，已跳过' },
      { section: 'markets', row: 4, field: 'location', message: '「位置」星域「Atlantis」在数据里找不到，已跳过' },
      { section: 'markets', row: 5, field: 'system', message: '「建筑所在星系」Nowhere 在数据里找不到，已跳过' },
      { section: 'markets', row: 6, field: 'system', message: '「建筑所在星系」Nowhere 在数据里找不到' },
    ])
    // 有授权档案的建筑照样能用（星系以后由同步得到），只是暂时不知道星域
    expect(r.get('建筑乙')).toMatchObject({ regionId: null, locationId: STRUCTURE_B, authProfile: 'default' })
  })

  it('structure markets: system from the console, or learned later from the sync', () => {
    const r = registry({ markets: [...PRESET_MARKETS, ...STRUCTURE_ROWS, { name: '建筑丙', type: 'structure', location: '1000000000003' }] })
    expect(r.get('联盟市场a')).toMatchObject({
      type: 'structure', regionId: GREAT_WILDLANDS, systemId: NIH_02, locationId: STRUCTURE_A, authProfile: 'default',
      visibility: 'allowed', inDefaultList: true, aliases: ['前线'], shortAlias: '联盟市场A',
    })
    expect(r.get('公开建筑')).toMatchObject({ regionId: THE_FORGE, systemId: PERIMETER, visibility: 'public' })
    expect(r.get('公开建筑')).not.toHaveProperty('authProfile')
    expect(r.get('建筑丙')).toMatchObject({ regionId: null })
    expect(r.get('建筑丙')).not.toHaveProperty('systemId')

    expect(r.locateStructure('建筑丙', NIH_02)).toBe(true)
    expect(r.get('建筑丙')).toMatchObject({ regionId: GREAT_WILDLANDS, systemId: NIH_02 })
    expect(r.locateStructure('建筑丙', NIH_02)).toBe(false)
  })
})

describe('MarketRegistry: names and aliases', () => {
  const r = registry({ markets: [...PRESET_MARKETS, ...STRUCTURE_ROWS] })

  it('matches names, hand aliases and system names case-insensitively, with or without spaces', () => {
    for (const token of ['Jita 4-4', 'JITA 4-4', 'jita4-4', 'Ｊｉｔａ　４－４', 'jita 4—4', '4-4', 'jita', '吉他']) {
      expect(r.match(token, PUBLIC)?.key, token).toBe('jita 4-4')
    }
    expect(r.match('艾玛', PUBLIC)?.key).toBe('amarr')
    expect(r.match('Jita 4', PUBLIC)).toBeNull()
    expect(r.match('', PUBLIC)).toBeNull()
  })

  it('hand-written aliases beat automatic system names without a report', () => {
    const r2 = registry({
      markets: [
        ...PRESET_MARKETS,
        { name: 'Jita 星系', type: 'system', location: 'Jita', aliases: '吉他' },
      ],
    })
    expect(r2.issues()).toEqual([])
    expect(r2.match('吉他', PUBLIC)?.key).toBe('jita 星系')
    expect(r2.get('jita 4-4')?.aliases).toEqual(['4-4', 'Jita'])
    // 两个市场的自动别名相同：先到先得
    expect(r2.match('jita', PUBLIC)?.key).toBe('jita 4-4')
    expect(r2.get('jita 星系')?.aliases).toEqual(['吉他'])
  })

  it('markets a group cannot see do not exist there', () => {
    expect(r.match('前线', PUBLIC)).toBeNull()
    expect(r.match('联盟市场A', PUBLIC)).toBeNull()
    expect(r.match('前线', ALLOWED)?.key).toBe('联盟市场a')
    expect(keys(r.visible(PUBLIC))).toEqual(['jita 4-4', '公开建筑', 'amarr', 'dodixie', 'rens', 'hek'])
    expect(keys(r.visible(ALLOWED))).toEqual(['jita 4-4', '联盟市场a', '公开建筑', 'amarr', 'dodixie', 'rens', 'hek'])
    // get 不看可见范围
    expect(r.get('联盟市场a')?.name).toBe('联盟市场A')
  })

  it('defaults list the base market and structures the group can see, by sort order', () => {
    expect(keys(r.defaults(PUBLIC))).toEqual(['jita 4-4', '公开建筑'])
    expect(keys(r.defaults(ALLOWED))).toEqual(['jita 4-4', '联盟市场a', '公开建筑'])
  })

  it('defaults never come back empty', () => {
    const r2 = registry({ markets: PRESET_MARKETS.map((m) => ({ ...m, inDefaultList: 'no' })) })
    expect(keys(r2.defaults(PUBLIC))).toEqual(['jita 4-4'])
  })

  it('splits a leading market through the registry (longest name first)', () => {
    const raven = item(638, 'Raven', '乌鸦级')
    const items = fakeResolver({ 乌鸦级: unique(raven), raven: unique(raven), r: ambiguous('prefix', raven) })
    expect(r.split('Jita 4-4 乌鸦级', PUBLIC, items, 'market')).toEqual({ market: r.get('jita 4-4'), rest: '乌鸦级' })
    expect(r.split('前线 乌鸦级', ALLOWED, items, 'market')).toEqual({ market: r.get('联盟市场a'), rest: '乌鸦级' })
    expect(r.split('前线 乌鸦级', PUBLIC, items, 'market')).toEqual({ rest: '乌鸦级', unknown: '前线' })
  })
})

describe('MarketRegistry: market references in the config', () => {
  it('resolves references written as a system name once the data is loaded', () => {
    // 本地认不出「吉他」，normalize 把第一个公开市场（Amarr）当成了默认列表里的那个
    const raw = { markets: [{ ...PRESET_MARKETS[1], inDefaultList: 'auto' }, PRESET_MARKETS[0]], price: { baseMarket: '吉他' } }
    expect(settingsOf(raw).markets.map((m) => [m.key, m.inDefaultList])).toEqual([['amarr', true], ['jita 4-4', false]])
    const r = registry(raw)
    expect(r.issues()).toEqual([])
    expect(r.base()?.key).toBe('jita 4-4')
    expect(r.configured('appraisal.defaultMarket')?.key).toBe('jita 4-4')
    expect(keys(r.defaults(PUBLIC))).toEqual(['jita 4-4'])
  })

  it('reports references it cannot find and falls back to the base market, then the first public one', () => {
    const r = registry({ appraisal: { defaultMarket: 'Nowhere', fallbackMarket: 'Atlantis' } })
    expect(r.configured('appraisal.defaultMarket')?.key).toBe('jita 4-4')
    expect(r.configured('appraisal.fallbackMarket')?.key).toBe('jita 4-4')
    expect(r.issues()).toEqual([
      { section: 'appraisal', field: 'defaultMarket', message: '「默认市场」写的「Nowhere」找不到这个市场，改用 Jita 4-4' },
      { section: 'appraisal', field: 'fallbackMarket', message: '「回退市场」写的「Atlantis」找不到这个市场，改用 Jita 4-4' },
    ])

    const r2 = registry({ markets: PRESET_MARKETS.slice(1), price: { baseMarket: 'Jita' }, appraisal: { defaultMarket: 'Hek' } })
    expect(r2.base()?.key).toBe('amarr')
    expect(r2.issues()).toEqual([{ section: 'price', field: 'baseMarket', message: '「基准市场」写的「Jita」找不到这个市场，改用 Amarr' }])
  })

  it('empty references: no base market means no comparison; the fallback market stays off', () => {
    const r = registry({ price: { baseMarket: '' } })
    expect(r.base()).toBeUndefined()
    expect(r.configured('price.baseMarket')).toBeUndefined()
    expect(r.configured('appraisal.fallbackMarket')).toBeUndefined()
    expect(r.configured('appraisal.defaultMarket')?.key).toBe('jita 4-4')
    expect(r.issues()).toEqual([])
  })

  it('a referenced market the group cannot see quietly becomes the base market', () => {
    const r = registry({ markets: [...PRESET_MARKETS, ...STRUCTURE_ROWS], appraisal: { defaultMarket: '前线' } })
    expect(r.configured('appraisal.defaultMarket')?.key).toBe('联盟市场a')
    expect(r.configured('appraisal.defaultMarket', ALLOWED)?.key).toBe('联盟市场a')
    expect(r.configured('appraisal.defaultMarket', PUBLIC)?.key).toBe('jita 4-4')
    expect(r.issues()).toEqual([])

    // 基准市场本身也看不到：用第一个公开市场
    const r2 = registry({ markets: [...PRESET_MARKETS, ...STRUCTURE_ROWS], price: { baseMarket: '前线' }, appraisal: { defaultMarket: '前线' } })
    expect(r2.configured('appraisal.defaultMarket', PUBLIC)?.key).toBe('jita 4-4')
    expect(r2.configured('price.baseMarket', PUBLIC)?.key).toBe('jita 4-4')
  })

  it('industry references stay quiet until the industry section exists', () => {
    const r = registry({ industry: undefined, markets: PRESET_MARKETS.slice(1) })
    expect(r.issues().filter((i) => i.section === 'industry')).toEqual([])
    expect(r.configured('industry.materialMarket')?.key).toBe('amarr')
  })
})

describe('MarketRegistry: data lifecycle', () => {
  it('is empty (not broken) before the data is ready', () => {
    const r = createMarketRegistry(settingsOf(), { current: () => { throw new DataNotReadyError() } })
    expect(r.all()).toEqual([])
    expect(r.match('jita', PUBLIC)).toBeNull()
    expect(r.defaults(PUBLIC)).toEqual([])
    expect(r.base()).toBeUndefined()
  })

  it('rebuilds after a data update', () => {
    const data = staticDataService()
    const r = registry({}, data)
    expect(r.get('jita 4-4')?.locationId).toBe(JITA_4_4)
    const v = makeVersion({
      revision: 2,
      edit: (json) => {
        const u = json['universe.json']
        u.stations = u.stations.filter((row: number[]) => row[0] !== JITA_4_4)
      },
    })
    data.update(loadDataSet(v.manifest, v.files, 'online', loadFixtureData().loadedAt + 1))
    expect(r.get('jita 4-4')).toBeUndefined()
    expect(r.issues()).toContainEqual({ section: 'markets', row: 1, field: 'location', message: '「位置」空间站 60003760 在数据里找不到，已跳过' })
  })
})
