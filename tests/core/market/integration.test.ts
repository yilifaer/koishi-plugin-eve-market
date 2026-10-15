// 和真的 ESI 客户端接在一起：本机的假 ESI（分页、缓存头），不连外网。

import { afterEach, describe, expect, it } from 'vitest'
import { createHistoryService, createMarketRegistry, createMarketService } from '../../../src/core/market'
import { staticDataService } from '../../fixtures/data/load'
import { rawOrder } from '../../fakes/fake-esi'
import { closeAll, makeEnv, realScheduler } from '../esi/helpers'
import { JITA_4_4, JITA_OTHER_STATION, RAVEN, THE_FORGE, settingsOf } from './helpers'

afterEach(closeAll)

describe('market service over the ESI client', () => {
  it('reads every page of the region orders once, then serves from the cache', async () => {
    const env = await makeEnv({}, (fake) => {
      fake.pageSize = 2
      fake.regionOrders.set(THE_FORGE, [
        rawOrder({ price: 260 }),
        rawOrder({ price: 250, location_id: JITA_OTHER_STATION }),
        rawOrder({ price: 258, volume_remain: 4 }),
        rawOrder({ price: 258, volume_remain: 1 }),
        rawOrder({ is_buy_order: true, price: 249, range: 'region' }),
        rawOrder({ type_id: 34, price: 4 }),
      ])
    })
    const registry = createMarketRegistry(settingsOf(), staticDataService())
    const service = createMarketService({ registry, esi: env.api, clock: env.clock, scheduler: realScheduler, logger: env.logger })

    const quote = await service.getQuote('jita 4-4', RAVEN)
    expect(quote).toMatchObject({
      status: 'ok', source: 'region',
      sell: { best: 258, volumeAtBest: 5, orders: 3, totalVolume: 8, volumeNear: 8 },
      buy: { best: 249, orders: 1 },
      mid: 253.5,
    })
    expect(registry.get('jita 4-4')?.locationId).toBe(JITA_4_4)
    const pages = env.fake.count(/^\/markets\/10000002\/orders$/)
    expect(pages).toBe(3)

    await service.getQuotes('jita 4-4', [{ typeId: RAVEN, qty: 1 }])
    expect(env.fake.count(/^\/markets\/10000002\/orders$/)).toBe(pages)
  })

  it('history goes through the same client and cache', async () => {
    const env = await makeEnv({}, (fake) => {
      fake.history.set(`${THE_FORGE}:${RAVEN}`, [
        { date: '2026-10-05', average: 250, highest: 260, lowest: 240, volume: 400, order_count: 900 },
        { date: '2026-10-06', average: 252, highest: 261, lowest: 241, volume: 410, order_count: 910 },
      ])
    })
    const history = createHistoryService({ esi: env.api, clock: env.clock })
    const result = await history.get(THE_FORGE, [RAVEN], 30)
    expect('points' in result && result.points.map((p) => [p.date, p.average, p.orderCount])).toEqual([['2026-10-05', 250, 900], ['2026-10-06', 252, 910]])
    await history.get(THE_FORGE, [RAVEN], 90)
    expect(env.fake.count(/history$/)).toBe(1)
    // 404 是这个星域没有这个物品的历史
    expect(await history.get(THE_FORGE, [34], 30)).toMatchObject({ ok: false, code: 'NO_HISTORY' })
  })
})
