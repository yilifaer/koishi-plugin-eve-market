import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAP_CACHE_MIN, MAP_MAX_BYTES, MAP_TIMEOUT_MS } from '../../../src/constants'
import { NetworkError } from '../../../src/core/ports'
import type { HttpClient, HttpRequest, HttpResponse } from '../../../src/core/ports'
import type { CoreFailure, InfluenceMap } from '../../../src/core/types'
import { createInfluenceMaps, mapCacheKey } from '../../../src/core/universe'
import { sniffImage } from '../../../src/core/util'
import type { InfluenceMapsOptions } from '../../../src/core/universe'
import { MAP_RETRY_MS, MAP_REVALIDATE_WAIT_MS, MAP_WARM_DELAY_MS } from '../../../src/core/universe/maps'
import { FakeTime, flush } from '../../fakes/fake-time'
import { MemoryBlobCache, MemoryLogger } from '../esi/helpers'

const PNG = fs.readFileSync(path.join(__dirname, 'fixtures/influence.png'))
const JPEG = fs.readFileSync(path.join(__dirname, 'fixtures/coalition.jpg'))
const HTML = Buffer.from('<!doctype html><title>维护中</title>')

// 编造的图片地址
const INFLUENCE_URL = 'https://maps.example.test/influence/influence.png'
const COALITION_URL = 'https://maps.example.test/coalition/coalition.png'
const MOVED_URL = 'https://mirror.example.test/influence.png'
const LAST_MODIFIED = 'Wed, 07 Oct 2026 04:00:00 GMT'
const MINUTE = 60_000
const TTL = MAP_CACHE_MIN * MINUTE
/** random 固定 0.5 时后台更新往后推 30 秒 */
const SPREAD = 30_000

interface Hosted {
  body: Buffer
  contentType?: string
  etag?: string
  lastModified?: string
}

function response(status: number, body: Buffer, headers: Record<string, string | undefined> = {}): HttpResponse {
  const lower = new Map(Object.entries(headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k.toLowerCase(), v as string]))
  return { status, body, header: (name) => lower.get(name.toLowerCase()) }
}

const header = (req: HttpRequest, name: string) => Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]

/** 本机的假图片网站：支持 ETag / If-Modified-Since、大小上限、故障、卡住 */
class FakeImageHost implements HttpClient {
  readonly requests: HttpRequest[] = []
  readonly images = new Map<string, Hosted>()
  /** 接下来几次请求的故障（按顺序用掉） */
  failures: Array<{ status?: number; error?: NetworkError }> = []
  private gate: Promise<void> | null = null

  /** 之后的请求一直等到调用返回的函数 */
  hold(): () => void {
    let release!: () => void
    this.gate = new Promise((resolve) => { release = resolve })
    return () => {
      this.gate = null
      release()
    }
  }

  count(url?: string) {
    return this.requests.filter((r) => !url || r.url === url).length
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req)
    if (this.gate) {
      await Promise.race([this.gate, new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve(), { once: true }))])
    }
    if (req.signal?.aborted) throw new NetworkError('aborted')
    const fault = this.failures.shift()
    if (fault?.error) throw fault.error
    if (fault?.status) return response(fault.status, HTML, { 'Content-Type': 'text/html' })
    const image = this.images.get(req.url)
    if (!image) return response(404, HTML, { 'Content-Type': 'text/html' })
    if (req.maxBytes && image.body.length > req.maxBytes) throw new NetworkError('too-large', `超过 ${req.maxBytes} 字节`)
    const headers = { 'Content-Type': image.contentType ?? 'image/png', ETag: image.etag, 'Last-Modified': image.lastModified }
    const matches = (image.etag && header(req, 'If-None-Match') === image.etag)
      || (!image.etag && image.lastModified && header(req, 'If-Modified-Since') === image.lastModified)
    if (matches) return response(304, Buffer.alloc(0), headers)
    return response(200, Buffer.from(image.body), headers)
  }
}

interface Setup {
  urls?: Partial<InfluenceMapsOptions['urls']>
  cache?: MemoryBlobCache
  time?: FakeTime
  host?: FakeImageHost
}

function setup(o: Setup = {}) {
  const time = o.time ?? new FakeTime()
  const host = o.host ?? new FakeImageHost()
  const cache = o.cache ?? new MemoryBlobCache()
  const logger = new MemoryLogger()
  const maps = createInfluenceMaps({
    http: host,
    cache,
    clock: time,
    scheduler: time,
    logger,
    urls: { influence: INFLUENCE_URL, coalition: COALITION_URL, ...o.urls },
    version: '0.0.3',
    random: () => 0.5,
  })
  return { time, host, cache, logger, maps }
}

