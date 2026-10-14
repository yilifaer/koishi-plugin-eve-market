// 人物统计的 302：用本机的假 zKill 和不跟随跳转的 HttpClient，检查客户端自己跟随同一主机的 /api/ 跳转。

import { afterEach, describe, expect, it } from 'vitest'
import { ZKILL_REDIRECT_MAX } from '../../../src/constants'
import { createModuleStore } from '../../../src/core/ports'
import type { HttpClient, HttpRequest, HttpResponse } from '../../../src/core/ports'
import { ZkillClient, parseZkillStats, zkillStatsPath } from '../../../src/core/zkill'
import { FakeZkill } from '../../fakes/fake-zkill'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { ManualClock, MemoryLogger, realScheduler } from '../esi/helpers'

const servers: FakeZkill[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()))
})

const HANAKO = 2119876543
const STATS = { shipsDestroyed: 37, shipsLost: 5, dangerRatio: 70 }

async function make(http: HttpClient = new NodeHttpClient()) {
  const fake = await new FakeZkill().start()
  servers.push(fake)
  fake.stats.set(HANAKO, STATS)
  const client = new ZkillClient(
    { http, clock: new ManualClock(), scheduler: realScheduler, logger: new MemoryLogger(), store: createModuleStore() },
    { base: fake.base, userAgent: 'test-agent/1.0', minIntervalMs: 0 },
  )
  return { fake, client }
}

describe('ZkillClient: stats path and 302', () => {
  it('follows the 302 to /kills/ and returns the stats', async () => {
    const { fake, client } = await make()
    const got = await client.getJson(zkillStatsPath(HANAKO))
    expect(got).toMatchObject({ ok: true, json: STATS })
    expect(fake.requests.map((r) => r.path)).toEqual([`/api/stats/characterID/${HANAKO}/`, `/api/stats/characterID/${HANAKO}/kills/`])
    // 两次请求都带同一个 User-Agent
    expect(new Set(fake.requests.map((r) => r.userAgent))).toEqual(new Set(['test-agent/1.0']))
    expect(parseZkillStats((got as { json: unknown }).json).kills).toBe(37)
  })

  it('works when the server answers directly (no redirect)', async () => {
    const { fake, client } = await make()
    fake.redirectStats = false
    expect(await client.getJson(zkillStatsPath(HANAKO))).toMatchObject({ ok: true, json: STATS })
    expect(fake.requests).toHaveLength(1)
  })

  it('caches by the original path: the second call makes no request', async () => {
    const { fake, client } = await make()
    await client.getJson(zkillStatsPath(HANAKO), { ttlMs: 60_000 })
    const again = await client.getJson(zkillStatsPath(HANAKO), { ttlMs: 60_000 })
    expect(again).toMatchObject({ ok: true, cached: true })
    expect(fake.requests).toHaveLength(2)
  })

  it('an unknown character gives {} (cached briefly as empty)', async () => {
    const { client } = await make()
    const got = await client.getJson(zkillStatsPath(2119000999))
    expect(got).toMatchObject({ ok: true, json: {} })
    expect(parseZkillStats((got as { json: unknown }).json).present).toBe(false)
  })

  it('a redirect to another host, a non-API path or a missing Location is a failure and is not followed', async () => {
    const calls: string[] = []
    const redirectTo = (location?: string): HttpClient => ({
      request: async (req: HttpRequest): Promise<HttpResponse> => {
        calls.push(req.url)
        return { status: 302, header: (n) => (n.toLowerCase() === 'location' ? location : undefined), body: Buffer.alloc(0) }
      },
    })
    for (const location of ['https://evil.example/api/x/', '/login', undefined, 'http://other-host.test/api/stats/characterID/1/']) {
      calls.length = 0
      const { client } = await make(redirectTo(location))
      const got = await client.getJson(zkillStatsPath(HANAKO))
      expect(got, String(location)).toMatchObject({ ok: false, kind: 'unavailable' })
      expect(calls).toHaveLength(1)
    }
  })

  it('stops after ZKILL_REDIRECT_MAX hops (redirect loop)', async () => {
    const calls: string[] = []
    const loop: HttpClient = {
      request: async (req: HttpRequest): Promise<HttpResponse> => {
        calls.push(req.url)
        return { status: 302, header: (n) => (n.toLowerCase() === 'location' ? `/api/stats/characterID/${HANAKO}/loop/` : undefined), body: Buffer.alloc(0) }
      },
    }
    const { client } = await make(loop)
    expect(await client.getJson(zkillStatsPath(HANAKO))).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(calls).toHaveLength(ZKILL_REDIRECT_MAX + 1)
  })

  it('applies 429 and Cloudflare handling to the redirected request too', async () => {
    const { fake, client } = await make()
    fake.faults.push({ kind: 'status', status: 302, headers: { Location: `/api/stats/characterID/${HANAKO}/kills/` } }, { kind: 'rate-limit', retryAfter: 120 })
    const got = await client.getJson(zkillStatsPath(HANAKO))
    expect(got).toMatchObject({ ok: false, kind: 'throttled' })
    // 暂停期里不再发请求
    const before = fake.requests.length
    expect(await client.getJson(zkillStatsPath(2119000998))).toMatchObject({ ok: false, kind: 'throttled' })
    expect(fake.requests).toHaveLength(before)
  })

  it('serves the kills and losses lists as arrays', async () => {
    const { fake, client } = await make()
    expect(await client.getJson(`/api/kills/characterID/${HANAKO}/`)).toMatchObject({ ok: true, json: [] })
    expect(await client.getJson(`/api/losses/characterID/${HANAKO}/`)).toMatchObject({ ok: true, json: [] })
    expect(fake.requests).toHaveLength(2)
  })
})
