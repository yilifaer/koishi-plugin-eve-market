// core/data 测试共用：从小数据集派生出「另一个版本」、假的 HTTP / BlobCache / 日志、临时的自带快照目录。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { DATA_FILES } from '../../../src/constants'
import { sha256 } from '../../../src/core/data'
import type { DataFileName } from '../../../src/core/data'
import { BLOB_KEY_PATTERN, NetworkError } from '../../../src/core/ports'
import type { BlobCache, HttpClient, HttpRequest, HttpResponse, Logger } from '../../../src/core/ports'
import type { DataManifest } from '../../../src/core/types'
import { fixtureFiles } from '../../fixtures/data/load'

export type Json = Record<string, any>

/** 一个完整的数据版本：manifest 原文和三个文件 */
export interface Version {
  manifest: DataManifest & Json
  manifestBody: Buffer
  files: Record<DataFileName, Buffer>
}

export function fixtureJson(): Record<DataFileName, Json> {
  const { files } = fixtureFiles()
  const out = {} as Record<DataFileName, Json>
  for (const name of DATA_FILES) out[name] = JSON.parse(files[name].toString('utf8'))
  return out
}

/** 由（改过的）JSON 生成一个版本，sha256、bytes、rows 按内容重算 */
export function makeVersion(opts: { build?: number; revision?: number; schema?: number; edit?: (json: Record<DataFileName, Json>) => void; extra?: Json } = {}): Version {
  const json = fixtureJson()
  opts.edit?.(json)
  const files = {} as Record<DataFileName, Buffer>
  const entries: Json = {}
  const rowsOf: Record<DataFileName, string> = { 'types.json': 'types', 'industry.json': 'blueprints', 'universe.json': 'systems' }
  for (const name of DATA_FILES) {
    files[name] = Buffer.from(JSON.stringify(json[name]))
    entries[name] = { sha256: sha256(files[name]), bytes: files[name].length, rows: json[name][rowsOf[name]].length }
  }
  const base = fixtureFiles().manifest
  const manifest = {
    ...base,
    schema: opts.schema ?? 1,
    buildNumber: opts.build ?? base.buildNumber,
    dataRevision: opts.revision ?? base.dataRevision,
    files: entries,
    ...opts.extra,
  } as DataManifest & Json
  return { manifest, manifestBody: Buffer.from(JSON.stringify(manifest)), files }
}

/** 把 types.json 某个物品的中文名改掉（区分两个版本用） */
export function renameItem(id: number, zh: string) {
  return (json: Record<DataFileName, Json>) => {
    const types = json['types.json']
    const col = types.columns.indexOf('zh')
    types.types.find((row: unknown[]) => row[0] === id)[col] = zh
  }
}

// ------------------------------------------------------------------ 假的 HTTP

export interface FakeReply {
  status?: number
  body?: Buffer | string
  headers?: Record<string, string>
  /** 抛网络错误 */
  fail?: NetworkError
  /** 一直等到被中止 */
  hang?: boolean
}

export type Route = FakeReply | ((req: HttpRequest) => FakeReply)

export class FakeHttp implements HttpClient {
  readonly routes = new Map<string, Route>()
  readonly requests: HttpRequest[] = []

  set(url: string, route: Route) {
    this.routes.set(url, route)
    return this
  }

  /** 一个目录下放一整个版本（manifest + 三个文件），ETag 用 manifest 的 sha256 */
  serveVersion(dir: string, version: Version, opts: { etag?: boolean } = {}) {
    const etag = `"${sha256(version.manifestBody).slice(0, 16)}"`
    const headers: Record<string, string> = opts.etag === false ? {} : { ETag: etag }
    this.set(`${dir}manifest.json`, (req): FakeReply => {
      if (opts.etag !== false && req.headers?.['If-None-Match'] === etag) return { status: 304 }
      return { body: version.manifestBody, headers }
    })
    for (const name of DATA_FILES) this.set(dir + name, { body: version.files[name] })
    return this
  }

