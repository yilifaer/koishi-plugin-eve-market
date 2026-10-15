// JaniceClient：假时钟 + 假 HTTP，不连外网。

import { beforeEach, describe, expect, it } from 'vitest'
import { NetworkError, createModuleStore } from '../../../src/core/ports'
import type { HttpClient, HttpRequest, HttpResponse, Logger, ModuleStore } from '../../../src/core/ports'
import { JaniceClient } from '../../../src/core/janice'
import type { JaniceFetch } from '../../../src/core/janice'
import type { CoreFailure } from '../../../src/core/types'
import { FakeTime, flush } from '../../fakes/fake-time'

const KEY = 'test-janice-key-0000'
const UA = 'koishi-plugin-eve-market/0.0.1 (+https://example.test/project; me@example.test)'
const BASE = 'https://janice.test'
const path = (code: string) => `${BASE}/api/rest/v2/appraisal/${code}`

type Step = { status?: number; headers?: Record<string, string>; body?: string | unknown } | Error | 'hang'

function reply(step: Exclude<Step, Error | 'hang'>): HttpResponse {
  const headers = Object.fromEntries(Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const raw = step.body === undefined ? '{}' : typeof step.body === 'string' ? step.body : JSON.stringify(step.body)
  return { status: step.status ?? 200, header: (n) => headers[n.toLowerCase()], body: Buffer.from(raw) }
}

class FakeFetch implements HttpClient {
  readonly calls: Array<{ url: string; at: number; req: HttpRequest }> = []
  script: Step[] = []
  fallback: Step = { body: { code: 'x' } }
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
  all() {
    return Object.values(this.lines).flat().join('\n')
  }
}

let time: FakeTime
let http: FakeFetch
let logger: MemoryLogger
let store: ModuleStore

function make(options: { minIntervalMs?: number; apiKey?: string } = {}) {
  return new JaniceClient({ http, clock: time, scheduler: time, logger, store }, { base: BASE, apiKey: KEY, userAgent: UA, ...options })
}

const failure = (r: JaniceFetch): CoreFailure => {
  if (r.ok) throw new Error('应该失败')
  return r
}

beforeEach(() => {
  time = new FakeTime(Date.UTC(2026, 9, 14, 12, 0))
  http = new FakeFetch(time)
  logger = new MemoryLogger()
  store = createModuleStore()
})

describe('JaniceClient request', () => {
  it('sends the key only in X-ApiKey, with Accept and User-Agent, 10 s timeout and 4 MB limit', async () => {
    const r = await make().fetchAppraisal('AbC123')
    expect(r.ok).toBe(true)
    const { req, url } = http.calls[0]
    expect(url).toBe(path('AbC123'))
    expect(req.method).toBe('GET')
    expect(req.headers).toEqual({ 'X-ApiKey': KEY, Accept: 'application/json', 'User-Agent': UA })
    expect(req.timeoutMs).toBe(10_000)
    expect(req.maxBytes).toBe(4 * 1024 * 1024)
    expect(req.body).toBeUndefined()
    expect(url).not.toContain(KEY)
  })

  it('never requests with a bad code or without a key', async () => {
    const client = make()
    for (const code of ['abc', 'a'.repeat(17), 'ab/../cd', 'ab cd12', 'AbC123?x=1', '']) {
      expect(failure(await client.fetchAppraisal(code)).code, code).toBe('BAD_ARGUMENT')
    }
    expect(failure(await make({ apiKey: '' }).fetchAppraisal('AbC123')).code).toBe('NOT_CONFIGURED')
    expect(http.calls).toHaveLength(0)
  })
})

describe('JaniceClient status mapping', () => {
  const cases: Array<[number, string]> = [
    [404, 'JANICE_NOT_FOUND'], [400, 'JANICE_NOT_FOUND'], [401, 'JANICE_BAD_KEY'], [403, 'JANICE_BAD_KEY'],
    [500, 'JANICE_DOWN'], [502, 'JANICE_DOWN'], [503, 'JANICE_DOWN'], [418, 'JANICE_DOWN'],
  ]
  for (const [status, code] of cases) {
    it(`${status} -> ${code}`, async () => {
      http.script = [{ status, body: { type: 'x', title: 't', status, detail: 'd', instance: 'i' } }]
      expect(failure(await make({ minIntervalMs: 0 }).fetchAppraisal('AbC123')).code).toBe(code)
    })
  }

  it('400 and 404 check the key once via /markets: 200 = not found, 400/401/403 = bad key', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = [{ status: 400 }, { body: [] }]
    expect(failure(await client.fetchAppraisal('AbC123')).code).toBe('JANICE_NOT_FOUND')
    const check = http.calls[1]
    expect(check.url).toBe(`${BASE}/api/rest/v2/markets`)
    expect(check.req.headers).toEqual({ 'X-ApiKey': KEY, Accept: 'application/json', 'User-Agent': UA })
    expect(check.req.timeoutMs).toBe(5000)
    expect(check.req.maxBytes).toBeLessThan(1024 * 1024)
    expect(check.req.redirect).toBe('manual')
    for (const status of [400, 401, 403]) {
      const other = make({ minIntervalMs: 0 })
      http.script = [{ status: 404 }, { status }]
      expect(failure(await other.fetchAppraisal('Zz9Yx8')).code, String(status)).toBe('JANICE_BAD_KEY')
    }
    expect(logger.all()).not.toContain(KEY)
  })

  it('keeps the interval between the appraisal request and the key check', async () => {
    const client = make()
    http.script = [{ status: 400 }, { body: [] }]
    const pending = client.fetchAppraisal('AbC123')
    await flush()
    expect(http.calls).toHaveLength(1)
    await time.advance(1000)
    expect(failure(await pending).code).toBe('JANICE_NOT_FOUND')
    expect(http.calls.map((c) => c.at)).toEqual([http.calls[0].at, http.calls[0].at + 1000])
  })

  it('maps timeouts and network errors to JANICE_DOWN, too-large and non-JSON to JANICE_BAD_RESPONSE', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = [new NetworkError('timeout', '超时'), new NetworkError('network', 'ECONNRESET'), new NetworkError('too-large'), { body: '<html>' }]
    expect(failure(await client.fetchAppraisal('AbC123')).code).toBe('JANICE_DOWN')
    expect(failure(await client.fetchAppraisal('AbC123')).code).toBe('JANICE_DOWN')
    expect(failure(await client.fetchAppraisal('AbC123')).code).toBe('JANICE_BAD_RESPONSE')
    expect(failure(await client.fetchAppraisal('AbC123')).code).toBe('JANICE_BAD_RESPONSE')
  })

  it('returns the parsed JSON on 200', async () => {
    http.script = [{ body: { code: 'AbC123', n: 1 } }]
    expect(await make().fetchAppraisal('AbC123')).toEqual({ ok: true, json: { code: 'AbC123', n: 1 } })
  })
})

