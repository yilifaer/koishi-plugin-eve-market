// 数据的三个来处：插件自带快照（data/*.gz）、本地缓存（BlobCache）、在线（manifest + 数据文件，网址可以有备用）。
// 这里只管读写和下载；选哪一份、什么时候换由 service.ts 决定。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'
import { DATA_FILES, DATA_MAX_BYTES, DATA_TIMEOUT_MS } from '../../constants'
import { NetworkError } from '../ports'
import type { BlobCache, HttpClient, HttpResponse } from '../ports'
import type { DataManifest } from '../types'
import { describeError } from '../util'
import type { DataFiles } from './dataset'
import { DataError, isObject, parseManifest, sha256 } from './shapes'
import type { DataFileName } from './shapes'

const gunzip = promisify(gunzipCallback)

export const GLOSSARY_FILE = 'glossary.yaml'

/** BlobCache 里的键（<实例>/data/eve-market/cache/data/ 下） */
export const CACHE_KEYS = {
  manifest: 'data/manifest.json',
  file: (name: DataFileName) => `data/${name}`,
  glossary: `data/${GLOSSARY_FILE}`,
  state: 'data/state.json',
} as const

// ------------------------------------------------------------------ 插件自带快照

export function readBundledManifest(dir: string): Promise<DataManifest> {
  return readFile(join(dir, 'manifest.json')).then((body) => parseManifest(body, '自带快照的 manifest.json'))
}

async function readGz(dir: string, name: string): Promise<Buffer> {
  return gunzip(await readFile(join(dir, `${name}.gz`)))
}

export async function readBundledFiles(dir: string): Promise<DataFiles> {
  const files = {} as DataFiles
  for (const name of DATA_FILES) files[name] = await readGz(dir, name)
  return files
}

/** 没有这个文件时返回 null */
export async function readBundledGlossary(dir: string): Promise<Buffer | null> {
  try {
    return await readGz(dir, GLOSSARY_FILE)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

// ------------------------------------------------------------------ 本地缓存

/** 没有缓存时返回 null；有但读不懂时抛 DataError（调用方丢掉整份缓存） */
export async function readCachedManifest(cache: BlobCache): Promise<DataManifest | null> {
  const entry = await cache.read(CACHE_KEYS.manifest)
  return entry ? parseManifest(entry.body, '缓存的 manifest.json') : null
}

export async function readCachedFiles(cache: BlobCache): Promise<DataFiles> {
  const files = {} as DataFiles
  for (const name of DATA_FILES) {
    const entry = await cache.read(CACHE_KEYS.file(name))
    if (!entry) throw new DataError('hash', `缓存里缺少 ${name}`)
    files[name] = entry.body
  }
  return files
}

/** 先写三个数据文件，最后写 manifest：中途失败时下次启动按 sha256 发现对不上，整份丢掉 */
export async function writeCachedData(cache: BlobCache, manifestBody: Buffer, files: DataFiles): Promise<void> {
  for (const name of DATA_FILES) {
    const body = files[name]
    const buf = typeof body === 'string' ? Buffer.from(body) : body
    await cache.write(CACHE_KEYS.file(name), buf, { sha256: sha256(buf) })
  }
  await cache.write(CACHE_KEYS.manifest, manifestBody, {})
}

export async function clearCachedData(cache: BlobCache): Promise<void> {
  await cache.remove(CACHE_KEYS.manifest)
  for (const name of DATA_FILES) await cache.remove(CACHE_KEYS.file(name))
}

/** 内容和写入时记下的 sha256 对不上就当没有 */
export async function readCachedGlossary(cache: BlobCache): Promise<Buffer | null> {
  const entry = await cache.read(CACHE_KEYS.glossary)
  if (!entry) return null
  return entry.meta.sha256 === sha256(entry.body) ? entry.body : null
}

export function writeCachedGlossary(cache: BlobCache, body: Buffer): Promise<void> {
  return cache.write(CACHE_KEYS.glossary, body, { sha256: sha256(body) })
}

export async function readCachedJson(cache: BlobCache, key: string): Promise<Record<string, unknown> | null> {
  const entry = await cache.read(key)
  if (!entry) return null
  try {
    const value: unknown = JSON.parse(entry.body.toString('utf8'))
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ 在线

/** 条件请求用的响应头 */
export interface Validator {
  etag?: string
  lastModified?: string
}

export function validatorOf(res: HttpResponse): Validator {
  const v: Validator = {}
  const etag = res.header('etag')
  const lastModified = res.header('last-modified')
  if (etag) v.etag = etag
  if (lastModified) v.lastModified = lastModified
  return v
}

export interface Downloader {
  http: HttpClient
  userAgent: string
  signal: AbortSignal
}

/** GET；给了 validator 时带 If-None-Match / If-Modified-Since。非 2xx 不抛异常（304 由调用方处理） */
export function getConditional(d: Downloader, url: string, validator?: Validator): Promise<HttpResponse> {
  const headers: Record<string, string> = { 'User-Agent': d.userAgent }
  if (validator?.etag) headers['If-None-Match'] = validator.etag
  if (validator?.lastModified) headers['If-Modified-Since'] = validator.lastModified
  return d.http.request({ method: 'GET', url, headers, timeoutMs: DATA_TIMEOUT_MS, maxBytes: DATA_MAX_BYTES, signal: d.signal })
}

/** manifest 所在的目录（数据文件和它放在一起） */
export function dirOf(url: string): string {
  const clean = url.split(/[?#]/)[0]
  return clean.slice(0, clean.lastIndexOf('/') + 1)
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const NETWORK_LABELS: Record<NetworkError['kind'], string> = {
  'network': '网络错误',
  'timeout': '超时',
  'too-large': '文件太大',
  'aborted': '已取消',
}

/** 给日志和「市场状态」看的一句话原因 */
export function reasonOf(error: unknown): string {
  if (error instanceof DataError) return error.message
  if (error instanceof NetworkError) return NETWORK_LABELS[error.kind]
  return describeError(error)
}

/**
 * 按顺序从几个目录下载一个数据文件，sha256 对上为止。raw.githubusercontent（约 5 分钟）、jsDelivr（约 12 小时）的缓存
 * 可能给出新 manifest + 旧文件，这时换下一个主机再试。
 */
export async function downloadFile(d: Downloader, dirs: readonly string[], name: DataFileName, expected: DataManifest['files'][string]): Promise<Buffer> {
  if (expected.bytes > DATA_MAX_BYTES) throw new DataError('format', `${name} 有 ${expected.bytes} 字节，超过上限`)
  const failures: string[] = []
  for (const dir of dirs) {
    const url = dir + name
    try {
      const res = await getConditional(d, url)
      if (res.status !== 200) failures.push(`${hostOf(url)} HTTP ${res.status}`)
      else if (sha256(res.body) !== expected.sha256) failures.push(`${hostOf(url)} 的 sha256 和 manifest 不一致`)
      else return res.body
    } catch (e) {
      if (d.signal.aborted) throw e
      failures.push(`${hostOf(url)} ${reasonOf(e)}`)
    }
  }
  throw new DataError('download', `${name} 下载失败：${failures.join('；')}`)
}
