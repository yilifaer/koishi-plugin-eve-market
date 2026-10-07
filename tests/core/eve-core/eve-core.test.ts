// createEveCore：真的各个模块接在一起，ESI 指向本机的假 ESI，物品数据来自临时的自带快照目录。

import { afterEach, describe, expect, it } from 'vitest'
import { PRESET_MARKETS } from '../../../src/config/presets'
import { normalizeConfig } from '../../../src/config/normalize'
import { createEveCore, describeIssue } from '../../../src/core'
import { createModuleStore } from '../../../src/core/ports'
import type { HttpClient, HttpRequest } from '../../../src/core/ports'
import type { EveCore } from '../../../src/core/types'
import { FakeEsi, rawOrder } from '../../fakes/fake-esi'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { bundledDir, cleanupDirs, FakeHttp, makeVersion, MemoryCache } from '../data/helpers'
import type { Json, Version } from '../data/helpers'
import { ManualClock, MemoryLogger, realScheduler } from '../esi/helpers'
import { ALLOWED, PUBLIC, STRUCTURE_ROWS } from '../market/helpers'

const THE_FORGE = 10000002
const RAVEN = 638
const DATA_DIR = 'https://data.test/official/data/'

/** ESI 的请求交给假 ESI，其他（数据下载）交给 FakeHttp */
class RoutedHttp implements HttpClient {
  constructor(private readonly esi: FakeEsi, private readonly node: NodeHttpClient, readonly other: FakeHttp) {}

  request(req: HttpRequest) {
    return req.url.startsWith(this.esi.base) ? this.node.request(req) : this.other.request(req)
  }
}

interface Made {
  core: EveCore
  fake: FakeEsi
  web: FakeHttp
  logger: MemoryLogger
  version: Version
}

const cores: EveCore[] = []
const fakes: FakeEsi[] = []

afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()))
  await Promise.all(fakes.splice(0).map((f) => f.stop()))
  cleanupDirs()
})

async function make(raw: Record<string, unknown> = {}, setupEsi?: (fake: FakeEsi) => void): Promise<Made> {
  const fake = new FakeEsi()
  setupEsi?.(fake)
  await fake.start()
  fakes.push(fake)
  const clock = new ManualClock()
  fake.clock = () => clock.now()
  const web = new FakeHttp()
  const logger = new MemoryLogger()
  const version = makeVersion()
  const { settings } = normalizeConfig({ advanced: { manifestUrl: '', glossaryUrl: '' }, ...raw })
  const unused = () => { throw new Error('这个测试用不到') }
  const core = createEveCore({
    http: new RoutedHttp(fake, new NodeHttpClient(), web),
    clock,
    scheduler: realScheduler,
    logger,
    cache: new MemoryCache(),
    auth: { list: async () => [], get: async () => undefined, upsert: unused, remove: unused },
    secrets: { keyId: 'test', seal: unused, open: unused },
    store: createModuleStore(),
    bundledDataDir: bundledDir(version),
    version: '0.0.1',
  }, settings, { esiBase: fake.base, random: () => 0.5 })
  cores.push(core)
  return { core, fake, web, logger, version }
}

describe('createEveCore: lifecycle and status', () => {
  it('is empty before start, ready from the bundled data after', async () => {
    const { core, version } = await make()
    const before = core.status()
    expect([before.ready, before.items.items, before.markets, before.issues]).toEqual([false, 0, [], []])

    const started = core.start()
    expect(core.start()).toBe(started)
    await started
    await core.ready
    const status = core.status()
    expect(status).toMatchObject({
      ready: true,
      data: { ready: true, origin: 'bundled', buildNumber: version.manifest.buildNumber, lastConfirmedAt: null },
      auth: [],
      issues: [],
    })
    expect(status.items.marketItems).toBeGreaterThan(100)
    expect(status.markets.map((m) => [m.marketKey, m.state])).toEqual([
      ['jita 4-4', 'OK'], ['amarr', 'OK'], ['dodixie', 'OK'], ['rens', 'OK'], ['hek', 'OK'],
    ])
    expect(status.esi).toMatchObject({ pausedUntil: null })
    expect(status.industry).toBeUndefined()
  })

  it('stop cancels the data checks', async () => {
    const { core } = await make()
    await core.start()
    await core.stop()
    expect(await core.data.refresh()).toMatchObject({ changed: false, error: '已停止' })
  })
})