describe('JaniceClient spacing', () => {
  it('serialises requests and keeps at least 1 s between them', async () => {
    const client = make()
    const results = [client.fetchAppraisal('AbC123'), client.fetchAppraisal('Zz9Yx8'), client.fetchAppraisal('Qq1Ww2')]
    await time.advance(0)
    expect(http.calls).toHaveLength(1)
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
    const first = client.fetchAppraisal('AbC123')
    const second = client.fetchAppraisal('Zz9Yx8')
    await time.advance(5000)
    expect(http.calls).toHaveLength(1)
    http.releaseAll()
    await flush()
    await first
    await time.advance(999)
    expect(http.calls).toHaveLength(1)
    await time.advance(1)
    expect(http.calls).toHaveLength(2)
    expect((await second).ok).toBe(true)
  })

  it('answers busy when too many are waiting', async () => {
    const client = make()
    const waiting = Array.from({ length: 10 }, (_, i) => client.fetchAppraisal(`Code${i}x`))
    expect(failure(await client.fetchAppraisal('Over111')).code).toBe('JANICE_BUSY')
    await time.advance(20_000)
    await Promise.all(waiting)
  })
})

describe('JaniceClient 429', () => {
  it('pauses until Retry-After and answers busy without requesting', async () => {
    const client = make()
    http.script = [{ status: 429, headers: { 'Retry-After': '120' } }]
    const t0 = time.now()
    expect(failure(await client.fetchAppraisal('AbC123'))).toMatchObject({ code: 'JANICE_BUSY', retryAt: t0 + 120_000 })
    await time.advance(119_000)
    expect(failure(await client.fetchAppraisal('Zz9Yx8'))).toMatchObject({ code: 'JANICE_BUSY', retryAt: t0 + 120_000 })
    expect(http.calls).toHaveLength(1)
    await time.advance(1000)
    expect((await client.fetchAppraisal('Zz9Yx8')).ok).toBe(true)
    expect(http.calls).toHaveLength(2)
  })

  it('pauses 60 s when there is no Retry-After', async () => {
    http.script = [{ status: 429 }]
    const t0 = time.now()
    expect(failure(await make().fetchAppraisal('AbC123')).retryAt).toBe(t0 + 60_000)
  })

  it('keeps the pause across client instances (plugin reload)', async () => {
    http.script = [{ status: 429, headers: { 'Retry-After': '30' } }]
    await make().fetchAppraisal('AbC123')
    expect(failure(await make().fetchAppraisal('Zz9Yx8')).code).toBe('JANICE_BUSY')
    expect(http.calls).toHaveLength(1)
  })
})

