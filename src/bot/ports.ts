// core 端口在 Koishi 上的实现：ctx.http、文件缓存、定时器、日志、密钥，以及模块级存储。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Context, HTTP } from 'koishi'
import { BLOB_KEY_PATTERN, NetworkError, createModuleStore } from '../core/ports'
import type {
  AuthStore, BlobCache, Clock, CorePorts, HttpClient, HttpRequest, HttpResponse, Logger, ModuleStore, Scheduler, SecretBox,
} from '../core/ports'
import { LOG, NET, STORE } from './text'

// ------------------------------------------------------------------ 模块级存储

/** 控制台保存配置时插件重载，但 Node 不会重新加载这个模块，所以这里的东西跨重载保留；重启 Koishi 才丢 */
const MODULE_STORE = createModuleStore()

export function moduleStore(): ModuleStore {
  return MODULE_STORE
}

// ------------------------------------------------------------------ HTTP

/** 我们自己发起的中止（超时、调用方取消），和 fetch 本身的错误区分开 */
class AbortMark {
  constructor(readonly kind: 'timeout' | 'aborted') {}
}

/**
 * 经 ctx.http 发请求（代理等全局设置照样生效；不用 bot.http，免得把机器人的令牌带到别的网站）。
 * 非 2xx 不抛异常；超时、超过大小、被取消、连不上才抛 NetworkError
 */
export class KoishiHttpClient implements HttpClient {
  constructor(private readonly http: HTTP) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    if (req.signal?.aborted) throw new NetworkError('aborted', NET.aborted)
    const controller = new AbortController()
    const onAbort = () => controller.abort(new AbortMark('aborted'))
    req.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = req.timeoutMs ? setTimeout(() => controller.abort(new AbortMark('timeout')), req.timeoutMs) : undefined
    try {
      const res = await this.http<Buffer>(req.url, {
        method: req.method,
        headers: req.headers,
        data: req.body,
        signal: controller.signal,
        validateStatus: () => true,
        responseType: (raw: Response) => readBody(raw, req.maxBytes),
        // 自己计时（连同读响应体），关掉 http 插件的全局超时
        ...req.timeoutMs ? { timeout: 0 } : {},
      })
      const headers = res.headers
      return { status: res.status, header: (name) => headers.get(name) ?? undefined, body: res.data }
    } catch (error) {
      throw toNetworkError(error, req, controller.signal, this.http)
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
    }
  }
}

async function readBody(raw: Response, maxBytes?: number): Promise<Buffer> {
  const declared = Number(raw.headers.get('content-length'))
  if (maxBytes && declared > maxBytes) {
    await raw.body?.cancel().catch(() => undefined)
    throw new NetworkError('too-large', NET.tooLarge(maxBytes))
  }
  if (!raw.body) return Buffer.alloc(0)
  const reader = raw.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (maxBytes && size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new NetworkError('too-large', NET.tooLarge(maxBytes))
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

type Loose = { code?: unknown; message?: unknown; cause?: unknown }

function toNetworkError(error: unknown, req: HttpRequest, signal: AbortSignal, http: HTTP): NetworkError {
  if (error instanceof NetworkError) return error
  const cause = (error as Loose | undefined)?.cause ?? error
  const mark: unknown = signal.reason
  if (signal.aborted && mark instanceof AbortMark) {
    return mark.kind === 'timeout'
      ? new NetworkError('timeout', NET.timeout(req.timeoutMs ?? 0), { cause })
      : new NetworkError('aborted', NET.aborted, { cause })
  }
  // http 插件自己的超时（全局设置）和插件停用
  if (http.isError(error) && error.code === 'ETIMEDOUT') {
    return error.message === 'request timeout'
      ? new NetworkError('timeout', error.message, { cause })
      : new NetworkError('aborted', NET.aborted, { cause })
  }
  return new NetworkError('network', NET.failed(reasonOf(error)), { cause })
}

/** 连不上的原因：优先取底层的错误码（ECONNREFUSED 等）；http 插件的说明里带着网址，不用 */
function reasonOf(error: unknown): string {
  let current: unknown = (error as Loose | undefined)?.cause
  let message = ''
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const e = current as Loose
    if (typeof e.code === 'string' && e.code) return e.code
    if (!message && typeof e.message === 'string') message = e.message
    current = e.cause
  }
  return message || 'fetch failed'
}

// ------------------------------------------------------------------ 文件缓存

/** 文件开头的标记：后面是 4 字节的 meta 长度、meta（JSON）、内容。meta 和内容在同一个文件里，一次改名就一起换掉 */
const BLOB_MAGIC = Buffer.from('EMB1')
const BLOB_SUFFIX = '.blob'
const HEADER_BYTES = BLOB_MAGIC.length + 4

export function encodeBlob(body: Buffer, meta: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(meta), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(json.length)
  return Buffer.concat([BLOB_MAGIC, length, json, body])
}

/** 读不懂（被截断、格式不对）时返回 null，当作没有缓存 */
export function decodeBlob(raw: Buffer): { body: Buffer; meta: Record<string, unknown> } | null {
  if (raw.length < HEADER_BYTES || !raw.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) return null
  const metaLength = raw.readUInt32BE(BLOB_MAGIC.length)
  if (HEADER_BYTES + metaLength > raw.length) return null
  let meta: unknown
  try {
    meta = JSON.parse(raw.subarray(HEADER_BYTES, HEADER_BYTES + metaLength).toString('utf8'))
  } catch {
    return null
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  return { body: raw.subarray(HEADER_BYTES + metaLength), meta: meta as Record<string, unknown> }
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code

/** 找不到文件（或上一级不是目录）当作没有 */
const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(errno(error) ?? '')

/** Windows 上目标文件正被别的程序读着时改名会失败，稍等再试几次 */
async function renameWithRetry(from: string, to: string, attempts = 4): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await fs.rename(from, to)
    } catch (error) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(errno(error) ?? '')) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * i))
    }
  }
}