describe('createEveCore: modules work together', () => {
  it('parses, quotes, formats and translates through the same registry, resolver and ESI client', async () => {
    const { core, fake } = await make({}, (f) => {
      f.regionOrders.set(THE_FORGE, [rawOrder({ price: 258_400_000 }), rawOrder({ is_buy_order: true, price: 249_000_000, range: 'station' })])
    })
    await core.start()
    const q = await core.parse.query('Jita 乌鸦级*2', { scope: 'market', access: PUBLIC, market: true })
    expect(q).toMatchObject({ market: { key: 'jita 4-4' }, name: '乌鸦级', quantity: 2, resolution: { kind: 'unique', item: { typeId: RAVEN } } })

    const quote = await core.prices.getQuote('jita 4-4', RAVEN, { qty: 2 })
    expect(quote).toMatchObject({ status: 'ok', sell: { best: 258_400_000 }, buy: { best: 249_000_000 } })
    expect(fake.count(/^\/markets\/10000002\/orders$/)).toBe(1)
    expect(core.status().markets[0].lastSuccessAt).not.toBeNull()
    expect(core.format.isk(quote.sell!.best)).toEqual({ na: false, full: '258,400,000 ISK', compact: '258.40M' })
    expect(core.universe.translate('吉他', 10).entries[0]).toMatchObject({ kind: 'system', en: 'Jita' })
    expect(core.items.byId(RAVEN)?.zh).toBe('乌鸦级')
  })
})

describe('createEveCore: configuration problems that need the data', () => {
  const raw = {
    markets: [...PRESET_MARKETS, { name: '不存在的站', type: 'npc-station', location: '60099999' }],
    aliases: [{ alias: '大鸟', target: 'Raven Navy Issue' }],
    price: { defaultQuantities: [{ item: 'PLEX', quantity: 500 }, { item: '不存在的物品', quantity: 2 }, { item: '救赎级', quantity: 1 }, { item: '高级水晶', quantity: 1 }] },
    advanced: { manifestUrl: `${DATA_DIR}manifest.json`, glossaryUrl: '' },
  }

  const renamed = (json: Record<string, Json>) => {
    const types = json['types.json']
    const col = types.columns.indexOf('en')
    types.types.find((row: unknown[]) => row[0] === 17636)[col] = 'Raven Fleet Issue'
  }

  it('checks after loading, logs each problem once and checks again after every data update', async () => {
    const { core, web, logger, version } = await make(raw)
    web.serveVersion(DATA_DIR, version)
    await core.start()
    const first = core.status().issues.map(describeIssue)
    expect(first).toEqual([
      '市场第 6 行「位置」空间站 60099999 在数据里找不到，已跳过',
      '默认数量第 2 行「物品」不存在的物品 找不到对应的物品，这一行不生效',
      '默认数量第 3 行「物品」救赎级 对应多个物品，请改写成 #typeID，这一行不生效',
      '默认数量第 4 行「物品」高级水晶 不是一个确定的物品，请写完整的名字或 #typeID，这一行不生效',
    ])
    expect(logger.at('warn').filter((t) => t.startsWith('配置问题'))).toEqual(first.map((t) => `配置问题：%s ${t}`))

    // 在线确认是最新：不算更新，不重复写日志
    expect(await core.data.refresh()).toMatchObject({ changed: false, checked: true })
    expect(logger.at('warn').filter((t) => t.startsWith('配置问题'))).toHaveLength(4)

    const next = makeVersion({ build: version.manifest.buildNumber + 1, edit: renamed })
    web.serveVersion(DATA_DIR, next)
    expect(await core.data.refresh()).toMatchObject({ changed: true })
    const alias = '物品别名第 1 行别名「大鸟」的目标「Raven Navy Issue」找不到对应的物品，这一行不生效'
    expect(core.status().issues.map(describeIssue)).toContain(alias)
    expect(logger.at('warn').filter((t) => t.startsWith('配置问题'))).toEqual([...first, alias].map((t) => `配置问题：%s ${t}`))
  })
})

