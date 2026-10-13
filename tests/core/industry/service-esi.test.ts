// 整个 core 接在本机的假 ESI 上：星域订单给材料和成品报价，/industry/systems 给星系成本指数，/markets/prices 给调整价。
// 地点名、建筑名、价格、指数都是编造的；星系、空间站是公共数据（NIH-02、Jita 4-4）。

import { afterEach, describe, expect, it } from 'vitest'
import { normalizeConfig } from '../../../src/config/normalize'
import { createEveCore } from '../../../src/core'
import { createModuleStore } from '../../../src/core/ports'
import type { HttpClient, HttpRequest } from '../../../src/core/ports'
import { isFailure } from '../../../src/core/types'
import type { EveCore, IndustryRequest, IndustryResult, LocationComparison } from '../../../src/core/types'
import { FakeEsi, rawOrder } from '../../fakes/fake-esi'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { bundledDir, cleanupDirs, FakeHttp, makeVersion, MemoryCache } from '../data/helpers'
import { ManualClock, MemoryLogger, realScheduler } from '../esi/helpers'
import { ALLOWED } from './service-fakes'

const THE_FORGE = 10000002
const JITA_4_4 = 60003760
const NIH_02 = 30000900
const RAVEN = 638

/** Raven 的材料（数据里的 ME 0 数量）和编造的 Jita 出售价 */
const SELL: Record<number, number> = {
  34: 4, 35: 20, 36: 95, 37: 160, 38: 820, 39: 1450, 40: 2600, 57478: 6500, 57479: 3_200_000, 57486: 41_000, [RAVEN]: 258_400_000,
}

class RoutedHttp implements HttpClient {
  constructor(private readonly esi: FakeEsi, private readonly node: NodeHttpClient, readonly other: FakeHttp) {}

  request(req: HttpRequest) {
    return req.url.startsWith(this.esi.base) ? this.node.request(req) : this.other.request(req)
  }
}

const cores: EveCore[] = []
const fakes: FakeEsi[] = []

afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()))
  await Promise.all(fakes.splice(0).map((f) => f.stop()))
  cleanupDirs()
})

const INDUSTRY = {
  locations: [
    { name: 'XX-1', system: 'NIH-02', visibility: 'allowed', isDefault: true },
    { name: 'XX-2', system: 'Jita', visibility: 'public' },
  ],
  structures: [{ location: 'XX-1', name: '大厂', structureType: 'Sotiyo', rigs: '37180', facilityTaxPct: 1 }],
}

async function make(setup?: (fake: FakeEsi) => void) {
  const fake = new FakeEsi()
  fake.regionOrders.set(THE_FORGE, Object.entries(SELL).map(([id, price]) => rawOrder({ type_id: Number(id), price, location_id: JITA_4_4, volume_remain: 1e9 })))
  fake.industrySystems = [{ solar_system_id: NIH_02, cost_indices: [{ activity: 'manufacturing', cost_index: 0.02 }, { activity: 'invention', cost_index: 0.05 }] }]
  fake.prices = [
    { type_id: 34, adjusted_price: 4 }, { type_id: 35, adjusted_price: 10 }, { type_id: 36, adjusted_price: 50 },
    { type_id: 37, adjusted_price: 300 }, { type_id: 38, adjusted_price: 1000 }, { type_id: 39, adjusted_price: 2500 },
    { type_id: 40, adjusted_price: 2500 }, { type_id: 57478, adjusted_price: 10_000 }, { type_id: 57479, adjusted_price: 350_000 },
    { type_id: 57486, adjusted_price: 12_000 },
  ]
  setup?.(fake)
  await fake.start()
  fakes.push(fake)
  const clock = new ManualClock()
  fake.clock = () => clock.now()
  const { settings } = normalizeConfig({ advanced: { manifestUrl: '', glossaryUrl: '' }, industry: INDUSTRY })
  const unused = () => { throw new Error('这个测试用不到') }
  const core = createEveCore({
    http: new RoutedHttp(fake, new NodeHttpClient(), new FakeHttp()),
    clock,
    scheduler: realScheduler,
    logger: new MemoryLogger(),
    cache: new MemoryCache(),
    auth: { list: async () => [], get: async () => undefined, upsert: unused, remove: unused },
    secrets: { keyId: 'test', seal: unused, open: unused },
    store: createModuleStore(),
    bundledDataDir: bundledDir(makeVersion()),
    version: '0.0.1',
  }, settings, { esiBase: fake.base, random: () => 0.5 })
  cores.push(core)
  await core.start()
  const run = async (text: string) => {
    const req = core.parse.industryArgs(text, 'manufacturing', ALLOWED)
    if (isFailure(req)) throw new Error(`「${text}」解析失败：${req.code}`)
    return core.industry.plan(req as IndustryRequest)
  }
  return { core, fake, run }
}

describe('IndustryService on the fake ESI', () => {
  it('prices from region orders, index and adjusted prices from ESI, each list requested once', async () => {
    const { core, fake, run } = await make()
    const r = await run('乌鸦级 XX-1') as IndustryResult
    expect(isFailure(r)).toBe(false)
    expect(r.missingPrices).toBe(0)
    expect(r.materialCost).toBe(138_298_834)
    expect(r.applied).toMatchObject({ location: 'XX-1', structure: '大厂', sci: 0.02, facilityTaxPct: 1, me: 10, te: 20 })
    expect(r.jobCost).toEqual({
      eiv: 138_275_000, grossSci: 2_765_500, bonuses: -138_275, facility: 1_382_750, scc: 5_531_000, extra: 0, total: 9_540_975, missingAdjusted: 0,
    })
    expect(r.productValue).toMatchObject({ marketKey: 'jita 4-4', unit: 258_400_000 })
    expect(r.indicesAt).toEqual(expect.any(Number))
    expect(r.pricesAt).toEqual(expect.any(Number))
    // 第二次计算和比价都用手上的列表
    const c = await core.industry.compare({ typeId: RAVEN, activity: 'manufacturing', materials: false, access: ALLOWED }) as LocationComparison
    expect(c.rows.map((row) => row.location)).toEqual(['XX-1', 'XX-2'])
    expect(fake.count(/^\/industry\/systems$/)).toBe(1)
    expect(fake.count(/^\/markets\/prices$/)).toBe(1)
    expect(core.status().industry).toEqual({ indicesAt: r.indicesAt, adjustedPricesAt: expect.any(Number) })
  })

  it('ESI errors on the two lists: the result still comes, with the reason', async () => {
    const { run } = await make((fake) => {
      fake.fault('GET', /^\/industry\/systems$/, { status: 503 }, 10)
      fake.fault('GET', /^\/markets\/prices$/, { status: 503 }, 10)
    })
    const r = await run('乌鸦级 XX-1') as IndustryResult
    expect(r.materialCost).toBe(138_298_834)
    expect(r.jobCost).toBeUndefined()
    expect(r.warnings).toEqual([
      '星系成本指数暂时取不到，安装费用没有计入星系成本指数（偏低）',
      '调整价暂时取不到，安装费用、设施税和 SCC 附加费没有计入',
    ])
  })
})