/** <实例>/data/eve-market/cache 下的文件缓存：先写临时文件再改名；只碰 *.blob 和自己的临时文件 */
export class FileBlobCache implements BlobCache {
  constructor(readonly root: string) {}

  async read(key: string): Promise<{ body: Buffer; meta: Record<string, unknown> } | null> {
    const file = this.fileOf(key)
    try {
      return decodeBlob(await fs.readFile(file))
    } catch (error) {
      if (isMissing(error) || errno(error) === 'EISDIR') return null
      throw error
    }
  }

  async write(key: string, body: Buffer, meta: Record<string, unknown>): Promise<void> {
    const file = this.fileOf(key)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
    try {
      await fs.writeFile(temp, encodeBlob(body, meta))
      await renameWithRetry(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.fileOf(key), { force: true })
  }

  /** 键不合法时抛错（不会碰到缓存目录以外的文件） */
  fileOf(key: string): string {
    if (!BLOB_KEY_PATTERN.test(key)) throw new Error(STORE.badCacheKey(key))
    return path.join(this.root, ...key.split('/')) + BLOB_SUFFIX
  }
}

// ------------------------------------------------------------------ 密钥（EVE 授权的 refresh token 加密）

export const SECRET_KEY_FILE = 'secret.key'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** sha256(密钥) 的前 8 位十六进制 */
export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/** AES-256-GCM；密文 `v1:<keyId>:<iv>:<tag>:<data>`（base64url），keyId 也参与校验 */
export class AesSecretBox implements SecretBox {
  readonly keyId: string

  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error(STORE.badSecretKey)
    this.keyId = keyIdOf(key)
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(this.aad())
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return ['v1', this.keyId, iv, cipher.getAuthTag(), data].map((p) => typeof p === 'string' ? p : p.toString('base64url')).join(':')
  }

  open(sealed: string): string {
    const parts = sealed.split(':')
    if (parts.length !== 5 || parts[0] !== 'v1') throw new Error(STORE.sealedMalformed)
    if (parts[1] !== this.keyId) throw new Error(STORE.sealedOtherKey)
    const [iv, tag, data] = parts.slice(2).map((p) => Buffer.from(p, 'base64url'))
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error(STORE.sealedMalformed)
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
      decipher.setAAD(this.aad())
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    } catch {
      throw new Error(STORE.sealedTampered)
    }
  }

  private aad(): Buffer {
    return Buffer.from(`v1:${this.keyId}`)
  }
}

/** 密钥文件读不出来时用它：授权功能报错，插件其他部分照常 */
export function unavailableSecretBox(reason: string): SecretBox {
  const fail = (): never => {
    throw new Error(`${STORE.secretUnavailable}：${reason}`)
  }
  return { keyId: '', seal: fail, open: fail }
}

