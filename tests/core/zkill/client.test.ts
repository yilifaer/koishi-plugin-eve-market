// ZkillClient：假时钟 + 假 fetch，不连外网。

import { beforeEach, describe, expect, it } from 'vitest'
import { NetworkError, createModuleStore } from '../../../src/core/ports'
import type { HttpClient, HttpRequest, HttpResponse, Logger, ModuleStore } from '../../../src/core/ports'
import { ZkillClient } from '../../../src/core/zkill'
import type { ZkillFailure, ZkillResult } from '../../../src/core/zkill'
import { FakeTime, flush } from '../../fakes/fake-time'

const UA = 'koishi-plugin-eve-market/0.0.1 (+https://example.test/project; me@example.test)'
const BASE = 'https://zkill.test'
const A = '/api/killID/1/'
const B = '/api/killID/2/'
const C = '/api/killID/3/'

type Step = { status?: number; headers?: Record<string, string>; body?: string | unknown } | Error | 'hang'

function reply(step: Exclude<Step, Error | 'hang'>): HttpResponse {
  const headers = Object.fromEntries(Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const raw = step.body === undefined ? '[]' : typeof step.body === 'string' ? step.body : JSON.stringify(step.body)
  return { status: step.status ?? 200, header: (n) => headers[n.toLowerCase()], body: Buffer.from(raw) }
}

class FakeFetch implements HttpClient {
  readonly calls: Array<{ url: string; at: number; req: HttpRequest }> = []
  script: Step[] = []
  /** 默认回复（script 用完以后） */
  fallback: Step = { body: [] }
  active = 0
  peak = 0
  private releases: Array<() => void> = []

  constructor(private readonly time: FakeTime) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push({ url: req.url, at: this.time.now(), req })
    this.active++
    this.peak = Math.max(this.peak, this.active)
    try {
      const step = this.script.length ? this.script.shift()! : this.fallback
      if (step === 'hang') await new Promise<void>((resolve) => this.releases.push(resolve))
      else if (step instanceof Error) throw step
      else return reply(step)
      return reply(this.fallback as Exclude<Step, Error | 'hang'>)
    } finally {
      this.active--
    }
  }

  releaseAll() {
    this.releases.splice(0).forEach((r) => r())
  }
}

class MemoryLogger implements Logger {
  readonly lines: Record<'debug' | 'info' | 'warn' | 'error', string[]> = { debug: [], info: [], warn: [], error: [] }
  debug = (...a: unknown[]) => void this.lines.debug.push(a.join(' '))
  info = (...a: unknown[]) => void this.lines.info.push(a.join(' '))
  warn = (...a: unknown[]) => void this.lines.warn.push(a.join(' '))
  error = (...a: unknown[]) => void this.lines.error.push(a.join(' '))
}

let time: FakeTime
let http: FakeFetch
let logger: MemoryLogger
let store: ModuleStore

function make(options: { minIntervalMs?: number } = {}) {
  return new ZkillClient({ http, clock: time, scheduler: time, logger, store }, { base: BASE, userAgent: UA, ...options })
}

const failure = (r: ZkillResult): ZkillFailure => {
  if (r.ok) throw new Error('应该失败')
  return r
}

beforeEach(() => {
  time = new FakeTime(Date.UTC(2026, 9, 14, 12, 0))
  http = new FakeFetch(time)
  logger = new MemoryLogger()
  store = createModuleStore()
})

describe('ZkillClient request', () => {
  it('sends the descriptive User-Agent, Accept and limits to the fixed host', async () => {
    const client = make()
    http.script = [{ body: [{ killmail_id: 1 }] }]
    const r = await client.getJson(A)
    expect(r).toEqual({ ok: true, json: [{ killmail_id: 1 }], cached: false })
    const { req } = http.calls[0]
    expect(req.method).toBe('GET')
    expect(req.url).toBe(`${BASE}${A}`)
    expect(req.headers).toEqual({ 'User-Agent': UA, Accept: 'application/json' })
    expect(req.timeoutMs).toBe(5000)
    expect(req.maxBytes).toBe(64 * 1024)
  })

  it('lets the caller raise the timeout and size limit per request', async () => {
    await make().getJson(A, { timeoutMs: 8000, maxBytes: 2_000_000 })
    expect(http.calls[0].req.timeoutMs).toBe(8000)
    expect(http.calls[0].req.maxBytes).toBe(2_000_000)
  })
})