describe('createEveCore: placeholders until 0.0.2 and 0.2.0', () => {
  it('structure markets need EVE authorization', async () => {
    const { core } = await make({ markets: [...PRESET_MARKETS, ...STRUCTURE_ROWS], sso: { clientId: 'test-client-id', clientSecret: 'x' } })
    await core.start()
    expect(core.auth.profiles()).toEqual([{
      profile: 'default', status: 'NEEDS_AUTH', characterId: '', characterName: '', scopesGranted: 0, scopesRequired: 3,
      tokenValid: false, lastRefreshAt: null, lastSuccessAt: null, lastError: '', lastErrorAt: null, markets: ['联盟市场A'],
    }])
    expect(core.status().issues.map(describeIssue)).toEqual(['市场第 6 行「联盟市场A」使用的授权档案 default 还没有授权'])
    expect(core.status().markets.find((m) => m.marketKey === '联盟市场a')).toMatchObject({ source: 'structure', state: 'NEEDS_AUTH' })
    expect(await core.auth.getAccessToken('default')).toMatchObject({ ok: false, status: 'NEEDS_AUTH' })
    expect(() => core.auth.beginAuth('default')).toThrow()
    expect(await core.auth.completeAuth('code', 'state')).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(await core.auth.searchStructures('default', 'abc')).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
    await expect(core.auth.remove('default')).resolves.toBeUndefined()
  })

  it('without a Client ID the local check already reports it, not twice', async () => {
    const { core } = await make({ markets: [...PRESET_MARKETS, ...STRUCTURE_ROWS] })
    await core.start()
    const texts = core.status().issues.map(describeIssue).filter((t) => t.includes('联盟市场A'))
    expect(texts).toEqual(['市场第 6 行「联盟市场A」使用的授权档案 default 还没有授权（「EVE 授权」里还没填 Client ID）'])
  })

  it('industry', async () => {
    const { core } = await make()
    await core.start()
    const req = { typeId: RAVEN, activity: 'manufacturing' as const, mode: 'base' as const, materials: false, access: PUBLIC }
    expect(await core.industry.plan(req)).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
    expect(await core.industry.compare(req)).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
    expect(core.industry.locations(PUBLIC)).toEqual([])
    expect(core.parse.industryArgs('乌鸦级', 'manufacturing', PUBLIC)).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
  })
})

describe('createEveCore: notices', () => {
  it('enabled, not expired, visible here, at most two', async () => {
    const { core } = await make({
      notices: {
        list: [
          { text: '公告一', visibility: 'all' },
          { text: '只给授权群', visibility: 'allowed' },
          { text: '已经过期', visibility: 'all', until: '2026-10-01 00:00' },
          { text: '停用的', visibility: 'all', enabled: false },
          { text: '公告二', visibility: 'all', until: '2026-12-31 23:59' },
          { text: '公告三', visibility: 'all' },
        ],
      },
    })
    expect(core.notices(PUBLIC)).toEqual(['公告一', '公告二'])
    expect(core.notices(ALLOWED)).toEqual(['公告一', '只给授权群'])
  })
})

describe('describeIssue', () => {
  it('names the table and row, or the section', () => {
    expect(describeIssue({ section: 'markets', row: 6, message: '「位置」不是数字，已跳过' })).toBe('市场第 6 行「位置」不是数字，已跳过')
    expect(describeIssue({ section: 'access', table: '授权群', row: 2, message: '重复' })).toBe('授权群第 2 行重复')
    expect(describeIssue({ section: 'price', message: '找不到基准市场' })).toBe('查价：找不到基准市场')
    expect(describeIssue({ section: 'advanced', table: '网址', message: '不对' })).toBe('高级 · 网址：不对')
  })
})