  /** 黑话表：带 ETag，条件请求命中时回 304 */
  serveGlossary(url: string, body: Buffer | string) {
    const etag = `"g-${sha256(body).slice(0, 12)}"`
    return this.set(url, (req): FakeReply => (req.headers?.['If-None-Match'] === etag ? { status: 304 } : { body, headers: { ETag: etag } }))
  }

  count(url: string) {
    return this.requests.filter((r) => r.url === url).length
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req)
    const route = this.routes.get(req.url)
    const reply: FakeReply = typeof route === 'function' ? route(req) : route ?? { status: 404, body: 'not found' }
    if (reply.hang) {
      await new Promise<void>((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new NetworkError('aborted')), { once: true })
      })
    }
    if (reply.fail) throw reply.fail
    const body = typeof reply.body === 'string' ? Buffer.from(reply.body) : reply.body ?? Buffer.alloc(0)
    if (req.maxBytes && body.length > req.maxBytes) throw new NetworkError('too-large')
    const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    return { status: reply.status ?? 200, header: (name) => headers[name.toLowerCase()], body }
  }
}

// ------------------------------------------------------------------ 假的 BlobCache 和日志

export class MemoryCache implements BlobCache {
  readonly entries = new Map<string, { body: Buffer; meta: Record<string, unknown> }>()
  readonly reads: string[] = []
  readonly writes: string[] = []
  readonly removes: string[] = []
  failWrites = false

  async read(key: string) {
    this.check(key)
    this.reads.push(key)
    const entry = this.entries.get(key)
    return entry ? { body: Buffer.from(entry.body), meta: { ...entry.meta } } : null
  }

  async write(key: string, body: Buffer, meta: Record<string, unknown>) {
    this.check(key)
    if (this.failWrites) throw new Error('disk full')
    this.writes.push(key)
    this.entries.set(key, { body: Buffer.from(body), meta: { ...meta } })
  }

  async remove(key: string) {
    this.check(key)
    this.removes.push(key)
    this.entries.delete(key)
  }

  /** 直接放进一个版本（和 writeCachedData 写的格式一样） */
  putVersion(version: Version) {
    for (const name of DATA_FILES) this.entries.set(`data/${name}`, { body: version.files[name], meta: { sha256: sha256(version.files[name]) } })
    this.entries.set('data/manifest.json', { body: version.manifestBody, meta: {} })
  }

  private check(key: string) {
    if (!BLOB_KEY_PATTERN.test(key)) throw new Error(`bad key ${key}`)
  }
}

export class MemoryLogger implements Logger {
  readonly lines: Array<{ level: 'debug' | 'info' | 'warn' | 'error'; text: string }> = []
  debug(...a: unknown[]) { this.push('debug', a) }
  info(...a: unknown[]) { this.push('info', a) }
  warn(...a: unknown[]) { this.push('warn', a) }
  error(...a: unknown[]) { this.push('error', a) }

  at(level: 'debug' | 'info' | 'warn' | 'error') {
    return this.lines.filter((l) => l.level === level).map((l) => l.text)
  }

  private push(level: 'debug' | 'info' | 'warn' | 'error', a: unknown[]) {
    this.lines.push({ level, text: a.map(String).join(' ') })
  }
}

// ------------------------------------------------------------------ 临时的自带快照目录

const tempDirs: string[] = []

/** 写一个和 data/ 一样格式的快照目录（.gz + manifest.json） */
export function bundledDir(version: Version, glossary: Buffer | null = fixtureFiles().glossary): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-market-bundled-'))
  tempDirs.push(dir)
  fs.writeFileSync(path.join(dir, 'manifest.json'), version.manifestBody)
  for (const name of DATA_FILES) fs.writeFileSync(path.join(dir, `${name}.gz`), zlib.gzipSync(version.files[name]))
  if (glossary) fs.writeFileSync(path.join(dir, 'glossary.yaml.gz'), zlib.gzipSync(glossary))
  return dir
}

export function cleanupDirs() {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}
