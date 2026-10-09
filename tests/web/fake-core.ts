// web 测试用的假 core：只实现授权页面用到的部分（授权档案、建筑市场状态、星系名、时间格式）。
// 所有 ID 和名字都是编造的。

import { randomBytes } from 'node:crypto'
import { SSO_SCOPES } from '../../src/constants'
import { normalizeConfig } from '../../src/config/normalize'
import type { Logger } from '../../src/core/ports'
import type {
  AuthCompletion, AuthProfileStatus, AuthService, CoreFailure, MarketService, MarketSourceStatus, Settings, StructureSearchHit,
  SystemView,
} from '../../src/core/types'
import type { WebCore, WebCoreHandle } from '../../src/web'

export const SYSTEM_ID = 30_000_901
export const SYSTEM_NAME = 'XX-1'
export const STRUCTURE_A = '1000000000201'
export const STRUCTURE_B = '1000000000202'
export const CALLBACK = 'http://127.0.0.1:5140/eve-market/sso/callback'
export const SSO_URL = 'https://login.example.invalid/v2/oauth/authorize'

export function profile(p: Partial<AuthProfileStatus> & { profile: string }): AuthProfileStatus {
  return {
    status: 'NEEDS_AUTH',
    characterId: '',
    characterName: '',
    scopesGranted: 0,
    scopesRequired: SSO_SCOPES.length,
    tokenValid: false,
    lastRefreshAt: null,
    lastSuccessAt: null,
    lastError: '',
    lastErrorAt: null,
    markets: [],
    ...p,
  }
}

export function structureSource(s: Partial<MarketSourceStatus> & { marketKey: string; name: string }): MarketSourceStatus {
  return {
    type: 'structure',
    source: 'structure',
    state: 'OK',
    paused: false,
    authProfile: 'default',
    lastRequestAt: null,
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    pages: null,
    orders: null,
    ...s,
  }
}

export class FakeAuth implements AuthService {
  list: AuthProfileStatus[] = []
  /** beginAuth 发出去、还没用过的 state */
  states = new Map<string, string>()
  begun: string[] = []
  completed: Array<{ code: string; state: string }> = []
  removed: string[] = []
  searches: Array<{ profile: string; text: string }> = []
  hits: StructureSearchHit[] | CoreFailure = []
  /** 不写 = 成功，角色 Test Pilot */
  completion: ((profile: string) => AuthCompletion) | null = null
  beginError: Error | null = null

  profiles() {
    return this.list
  }

  async getAccessToken() {
    return { ok: false as const, status: 'NEEDS_AUTH' as const, reason: 'fake' }
  }

  beginAuth(name: string) {
    if (this.beginError) throw this.beginError
    const state = randomBytes(32).toString('base64url')
    this.states.set(state, name)
    this.begun.push(name)
    return { url: `${SSO_URL}?response_type=code&state=${state}`, state }
  }

  async completeAuth(code: string, state: string): Promise<AuthCompletion> {
    this.completed.push({ code, state })
    const name = this.states.get(state)
    if (!name) return { ok: false, reason: 'bad_state', message: 'unknown state' }
    this.states.delete(state)
    if (this.completion) return this.completion(name)
    return {
      ok: true,
      profile: name,
      characterId: '2112000001',
      characterName: 'Test Pilot',
      structures: [
        { marketKey: '联盟市场a', marketName: '联盟市场A', structureId: STRUCTURE_A, access: 'ok', structureName: 'XX-1 - 联盟市场A', systemId: SYSTEM_ID },
        { marketKey: '联盟市场b', marketName: '联盟市场B', structureId: STRUCTURE_B, access: 'forbidden' },
      ],
    }
  }

  async remove(name: string) {
    this.removed.push(name)
    this.list = this.list.filter((p) => p.profile !== name)
  }

  async searchStructures(name: string, text: string) {
    this.searches.push({ profile: name, text })
    return this.hits
  }
}

export interface FakeCore {
  core: WebCore
  auth: FakeAuth
  sources: MarketSourceStatus[]
  handle: WebCoreHandle
  /** false 时 ready() 返回 null（插件还在启动） */
  ready: boolean
}

export function fakeCore(): FakeCore {
  const auth = new FakeAuth()
  const state: FakeCore = {
    auth,
    sources: [],
    ready: true,
    core: undefined as unknown as WebCore,
    handle: { ready: async () => state.ready ? state.core : null },
  }
  const prices: Pick<MarketService, 'sources'> = { sources: () => state.sources }
  const system = (id: number): SystemView | undefined => id === SYSTEM_ID
    ? { id, en: SYSTEM_NAME, zh: '', security: -0.2, secClass: 'null', constellation: null, region: null }
    : undefined
  state.core = {
    auth,
    prices: prices as MarketService,
    universe: { system } as unknown as WebCore['universe'],
    format: { clock: (ms: number) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ') } as unknown as WebCore['format'],
  }
  return state
}

export function settingsWith(sso: Record<string, string> = {}): Settings {
  return normalizeConfig({
    sso: { clientId: 'test-client-id', clientSecret: 'test-client-secret', callbackUrl: CALLBACK, adminKey: '', ...sso },
  }).settings
}

export class MemoryLogger implements Logger {
  readonly lines: string[] = []
  debug(...a: unknown[]) { this.lines.push(a.map(String).join(' ')) }
  info(...a: unknown[]) { this.lines.push(a.map(String).join(' ')) }
  warn(...a: unknown[]) { this.lines.push(a.map(String).join(' ')) }
  error(...a: unknown[]) { this.lines.push(a.map(String).join(' ')) }
}