function ok(value: InfluenceMap | CoreFailure): InfluenceMap {
  if ('ok' in value) throw new Error(`失败了：${value.code} ${value.message}`)
  return value
}

describe('sniffImage', () => {
  it('knows PNG and JPEG by their first bytes, nothing else', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(HTML)).toBeNull()
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull()
    expect(sniffImage(PNG.subarray(0, 4))).toBeNull()
    expect(sniffImage(Buffer.alloc(0))).toBeNull()
  })

  it('reads a view at its own offset', () => {
    const block = Buffer.concat([Buffer.from('xxxx'), JPEG])
    expect(sniffImage(new Uint8Array(block.buffer, block.byteOffset + 4, JPEG.length))).toBe('image/jpeg')
  })
})

describe('influence maps: download and cache', () => {
  it('downloads on first use and hands out the bytes unchanged, MIME from the file header', async () => {
    const { host, cache, maps, time } = setup()
    host.images.set(INFLUENCE_URL, { body: PNG, contentType: 'application/octet-stream', etag: '"a1"', lastModified: LAST_MODIFIED })
    expect(maps.cached('influence')).toBe(false)
    const got = ok(await maps.get('influence'))
    expect(got).toMatchObject({ kind: 'influence', mime: 'image/png', updatedAt: Date.parse(LAST_MODIFIED), checkedAt: time.now(), stale: false })
    expect(Buffer.isBuffer(got.body) && got.body.equals(PNG)).toBe(true)
    expect(maps.cached('influence')).toBe(true)
    expect(maps.cached('coalition')).toBe(false)

    const [req] = host.requests
    expect(req).toMatchObject({ method: 'GET', url: INFLUENCE_URL, timeoutMs: MAP_TIMEOUT_MS, maxBytes: MAP_MAX_BYTES })
    expect(header(req, 'Accept')).toMatch(/image\/png/)
    expect(header(req, 'User-Agent')).toMatch(/^koishi-plugin-eve-market\/0\.0\.3 /)
    expect(header(req, 'If-None-Match')).toBeUndefined()

    const saved = cache.entries.get(mapCacheKey('influence'))
    expect(saved?.body.equals(PNG)).toBe(true)
    expect(saved?.meta).toMatchObject({ url: INFLUENCE_URL, mime: 'image/png', etag: '"a1"', lastModified: LAST_MODIFIED })
  })

  it('a JPEG is a JPEG whatever Content-Type says; an HTML page is refused', async () => {
    const { host, maps } = setup()
    host.images.set(COALITION_URL, { body: JPEG, contentType: 'image/png' })
    expect(ok(await maps.get('coalition')).mime).toBe('image/jpeg')
    host.images.set(INFLUENCE_URL, { body: HTML, contentType: 'image/png' })
    const failed = await maps.get('influence')
    expect(failed).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    expect((failed as CoreFailure).message).toContain('不是 PNG 或 JPEG')
    expect((failed as CoreFailure).reason).toBeUndefined()
  })

  it('an empty address means the map is not offered: no request, no timer', async () => {
    const { host, maps, time } = setup({ urls: { coalition: '' } })
    expect(await maps.get('coalition')).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
    expect(maps.cached('coalition')).toBe(false)
    maps.start()
    await flush()
    expect(time.pending).toBe(1)
    expect(host.count()).toBe(0)
    maps.stop()
  })

  it('the cache answers for 60 minutes; then a conditional request, and 304 keeps the image', async () => {
    const { host, cache, maps, time } = setup()
    host.images.set(INFLUENCE_URL, { body: PNG, etag: '"a1"', lastModified: LAST_MODIFIED })
    await maps.get('influence')
    await time.advance(TTL - MINUTE)
    await maps.get('influence')
    expect(host.count()).toBe(1)

    await time.advance(2 * MINUTE)
    const again = ok(await maps.get('influence'))
    expect(host.count()).toBe(2)
    expect(header(host.requests[1], 'If-None-Match')).toBe('"a1"')
    expect(header(host.requests[1], 'If-Modified-Since')).toBe(LAST_MODIFIED)
    expect(again).toMatchObject({ checkedAt: time.now(), updatedAt: Date.parse(LAST_MODIFIED), stale: false })
    expect(again.body.equals(PNG)).toBe(true)
    // 304 不重写本地缓存
    expect(cache.writes).toBe(1)
  })

  it('a new image replaces the old one; without Last-Modified the time is when the bytes changed', async () => {
    const { host, maps, time } = setup()
    host.images.set(INFLUENCE_URL, { body: PNG })
    const t0 = time.now()
    expect(ok(await maps.get('influence')).updatedAt).toBe(t0)

    await time.advance(TTL + MINUTE)
    expect(ok(await maps.get('influence'))).toMatchObject({ updatedAt: t0, checkedAt: time.now() })

    await time.advance(TTL + MINUTE)
    host.images.set(INFLUENCE_URL, { body: JPEG })
    const changed = ok(await maps.get('influence'))
    expect(changed).toMatchObject({ mime: 'image/jpeg', updatedAt: time.now() })
    expect(changed.body.equals(JPEG)).toBe(true)
    expect(host.count()).toBe(3)
  })

  it('concurrent requests share one download', async () => {
    const { host, maps } = setup()
    host.images.set(INFLUENCE_URL, { body: PNG })
    const all = await Promise.all([maps.get('influence'), maps.get('influence'), maps.get('influence')])
    expect(all.map((m) => ok(m).body.equals(PNG))).toEqual([true, true, true])
    expect(host.count()).toBe(1)
  })
})

