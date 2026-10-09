// core/sso 测试共用：假 ESI（含 SSO）+ 真的 HTTP 客户端 + 手动时钟 + 内存里的授权档案表 + 真的 AES 密钥盒。
// 角色、建筑、应用的 ID 和名字都是编造的。

import { randomBytes } from 'node:crypto'
import { AesSecretBox } from '../../../src/bot/ports'
import { DEFAULT_CALLBACK_URL } from '../../../src/config/presets'
import { createEsi } from '../../../src/core/esi'
import type { EsiApi } from '../../../src/core/esi'
import { createModuleStore } from '../../../src/core/ports'
import type { AuthRecord, AuthStore, ModuleStore, SecretBox } from '../../../src/core/ports'
import { createAuthService } from '../../../src/core/sso'
import type { ManagedAuthService } from '../../../src/core/sso'
import type { MarketSetting, Settings } from '../../../src/core/types'
import { FakeEsi } from '../../fakes/fake-esi'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { ManualClock, MemoryBlobCache, MemoryLogger, realScheduler } from '../esi/helpers'

/** 编造的玩家建筑：A 能访问，B 没有停靠权限，C 查不到 */
export const STRUCTURE_A = 1_000_000_000_201
export const STRUCTURE_B = 1_000_000_000_202
export const STRUCTURE_C = 1_000_000_000_203
export const SYSTEM_XX1 = 30_000_201

export const MINUTE = 60_000

export function structureMarket(row: number, name: string, id: number, authProfile = 'default'): MarketSetting {
  return {
    row, key: name.toLowerCase(), name, aliases: [], type: 'structure', location: String(id), system: '',
    inDefaultList: true, autoDefaultList: true, sortOrder: row, visibility: 'allowed', authProfile, note: '',
  }
}

export const MARKETS: MarketSetting[] = [
  structureMarket(1, '联盟市场A', STRUCTURE_A),
  structureMarket(2, '联盟市场B', STRUCTURE_B),
  structureMarket(3, '联盟市场C', STRUCTURE_C),
]

type StoreOp = 'list' | 'get' | 'upsert' | 'remove'

/** 内存里的授权档案表；可以让下一次操作失败或者变慢，记下每次写入 */
export class MemoryAuthStore implements AuthStore {
  readonly rows = new Map<string, AuthRecord>()
  readonly writes: AuthRecord[] = []
  failNext: Partial<Record<StoreOp, number>> = {}
  private gates: Partial<Record<StoreOp, Promise<void>>> = {}

  /** 下一次 op 照常写进去，但等调用返回的函数以后才返回（慢的数据库） */
  hold(op: StoreOp): () => void {
    let release!: () => void
    this.gates[op] = new Promise<void>((resolve) => (release = resolve))
    return () => release()
  }

  async list() {
    this.maybeFail('list')
    return [...this.rows.values()].map((r) => ({ ...r, scopes: [...r.scopes] }))
  }

  async get(profile: string) {
    this.maybeFail('get')
    const r = this.rows.get(profile)
    return r ? { ...r, scopes: [...r.scopes] } : undefined
  }

  async upsert(rec: AuthRecord) {
    this.maybeFail('upsert')
    this.writes.push({ ...rec })
    this.rows.set(rec.profile, { ...rec, scopes: [...rec.scopes] })
    await this.gate('upsert')
  }

  async remove(profile: string) {
    this.maybeFail('remove')
    this.rows.delete(profile)
    await this.gate('remove')
  }

  private async gate(op: StoreOp) {
    const gate = this.gates[op]
    delete this.gates[op]
    await gate
  }

  private maybeFail(op: StoreOp) {
    const left = this.failNext[op] ?? 0
    if (left > 0) {
      this.failNext[op] = left - 1
      throw new Error(`database is locked (${op})`)
    }
  }
}

export function newBox(): SecretBox {
  return new AesSecretBox(randomBytes(32))
}