describe('ZkillClient spacing', () => {
  it('serialises requests and keeps at least 1 s between them', async () => {
    const client = make()
    const results = [client.getJson(A), client.getJson(B), client.getJson(C)]
    await time.advance(0)
    expect(http.calls.map((c) => c.url)).toEqual([`${BASE}${A}`])
    await time.advance(999)
    expect(http.calls).toHaveLength(1)
    await time.advance(1)
    expect(http.calls).toHaveLength(2)
    await time.advance(1000)
    expect(http.calls).toHaveLength(3)
    expect((await Promise.all(results)).every((r) => r.ok)).toBe(true)
    const gaps = http.calls.slice(1).map((c, i) => c.at - http.calls[i].at)
    expect(gaps.every((g) => g >= 1000)).toBe(true)
    expect(http.peak).toBe(1)
  })

  it('counts the gap from when the previous request finished', async () => {
    const client = make()
    http.script = ['hang']
    const first = client.getJson(A)
    const second = client.getJson(B)
    await time.advance(5000)
    expect(http.calls).toHaveLength(1)
    http.releaseAll()
    await flush()
    await first
    expect(http.calls).toHaveLength(1)
    await time.advance(999)
    expect(http.calls).toHaveLength(1)
    await time.advance(1)
    expect(http.calls).toHaveLength(2)
    expect((await second).ok).toBe(true)
  })

  it('does not wait when the last request was long ago', async () => {
    const client = make()
    await client.getJson(A)
    await time.advance(10_000)
    const p = client.getJson(B)
    await flush()
    expect(http.calls).toHaveLength(2)
    await p
  })

  it('honours a custom interval (0 = no spacing)', async () => {
    const client = make({ minIntervalMs: 0 })
    await Promise.all([client.getJson(A), client.getJson(B)])
    expect(http.calls).toHaveLength(2)
    expect(http.calls[1].at).toBe(http.calls[0].at)
  })
})

describe('ZkillClient single flight', () => {
  it('shares one request between callers of the same address', async () => {
    const client = make()
    http.script = [{ body: [{ killmail_id: 1 }] }]
    const [x, y, z] = await Promise.all([client.getJson(A), client.getJson(A), client.getJson(A)])
    expect(http.calls).toHaveLength(1)
    expect(x).toEqual(y)
    expect(y).toEqual(z)
  })

  it('shares a failure too, then asks again once it is no longer remembered', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = [{ status: 500, body: 'oops' }]
    const [x, y] = await Promise.all([client.getJson(A), client.getJson(A)])
    expect(failure(x).kind).toBe('unavailable')
    expect(y).toEqual(x)
    expect(http.calls).toHaveLength(1)
  })
})

