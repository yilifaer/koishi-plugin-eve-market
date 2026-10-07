import { describe, expect, it } from 'vitest'
import { PRESET_MARKETS } from '../../../src/config/presets'
import type { EsiPagedResult, EsiRegionOrder } from '../../../src/core/esi'
import { createMarketRegistry, createMarketService } from '../../../src/core/market'
import type { StructureRead, StructureSource } from '../../../src/core/market'
import type { MarketDef, MarketSourceStatus } from '../../../src/core/types'
import { staticDataService } from '../../fixtures/data/load'
import { FakeTime } from '../../fakes/fake-time'
import { MemoryLogger } from '../esi/helpers'
import {
  DOMAIN, FakeOrdersApi, JITA_OTHER_STATION, PERIMETER, PERIMETER_STATION, PLEX, RAVEN, STRUCTURE_A, STRUCTURE_B,
  STRUCTURE_ROWS, THE_FORGE, TRITANIUM, deferred, httpError, order, settingsOf,
} from './helpers'

const MIN = 60_000
const GLOBAL = 19000001

const MARKETS = [
  ...PRESET_MARKETS,
  ...STRUCTURE_ROWS,
  { name: 'Jita 星系', type: 'system', location: 'Jita' },
  { name: '伏尔戈', type: 'region', location: 'The Forge' },
  { name: '同步中的建筑', type: 'structure', location: '1000000000004' },
]

/** Jita 4-4、Jita 别的空间站、Perimeter 各有卖单和买单 */
function forgeRaven() {
  return [
    order({ price: 258, volumeRemain: 2 }),
    order({ price: 255, locationId: JITA_OTHER_STATION }),
    order({ price: 240, locationId: PERIMETER_STATION, systemId: PERIMETER }),
    order({ price: 245, locationId: STRUCTURE_B, systemId: PERIMETER }),
    order({ isBuyOrder: true, price: 249, range: 'region' }),
    order({ isBuyOrder: true, price: 251, locationId: JITA_OTHER_STATION, range: 'region' }),
    order({ isBuyOrder: true, price: 253, locationId: PERIMETER_STATION, systemId: PERIMETER, range: 'region' }),
    order({ isBuyOrder: true, price: 300, minVolume: 50, range: 'region' }),
  ]
}

function setup(opts: { structures?: StructureSource; start?: number } = {}) {
  const time = new FakeTime(opts.start)
  const api = new FakeOrdersApi(() => time.now())
  const logger = new MemoryLogger()
  const registry = createMarketRegistry(settingsOf({ markets: MARKETS }), staticDataService())
  const service = createMarketService({ registry, esi: api, clock: time, scheduler: time, logger, structures: opts.structures })
  return { time, api, logger, registry, service }
}