export interface SsoEnv {
  fake: FakeEsi
  http: NodeHttpClient
  clock: ManualClock
  logger: MemoryLogger
  db: MemoryAuthStore
  box: SecretBox
  store: ModuleStore
  esi: EsiApi
  auth: ManagedAuthService
  settings: Pick<Settings, 'sso' | 'markets' | 'advanced'>
  /** 用同一套假服务、数据库再建一个服务（模拟重载、重启、换密钥） */
  another(opts?: { box?: SecretBox; store?: ModuleStore; sso?: Partial<Settings['sso']>; markets?: MarketSetting[] }): ManagedAuthService
  /** 浏览器那一段：打开授权网址，假 SSO 直接重定向回来，取出 code 和 state */
  login(url: string): Promise<{ code: string; state: string }>
  /** 整个授权流程 */
  authorize(profile?: string, service?: ManagedAuthService): ReturnType<ManagedAuthService['completeAuth']>
  /** 发到 token 端点的请求数 */
  tokenCalls(): number
  /** 测试里出现过的所有秘密：Client Secret、授权码、所有发出去的 token */
  secrets(): string[]
}

export interface EnvOptions {
  sso?: Partial<Settings['sso']>
  markets?: MarketSetting[]
  box?: SecretBox
  setup?: (fake: FakeEsi) => void
}

const fakes: FakeEsi[] = []
const services: ManagedAuthService[] = []

export async function makeSsoEnv(options: EnvOptions = {}): Promise<SsoEnv> {
  const fake = new FakeEsi()
  fake.structureInfo.set(STRUCTURE_A, { name: 'XX-1 - 联盟市场A', owner_id: 98_000_001, solar_system_id: SYSTEM_XX1, type_id: 35833 })
  fake.structureInfo.set(STRUCTURE_B, { name: 'XX-1 - 联盟市场B', owner_id: 98_000_001, solar_system_id: SYSTEM_XX1, type_id: 35832 })
  fake.forbiddenStructures.add(STRUCTURE_B)
  options.setup?.(fake)
  await fake.start()
  fakes.push(fake)
  const clock = new ManualClock()
  fake.clock = () => clock.now()
  const http = new NodeHttpClient()
  const logger = new MemoryLogger()
  const db = new MemoryAuthStore()
  const box = options.box ?? newBox()
  const store = createModuleStore()
  const esi = createEsi(
    { http, clock, scheduler: realScheduler, logger, cache: new MemoryBlobCache(), store, version: '0.0.2' },
    { base: fake.base, retryDelayMs: { min: 5, max: 10 }, random: () => 0.5 },
  )
  const settingsOf = (sso: Partial<Settings['sso']> = {}, markets = options.markets ?? MARKETS): Pick<Settings, 'sso' | 'markets' | 'advanced'> => ({
    sso: { clientId: fake.sso.clientId, clientSecret: fake.sso.clientSecret, callbackUrl: DEFAULT_CALLBACK_URL, adminKey: '', ...options.sso, ...sso },
    markets,
    advanced: { manifestUrls: [], glossaryUrls: [], esiContact: '' },
  })
  const build = (o: { box?: SecretBox; store?: ModuleStore; sso?: Partial<Settings['sso']>; markets?: MarketSetting[] } = {}) => {
    const service = createAuthService({
      ports: { http, clock, logger, auth: db, secrets: o.box ?? box, store: o.store ?? store, version: '0.0.2' },
      settings: settingsOf(o.sso, o.markets),
      esi,
      ssoBase: fake.base,
    })
    services.push(service)
    return service
  }
  const auth = build()
  const env: SsoEnv = {
    fake, http, clock, logger, db, box, store, esi, auth,
    settings: settingsOf(),
    another: build,
    async login(url: string) {
      const res = await http.request({ method: 'GET', url })
      if (res.status !== 302) throw new Error(`authorize returned ${res.status}`)
      const back = new URL(res.header('location')!)
      return { code: back.searchParams.get('code')!, state: back.searchParams.get('state')! }
    },
    async authorize(profile = 'default', service = auth) {
      const { url } = service.beginAuth(profile)
      const { code, state } = await env.login(url)
      return service.completeAuth(code, state)
    },
    tokenCalls: () => fake.count(/^\/v2\/oauth\/token$/, 'POST'),
    secrets() {
      const out = new Set<string>([fake.sso.clientSecret, ...fake.accessTokens, ...fake.refreshTokens])
      for (const r of fake.requests) {
        const form = new URLSearchParams(r.body)
        for (const name of ['code', 'refresh_token', 'token']) {
          const value = form.get(name)
          if (value) out.add(value)
        }
        const bearer = r.headers.authorization
        if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) out.add(bearer.slice(7))
      }
      return [...out].filter((s) => s.length >= 6)
    },
  }
  return env
}

/** afterEach 里调用 */
export async function closeSsoEnvs() {
  for (const s of services.splice(0)) s.stop()
  await Promise.all(fakes.splice(0).map((f) => f.stop()))
}
