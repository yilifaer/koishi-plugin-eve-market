import { afterEach, describe, expect, it } from 'vitest'
import { EsiError, parseIndustrySystems, parseRegionOrders, parseServerStatus, parseStructureOrders } from '../../../src/core/esi'
import { rawOrder } from '../../fakes/fake-esi'
import { JITA, JITA_4_4, RAVEN, STRUCTURE, THE_FORGE, TRITANIUM, authFrom, closeAll, makeEnv } from './helpers'

afterEach(closeAll)

describe('EsiApi: markets', () => {
  it('region orders: buy and sell together, filtered by type, fields renamed and ranges as numbers', async () => {
    const sell = rawOrder({ price: 251_000_000, volume_remain: 2, range: 'region' })
    const buy = rawOrder({ is_buy_order: true, price: 240_000_000, min_volume: 2, range: '5', location_id: 60008494, system_id: 30002187 })
    const other = rawOrder({ type_id: TRITANIUM, price: 4.5 })
    const env = await makeEnv({}, (f) => f.regionOrders.set(THE_FORGE, [sell, buy, other]))
    const res = await env.api.regionOrders(THE_FORGE, RAVEN)
    expect(res.value).toEqual([
      {
        orderId: sell.order_id, typeId: RAVEN, locationId: JITA_4_4, systemId: JITA, isBuyOrder: false, price: 251_000_000,
        volumeRemain: 2, volumeTotal: 5, minVolume: 1, range: 'region', duration: 90, issued: Date.UTC(2026, 9, 1, 8),
      },
      {
        orderId: buy.order_id, typeId: RAVEN, locationId: 60008494, systemId: 30002187, isBuyOrder: true, price: 240_000_000,
        volumeRemain: 3, volumeTotal: 5, minVolume: 2, range: 5, duration: 90, issued: Date.UTC(2026, 9, 1, 8),
      },
    ])
    expect(res.pages).toBe(1)
    expect(res.lastModified).not.toBeNull()
  })

  it('region orders: an empty market is an empty list, not an error', async () => {
    const env = await makeEnv()
    const res = await env.api.regionOrders(THE_FORGE, RAVEN)
    expect(res.value).toEqual([])
    expect(res.pages).toBe(1)
  })

  it('structure orders need a token and come without system_id', async () => {
    const env = await makeEnv({}, (f) => {
      f.pageSize = 2
      f.structureOrders.set(STRUCTURE, [rawOrder({ location_id: STRUCTURE }), rawOrder({ location_id: STRUCTURE, is_buy_order: true }), rawOrder({ location_id: STRUCTURE, range: 'station' })])
    })
    const { access } = env.fake.issueTokens()
    const res = await env.api.structureOrders(STRUCTURE, { auth: authFrom(() => access, 'alliance') })
    expect(res.pages).toBe(2)
    expect(res.value.map((o) => [o.locationId, o.isBuyOrder, o.range])).toEqual([[STRUCTURE, false, 'region'], [STRUCTURE, true, 'region'], [STRUCTURE, false, 'station']])
    expect(res.value[0]).not.toHaveProperty('systemId')
    expect(env.fake.requests.map((r) => [r.path, r.query.get('page'), r.headers.authorization])).toEqual([
      [`/markets/structures/${STRUCTURE}`, '1', `Bearer ${access}`],
      [`/markets/structures/${STRUCTURE}`, '2', `Bearer ${access}`],
    ])
    // 不同授权档案的缓存分开
    expect(env.client.keyOf({ route: 'x', path: `/markets/structures/${STRUCTURE}`, query: { page: 1 }, ttlSec: 1, parse: (j) => j }, authFrom(() => access, 'alliance'))).toContain('profile=alliance')
  })

  it('structure orders: losing access is a 403', async () => {
    const env = await makeEnv({}, (f) => f.forbiddenStructures.add(STRUCTURE))
    const { access } = env.fake.issueTokens()
    const error = await env.api.structureOrders(STRUCTURE, { auth: authFrom(() => access) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EsiError)
    expect(error).toMatchObject({ kind: 'http', status: 403, code: 'Market access denied' })
  })

  it('history by region and type', async () => {
    const env = await makeEnv({}, (f) => f.history.set(`${THE_FORGE}:${RAVEN}`, [
      { date: '2026-10-05', average: 250e6, highest: 260e6, lowest: 240e6, volume: 31, order_count: 120 },
      { date: '2026-10-06', average: 252e6, highest: 255e6, lowest: 249e6, volume: 28, order_count: 117 },
    ]))
    const res = await env.api.history(THE_FORGE, RAVEN)
    expect(env.fake.requests[0].path).toBe('/markets/10000002/history')
    expect(env.fake.requests[0].query.get('type_id')).toBe(String(RAVEN))
    expect(res.value[1]).toEqual({ date: '2026-10-06', average: 252e6, highest: 255e6, lowest: 249e6, volume: 28, orderCount: 117 })
  })

  it('adjusted prices: either price may be missing', async () => {
    const env = await makeEnv({}, (f) => {
      f.prices = [{ type_id: RAVEN, adjusted_price: 245e6, average_price: 251e6 }, { type_id: TRITANIUM, average_price: 4.1 }]
    })
    expect((await env.api.prices()).value).toEqual([
      { typeId: RAVEN, adjustedPrice: 245e6, averagePrice: 251e6 },
      { typeId: TRITANIUM, adjustedPrice: null, averagePrice: 4.1 },
    ])
  })
})

describe('EsiApi: industry, incursions, status', () => {
  it('system cost indices keyed by activity; unknown activities are ignored', async () => {
    const env = await makeEnv({}, (f) => {
      f.industrySystems = [{ solar_system_id: JITA, cost_indices: [
        { activity: 'manufacturing', cost_index: 0.0746108842 },
        { activity: 'reaction', cost_index: 0.0012 },
        { activity: 'something_new', cost_index: 9 },
      ] }]
    })
    const res = await env.api.industrySystems()
    expect(res.value).toEqual([{ systemId: JITA, costIndices: { manufacturing: 0.0746108842, reaction: 0.0012 } }])
    expect(env.fake.requests[0].path).toBe('/industry/systems')
  })

  it('incursions', async () => {
    const env = await makeEnv({}, (f) => {
      f.incursions = [{
        constellation_id: 20000020, faction_id: 500019, has_boss: true, infested_solar_systems: [30000142, 30000144],
        influence: 0.6, staging_solar_system_id: 30000144, state: 'established', type: 'Incursion',
      }]
    })
    expect((await env.api.incursions()).value).toEqual([{
      constellationId: 20000020, factionId: 500019, hasBoss: true, infestedSystems: [30000142, 30000144],
      influence: 0.6, stagingSystemId: 30000144, state: 'established', type: 'Incursion',
    }])
  })

  it('server status', async () => {
    const env = await makeEnv()
    expect((await env.api.serverStatus()).value).toEqual({ players: 23456, serverVersion: '3000001', startTime: Date.UTC(2026, 9, 7, 11, 5, 12), vip: false })
  })
})

describe('EsiApi: universe', () => {
  it('names: one POST with sorted, unique IDs', async () => {
    const env = await makeEnv({}, (f) => {
      f.names.set(JITA, { name: 'Jita', category: 'solar_system' })
      f.names.set(RAVEN, { name: 'Raven', category: 'inventory_type' })
    })
    const res = await env.api.names([JITA, RAVEN, JITA])
    const [req] = env.fake.requests
    expect(req.method).toBe('POST')
    expect(req.headers['content-type']).toBe('application/json')
    expect(JSON.parse(req.body)).toEqual([RAVEN, JITA])
    expect(res.value).toEqual([{ id: RAVEN, name: 'Raven', category: 'inventory_type' }, { id: JITA, name: 'Jita', category: 'solar_system' }])
    expect((await env.api.names([RAVEN, JITA])).cached).toBe(true)
  })

  it('ids: exact names in the requested language; categories without hits are empty', async () => {
    const env = await makeEnv({}, (f) => {
      f.idNames.zh.set('乌鸦级', { category: 'inventory_types', id: RAVEN, name: '乌鸦级' })
      f.idNames.en.set('raven', { category: 'inventory_types', id: RAVEN, name: 'Raven' })
    })
    const zh = await env.api.ids([' 乌鸦级 ', '乌鸦级', '不存在的东西'], 'zh')
    expect(env.fake.requests[0].headers['accept-language']).toBe('zh')
    expect(JSON.parse(env.fake.requests[0].body)).toEqual(['乌鸦级', '不存在的东西'])
    expect(zh.value.inventoryTypes).toEqual([{ id: RAVEN, name: '乌鸦级' }])
    expect(zh.value.systems).toEqual([])
    const en = await env.api.ids(['Raven'], 'en')
    expect(env.fake.requests[1].headers['accept-language']).toBe('en')
    expect(en.value.inventoryTypes).toEqual([{ id: RAVEN, name: 'Raven' }])
  })

  it('type information, and 404 for an unknown type', async () => {
    const env = await makeEnv({}, (f) => {
      f.types.set(99_000_001, { type_id: 99_000_001, name: 'Brand New Hull', description: '', group_id: 25, market_group_id: 61, published: true, volume: 50000, packaged_volume: 2500, capacity: 400, portion_size: 1 })
      f.types.set(99_000_002, { type_id: 99_000_002, name: 'Unsellable Thing', description: '', group_id: 1, published: true })
    })
    expect((await env.api.type(99_000_001, { language: 'zh' })).value).toEqual({
      typeId: 99_000_001, name: 'Brand New Hull', groupId: 25, marketGroupId: 61, published: true, volume: 50000, packagedVolume: 2500, capacity: 400, portionSize: 1,
    })
    expect(env.fake.requests[0].headers['accept-language']).toBe('zh')
    expect((await env.api.type(99_000_002)).value).toMatchObject({ marketGroupId: null, volume: null, packagedVolume: null })
    await expect(env.api.type(99_000_003)).rejects.toMatchObject({ kind: 'http', status: 404 })
  })

  it('structure information and structure search (authorized)', async () => {
    const env = await makeEnv({}, (f) => {
      f.structureInfo.set(STRUCTURE, { name: 'TEST-1 - Market Hub', owner_id: 98000001, solar_system_id: 30000001, type_id: 35833 })
      f.searchResults.set('Market Hub', [STRUCTURE])
    })
    const { access } = env.fake.issueTokens()
    const auth = authFrom(() => access)
    expect((await env.api.structure(STRUCTURE, { auth })).value).toEqual({ name: 'TEST-1 - Market Hub', ownerId: 98000001, solarSystemId: 30000001, typeId: 35833 })
    expect((await env.api.searchStructures(2112000001, 'Market Hub', { auth })).value).toEqual([STRUCTURE])
    expect((await env.api.searchStructures(2112000001, 'Nothing', { auth })).value).toEqual([])
    const search = env.fake.requests.find((r) => r.path.endsWith('/search'))!
    expect(Object.fromEntries(search.query)).toEqual({ categories: 'structure', search: 'Market Hub' })
  })
})

describe('EsiApi: argument checks', () => {
  it('refuses IDs that cannot be right before sending anything', async () => {
    const env = await makeEnv()
    expect(() => env.api.regionOrders(0, RAVEN)).toThrow(RangeError)
    expect(() => env.api.history(THE_FORGE, 1.5)).toThrow(RangeError)
    expect(() => env.api.names([])).toThrow(RangeError)
    expect(() => env.api.names(Array.from({ length: 1001 }, (_, i) => i + 1))).toThrow(RangeError)
    expect(() => env.api.ids(['  '], 'en')).toThrow(RangeError)
    expect(env.fake.requests).toHaveLength(0)
  })
})

describe('response shapes', () => {
  it('rejects rows with missing or mistyped fields, naming the row and field', () => {
    const good = rawOrder()
    expect(() => parseRegionOrders({})).toThrow('orders 应该是数组')
    expect(() => parseRegionOrders([good, 'x'])).toThrow('orders[1] 应该是对象')
    expect(() => parseRegionOrders([{ ...good, price: '1' }])).toThrow('orders[0] 的 price 应该是数字')
    expect(() => parseRegionOrders([{ ...good, volume_remain: 1.5 }])).toThrow('volume_remain 应该是整数')
    expect(() => parseRegionOrders([{ ...good, range: 'galaxy' }])).toThrow('range')
    expect(() => parseRegionOrders([{ ...good, issued: 'yesterday' }])).toThrow('issued')
    const { system_id: _, ...noSystem } = good
    expect(() => parseRegionOrders([noSystem])).toThrow('system_id')
    expect(parseStructureOrders([noSystem])).toHaveLength(1)
  })

  it('accepts every documented range', () => {
    const ranges = ['station', 'region', 'solarsystem', '1', '2', '3', '4', '5', '10', '20', '30', '40']
    expect(parseRegionOrders(ranges.map((range) => rawOrder({ range }))).map((o) => o.range)).toEqual(['station', 'region', 'solarsystem', 1, 2, 3, 4, 5, 10, 20, 30, 40])
  })

  it('cost indices must be a list; status vip defaults to false', () => {
    expect(() => parseIndustrySystems([{ solar_system_id: 1 }])).toThrow('cost_indices')
    expect(parseServerStatus({ players: 1, server_version: 'x', start_time: '2026-10-07T11:00:00Z' }).vip).toBe(false)
  })
})