describe('MarketService.getQuote: NPC markets from region orders', () => {
  it('a station quote: sell and buy only from orders in that station', async () => {
    const { time, api, service } = setup()
    api.set(THE_FORGE, RAVEN, { orders: forgeRaven(), lastModified: time.now() - 2 * MIN })
    expect(await service.getQuote('jita 4-4', RAVEN)).toEqual({
      marketKey: 'jita 4-4',
      typeId: RAVEN,
      sell: { best: 258, volumeAtBest: 2, orders: 1, totalVolume: 2 },
      buy: { best: 249, volumeAtBest: 1, orders: 1, totalVolume: 1 },
      mid: 253.5,
      status: 'ok',
      dataTime: time.now() - 2 * MIN,
      ageSec: 120,
      source: 'region',
    })
  })

  it('system and region markets share the same request and filter locally', async () => {
    const { api, service } = setup()
    api.set(THE_FORGE, RAVEN, { orders: forgeRaven() })
    const [system, region] = await Promise.all([service.getQuote('jita 星系', RAVEN), service.getQuote('伏尔戈', RAVEN)])
    expect([system.sell?.best, system.buy?.best]).toEqual([255, 251])
    expect([region.sell?.best, region.buy?.best]).toEqual([240, 253])
    expect(api.calls.map((c) => [c.regionId, c.typeId])).toEqual([[THE_FORGE, RAVEN]])
  })

  it('other trade hubs ask their own region', async () => {
    const { api, service } = setup()
    await service.getQuote('amarr', RAVEN)
    expect(api.calls.map((c) => c.regionId)).toEqual([DOMAIN])
  })

  it('quantity decides which buy orders count (min_volume ≤ qty)', async () => {
    const { api, service } = setup()
    api.set(THE_FORGE, RAVEN, { orders: forgeRaven() })
    expect((await service.getQuote('jita 4-4', RAVEN, { qty: 50 })).buy?.best).toBe(300)
    expect((await service.getQuote('jita 4-4', RAVEN, { qty: 49 })).buy?.best).toBe(249)
    expect((await service.getQuote('jita 4-4', RAVEN, { qty: Number.NaN })).buy?.best).toBe(249)
  })

  it('no orders: both sides null, never 0', async () => {
    const { service } = setup()
    expect(await service.getQuote('jita 4-4', TRITANIUM)).toMatchObject({ status: 'ok', sell: null, buy: null, mid: null })
  })

  it('PLEX comes from the global market region, unfiltered, whatever market was asked', async () => {
    const { api, service } = setup()
    api.set(GLOBAL, PLEX, { orders: [order({ typeId: PLEX, price: 5_012_000, locationId: 60000000, systemId: 31000000 }), order({ typeId: PLEX, isBuyOrder: true, price: 4_861_000, locationId: 1, systemId: 2 })] })
    for (const key of ['jita 4-4', 'amarr', '联盟市场a']) {
      const quote = await service.getQuote(key, PLEX)
      expect(quote).toMatchObject({ marketKey: key, source: 'global', status: 'ok', sell: { best: 5_012_000 }, buy: { best: 4_861_000 } })
    }
    expect(new Set(api.calls.map((c) => c.regionId))).toEqual(new Set([GLOBAL]))
  })

  it('structures without an auth profile read their public orders from the region', async () => {
    const { api, service } = setup()
    api.set(THE_FORGE, RAVEN, { orders: forgeRaven() })
    expect(await service.getQuote('公开建筑', RAVEN)).toMatchObject({ source: 'region', status: 'ok', sell: { best: 245 }, buy: null })
    expect(await service.getQuote('nowhere', RAVEN)).toMatchObject({ status: 'unavailable', marketKey: 'nowhere', detail: '没有这个市场' })
  })

  it('a market whose region is unknown cannot be priced from region orders', async () => {
    const lost: MarketDef = {
      key: 'lost', name: '没有星系的建筑', aliases: [], shortAlias: 'lost', type: 'structure', regionId: null, locationId: 1_000_000_000_003,
      inDefaultList: false, sortOrder: 0, visibility: 'public',
    }
    const time = new FakeTime()
    const api = new FakeOrdersApi(() => time.now())
    const registry = { get: (key: string) => (key === 'lost' ? lost : undefined), all: () => [lost] }
    const service = createMarketService({ registry, esi: api, clock: time, scheduler: time, logger: new MemoryLogger() })
    expect(await service.getQuote('lost', RAVEN)).toMatchObject({ status: 'unavailable', detail: '不知道「没有星系的建筑」在哪个星域' })
    expect(await service.getQuote('lost', PLEX)).toMatchObject({ status: 'ok', source: 'global' })
    expect(service.available('lost')).toEqual({ status: 'unavailable' })
    expect(api.calls.map((c) => c.regionId)).toEqual([GLOBAL])
  })
})

describe('MarketService.getQuote: when ESI misbehaves', () => {
  it('times out at the deadline, without a downtime note outside 11:00–11:30', async () => {
    const { time, api, service } = setup()
    api.set(THE_FORGE, RAVEN, { wait: deferred() })
    const pending = service.getQuote('jita 4-4', RAVEN, { deadlineMs: 2000 })
    await time.advance(2000)
    expect(await pending).toEqual({
      marketKey: 'jita 4-4', typeId: RAVEN, sell: null, buy: null, mid: null, status: 'timeout', dataTime: null, ageSec: null, source: 'region',
    })
  })

  it('uses data up to an hour old after an error, and says so', async () => {
    const { time, api, service } = setup()
    api.set(THE_FORGE, RAVEN, [{ orders: forgeRaven(), lastModified: time.now(), expiresAt: time.now() + 5 * MIN }, { fail: httpError(503) }])
    await service.getQuote('jita 4-4', RAVEN)
    await time.advance(23 * MIN)
    expect(await service.getQuote('jita 4-4', RAVEN)).toMatchObject({
      status: 'stale', reason: 'cache', sell: { best: 258 }, ageSec: 23 * 60, detail: 'GET /markets/{region_id}/orders HTTP 503',
    })
  })

  it('without usable data it is unavailable; during downtime it says so', async () => {
    const { api, service } = setup({ start: Date.UTC(2026, 9, 7, 11, 10) })
    api.set(THE_FORGE, RAVEN, { fail: httpError(502) })
    expect(await service.getQuote('jita 4-4', RAVEN)).toMatchObject({ status: 'unavailable', reason: 'esi_error', downtime: true, sell: null, buy: null })
  })

  it('sources() shows the latest request, success and error of each NPC market', async () => {
    const { time, api, service } = setup()
    api.set(THE_FORGE, RAVEN, [{ fail: httpError(502) }, { orders: forgeRaven() }])
    await service.getQuote('jita 4-4', RAVEN)
    const failing = service.sources().find((s) => s.marketKey === 'jita 4-4')
    expect(failing).toMatchObject({ state: 'DEGRADED', source: 'region', lastRequestAt: time.now(), lastSuccessAt: null, lastErrorAt: time.now(), lastError: { status: 502 } })
    await time.advance(MIN)
    await service.getQuote('jita 4-4', RAVEN)
    expect(service.sources().find((s) => s.marketKey === 'jita 4-4')).toMatchObject({ state: 'OK', lastSuccessAt: time.now(), lastError: { status: 502 } })
    expect(service.sources().map((s) => s.marketKey)).toContain('hek')
  })
})

