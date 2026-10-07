// core/esi 测试共用：假 ESI + 真的 HTTP 客户端 + 手动时钟（定时器用真的，等待都很短）。

import { BLOB_KEY_PATTERN, createModuleStore } from '../../../src/core/ports'
import type { BlobCache, Clock, Logger, ModuleStore, Scheduler } from '../../../src/core/ports'
import { EsiApi, EsiClient } from '../../../src/core/esi'
import type { EsiAuth, EsiClientOptions } from '../../../src/core/esi'
import { FakeEsi } from '../../fakes/fake-esi'
import { NodeHttpClient } from '../../fakes/node-http-client'

export const JITA = 30000142
export const JITA_4_4 = 60003760
export const THE_FORGE = 10000002
export const RAVEN = 638
export const TRITANIUM = 34
/** 编造的玩家建筑 */
export const STRUCTURE = 1_000_000_000_001

/** 只有 now()；advance 只是拨时间，不触发定时器 */
export class ManualClock implements Clock {
  constructor(public t = Date.UTC(2026, 9, 7, 6, 20)) {}
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

export const realScheduler: Scheduler = {
  timeout(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}

export class MemoryBlobCache implements BlobCache {
  readonly entries = new Map<string, { body: Buffer; meta: Record<string, unknown> }>()
  writes = 0

  async read(key: string) {
    this.check(key)
    const entry = this.entries.get(key)
    return entry ? { body: Buffer.from(entry.body), meta: { ...entry.meta } } : null
  }

  async write(key: string, body: Buffer, meta: Record<string, unknown>) {
    this.check(key)
    this.writes++
    this.entries.set(key, { body: Buffer.from(body), meta: { ...meta } })
  }

  async remove(key: string) {
    this.entries.delete(key)
  }

  json(key: string): unknown {
    const entry = this.entries.get(key)
    return entry ? JSON.parse(entry.body.toString('utf8')) : undefined
  }

  private check(key: string) {
    if (!BLOB_KEY_PATTERN.test(key)) throw new Error(`bad key ${key}`)
  }
}

export class MemoryLogger implements Logger {
  readonly lines: Array<{ level: string; text: string }> = []
  debug(...a: unknown[]) { this.push('debug', a) }
  info(...a: unknown[]) { this.push('info', a) }
  warn(...a: unknown[]) { this.push('warn', a) }
  error(...a: unknown[]) { this.push('error', a) }

  text() {
    return this.lines.map((l) => `${l.level} ${l.text}`).join('\n')
  }

  at(level: string) {
    return this.lines.filter((l) => l.level === level).map((l) => l.text)
  }

  private push(level: string, a: unknown[]) {
    this.lines.push({ level, text: a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' ') })
  }
}

export interface Env {
  fake: FakeEsi
  http: NodeHttpClient
  clock: ManualClock
  logger: MemoryLogger
  cache: MemoryBlobCache
  store: ModuleStore
  client: EsiClient
  api: EsiApi
  /** 用同一个模块级存储或 BlobCache 再建一个客户端（模拟重载、重启） */
  another(opts?: { store?: ModuleStore; cache?: MemoryBlobCache; options?: EsiClientOptions }): EsiClient
  close(): Promise<void>
}

const fakes: FakeEsi[] = []
const clients: EsiClient[] = []

export async function makeEnv(options: EsiClientOptions = {}, setup?: (fake: FakeEsi) => void): Promise<Env> {
  const fake = new FakeEsi()
  setup?.(fake)
  await fake.start()
  fakes.push(fake)
  const clock = new ManualClock()
  fake.clock = () => clock.now()
  const http = new NodeHttpClient()
  const logger = new MemoryLogger()
  const cache = new MemoryBlobCache()
  const store = createModuleStore()
  const build = (s: ModuleStore, c: BlobCache, extra: EsiClientOptions = {}) => {
    const client = new EsiClient(
      { http, clock, scheduler: realScheduler, logger, cache: c, store: s, version: '0.0.1' },
      { base: fake.base, retryDelayMs: { min: 5, max: 10 }, random: () => 0.5, ...options, ...extra },
    )
    clients.push(client)
    return client
  }
  const client = build(store, cache)
  return {
    fake, http, clock, logger, cache, store, client,
    api: new EsiApi(client),
    another: (o = {}) => build(o.store ?? store, o.cache ?? cache, o.options),
    close: async () => {
      client.stop()
      await fake.stop()
    },
  }
}

/** afterEach 里调用：停掉所有客户端和假服务 */
export async function closeAll() {
  for (const client of clients.splice(0)) client.stop()
  await Promise.all(fakes.splice(0).map((f) => f.stop()))
}

/** 一个计数的授权档案：force = true 时换一个新 token */
export function authFrom(tokens: () => string, profile = 'main'): EsiAuth & { calls: boolean[] } {
  const calls: boolean[] = []
  return {
    profile,
    calls,
    async token(force: boolean) {
      calls.push(force)
      return tokens()
    },
  }
}

/** 等事件循环里排着的回调都跑完 */
export async function settle(times = 5) {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** 等到条件成立（最多 2 秒） */
export async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('until: 等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