describe('ZkillClient 429', () => {
  it('pauses until Retry-After and answers throttled without requesting', async () => {
    const client = make()
    http.script = [{ status: 429, headers: { 'Retry-After': '120' } }]
    const t0 = time.now()
    const r = failure(await client.getJson(A))
    expect(r).toMatchObject({ kind: 'throttled', retryAt: t0 + 120_000 })
    await time.advance(119_000)
    const during = failure(await client.getJson(B))
    expect(during).toMatchObject({ kind: 'throttled', retryAt: t0 + 120_000 })
    expect(http.calls).toHaveLength(1)
    await time.advance(1000)
    http.script = [{ body: [{ ok: 1 }] }]
    expect((await client.getJson(B)).ok).toBe(true)
    expect(http.calls).toHaveLength(2)
  })

  it('pauses 60 s when there is no Retry-After', async () => {
    const client = make()
    http.script = [{ status: 429 }]
    const t0 = time.now()
    expect(failure(await client.getJson(A)).retryAt).toBe(t0 + 60_000)
  })

  it('understands a Retry-After given as an HTTP date', async () => {
    const client = make()
    const at = time.now() + 90_000
    http.script = [{ status: 429, headers: { 'Retry-After': new Date(at).toUTCString() } }]
    expect(failure(await client.getJson(A)).retryAt).toBe(at)
  })

  it('treats an HTML body on 429 as throttled, not blocked', async () => {
    http.script = [{ status: 429, headers: { 'Content-Type': 'text/html' }, body: '<html>1015</html>' }]
    expect(failure(await make().getJson(A)).kind).toBe('throttled')
  })

  it('also fails requests that were already queued when the pause starts', async () => {
    const client = make()
    http.script = [{ status: 429, headers: { 'Retry-After': '30' } }]
    const first = client.getJson(A)
    const second = client.getJson(B)
    await time.advance(5000)
    expect(failure(await first).kind).toBe('throttled')
    expect(failure(await second).kind).toBe('throttled')
    expect(http.calls).toHaveLength(1)
  })
})

describe('ZkillClient challenge / 403', () => {
  const html = '<!DOCTYPE html><html><title>Just a moment...</title></html>'

  it.each([
    ['403 with an HTML page', { status: 403, headers: { 'Content-Type': 'text/html' }, body: html }],
    ['403 with no body type', { status: 403, body: 'Forbidden' }],
    ['200 with an HTML challenge page', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html }],
    ['200 whose body starts with <', { status: 200, body: `  \n${html}` }],
    ['cf-mitigated header', { status: 200, headers: { 'cf-mitigated': 'challenge' }, body: '[]' }],
  ] as Array<[string, Step]>)('treats %s as blocked and pauses 5 minutes', async (_, step) => {
    const client = make()
    http.script = [step]
    const t0 = time.now()
    expect(failure(await client.getJson(A))).toMatchObject({ kind: 'blocked', retryAt: t0 + 5 * 60_000 })
    await time.advance(299_000)
    expect(failure(await client.getJson(B)).kind).toBe('blocked')
    expect(http.calls).toHaveLength(1)
    await time.advance(1000)
    expect((await client.getJson(B)).ok).toBe(true)
    expect(http.calls).toHaveLength(2)
  })

  it('logs one warning only, no matter how many requests are turned away or block again', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = [{ status: 403, body: html }, { status: 403, body: html }]
    await client.getJson(A)
    for (const path of [B, C, A]) await client.getJson(path)
    await time.advance(5 * 60_000)
    await client.getJson(B)
    expect(http.calls).toHaveLength(2)
    expect(logger.lines.warn).toHaveLength(1)
    expect(logger.lines.warn[0]).not.toContain(UA)
  })

  it('logs recovery once and warns again after a success', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = [{ status: 403, body: html }]
    await client.getJson(A)
    await time.advance(5 * 60_000)
    expect((await client.getJson(B)).ok).toBe(true)
    expect(logger.lines.info).toHaveLength(1)
    http.script = [{ status: 403, body: html }]
    await client.getJson(C)
    expect(logger.lines.warn).toHaveLength(2)
  })

  it.each([
    ['404 HTML page', { status: 404, headers: { 'Content-Type': 'text/html' }, body: '<html>Not found</html>' }],
    ['502 HTML page', { status: 502, headers: { 'Content-Type': 'text/html' }, body: '<html>Bad gateway</html>' }],
    ['503 HTML page without Cloudflare marks', { status: 503, body: '<html>Maintenance</html>' }],
  ] as Array<[string, Step]>)('a %s is a plain failure: no pause, others still go through', async (_, step) => {
    const client = make({ minIntervalMs: 0 })
    http.script = [step]
    expect(failure(await client.getJson(A)).kind).toBe('unavailable')
    expect((await client.getJson(B)).ok).toBe(true)
    expect(http.calls).toHaveLength(2)
  })

  it('a 503 with cf-ray and a Just a moment page is blocked', async () => {
    const client = make()
    http.script = [{ status: 503, headers: { 'cf-ray': 'abc' }, body: html }]
    expect(failure(await client.getJson(A)).kind).toBe('blocked')
  })

  it('does not take a JSON body that merely contains < for a challenge', async () => {
    http.script = [{ body: [{ name: '<b>' }] }]
    expect((await make().getJson(A)).ok).toBe(true)
  })
})