/** 文件里是 base64 文字（也接受原始的 32 字节） */
function parseKey(raw: Buffer): Buffer {
  if (raw.length === KEY_BYTES) return raw
  const text = raw.toString('utf8').trim()
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0)
  if (key.length !== KEY_BYTES) throw new Error(STORE.badSecretKey)
  return key
}

/** 别的用户也能读时尽量改回 0600（Windows 上权限位没有意义，跳过；改不了也不影响使用） */
async function tightenKeyFile(file: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const { mode } = await fs.stat(file)
    if (mode & 0o077) await fs.chmod(file, 0o600)
  } catch {}
}

/** 第一次启动时生成（权限 0600）；已经有了就原样读出来，绝不覆盖。密钥和 keyId 都不写日志 */
export async function loadSecretKey(dir: string, logger?: Logger): Promise<Buffer> {
  const file = path.join(dir, SECRET_KEY_FILE)
  try {
    const key = parseKey(await fs.readFile(file))
    await tightenKeyFile(file)
    return key
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error
  }
  await fs.mkdir(dir, { recursive: true })
  const key = randomBytes(KEY_BYTES)
  try {
    await fs.writeFile(file, `${key.toString('base64')}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    // 同时启动的另一个实例先写好了
    if (errno(error) === 'EEXIST') return parseKey(await fs.readFile(file))
    throw error
  }
  logger?.info(LOG.secretKeyCreated)
  return key
}

export async function openSecretBox(dir: string, logger: Logger): Promise<SecretBox> {
  try {
    return new AesSecretBox(await loadSecretKey(dir, logger))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.error(LOG.secretKeyUnreadable(reason))
    return unavailableSecretBox(reason)
  }
}

// ------------------------------------------------------------------ 定时器、时钟、日志

/** ctx.setTimeout：插件停用时 Koishi 自动清掉；停用以后再排的定时器直接忽略 */
export function koishiScheduler(ctx: Context): Scheduler {
  return {
    timeout(fn, ms) {
      try {
        return ctx.setTimeout(fn, Math.max(0, ms))
      } catch {
        return () => undefined
      }
    },
  }
}

export const systemClock: Clock = { now: () => Date.now() }

export function koishiLogger(ctx: Context, name = 'eve-market'): Logger {
  const logger = ctx.logger(name)
  return {
    debug: (...a) => logger.debug(a[0], ...a.slice(1)),
    info: (...a) => logger.info(a[0], ...a.slice(1)),
    warn: (...a) => logger.warn(a[0], ...a.slice(1)),
    error: (...a) => logger.error(a[0], ...a.slice(1)),
  }
}

// ------------------------------------------------------------------ 组装

/** <实例>/data/eve-market（secret.key 和 cache/ 都在这里） */
export function dataDir(ctx: Context): string {
  return path.resolve(ctx.baseDir, 'data', 'eve-market')
}

export interface PortOptions {
  /** 授权档案表（storage 层实现） */
  auth: AuthStore
  /** 随插件发布的数据快照目录 */
  bundledDataDir: string
  version: string
  /** 不写 = 模块级存储（测试里每次传一个新的） */
  store?: ModuleStore
  /** 不写 = dataDir(ctx) */
  dir?: string
  logger?: Logger
  clock?: Clock
  /** 不写 = koishiScheduler(ctx) */
  scheduler?: Scheduler
}

export async function makePorts(ctx: Context, options: PortOptions): Promise<CorePorts> {
  const dir = options.dir ?? dataDir(ctx)
  const logger = options.logger ?? koishiLogger(ctx)
  return {
    http: new KoishiHttpClient(ctx.http),
    // 插件的 ctx.http 在插件停用时会中止进行中的请求；SSO 的请求经根上下文发，停用时照样做完（代理等全局设置一样生效）
    ssoHttp: new KoishiHttpClient(ctx.root.http),
    clock: options.clock ?? systemClock,
    scheduler: options.scheduler ?? koishiScheduler(ctx),
    logger,
    cache: new FileBlobCache(path.join(dir, 'cache')),
    auth: options.auth,
    secrets: await openSecretBox(dir, logger),
    store: options.store ?? moduleStore(),
    bundledDataDir: options.bundledDataDir,
    version: options.version,
  }
}
