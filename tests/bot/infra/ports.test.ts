import { promises as fs } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { Context, Logger } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AesSecretBox, FileBlobCache, KoishiHttpClient, SECRET_KEY_FILE, dataDir, decodeBlob, encodeBlob, keyIdOf, koishiLogger,
  koishiScheduler, loadSecretKey, makePorts, moduleStore, openSecretBox, unavailableSecretBox,
} from '../../../src/bot/ports'
import { NetworkError } from '../../../src/core/ports'
import type { AuthStore, HttpClient } from '../../../src/core/ports'
import { redact } from '../../../src/core/util'

// ------------------------------------------------------------------ 本机测试服务

let server: http.Server
let base = ''
const seen: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }> = []

function route(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
  const url = new URL(req.url ?? '/', base)
  seen.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body })
  switch (url.pathname) {
    case '/ok':
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v1"', 'X-Pages': '3' })
      return res.end('{"ok":true}')
    case '/status': {
      const status = Number(url.searchParams.get('code'))
      res.writeHead(status, { 'Content-Type': 'application/json' })
      return res.end(status === 304 ? undefined : `{"error":"e${status}"}`)
    }
    case '/echo':
      res.writeHead(201, { 'Content-Type': 'text/plain' })
      return res.end(`${req.method} ${req.headers['content-type']} ${body}`)
    case '/slow':
      return setTimeout(() => res.end('late'), Number(url.searchParams.get('ms') ?? 2000))
    case '/slow-body':
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.write('a')
      return setTimeout(() => res.end('b'), 2000)
    case '/big-declared':
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '1000' })
      return res.end(Buffer.alloc(1000, 1))
    case '/big-chunked': {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      for (let i = 0; i < 10; i++) res.write(Buffer.alloc(100, 2))
      return res.end()
    }
    case '/gzip':
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
      return res.end(gzipSync(Buffer.from('{"zipped":true}')))
    case '/binary':
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]))
    default:
      res.writeHead(404)
      return res.end()
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => route(req, res, Buffer.concat(chunks).toString('utf8')))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function app(httpConfig: Record<string, unknown> = {}) {
  const ctx = new Context()
  ctx.plugin(HTTP as never, httpConfig)
  await ctx.start()
  return ctx
}

async function failure(promise: Promise<unknown>): Promise<NetworkError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(NetworkError)
    return error as NetworkError
  }
  throw new Error('expected a NetworkError')
}

// ------------------------------------------------------------------ HttpClient