describe('ZkillClient queue limit', () => {
  it('turns new urls away when the queue is full, but still merges the same url', async () => {
    const client = make()
    http.fallback = { body: [{ n: 1 }] }
    const flights = Array.from({ length: 10 }, (_, i) => client.getJson(`/api/killID/${100 + i}/`))
    expect(client.pending).toBe(10)
    expect(failure(await client.getJson('/api/killID/999/')).kind).toBe('unavailable')
    const same = client.getJson('/api/killID/100/')
    expect(client.pending).toBe(10)
    await time.advance(20_000)
    expect((await same).ok).toBe(true)
    await Promise.all(flights)
    expect(http.calls).toHaveLength(10)
    expect(client.pending).toBe(0)
  })

  it('a queued request whose only caller timed out is never sent', async () => {
    const client = make()
    http.fallback = { body: [{ n: 1 }] }
    const first = client.getJson(A)
    await flush()
    const second = client.getJson(B, { deadlineMs: 200 })
    await time.advance(300)
    expect(failure(await second).kind).toBe('deadline')
    await time.advance(5000)
    await first
    expect(http.calls.map((c) => c.url)).toEqual([`${BASE}${A}`])
    expect(client.pending).toBe(0)
  })

  it('keeps the request when another caller is still waiting for it', async () => {
    const client = make()
    http.fallback = { body: [{ n: 1 }] }
    const first = client.getJson(A)
    await flush()
    const impatient = client.getJson(B, { deadlineMs: 200 })
    const patient = client.getJson(B)
    await time.advance(300)
    expect(failure(await impatient).kind).toBe('deadline')
    await time.advance(5000)
    await first
    expect((await patient).ok).toBe(true)
    expect(http.calls).toHaveLength(2)
  })
})

