// 系统指数和调整价经真的 ESI 客户端请求本机的假 ESI：路由、限流组、缓存时间、条件请求、出错时用旧数据。
// 星系和物品是公共数据，数值是编造的。

import { afterEach, describe, expect, it } from 'vitest'
import { createIndustryIndices } from '../../../src/core/industry'
import type { IndustryIndices } from '../../../src/core/industry'
import { isFailure } from '../../../src/core/types'
import type { CoreFailure } from '../../../src/core/types'
import { closeAll, makeEnv, realScheduler } from '../esi/helpers'

const JITA = 30000142
const NIH_02 = 30000900
const TRITANIUM = 34
const PYERITE = 35
const HOUR = 3600_000

/** 取到了数据（不是失败） */
function got<T>(value: T | CoreFailure): T {
  if (isFailure(value)) throw new Error(`应该取到数据：${value.message}`)
  return value
}

const services: IndustryIndices[] = []
afterEach(async () => {
  for (const s of services.splice(0)) s.stop()
  await closeAll()
})

async function setup() {
  const env = await makeEnv({}, (fake) => {
    fake.industrySystems = [
      { solar_system_id: JITA, cost_indices: [{ activity: 'manufacturing', cost_index: 0.0231 }, { activity: 'reaction', cost_index: 0.001 }, { activity: 'copying', cost_index: 0.002 }] },
      { solar_system_id: NIH_02, cost_indices: [{ activity: 'manufacturing', cost_index: 0.012 }, { activity: 'reaction', cost_index: 0.0185 }] },
    ]
    fake.prices = [{ type_id: TRITANIUM, adjusted_price: 4.12, average_price: 4.5 }, { type_id: PYERITE, average_price: 9 }]
  })
  const service = createIndustryIndices({ esi: env.api, clock: env.clock, scheduler: realScheduler, logger: env.logger, store: env.store })
  services.push(service)
  return { ...env, service }
}

describe('IndustryIndices with the ESI client', () => {
  it('reads /industry/systems (rate-limit group industry) and /markets/prices', async () => {
    const { fake, service } = await setup()
    const indices = got(await service.systemIndices())
    expect(indices.bySystem.get(JITA)).toEqual({ manufacturing: 0.0231, reaction: 0.001 })
    expect(indices.bySystem.get(NIH_02)).toEqual({ manufacturing: 0.012, reaction: 0.0185 })
    expect(indices.stale).toBe(false)
    const prices = got(await service.adjustedPrices())
    expect([...prices.byType]).toEqual([[TRITANIUM, 4.12]])
    expect(fake.requests.map((r) => r.path)).toEqual(['/industry/systems', '/markets/prices'])
    expect(fake.requests[0].headers['x-compatibility-date']).toBeTruthy()
    expect(fake.buckets.industry.spent).toHaveLength(1)
    // Last-Modified 是假 ESI 第一次见到这份数据的时间
    expect(service.status()).toEqual({ indicesAt: indices.dataTime, adjustedPricesAt: prices.dataTime })
  })

  it('does not ask again before the cache expires; afterwards a 304 keeps the same table', async () => {
    const { fake, clock, service } = await setup()
    const first = got(await service.systemIndices())
    clock.advance(HOUR - 1000)
    await service.systemIndices()
    expect(fake.count(/^\/industry\/systems$/)).toBe(1)
    clock.advance(1000)
    const again = got(await service.systemIndices())
    expect(fake.count(/^\/industry\/systems$/)).toBe(2)
    expect(fake.requests.at(-1)?.status).toBe(304)
    expect(again.bySystem).toBe(first.bySystem)
  })

  it('uses the old lists when ESI fails after expiry, and answers UPSTREAM_UNAVAILABLE without any', async () => {
    const { fake, clock, service } = await setup()
    await service.systemIndices()
    clock.advance(HOUR)
    // 5xx 会重试一次
    fake.fault('GET', /^\/industry\/systems$/, { status: 503 }, 2)
    expect(await service.systemIndices()).toMatchObject({ stale: true })

    fake.fault('GET', /^\/markets\/prices$/, { status: 500 }, 2)
    expect(await service.adjustedPrices()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
  })
})