describe('influence maps: when the source is down', () => {
  it('sends the old image marked stale, and does not retry for a few minutes', async () => {
    const { host, maps, time, logger } = setup()
    host.images.set(INFLUENCE_URL, { body: PNG, lastModified: LAST_MODIFIED })
    await maps.get('influence')

    await time.advance(TTL + MINUTE)
    host.failures.push({ status: 502 })
    const old = ok(await maps.get('influence'))
    expect(old).toMatchObject({ stale: true, updatedAt: Date.parse(LAST_MODIFIED) })
    expect(old.body.equals(PNG)).toBe(true)
    expect(host.count()).toBe(2)

    await time.advance(MINUTE)
    expect(ok(await maps.get('influence')).stale).toBe(true)
    expect(host.count()).toBe(2)

    await time.advance(MAP_RETRY_MS)
    host.failures.push({ error: new NetworkError('network', 'ECONNREFUSED') })
    expect(ok(await maps.get('influence')).stale).toBe(true)
    expect(host.count()).toBe(3)
    // 连续失败只写一次 warn
    expect(logger.at('warn')).toHaveLength(1)
    expect(logger.at('warn')[0]).toContain('势力图更新失败，先用旧图')

    await time.advance(MAP_RETRY_MS)
    expect(ok(await maps.get('influence')).stale).toBe(false)
    expect(logger.at('info')).toEqual(['势力图恢复更新'])
  })

  it('no old image: UPSTREAM_UNAVAILABLE, answered at once while backing off', async () => {
    const { host, maps, time } = setup()
    host.failures.push({ status: 500 })
    expect(await maps.get('influence')).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: 'HTTP 500' })
    await time.advance(MINUTE)
    expect(await maps.get('influence')).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    expect(host.count()).toBe(1)
  })

  it('an image over the size limit is reported as too large; an old image is still sent', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAP_MAX_BYTES)])
    const a = setup()
    a.host.images.set(INFLUENCE_URL, { body: big })
    expect(await a.maps.get('influence')).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE', reason: 'too-large' })
    await a.time.advance(MINUTE)
    expect(await a.maps.get('influence')).toMatchObject({ ok: false, reason: 'too-large' })

    const b = setup()
    b.host.images.set(INFLUENCE_URL, { body: PNG })
    await b.maps.get('influence')
    await b.time.advance(TTL + MINUTE)
    b.host.images.set(INFLUENCE_URL, { body: big })
    const old = ok(await b.maps.get('influence'))
    expect(old.stale).toBe(true)
    expect(old.body.equals(PNG)).toBe(true)
  })

  it('an expired image is sent after 2 seconds if the new one is still on its way', async () => {
    const { host, maps, time } = setup()
    host.images.set(INFLUENCE_URL, { body: PNG })
    await maps.get('influence')
    await time.advance(TTL + MINUTE)
    host.images.set(INFLUENCE_URL, { body: JPEG })
    const release = host.hold()
    const waiting = maps.get('influence')
    await time.advance(MAP_REVALIDATE_WAIT_MS)
    const old = ok(await waiting)
    expect(old).toMatchObject({ mime: 'image/png', stale: false })
    release()
    await flush()
    expect(ok(await maps.get('influence')).mime).toBe('image/jpeg')
    expect(host.count()).toBe(2)
  })
})