describe('KoishiHttpClient', () => {
  let ctx: Context
  let client: HttpClient

  beforeEach(async () => {
    seen.length = 0
    ctx = await app()
    client = new KoishiHttpClient(ctx.http)
  })

  afterEach(async () => {
    await ctx.stop()
  })

  it('returns status, raw body and case-insensitive headers', async () => {
    const res = await client.request({ method: 'GET', url: `${base}/ok`, headers: { 'User-Agent': 'eve-market-test' } })
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('{"ok":true}')
    expect(Buffer.isBuffer(res.body)).toBe(true)
    expect(res.header('etag')).toBe('"v1"')
    expect(res.header('X-PAGES')).toBe('3')
    expect(res.header('x-missing')).toBeUndefined()
    expect(seen[0].headers['user-agent']).toBe('eve-market-test')
  })

  it('does not throw on non-2xx', async () => {
    for (const code of [304, 400, 403, 404, 420, 500, 503]) {
      const res = await client.request({ method: 'GET', url: `${base}/status?code=${code}` })
      expect(res.status).toBe(code)
      expect(res.body.toString()).toBe(code === 304 ? '' : `{"error":"e${code}"}`)
    }
  })

  it('sends the body as given, with the caller\'s content type', async () => {
    const res = await client.request({
      method: 'POST',
      url: `${base}/echo`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&x=1',
    })
    expect(res.status).toBe(201)
    expect(res.body.toString()).toBe('POST application/x-www-form-urlencoded grant_type=refresh_token&x=1')
  })

  it('keeps binary bodies intact and decodes gzip', async () => {
    expect([...(await client.request({ method: 'GET', url: `${base}/binary` })).body]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 255])
    expect((await client.request({ method: 'GET', url: `${base}/gzip` })).body.toString()).toBe('{"zipped":true}')
  })

  it('times out while waiting for headers or for the body', async () => {
    const e1 = await failure(client.request({ method: 'GET', url: `${base}/slow`, timeoutMs: 100 }))
    expect(e1.kind).toBe('timeout')
    expect(e1.message).toBe('100 毫秒没有响应')
    const e2 = await failure(client.request({ method: 'GET', url: `${base}/slow-body`, timeoutMs: 150 }))
    expect(e2.kind).toBe('timeout')
  })

  it('stops reading past maxBytes, by Content-Length or while streaming', async () => {
    const e1 = await failure(client.request({ method: 'GET', url: `${base}/big-declared`, maxBytes: 100 }))
    expect(e1.kind).toBe('too-large')
    expect(e1.message).toBe('响应超过 100 字节')
    expect((await failure(client.request({ method: 'GET', url: `${base}/big-chunked`, maxBytes: 250 }))).kind).toBe('too-large')
    expect((await client.request({ method: 'GET', url: `${base}/big-chunked`, maxBytes: 1000 })).body.length).toBe(1000)
  })

  it('reports cancellation by the caller as aborted', async () => {
    const controller = new AbortController()
    const pending = client.request({ method: 'GET', url: `${base}/slow`, signal: controller.signal, timeoutMs: 5000 })
    setTimeout(() => controller.abort(), 50)
    expect((await failure(pending)).kind).toBe('aborted')
    const done = new AbortController()
    done.abort()
    expect((await failure(client.request({ method: 'GET', url: `${base}/ok`, signal: done.signal }))).kind).toBe('aborted')
  })

  it('reports a refused connection as a network error without the URL', async () => {
    const closed = http.createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const error = await failure(client.request({ method: 'GET', url: `http://127.0.0.1:${port}/x?token=secret-value` }))
    expect(error.kind).toBe('network')
    expect(error.message).toMatch(/^连接失败：/)
    expect(error.message).not.toContain('secret-value')
  })

  it('its own timeout wins over the http plugin\'s global timeout; without one the global timeout applies', async () => {
    const strict = await app({ timeout: 50 })
    try {
      const own = new KoishiHttpClient(strict.http)
      const res = await own.request({ method: 'GET', url: `${base}/slow?ms=200`, timeoutMs: 2000 })
      expect(res.body.toString()).toBe('late')
      expect((await failure(own.request({ method: 'GET', url: `${base}/slow?ms=500` }))).kind).toBe('timeout')
    } finally {
      await strict.stop()
    }
  })
})

// ------------------------------------------------------------------ 文件缓存

