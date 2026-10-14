// 密钥只能出现在 X-ApiKey 请求头里：各种失败路径都不能把它带进日志、失败信息、状态。

import { afterEach, describe, expect, it } from 'vitest'
import { normalizeConfig } from '../../../src/config/normalize'
import { createEveCore } from '../../../src/core'
import { JaniceClient, createJaniceService } from '../../../src/core/janice'
import { NetworkError, createModuleStore } from '../../../src/core/ports'
import type { HttpClient, HttpRequest } from '../../../src/core/ports'
import { isFailure } from '../../../src/core/types'
import type { EveCore } from '../../../src/core/types'
import { redact, registerSecret, safeError } from '../../../src/core/util'
import { FakeJanice } from '../../fakes/fake-janice'
import { FakeTime } from '../../fakes/fake-time'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { bundledDir, cleanupDirs, FakeHttp, makeVersion, MemoryCache } from '../data/helpers'
import { MemoryLogger, realScheduler } from '../esi/helpers'

const KEY = 'test-janice-key-0000'
const UA = 'koishi-plugin-eve-market/0.0.1 (+https://example.test/project)'
const servers: Array<{ stop(): Promise<void> }> = []
const cores: EveCore[] = []

afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()))
  await Promise.all(servers.splice(0).map((s) => s.stop()))
  cleanupDirs()
})

/** 一个会把请求配置（含请求头）塞进错误文字的坏 HTTP 实现，模拟 ctx.http 的做法 */
class LeakyHttp implements HttpClient {
  constructor(private readonly error: (req: HttpRequest) => Error) {}
  async request(req: HttpRequest): Promise<never> {
    throw this.error(req)
  }
}

function setup(http: HttpClient) {
  const time = new FakeTime(Date.UTC(2026, 9, 14, 12, 0))
  const logger = new MemoryLogger()
  const client = new JaniceClient(
    { http, clock: time, scheduler: time, logger, store: createModuleStore() },
    { base: 'https://janice.test', apiKey: KEY, userAgent: UA, minIntervalMs: 0 },
  )
  const service = createJaniceService({ client, items: { byId: () => undefined }, clock: time, scheduler: time, logger })
  return { service, logger, time }
}

describe('the key stays in the request header', () => {
  it('is in X-ApiKey only: not in the URL, the User-Agent or any other header', async () => {
    const fake = await new FakeJanice().start()
    servers.push(fake)
    fake.add('AbC123')
    const http = new NodeHttpClient()
    const time = new FakeTime()
    const client = new JaniceClient(
      { http, clock: time, scheduler: time, logger: new MemoryLogger(), store: createModuleStore() },
      { base: fake.base, apiKey: KEY, userAgent: UA, minIntervalMs: 0 },
    )
    await createJaniceService({ client, items: { byId: () => undefined }, clock: time, scheduler: time, logger: new MemoryLogger() }).get('AbC123')
    expect(http.requests).toHaveLength(1)
    const { url, headers, body } = http.requests[0]
    expect(url).not.toContain(KEY)
    expect(body).toBeUndefined()
    expect(Object.entries(headers ?? {}).filter(([, v]) => v.includes(KEY)).map(([k]) => k)).toEqual(['X-ApiKey'])
    expect(fake.requests[0].apiKey).toBe(KEY)
    expect(fake.requests[0].path).not.toContain(KEY)
    expect(fake.requests[0].userAgent).not.toContain(KEY)
  })

  const errors: Array<[string, (req: HttpRequest) => Error]> = [
    ['an error that quotes the request headers as text', (req) => new NetworkError('network', `connect failed; headers: X-ApiKey: ${req.headers?.['X-ApiKey']}`)],
    ['an error that quotes the headers as JSON', (req) => new NetworkError('network', `bad request ${JSON.stringify({ headers: req.headers })}`)],
    ['an error that quotes the key bare', (req) => new Error(`boom ${req.headers?.['X-ApiKey']} boom`)],
    ['an error with the key as a query parameter', (req) => new Error(`GET ${req.url}?apikey=${req.headers?.['X-ApiKey']} failed`)],
    ['an HTTP error object with config.headers', (req) => Object.assign(new Error('Request failed'), { config: { headers: req.headers }, response: { status: 502, data: { headers: req.headers } } })],
  ]
  for (const [name, make] of errors) {
    it(`does not leak through ${name}`, async () => {
      const { service, logger } = setup(new LeakyHttp(make))
      const r = await service.get('AbC123')
      expect(isFailure(r) && r.code).toBe('JANICE_DOWN')
      expect(JSON.stringify(r)).not.toContain(KEY)
      expect(logger.text()).not.toContain(KEY)
      expect(JSON.stringify(service.status())).not.toContain(KEY)
    })
  }

  it('does not leak through any status path (4xx, 5xx, 429, bad body)', async () => {
    const fake = await new FakeJanice().start()
    servers.push(fake)
    const time = new FakeTime()
    const logger = new MemoryLogger()
    const client = new JaniceClient(
      { http: new NodeHttpClient(), clock: time, scheduler: time, logger, store: createModuleStore() },
      { base: fake.base, apiKey: KEY, userAgent: UA, minIntervalMs: 0 },
    )
    const service = createJaniceService({ client, items: { byId: () => undefined }, clock: time, scheduler: time, logger })
    // 服务端把收到的密钥回显在错误体里
    const echo = `{"title":"bad","detail":"key ${KEY} rejected","X-ApiKey":"${KEY}","apikey":"${KEY}"}`
    fake.faults = [
      { kind: 'status', status: 401, body: echo }, { kind: 'status', status: 403, body: echo }, { kind: 'status', status: 500, body: echo },
      { kind: 'raw', body: echo }, { kind: 'rate-limit', retryAfter: 5 },
    ]
    const outcomes = []
    for (const code of ['AbC123', 'Zz9Yx8', 'Qq1Ww2', 'Rr3Tt4']) {
      outcomes.push(await service.get(code))
      await time.advance(30_000)
    }
    outcomes.push(await service.get('Ss5Uu6'))
    expect(JSON.stringify(outcomes)).not.toContain(KEY)
    expect(logger.text()).not.toContain(KEY)
    expect(JSON.stringify(service.status())).not.toContain(KEY)
  })

  it('does not leak through createEveCore: status, issues and logs', async () => {
    const fake = await new FakeJanice().start()
    servers.push(fake)
    fake.faults = [{ kind: 'status', status: 401, body: KEY }]
    const logger = new MemoryLogger()
    const { settings } = normalizeConfig({ advanced: { manifestUrl: '', glossaryUrl: '' }, janice: { apiKey: ` ${KEY} `, who: 'allowed' } })
    const unused = () => { throw new Error('这个测试用不到') }
    const core = createEveCore({
      http: new Routed(fake.base, new FakeHttp()),
      clock: new FakeTime(),
      scheduler: realScheduler,
      logger,
      cache: new MemoryCache(),
      auth: { list: async () => [], get: async () => undefined, upsert: unused, remove: unused },
      secrets: { keyId: 'test', seal: unused, open: unused },
      store: createModuleStore(),
      bundledDataDir: bundledDir(makeVersion()),
      version: '0.0.1',
    }, settings, { janiceBase: fake.base, random: () => 0.5 })
    cores.push(core)
    await core.start()
    const r = await core.janice.get('AbC123')
    expect(isFailure(r) && r.code).toBe('JANICE_BAD_KEY')
    expect(fake.requests[0].apiKey).toBe(KEY)
    expect(JSON.stringify(core.status())).not.toContain(KEY)
    expect(JSON.stringify(settings.issues)).not.toContain(KEY)
    expect(logger.text()).not.toContain(KEY)
    expect(core.janice.status().lastError?.code).toBe('JANICE_BAD_KEY')
  })
})