describe('MarketService.getQuotes', () => {
  it('prices many items at once under one deadline; slow ones are marked as timed out', async () => {
    const { time, api, service } = setup()
    api.set(THE_FORGE, RAVEN, { orders: forgeRaven() })
    api.set(THE_FORGE, TRITANIUM, { wait: deferred() })
    api.set(GLOBAL, PLEX, { orders: [order({ typeId: PLEX, price: 5_000_000 })] })
    const pending = service.getQuotes('jita 4-4', [{ typeId: RAVEN, qty: 10 }, { typeId: TRITANIUM, qty: 1000 }, { typeId: PLEX, qty: 500 }, { typeId: RAVEN, qty: 40 }], { deadlineMs: 12_000 })
    await time.advance(12_000)
    const quotes = await pending
    expect([...quotes.keys()]).toEqual([RAVEN, TRITANIUM, PLEX])
    // 同一种物品两行：按合计 50 件算买单的 min_volume
    expect(quotes.get(RAVEN)).toMatchObject({ status: 'ok', buy: { best: 300 } })
    expect(quotes.get(TRITANIUM)).toMatchObject({ status: 'timeout' })
    expect(quotes.get(PLEX)).toMatchObject({ status: 'ok', source: 'global' })
  })

  it('passes the lane on to ESI: comparison quotes go on the background lane', async () => {
    const { api, service } = setup()
    api.set(THE_FORGE, RAVEN, { orders: forgeRaven() })
    api.set(THE_FORGE, TRITANIUM, { orders: [order({ typeId: TRITANIUM, price: 5 })] })
    await service.getQuotes('jita 4-4', [{ typeId: RAVEN, qty: 1 }], { lane: 'background' })
    await service.getQuote('jita 4-4', TRITANIUM, { lane: 'background' })
    expect(api.calls.map((c) => c.opts.lane)).toEqual(['background', 'background'])
    await service.getQuote('amarr', TRITANIUM)
    expect(api.calls.map((c) => c.opts.lane)).toEqual(['background', 'background', 'interactive'])
  })

  it('cached() tells which prices are already at hand', async () => {
    const { api, service } = setup()
    api.set(THE_FORGE, RAVEN, { orders: forgeRaven() })
    expect(service.cached('jita 4-4', RAVEN)).toBe(false)
    await service.getQuotes('jita 4-4', [{ typeId: RAVEN, qty: 1 }])
    expect(service.cached('jita 4-4', RAVEN)).toBe(true)
    expect(service.cached('伏尔戈', RAVEN)).toBe(true)
    expect(service.cached('amarr', RAVEN)).toBe(false)
    expect(service.cached('联盟市场a', RAVEN)).toBe(true)
    expect(service.cached('nowhere', RAVEN)).toBe(false)
  })
})