describe('FileBlobCache', () => {
  let dir: string
  let cache: FileBlobCache

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-market-cache-'))
    cache = new FileBlobCache(path.join(dir, 'cache'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('round-trips body and meta; missing keys read as null', async () => {
    expect(await cache.read('data/types.json')).toBeNull()
    await cache.write('data/types.json', Buffer.from('{"a":1}'), { etag: '"x"', sha256: 'abc', at: 5 })
    const entry = await cache.read('data/types.json')
    expect(entry?.body.toString()).toBe('{"a":1}')
    expect(entry?.meta).toEqual({ etag: '"x"', sha256: 'abc', at: 5 })
    await cache.write('structures/1000000000001/page-3', Buffer.alloc(0), {})
    expect(await cache.read('structures/1000000000001/page-3')).toEqual({ body: Buffer.alloc(0), meta: {} })
  })

  it('replaces atomically and leaves no temporary files', async () => {
    await cache.write('esi-meta.json', Buffer.from('one'), { n: 1 })
    await Promise.all(Array.from({ length: 10 }, (_, i) => cache.write('esi-meta.json', Buffer.from(`v${i}`), { n: i })))
    const entry = await cache.read('esi-meta.json')
    expect(entry!.body.toString()).toBe(`v${entry!.meta.n}`)
    expect(await fs.readdir(path.join(dir, 'cache'))).toEqual(['esi-meta.json.blob'])
  })

  it('removes entries; removing a missing one is fine', async () => {
    await cache.write('maps/influence.png', Buffer.from([1, 2, 3]), {})
    await cache.remove('maps/influence.png')
    await cache.remove('maps/influence.png')
    expect(await cache.read('maps/influence.png')).toBeNull()
  })

  it('rejects keys outside the cache format', async () => {
    for (const key of ['../secret.key', '/etc/passwd', 'a/../b', '.hidden', 'a//b', 'a\\b', '', 'a/.b', 'data/空格 名']) {
      await expect(cache.read(key)).rejects.toThrow('缓存键不合法')
      await expect(cache.write(key, Buffer.alloc(1), {})).rejects.toThrow('缓存键不合法')
    }
    expect(cache.fileOf('data/types.json')).toBe(path.join(dir, 'cache', 'data', 'types.json.blob'))
  })

  it('treats damaged files as missing', async () => {
    await cache.write('data/manifest.json', Buffer.from('{}'), { ok: true })
    const file = cache.fileOf('data/manifest.json')
    await fs.writeFile(file, Buffer.from('EMB1\x00\x00\x00\x10{"x"'))
    expect(await cache.read('data/manifest.json')).toBeNull()
    await fs.writeFile(file, 'not a blob')
    expect(await cache.read('data/manifest.json')).toBeNull()
    expect(decodeBlob(encodeBlob(Buffer.from('b'), { k: [1] }))).toEqual({ body: Buffer.from('b'), meta: { k: [1] } })
    expect(decodeBlob(Buffer.concat([Buffer.from('EMB1'), Buffer.from([0, 0, 0, 2]), Buffer.from('[]')]))).toBeNull()
  })
})

// ------------------------------------------------------------------ 密钥

describe('SecretBox', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-market-key-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const silent = { debug() {}, info() {}, warn() {}, error() {} }

  it('creates secret.key once (0600) and reads the same key afterwards', async () => {
    const infos: string[] = []
    const key = await loadSecretKey(path.join(dir, 'data', 'eve-market'), { ...silent, info: (m) => infos.push(String(m)) })
    const file = path.join(dir, 'data', 'eve-market', SECRET_KEY_FILE)
    expect(key).toHaveLength(32)
    expect((await fs.readFile(file, 'utf8')).trim()).toBe(key.toString('base64'))
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(infos).toHaveLength(1)
    expect(await loadSecretKey(path.join(dir, 'data', 'eve-market'), silent)).toEqual(key)
  })

  it('keyId is the first 8 hex digits of sha256(key)', () => {
    const key = Buffer.alloc(32, 7)
    expect(new AesSecretBox(key).keyId).toBe(keyIdOf(key))
    expect(keyIdOf(key)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('seals with a fresh IV each time and opens again', () => {
    const box = new AesSecretBox(Buffer.alloc(32, 1))
    const a = box.seal('refresh-token-value')
    const b = box.seal('refresh-token-value')
    expect(a).not.toBe(b)
    expect(a).toMatch(new RegExp(`^v1:${box.keyId}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$`))
    expect(box.open(a)).toBe('refresh-token-value')
    expect(box.open(box.seal('中文 & 符号'))).toBe('中文 & 符号')
    // 日志脱敏认得这种密文
    expect(redact(`saved ${a}`)).toBe('saved v1:***')
  })

  it('refuses tampered, foreign and malformed ciphertext', () => {
    const box = new AesSecretBox(Buffer.alloc(32, 1))
    const other = new AesSecretBox(Buffer.alloc(32, 2))
    const sealed = box.seal('secret')
    const parts = sealed.split(':')
    const flipped = Buffer.from(parts[4], 'base64url')
    flipped[0] ^= 1
    expect(() => box.open([...parts.slice(0, 4), flipped.toString('base64url')].join(':'))).toThrow('密文校验失败')
    expect(() => other.open(sealed)).toThrow('密文是用另一个密钥加密的')
    expect(() => other.open([parts[0], other.keyId, ...parts.slice(2)].join(':'))).toThrow('密文校验失败')
    expect(() => box.open('v2:x:y:z:w')).toThrow('密文格式不对')
    expect(() => box.open(`v1:${box.keyId}:AAAA:${parts[3]}:${parts[4]}`)).toThrow('密文格式不对')
    expect(() => new AesSecretBox(Buffer.alloc(16))).toThrow('32 字节')
  })

  it('accepts a raw 32-byte key file, never overwrites a bad one, and falls back to an unavailable box', async () => {
    const raw = Buffer.alloc(32, 9)
    await fs.writeFile(path.join(dir, SECRET_KEY_FILE), raw)
    expect(await loadSecretKey(dir, silent)).toEqual(raw)

    await fs.writeFile(path.join(dir, SECRET_KEY_FILE), 'not-a-key')
    const errors: string[] = []
    const box = await openSecretBox(dir, { ...silent, error: (m) => errors.push(String(m)) })
    expect(box.keyId).toBe('')
    expect(() => box.seal('x')).toThrow('密钥文件不可用')
    expect(errors).toEqual(['读取 EVE 授权的密钥文件失败，授权功能暂时不能用：secret.key 不是 32 字节的密钥'])
    expect(await fs.readFile(path.join(dir, SECRET_KEY_FILE), 'utf8')).toBe('not-a-key')
    expect(() => unavailableSecretBox('x').open('v1:a:b:c:d')).toThrow('密钥文件不可用：x')
  })
})

// ------------------------------------------------------------------ 定时器、日志、组装

describe('Scheduler, Logger and makePorts', () => {
  it('ctx.setTimeout fires, can be cancelled, and is cleared when the plugin stops', async () => {
    const root = await app()
    const fired: string[] = []
    let scheduler!: ReturnType<typeof koishiScheduler>
    const fork = root.plugin({ name: 'timers', apply: (ctx: Context) => { scheduler = koishiScheduler(ctx) } })
    scheduler.timeout(() => fired.push('a'), 10)
    const cancel = scheduler.timeout(() => fired.push('b'), 10)
    cancel()
    scheduler.timeout(() => fired.push('c'), 200)
    scheduler.timeout(() => fired.push('negative'), -5)
    await new Promise((resolve) => setTimeout(resolve, 60))
    fork.dispose()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(fired.sort()).toEqual(['a', 'negative'])
    // 停用以后再排的定时器直接忽略，不抛错
    expect(() => scheduler.timeout(() => fired.push('late'), 1)()).not.toThrow()
    await root.stop()
  })

  it('the logger writes to Koishi\'s logger', async () => {
    const records: Logger.Record[] = []
    const target: Logger.Target = { colors: 0, record: (r) => records.push(r) }
    Logger.targets.push(target)
    const root = new Context()
    try {
      const logger = koishiLogger(root, 'eve-market-test')
      logger.warn('配置问题：%s', '第 1 行')
      logger.info('一切正常')
      expect(records.filter((r) => r.name === 'eve-market-test').map((r) => [r.type, r.content])).toEqual([
        ['warn', '配置问题：第 1 行'],
        ['info', '一切正常'],
      ])
    } finally {
      Logger.targets.splice(Logger.targets.indexOf(target), 1)
    }
  })

  it('makePorts puts secret.key and cache/ under <instance>/data/eve-market', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-market-instance-'))
    const root = await app()
    try {
      root.baseDir = dir
      expect(dataDir(root)).toBe(path.join(dir, 'data', 'eve-market'))
      const auth: AuthStore = { list: async () => [], get: async () => undefined, upsert: async () => {}, remove: async () => {} }
      const ports = await makePorts(root, { auth, bundledDataDir: '/bundled', version: '0.0.1' })
      expect(ports.store).toBe(moduleStore())
      expect(ports.auth).toBe(auth)
      expect(ports.version).toBe('0.0.1')
      expect(ports.secrets.keyId).toMatch(/^[0-9a-f]{8}$/)
      await ports.cache.write('data/x.json', Buffer.from('1'), {})
      expect(await fs.readdir(path.join(dir, 'data', 'eve-market'))).toEqual(['cache', SECRET_KEY_FILE])
      expect(Math.abs(ports.clock.now() - Date.now())).toBeLessThan(1000)
      expect((await ports.http.request({ method: 'GET', url: `${base}/ok` })).status).toBe(200)
    } finally {
      await root.stop()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('the module store is one object for the whole process', () => {
    expect(moduleStore()).toBe(moduleStore())
    expect(moduleStore().get('ports-test', () => ({ n: 1 }))).toBe(moduleStore().get('ports-test', () => ({ n: 2 })))
  })
})