class Routed implements HttpClient {
  private readonly node = new NodeHttpClient()
  constructor(private readonly base: string, private readonly other: FakeHttp) {}
  request(req: HttpRequest) {
    return req.url.startsWith(this.base) ? this.node.request(req) : this.other.request(req)
  }
}

describe('safe-error masking', () => {
  it('masks the X-ApiKey header in text and the apikey / x-apikey JSON fields', () => {
    expect(redact(`headers: X-ApiKey: ${KEY}, Accept: x`)).not.toContain(KEY)
    expect(redact(`x-apikey=${KEY}`)).not.toContain(KEY)
    expect(redact(`{"X-ApiKey":"${KEY}"}`)).toBe('{"X-ApiKey":"***"}')
    expect(redact(`{"apikey": "${KEY}", "a": 1}`)).toBe('{"apikey":"***", "a": 1}')
    expect(redact(`https://x.test/p?apikey=${KEY}&a=1`)).toBe('https://x.test/p?apikey=***&a=1')
  })

  it('masks the inspect and Headers forms of the header', () => {
    expect(redact(`{ 'X-ApiKey': '${KEY}', Accept: 'x' }`)).not.toContain(KEY)
    expect(redact(`Headers { 'x-apikey': '${KEY}' }`)).not.toContain(KEY)
    expect(redact(`{ "x-apikey": "${KEY}" }`)).not.toContain(KEY)
  })

  it('masks a registered secret without passing it explicitly', () => {
    registerSecret('registered-fake-key-1')
    expect(redact('boom registered-fake-key-1 boom')).toBe('boom *** boom')
  })

  it('masks a known secret anywhere, and safeError keeps no request config', () => {
    const err = Object.assign(new Error(`failed ${KEY}`), { config: { headers: { 'X-ApiKey': KEY } }, response: { status: 502, data: `{"X-ApiKey":"${KEY}"}` } })
    const info = JSON.stringify(safeError(err, 'GET /api', [KEY]))
    expect(info).not.toContain(KEY)
    expect(info).not.toContain('headers')
  })

  it('keeps ordinary text', () => {
    expect(redact('Janice 请求失败：HTTP 500')).toBe('Janice 请求失败：HTTP 500')
  })
})