describe('JaniceClient redirects', () => {
  it('requests with redirect manual and treats 3xx as down without following', async () => {
    http.script = [{ status: 302, headers: { Location: 'http://other.test/x' } }]
    const res = await make().fetchAppraisal('AbC123')
    expect(failure(res)).toMatchObject({ code: 'JANICE_DOWN', message: 'HTTP 3xx' })
    expect(http.calls).toHaveLength(1)
    expect(http.calls[0].req.redirect).toBe('manual')
  })
})

describe('JaniceClient 429 cap', () => {
  it('clamps a huge Retry-After to one hour', async () => {
    http.script = [{ status: 429, headers: { 'Retry-After': '99999999' } }]
    const t0 = time.now()
    expect(failure(await make().fetchAppraisal('AbC123')).retryAt).toBe(t0 + 3_600_000)
  })
})

describe('JaniceClient logging', () => {
  it('warns about a rejected key at most once per 10 minutes, with the status only', async () => {
    const client = make({ minIntervalMs: 0 })
    http.fallback = { status: 401, body: { detail: `bad ${KEY}` } }
    await client.fetchAppraisal('AbC123')
    await client.fetchAppraisal('AbC123')
    expect(logger.lines.warn).toHaveLength(1)
    expect(logger.lines.warn[0]).toContain('401')
    await time.advance(9 * 60_000)
    await client.fetchAppraisal('AbC123')
    expect(logger.lines.warn).toHaveLength(1)
    await time.advance(60_000)
    await client.fetchAppraisal('AbC123')
    expect(logger.lines.warn).toHaveLength(2)
    expect(logger.all()).not.toContain(KEY)
  })

  it('warns once per outage and says when it recovers', async () => {
    const client = make({ minIntervalMs: 0 })
    http.script = [{ status: 500 }, { status: 500 }]
    await client.fetchAppraisal('AbC123')
    await client.fetchAppraisal('AbC123')
    expect(logger.lines.warn).toHaveLength(1)
    await client.fetchAppraisal('AbC123')
    expect(logger.lines.info).toHaveLength(1)
  })

  it('stop() aborts the queue', async () => {
    const client = make()
    http.script = ['hang']
    const first = client.fetchAppraisal('AbC123')
    const second = client.fetchAppraisal('Zz9Yx8')
    await flush()
    client.stop()
    http.releaseAll()
    await time.advance(5000)
    await first
    expect(failure(await second).code).toBe('JANICE_DOWN')
    expect(failure(await client.fetchAppraisal('Qq1Ww2')).code).toBe('JANICE_DOWN')
  })
})