describe('MarketService: structure markets', () => {
  it('until the structure sync exists they all need authorization', async () => {
    const { api, service } = setup()
    expect(await service.getQuote('联盟市场a', RAVEN)).toEqual({
      marketKey: '联盟市场a', typeId: RAVEN, sell: null, buy: null, mid: null, status: 'not_ready', reason: 'needs_auth',
      dataTime: null, ageSec: null, source: 'structure',
    })
    expect(service.available('联盟市场a')).toEqual({ status: 'not_ready', reason: 'needs_auth' })
    expect(service.sources().find((s) => s.marketKey === '联盟市场a')).toMatchObject({ source: 'structure', state: 'NEEDS_AUTH', authProfile: 'default' })
    expect(api.calls).toEqual([])
    await expect(service.touch('联盟市场a')).resolves.toBeUndefined()
    await expect(service.resync()).resolves.toBeUndefined()
  })

  it('available(): NPC markets always, region-read structures when the region is known', () => {
    const { service } = setup()
    expect(service.available('jita 4-4')).toEqual({ status: 'ok' })
    expect(service.available('公开建筑')).toEqual({ status: 'ok' })
    expect(service.available('nowhere')).toEqual({ status: 'unavailable' })
  })

  it('a structure source plugs in: orders summarized with the same rules, touched once per request', async () => {
    const touched: Array<[string, number]> = []
    const resynced: string[][] = []
    const book: Record<number, StructureRead> = {
      [RAVEN]: {
        status: 'ok',
        dataTime: Date.UTC(2026, 9, 7, 6, 16),
        orders: [
          { isBuyOrder: false, price: 270, volumeRemain: 1, minVolume: 1, locationId: STRUCTURE_A },
          { isBuyOrder: true, price: 240, volumeRemain: 5, minVolume: 1, locationId: STRUCTURE_A },
          { isBuyOrder: true, price: 260, volumeRemain: 5, minVolume: 20, locationId: STRUCTURE_A },
        ],
      },
      [TRITANIUM]: { status: 'stale', reason: 'sync_error', dataTime: Date.UTC(2026, 9, 7, 5, 20), orders: [] },
    }
    const status = (m: MarketDef): MarketSourceStatus => ({
      marketKey: m.key, name: m.name, type: m.type, source: 'structure', state: 'OK', paused: false, lastRequestAt: null,
      lastSyncAt: 1, lastSuccessAt: 1, lastError: null, lastErrorAt: null, pages: 3, orders: 2841,
    })
    const structures: StructureSource = {
      read: (_m, typeId) => book[typeId] ?? { status: 'auth_error', reason: 'auth', detail: '403' },
      available: () => ({ status: 'ok' }),
      touch: async (m, waitMs) => { touched.push([m.key, waitMs]) },
      resync: async (markets) => { resynced.push(markets.map((m) => m.key)) },
      status,
    }
    const { service } = setup({ structures })

    expect(await service.getQuote('联盟市场a', RAVEN, { qty: 1 })).toEqual({
      marketKey: '联盟市场a', typeId: RAVEN, sell: { best: 270, volumeAtBest: 1, orders: 1, totalVolume: 1 },
      buy: { best: 240, volumeAtBest: 5, orders: 1, totalVolume: 5 }, mid: 255, status: 'ok',
      dataTime: Date.UTC(2026, 9, 7, 6, 16), ageSec: 240, source: 'structure',
    })
    expect(touched).toEqual([['联盟市场a', 6000]])

    const quotes = await service.getQuotes('联盟市场a', [{ typeId: RAVEN, qty: 20 }, { typeId: TRITANIUM, qty: 1 }, { typeId: 35, qty: 1 }], { deadlineMs: 3000 })
    expect(touched).toEqual([['联盟市场a', 6000], ['联盟市场a', 3000]])
    expect(quotes.get(RAVEN)?.buy?.best).toBe(260)
    expect(quotes.get(TRITANIUM)).toMatchObject({ status: 'stale', reason: 'sync_error', sell: null, ageSec: 3600 })
    expect(quotes.get(35)).toMatchObject({ status: 'auth_error', reason: 'auth', detail: '403' })

    await service.resync()
    await service.resync('联盟市场a')
    await service.resync('jita 4-4')
    expect(resynced).toEqual([['联盟市场a', '同步中的建筑'], ['联盟市场a']])
    expect(service.sources().find((s) => s.marketKey === '联盟市场a')).toMatchObject({ state: 'OK', orders: 2841 })
  })

  it('a slow or failing touch never holds a quote past its deadline', async () => {
    const hang = deferred<void>()
    const structures: StructureSource = {
      read: () => ({ status: 'stale', reason: 'refreshing', dataTime: null, orders: [] }),
      available: () => ({ status: 'ok' }),
      touch: () => hang.promise,
      resync: async () => {},
      status: () => { throw new Error('unused') },
    }
    const { time, service, logger } = setup({ structures })
    const pending = service.getQuote('联盟市场a', RAVEN, { deadlineMs: 1500 })
    await time.advance(1500)
    expect(await pending).toMatchObject({ status: 'stale', reason: 'refreshing' })

    const failing = setup({ structures: { ...structures, touch: async () => { throw new Error('boom') } } })
    expect(await failing.service.getQuote('联盟市场a', RAVEN)).toMatchObject({ status: 'stale' })
    expect(failing.logger.at('warn')).toEqual(['建筑市场「联盟市场A」恢复同步失败：boom'])
    expect(logger.at('warn')).toEqual([])
  })
})

describe('MarketService: background completion', () => {
  it('pending requests do not stop a later caller from getting a fresh answer', async () => {
    const { time, api, service } = setup()
    const slow = deferred<EsiPagedResult<EsiRegionOrder>>()
    api.set(THE_FORGE, RAVEN, { wait: slow })
    const first = service.getQuote('jita 4-4', RAVEN, { deadlineMs: 1000 })
    await time.advance(1000)
    expect((await first).status).toBe('timeout')
    slow.resolve(api.result(forgeRaven()))
    await time.advance(0)
    expect(await service.getQuote('jita 4-4', RAVEN)).toMatchObject({ status: 'ok', sell: { best: 258 } })
    expect(api.count(THE_FORGE, RAVEN)).toBe(1)
  })
})
