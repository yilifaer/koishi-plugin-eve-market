// 带令牌、密钥的请求不跟随重定向：经 Koishi 的 http 发真实请求，假 ESI / SSO 回 302 指向另一个本机服务，
// 检查请求失败、跳转目标一次也没被请求、令牌和密钥不出现在错误和日志里；不带令牌的 ESI 请求照常跟随。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { KoishiHttpClient } from '../../../src/bot/ports'
import { createModuleStore } from '../../../src/core/ports'
import type { HttpClient, HttpRequest } from '../../../src/core/ports'
import { EsiApi, EsiClient, EsiError } from '../../../src/core/esi'
import { SsoClient, SsoError } from '../../../src/core/sso'
import { FakeEsi } from '../../fakes/fake-esi'
import { ManualClock, MemoryBlobCache, MemoryLogger, STRUCTURE, THE_FORGE, TRITANIUM, authFrom, realScheduler } from '../../core/esi/helpers'

const ACCESS = 'at-redirect-test-7f3a9c0e'
const REFRESH = 'rt-redirect-test-51d2b8aa'
const CODE = 'code-redirect-test-0c4e'

// ------------------------------------------------------------------ 跳转目标

let target: http.Server
let targetBase = ''
const hits: Array<{ path: string; headers: http.IncomingHttpHeaders }> = []

beforeAll(async () => {
  target = http.createServer((req, res) => {
    hits.push({ path: new URL(req.url ?? '/', 'http://x').pathname, headers: req.headers })
    req.resume()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('[]')
  })
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  targetBase = `http://127.0.0.1:${(target.address() as AddressInfo).port}`
})

afterAll(async () => {
  target.closeAllConnections?.()
  await new Promise<void>((resolve) => target.close(() => resolve()))
})

/** 记下发出的请求，转给 Koishi 的 http */
class Recording implements HttpClient {
  readonly requests: HttpRequest[] = []
  constructor(private readonly inner: HttpClient) {}
  request(req: HttpRequest) {
    this.requests.push(req)
    return this.inner.request(req)
  }
}

let ctx: Context
let fake: FakeEsi
let httpClient: Recording
let logger: MemoryLogger
let esi: EsiClient

beforeEach(async () => {
  hits.length = 0
  ctx = new Context()
  ctx.plugin(HTTP as never, {})
  await ctx.start()
  fake = await new FakeEsi().start()
  httpClient = new Recording(new KoishiHttpClient(ctx.http))
  logger = new MemoryLogger()
  esi = new EsiClient(
    { http: httpClient, clock: new ManualClock(), scheduler: realScheduler, logger, cache: new MemoryBlobCache(), store: createModuleStore(), version: '0.0.7' },
    { base: fake.base, retryDelayMs: { min: 5, max: 10 }, random: () => 0.5 },
  )
})

afterEach(async () => {
  esi.stop()
  await fake.stop()
  await ctx.stop()
})

function redirectTo(method: string, pattern: RegExp, status = 302) {
  fake.fault(method, pattern, { status, raw: '', headers: { Location: `${targetBase}/elsewhere` } }, 5)
}

async function rejected<E>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise
  } catch (e) {
    return e as E
  }
  throw new Error('expected a failure')
}

function leaks(e: unknown, secrets: readonly string[]): string[] {
  const texts = [String(e), JSON.stringify(e), (e as Error).message, JSON.stringify((e as { info?: () => unknown }).info?.()), logger.text()]
  return secrets.filter((s) => texts.some((t) => t.includes(s)))
}

// ------------------------------------------------------------------ ESI

describe('ESI requests with a token', () => {
  it('structure orders: 302 fails as an ESI http error, no retry, the target gets nothing', async () => {
    redirectTo('GET', /^\/markets\/structures\//)
    const api = new EsiApi(esi)
    const e = await rejected<EsiError>(api.structureOrders(STRUCTURE, { auth: authFrom(() => ACCESS) }))
    expect(e).toBeInstanceOf(EsiError)
    expect(e).toMatchObject({ kind: 'http', status: 302, code: 'redirect' })
    expect(e.paused || e.abandoned).toBe(false)
    expect(hits).toHaveLength(0)
    expect(fake.requests.filter((r) => r.path.startsWith('/markets/structures/'))).toHaveLength(1)
    expect(httpClient.requests.every((r) => r.redirect === 'manual')).toBe(true)
    expect(leaks(e, [ACCESS])).toEqual([])
  })

  it('structure info and character search: 301 / 307 fail the same way', async () => {
    const api = new EsiApi(esi)
    redirectTo('GET', /^\/universe\/structures\//, 301)
    const info = await rejected<EsiError>(api.structure(STRUCTURE, { auth: authFrom(() => ACCESS) }))
    expect(info).toMatchObject({ kind: 'http', status: 301, code: 'redirect' })
    redirectTo('GET', /^\/characters\/\d+\/search$/, 307)
    const search = await rejected<EsiError>(api.searchCharacters(2112000001, 'Test Pil', { auth: authFrom(() => ACCESS) }))
    expect(search).toMatchObject({ kind: 'http', status: 307, code: 'redirect' })
    expect(hits).toHaveLength(0)
    expect(leaks(info, [ACCESS])).toEqual([])
    expect(leaks(search, [ACCESS])).toEqual([])
  })

  it('requests without a token keep the default and still follow', async () => {
    redirectTo('GET', /^\/markets\/\d+\/history$/)
    const api = new EsiApi(esi)
    const got = await api.history(THE_FORGE, TRITANIUM)
    expect(got.value).toEqual([])
    expect(hits).toHaveLength(1)
    expect(hits[0].headers.authorization).toBeUndefined()
    expect(httpClient.requests.at(-1)!.redirect).toBeUndefined()
  })
})

// ------------------------------------------------------------------ SSO

describe('SSO token endpoint', () => {
  const sso = () => new SsoClient({
    http: httpClient, clientId: fake.sso.clientId, clientSecret: fake.sso.clientSecret, userAgent: 'test-agent/0.0.7', base: fake.base,
  })

  it('code exchange, refresh and revoke answered with 302 fail as unavailable, the target gets nothing', async () => {
    redirectTo('POST', /^\/v2\/oauth\/(token|revoke)$/)
    const secrets = [fake.sso.clientSecret, REFRESH, CODE, Buffer.from(`${fake.sso.clientId}:${fake.sso.clientSecret}`).toString('base64')]
    for (const call of [() => sso().exchangeCode(CODE), () => sso().refresh(REFRESH), () => sso().revoke(REFRESH)]) {
      const e = await rejected<SsoError>(call())
      expect(e).toBeInstanceOf(SsoError)
      expect(e).toMatchObject({ kind: 'unavailable', status: 302, code: 'redirect', transient: true })
      expect(leaks(e, secrets)).toEqual([])
    }
    expect(hits).toHaveLength(0)
    expect(httpClient.requests).toHaveLength(3)
    expect(httpClient.requests.every((r) => r.redirect === 'manual')).toBe(true)
  })

  it('the browser login URL is unchanged (that redirect is for the user, not a request we send)', () => {
    const url = new URL(sso().authorizeUrl('http://127.0.0.1:5140/eve-market/sso/callback', 'st-1'))
    expect(url.origin + url.pathname).toBe(`${fake.base}/v2/oauth/authorize`)
    expect(httpClient.requests).toHaveLength(0)
  })
})