describe('influence maps: startup and background refresh', () => {
  /** 先用一个实例下载两张图，写进本地缓存 */
  async function primed() {
    const first = setup()
    first.host.images.set(INFLUENCE_URL, { body: PNG, etag: '"a1"' })
    first.host.images.set(COALITION_URL, { body: JPEG, etag: '"b1"' })
    await first.maps.get('influence')
    await first.maps.get('coalition')
    return first
  }

  it('starts from the local cache and refreshes when it expires, then every 60 minutes', async () => {
    const first = await primed()
    await first.time.advance(10 * MINUTE)
    const { maps, host, time } = setup({ cache: first.cache, time: first.time, host: first.host })
    host.requests.length = 0
    maps.start()
    await flush()
    expect([maps.cached('influence'), maps.cached('coalition')]).toEqual([true, true])
    const local = ok(await maps.get('coalition'))
    expect(local.body.equals(JPEG)).toBe(true)
    // 本地图片是读出来的缓存文件里的一段（不复制）；Buffer 交给机器人时按 base64 编码的只有这一段
    expect(local.body.toString('base64')).toBe(JPEG.toString('base64'))
    expect(host.count()).toBe(0)

    await time.advance(TTL - 10 * MINUTE + SPREAD)
    expect(host.count()).toBe(2)
    expect(host.requests.map((r) => header(r, 'If-None-Match')).sort()).toEqual(['"a1"', '"b1"'])
    await time.advance(TTL + SPREAD)
    expect(host.count()).toBe(4)
    maps.stop()
    expect(time.pending).toBe(0)
  })

  it('an old local cache is refreshed shortly after start, not at once', async () => {
    const first = await primed()
    await first.time.advance(3 * TTL)
    const { maps, host, time } = setup({ cache: first.cache, time: first.time, host: first.host })
    host.requests.length = 0
    maps.start()
    await time.advance(MAP_WARM_DELAY_MS)
    expect(host.count()).toBe(0)
    await time.advance(SPREAD)
    expect(host.count()).toBe(2)
    maps.stop()
  })

  it('warms up an empty cache; a failed warm-up is retried an hour later', async () => {
    const { maps, host, time } = setup()
    host.images.set(INFLUENCE_URL, { body: PNG })
    maps.start()
    maps.start()
    await time.advance(MAP_WARM_DELAY_MS + SPREAD)
    expect(host.count(INFLUENCE_URL)).toBe(1)
    expect(host.count(COALITION_URL)).toBe(1)
    expect(maps.cached('influence')).toBe(true)
    expect(maps.cached('coalition')).toBe(false)
    host.images.set(COALITION_URL, { body: JPEG })
    await time.advance(TTL + SPREAD)
    expect(maps.cached('coalition')).toBe(true)
    maps.stop()
  })

  it('a cached image from another address is not used', async () => {
    const first = await primed()
    const { maps, host } = setup({ cache: first.cache, time: first.time, host: first.host, urls: { influence: MOVED_URL } })
    host.images.set(MOVED_URL, { body: JPEG })
    maps.start()
    await flush()
    expect(maps.cached('influence')).toBe(false)
    expect(ok(await maps.get('influence')).mime).toBe('image/jpeg')
    expect(host.count(MOVED_URL)).toBe(1)
    maps.stop()
  })

  it('a broken local cache is ignored', async () => {
    const cache = new MemoryBlobCache()
    await cache.write(mapCacheKey('influence'), HTML, { v: 1, url: INFLUENCE_URL, updatedAt: 1, checkedAt: 1 })
    await cache.write(mapCacheKey('coalition'), JPEG, { v: 1, url: COALITION_URL, updatedAt: 'yesterday', checkedAt: 1 })
    const { maps } = setup({ cache })
    maps.start()
    await flush()
    expect([maps.cached('influence'), maps.cached('coalition')]).toEqual([false, false])
    maps.stop()
  })

  it('stop cancels the timers and the download in progress, quietly', async () => {
    const { maps, host, time, logger } = setup()
    host.images.set(INFLUENCE_URL, { body: PNG })
    maps.start()
    await flush()
    expect(time.pending).toBe(2)
    host.hold()
    const waiting = maps.get('influence')
    await flush()
    maps.stop()
    expect(time.pending).toBe(0)
    expect(await waiting).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    expect(logger.at('warn')).toEqual([])
  })
})