describe('ZkillClient caches', () => {
  it('serves a positive result from memory for ttlMs, then asks again', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = [{ body: [{ n: 1 }] }, { body: [{ n: 2 }] }]
    expect(await client.getJson(A, { ttlMs: 60_000 })).toEqual({ ok: true, json: [{ n: 1 }], cached: false })
    await time.advance(59_999)
    expect(await client.getJson(A, { ttlMs: 60_000 })).toEqual({ ok: true, json: [{ n: 1 }], cached: true })
    expect(http.calls).toHaveLength(1)
    await time.advance(1)
    expect(await client.getJson(A, { ttlMs: 60_000 })).toEqual({ ok: true, json: [{ n: 2 }], cached: false })
    expect(http.calls).toHaveLength(2)
  })

  it('does not cache when ttlMs is not given', async () => {
    const client = make({ minIntervalMs: 0 })
    await client.getJson(A)
    await client.getJson(A)
    expect(http.calls).toHaveLength(2)
  })

  it('caches an empty result ([] / {} / null) for emptyTtlMs instead', async () => {
    const client = make({ minIntervalMs: 0 })
    for (const empty of [[], {}, null]) {
      http.calls.length = 0
      http.script = [{ body: empty }, { body: [{ n: 1 }] }]
      const path = `/api/x/${JSON.stringify(empty)}/`
      const opts = { ttlMs: 3_600_000, emptyTtlMs: 300_000 }
      expect((await client.getJson(path, opts)).ok).toBe(true)
      await time.advance(299_000)
      expect(await client.getJson(path, opts)).toMatchObject({ ok: true, json: empty, cached: true })
      expect(http.calls).toHaveLength(1)
      await time.advance(1000)
      expect(await client.getJson(path, opts)).toMatchObject({ json: [{ n: 1 }], cached: false })
      expect(http.calls).toHaveLength(2)
    }
  })

  it('does not cache an empty result when emptyTtlMs is not given', async () => {
    const client = make({ minIntervalMs: 0 })
    await client.getJson(A, { ttlMs: 60_000 })
    await client.getJson(A, { ttlMs: 60_000 })
    expect(http.calls).toHaveLength(2)
  })

  it.each([
    ['HTTP 500', { status: 500, body: 'oops' }],
    ['HTTP 404', { status: 404, body: '{}' }],
    ['invalid JSON', { body: '{not json' }],
    ['empty body', { body: '' }],
    ['network error', new NetworkError('network', 'ECONNRESET')],
    ['timeout', new NetworkError('timeout')],
    ['too large', new NetworkError('too-large')],
  ] as Array<[string, Step]>)('remembers a %s failure for 30 s', async (_, step) => {
    const client = make({ minIntervalMs: 0 })
    http.script = [step]
    expect(failure(await client.getJson(A, { ttlMs: 60_000 })).kind).toBe('unavailable')
    await time.advance(29_000)
    expect(failure(await client.getJson(A, { ttlMs: 60_000 })).kind).toBe('unavailable')
    expect(http.calls).toHaveLength(1)
    // 别的地址不受影响
    expect((await client.getJson(B)).ok).toBe(true)
    await time.advance(1000)
    expect((await client.getJson(A)).ok).toBe(true)
    expect(http.calls).toHaveLength(3)
  })

  it('warns about a failing zKill once, then only debug-logs until it recovers', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = [{ status: 500 }, { status: 500 }]
    await client.getJson(A)
    await client.getJson(B)
    expect(logger.lines.warn).toHaveLength(1)
  })

  it('shares the pause and caches with a client rebuilt on the same store (plugin reload)', async () => {
    http.script = [{ status: 429, headers: { 'Retry-After': '60' } }]
    await make().getJson(A)
    expect(failure(await make().getJson(B)).kind).toBe('throttled')
    expect(http.calls).toHaveLength(1)
  })
})

describe('ZkillClient deadline and stop', () => {
  it('gives up waiting at deadlineMs but lets the request finish into the cache', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = ['hang']
    const p = client.getJson(A, { deadlineMs: 100, ttlMs: 60_000 })
    await time.advance(100)
    expect(failure(await p).kind).toBe('deadline')
    // 请求还在后台；结果回来以后写进缓存
    http.fallback = { body: [{ late: true }] }
    http.releaseAll()
    await flush()
    expect(await client.getJson(A, { ttlMs: 60_000 })).toEqual({ ok: true, json: [{ late: true }], cached: true })
  })

  it('answers aborted after stop() without asking zKill', async () => {
    const client = make({ minIntervalMs: 0 })
    client.stop()
    expect(failure(await client.getJson(A)).kind).toBe('aborted')
    expect(http.calls).toHaveLength(0)
  })

  it('does not memorise an aborted request', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = [new NetworkError('aborted')]
    expect(failure(await client.getJson(A)).kind).toBe('aborted')
    expect((await client.getJson(A)).ok).toBe(true)
  })
})

describe('ZkillClient.markBad', () => {
  it('drops the cached answer and remembers the address as failed for 30 s', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = [{ body: [{ weird: true }] }]
    await client.getJson(A, { ttlMs: 60_000 })
    expect(failure(client.markBad(A, '格式不对')).kind).toBe('unavailable')
    expect(failure(await client.getJson(A, { ttlMs: 60_000 })).kind).toBe('unavailable')
    expect(http.calls).toHaveLength(1)
    await time.advance(30_000)
    http.script = [{ body: [{ good: true }] }]
    expect(await client.getJson(A, { ttlMs: 60_000 })).toEqual({ ok: true, json: [{ good: true }], cached: false })
  })
})
