// 服务角色的授权档案（§3.4、§7.4–§7.6）：授权、按需刷新 access token、状态机、删除、按名字搜建筑。
// - refresh token 用 SecretBox 加密后经 AuthStore 保存；SSO 返回了新的就加密保存（按会轮换处理）。access token 只在内存。
// - 状态：NEEDS_AUTH（没授权、没填 Client ID、密钥变了）→ 授权成功 → OK；网络错误、5xx → DEGRADED，按 1、5、15、60 分钟退避；
//   invalid_grant、owner 变了、权限不够、其他 4xx → AUTH_ERROR，不再自动刷新（每小时最多试一次），等重新授权。
// - 剩不到 60 秒就先刷新；同一个档案同时只刷新一次（single-flight）。
// - 状态变化写一条日志，持续出错期间不重复写。日志只有档案名、角色名和脱敏后的错误，没有任何 token。

import {
  AUTH_ERROR_RETRY_MINUTES, AUTH_RETRY_MINUTES, SSO_JWT_ISSUERS, SSO_SCOPES, SSO_SEARCH_SCOPE, STRUCTURE_SEARCH_MAX_CHARS,
  STRUCTURE_SEARCH_MIN_CHARS, TOKEN_REFRESH_MARGIN_SEC,
} from '../../constants'
import { EsiError, MemoryResponseCache, userAgent } from '../esi'
import type { EsiApi, EsiAuth } from '../esi'
import type { AuthRecord, AuthStatus, CorePorts } from '../ports'
import type {
  AuthCompletion, AuthProfileStatus, AuthService, CoreFailure, MarketSetting, Settings, StructureProbe, StructureSearchHit, TokenResult,
} from '../types'
import { Backoff, SingleFlight, describeError, mapLimit } from '../util'
import { SsoClient, checkAccessToken, isSsoError, missingScopes } from './oauth'
import type { AccessClaims, TokenSet } from './oauth'
import { AuthStates } from './states'

const MINUTE = 60_000
/** 和控制台「市场」表格里「授权档案」的规则一样 */
const PROFILE_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u
const MAX_CODE_CHARS = 2048
/** 按名字搜建筑最多列几个 */
const MAX_SEARCH_HITS = 20
/** 探测建筑、查建筑名的并发 */
const PROBE_CONCURRENCY = 4
const PROBE_CACHE_BYTES = 1024 * 1024
/** 刚刷新过（这么久以内）又被要求强制刷新时，直接给刚拿到的（几个请求同时收到 401 时只刷新一次） */
const FORCE_MIN_AGE_MS = 10_000
/** 刷新失败（网络问题）时，还剩这么久以上的旧 access token 照样给出去 */
const USABLE_GUARD_MS = 5_000
/** 数据库读不出档案时，多久以后再试 */
const LOAD_RETRY_MS = MINUTE

/** 建筑市场同步必需的权限；按名字搜建筑的权限缺了只影响管理页的搜索 */
export const ESSENTIAL_SCOPES: readonly string[] = SSO_SCOPES.filter((s) => s !== SSO_SEARCH_SCOPE)

/** 状态里的原因（显示在「市场状态」「市场授权」和管理页）和授权失败的说明 */
export const AUTH_TEXT = {
  notConfigured: '「EVE 授权」里还没有填 Client ID 和 Secret Key',
  notAuthorized: '还没有授权',
  secretUnavailable: '密钥文件 secret.key 读不出来，授权暂时不能用（详见启动日志）',
  keyChanged: '保存授权用的密钥变了（换了机器或 secret.key 丢了），请重新授权',
  loadFailed: '读不出保存的授权档案（数据库出错），稍后自动重试',
  unreadable: '保存的刷新令牌解不开（数据可能损坏），请重新授权',
  invalidGrant: '刷新令牌失效（被撤销、过期或已经换过），请重新授权',
  invalidClient: 'EVE 不认这个应用的 Client ID 或 Secret Key，请核对控制台「EVE 授权」后重新授权',
  ownerChanged: '角色已转手（所属账号变了），请重新授权',
  otherCharacter: '刷新后拿到的角色和授权时的不一样，请重新授权',
  missingScopes: (scopes: readonly string[]) => `权限不够：缺少 ${scopes.join('、')}。请在 EVE 开发者网站编辑应用，勾上缺少的权限并保存，再重新授权`,
  rejected: (brief: string) => `EVE 登录服务器拒绝了请求（${brief}），请重新授权`,
  badToken: (why: string) => `EVE 返回的令牌不对：${why}`,
  unavailable: (brief: string) => `暂时连不上 EVE 登录服务器（${brief}），稍后自动重试`,
  badState: '授权链接已经失效或用过了，请回到授权页面重新点「授权」',
  badCode: '回调里没有有效的授权码',
  codeRejected: '授权码已经失效（超过有效期或用过了）',
  exchangeUnavailable: (brief: string) => `暂时连不上 EVE 登录服务器（${brief}）`,
  noRefreshToken: 'EVE 没有返回刷新令牌，请重新授权',
  saveFailed: '授权成功了，但档案没能写进数据库，请稍后重新授权（详见日志）',
  badProfile: '授权档案名只能用文字、数字、- 和 _（最多 32 个字）',
  searchLength: `按名字搜建筑要输入 ${STRUCTURE_SEARCH_MIN_CHARS}–${STRUCTURE_SEARCH_MAX_CHARS} 个字`,
  noSearchScope: `授权时没有拿到按名字搜建筑的权限（${SSO_SEARCH_SCOPE}）。请在 EVE 开发者网站编辑应用，勾上这项权限并保存，再重新授权`,
  searchFailed: (brief: string) => `暂时连不上 EVE 的搜索接口（${brief}），请稍后再试`,
  searchRejected: (brief: string) => `EVE 的搜索接口拒绝了请求（${brief}）。可以改用游戏里的建筑链接找建筑 ID（见说明文档第 4 步的最后一段）`,
} as const

const STATUS_LABEL: Record<AuthStatus, string> = {
  NEEDS_AUTH: '需要授权',
  OK: '正常',
  DEGRADED: '暂时刷新不了',
  AUTH_ERROR: '需要重新授权',
}

export interface AuthServiceOptions {
  ports: Pick<CorePorts, 'http' | 'ssoHttp' | 'clock' | 'logger' | 'auth' | 'secrets' | 'store' | 'version'>
  settings: Pick<Settings, 'sso' | 'markets' | 'advanced'>
  /** 探测建筑、按名字搜建筑 */
  esi: Pick<EsiApi, 'structure' | 'searchStructures' | 'searchCharacters'>
  /** 测试指向假服务 */
  ssoBase?: string
}

export interface ManagedAuthService extends AuthService {
  /** 从 AuthStore 读入档案；没调用时第一次用到时自动读 */
  start(): Promise<void>
  /**
   * 插件停用：不再通知。进行中的刷新照样做完并保存（半路放弃会丢掉 SSO 换出来的新 refresh token）：
   * SSO 的请求走 ports.ssoHttp，停用不会中止它
   */
  stop(): void
  /** force：ESI 回了 401，不管缓存的 access token 还剩多久都刷新 */
  getAccessToken(profile: string, opts?: { force?: boolean }): Promise<TokenResult>
  /** 给 ESI 客户端用：取不到 token 时抛 EsiError('auth')，code 是档案的状态（NEEDS_AUTH / DEGRADED / AUTH_ERROR） */
  esiAuth(profile: string): EsiAuth
  /** 一个档案的状态；既没有保存、也没有市场用到时 undefined */
  profile(name: string): AuthProfileStatus | undefined
  /** 档案状态变化（授权成功、刷新出错、恢复、删除）时通知，例如授权成功后同步一次建筑市场 */
  onChange(listener: (status: AuthProfileStatus) => void): () => void
}

interface AccessToken {
  token: string
  characterId: string
  /** 本机时间（毫秒） */
  expiresAt: number
  obtainedAt: number
}

interface Slot {
  name: string
  rec: AuthRecord | null
  /** 内存里的状态；密钥对不上等「需要授权」的情况由 blocked() 另外判断，不写进数据库 */
  status: AuthStatus
  lastError: string
  lastErrorAt: number | null
  access: AccessToken | null
  backoff: Backoff
  /** 这之前不再自动刷新（DEGRADED 的退避、AUTH_ERROR 每小时一次） */
  retryAt: number | null
  /** 授权、删除时加一：进行中的刷新回来发现变了就丢掉结果 */
  generation: number
}

type Failure = { status: 'DEGRADED' | 'AUTH_ERROR'; reason: string }

function ok(access: AccessToken): TokenResult {
  return { ok: true, token: access.token, characterId: access.characterId }
}

function fail(status: AuthStatus, reason: string): TokenResult {
  return { ok: false, status, reason }
}

/** 给状态和页面看的短说明：「HTTP 503 temporarily_unavailable」「timeout」；不是 SsoError 时只给错误的类名 */
function briefOf(e: unknown): string {
  if (isSsoError(e)) return e.brief
  return e instanceof Error ? e.name : 'error'
}

/** 日志用：SsoError 的说明已经脱敏 */
function describe(e: unknown, secrets: readonly string[]): string {
  if (isSsoError(e)) return `${e.route} ${e.message}`
  return describeError(e, undefined, secrets)
}

class SsoAuthService implements ManagedAuthService {
  private readonly slots = new Map<string, Slot>()
  private readonly flights = new SingleFlight<string, TokenResult>()
  private readonly listeners = new Set<(status: AuthProfileStatus) => void>()
  private readonly states: AuthStates
  private readonly sso: SsoClient
  private loaded = false
  private loading: Promise<void> | null = null
  private loadFailed = false
  private loadRetryAt = 0

  constructor(private readonly o: AuthServiceOptions) {
    const { ports, settings } = o
    this.states = new AuthStates(ports.clock, ports.store)
    this.sso = new SsoClient({
      http: ports.ssoHttp ?? ports.http,
      clientId: settings.sso.clientId,
      clientSecret: settings.sso.clientSecret,
      userAgent: userAgent(ports.version, settings.advanced.esiContact),
      base: o.ssoBase,
    })
  }

  private get configured(): boolean {
    return !!this.o.settings.sso.clientId && !!this.o.settings.sso.clientSecret
  }

  private now(): number {
    return this.o.ports.clock.now()
  }

  /** 日志用的错误说明：去掉 Client Secret 和调用方知道的其他秘密 */
  private safe(e: unknown, secrets: readonly string[] = []): string {
    return describe(e, [...secrets, this.o.settings.sso.clientSecret])
  }

  // ------------------------------------------------------------------ 生命周期

  start(): Promise<void> {
    return this.ensureLoaded()
  }

  stop() {
    this.listeners.clear()
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded || (this.loadFailed && this.now() < this.loadRetryAt)) return Promise.resolve()
    this.loading ??= this.load().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async load() {
    const { auth, logger } = this.o.ports
    let recs: AuthRecord[]
    try {
      recs = await auth.list()
    } catch (e) {
      if (!this.loadFailed) logger.warn(`读不出保存的 EVE 授权档案，稍后再试：${this.safe(e)}`)
      this.loadFailed = true
      this.loadRetryAt = this.now() + LOAD_RETRY_MS
      return
    }
    for (const rec of recs) this.adopt(rec)
    this.loaded = true
    this.loadFailed = false
  }

  private adopt(rec: AuthRecord) {
    const slot = this.slot(rec.profile)
    // 读入之前已经在这次运行里授权过的，以内存为准
    if (slot.rec) return
    const now = this.now()
    slot.rec = { ...rec, scopes: [...rec.scopes] }
    slot.status = rec.status
    slot.lastError = rec.lastError
    slot.lastErrorAt = rec.lastErrorAt
    slot.access = null
    const retryAt = rec.status === 'AUTH_ERROR' && rec.lastErrorAt !== null ? rec.lastErrorAt + AUTH_ERROR_RETRY_MINUTES * MINUTE : null
    slot.retryAt = retryAt !== null && retryAt > now ? retryAt : null
    const keyId = this.o.ports.secrets.keyId
    if (rec.refreshToken && keyId && rec.keyId !== keyId) {
      slot.lastErrorAt = now
      this.o.ports.logger.warn(`EVE 授权档案 ${rec.profile}：${AUTH_TEXT.keyChanged}`)
    }
  }

  private slot(name: string): Slot {
    let slot = this.slots.get(name)
    if (!slot) {
      slot = {
        name,
        rec: null,
        status: 'NEEDS_AUTH',
        lastError: '',
        lastErrorAt: null,
        access: null,
        backoff: new Backoff(AUTH_RETRY_MINUTES.map((m) => m * MINUTE)),
        retryAt: null,
        generation: 0,
      }
      this.slots.set(name, slot)
    }
    return slot
  }

  // ------------------------------------------------------------------ 状态

  /** 用到授权档案的建筑市场，按档案分组、按表格顺序 */
  private usage(): Map<string, MarketSetting[]> {
    const out = new Map<string, MarketSetting[]>()
    for (const m of this.o.settings.markets) {
      if (m.type !== 'structure' || !m.authProfile) continue
      out.set(m.authProfile, [...out.get(m.authProfile) ?? [], m])
    }
    return out
  }

  /** 市场表格里用到的档案（表格顺序），再加上只在数据库里的（按名字） */
  private names(): string[] {
    const out = [...this.usage().keys()]
    const extra = [...this.slots.values()].filter((s) => s.rec && !out.includes(s.name)).map((s) => s.name).sort()
    return [...out, ...extra]
  }

  /**
   * 不能刷新的原因：null = 可以刷新；'' = 只是还没授权（不算错误）；其他 = 写给管理员看的原因。
   * 这些情况都是 NEEDS_AUTH，不写进数据库（换回原来的 secret.key、插件重新启动以后自动恢复）
   */
  private blocked(slot: Slot | undefined): string | null {
    const rec = slot?.rec
    if (!this.configured) return rec ? AUTH_TEXT.notConfigured : ''
    if (!rec?.refreshToken) return this.loadFailed && !this.loaded ? AUTH_TEXT.loadFailed : ''
    const keyId = this.o.ports.secrets.keyId
    if (!keyId) return AUTH_TEXT.secretUnavailable
    if (rec.keyId !== keyId) return AUTH_TEXT.keyChanged
    return null
  }

  private view(name: string): AuthProfileStatus {
    const slot = this.slots.get(name)
    const rec = slot?.rec ?? null
    const blocked = this.blocked(slot)
    const status: AuthStatus = blocked === null && slot ? slot.status : 'NEEDS_AUTH'
    const access = slot?.access
    return {
      profile: name,
      status,
      characterId: rec?.characterId ?? '',
      characterName: rec?.characterName ?? '',
      scopesGranted: rec ? SSO_SCOPES.filter((s) => rec.scopes.includes(s)).length : 0,
      scopesRequired: SSO_SCOPES.length,
      tokenValid: (status === 'OK' || status === 'DEGRADED') && !!access && access.expiresAt > this.now(),
      lastRefreshAt: rec?.lastRefreshAt ?? null,
      lastSuccessAt: rec?.lastSuccessAt ?? null,
      lastError: blocked === null ? slot?.lastError ?? '' : blocked,
      lastErrorAt: blocked === null || blocked ? slot?.lastErrorAt ?? null : null,
      markets: (this.usage().get(name) ?? []).map((m) => m.name),
    }
  }

  profiles(): AuthProfileStatus[] {
    return this.names().map((name) => this.view(name))
  }

  profile(name: string): AuthProfileStatus | undefined {
    return this.names().includes(name) ? this.view(name) : undefined
  }

  onChange(listener: (status: AuthProfileStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(name: string) {
    if (!this.listeners.size) return
    const status = this.view(name)
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch (e) {
        this.o.ports.logger.warn(`EVE 授权档案 ${name} 的状态通知出错：${this.safe(e)}`)
      }
    }
  }

  /** 改状态；变了才写日志、发通知（持续出错期间不重复写） */
  private transition(slot: Slot, status: AuthStatus, reason: string) {
    const before = slot.status
    slot.status = status
    if (status !== 'OK') {
      slot.lastError = reason
      slot.lastErrorAt = this.now()
    }
    if (before === status) return
    const who = slot.rec?.characterName ? `（角色「${slot.rec.characterName}」）` : ''
    if (status === 'OK') this.o.ports.logger.info(`EVE 授权档案 ${slot.name}${who}恢复正常`)
    else this.o.ports.logger.warn(`EVE 授权档案 ${slot.name}${who}${STATUS_LABEL[status]}：${reason}`)
    this.emit(slot.name)
  }

  /** 写进数据库；失败只记日志（内存里的照样能用，下次成功时再写） */
  private async persist(slot: Slot): Promise<void> {
    if (!slot.rec) return
    const rec: AuthRecord = { ...slot.rec, status: slot.status, lastError: slot.lastError, lastErrorAt: slot.lastErrorAt }
    slot.rec = rec
    try {
      await this.o.ports.auth.upsert(rec)
    } catch (e) {
      this.o.ports.logger.warn(`EVE 授权档案 ${slot.name} 没能写进数据库：${this.safe(e)}`)
    }
  }

  // ------------------------------------------------------------------ access token

  async getAccessToken(profile: string, opts: { force?: boolean } = {}): Promise<TokenResult> {
    await this.ensureLoaded()
    const slot = this.slots.get(profile)
    const blocked = this.blocked(slot)
    if (blocked !== null || !slot) return fail('NEEDS_AUTH', blocked || (this.configured ? AUTH_TEXT.notAuthorized : AUTH_TEXT.notConfigured))
    const access = slot.access
    const now = this.now()
    if (access && slot.status !== 'AUTH_ERROR' && access.expiresAt > now) {
      if (!opts.force && access.expiresAt - now > TOKEN_REFRESH_MARGIN_SEC * 1000) return ok(access)
      if (opts.force && now - access.obtainedAt < FORCE_MIN_AGE_MS) return ok(access)
    }
    return this.flights.run(profile, () => this.refresh(slot, !!opts.force, false))
  }

  esiAuth(profile: string): EsiAuth {
    return {
      profile,
      token: async (force: boolean) => {
        const result = await this.getAccessToken(profile, { force })
        if (result.ok) return result.token
        throw new EsiError('auth', `授权档案 ${profile}：${result.reason}`, { route: 'SSO', code: result.status })
      },
    }
  }

  /** 退避期间、或者刷新出错以后：还没过期的旧 token 照样能用（AUTH_ERROR 和强制刷新除外） */
  private fallback(slot: Slot, force: boolean): TokenResult {
    const access = slot.access
    if (!force && slot.status !== 'AUTH_ERROR' && access && access.expiresAt > this.now() + USABLE_GUARD_MS) return ok(access)
    return fail(slot.status, slot.lastError || STATUS_LABEL[slot.status])
  }

  private async refresh(slot: Slot, force: boolean, retried: boolean): Promise<TokenResult> {
    const { secrets, auth } = this.o.ports
    if (slot.retryAt !== null && this.now() < slot.retryAt) return this.fallback(slot, force)
    const rec = slot.rec!
    const generation = slot.generation
    let plain: string
    try {
      plain = secrets.open(rec.refreshToken)
    } catch {
      return this.failed(slot, generation, force, { status: 'AUTH_ERROR', reason: AUTH_TEXT.unreadable })
    }
    let tokens: TokenSet
    try {
      tokens = await this.sso.refresh(plain)
    } catch (e) {
      if (isSsoError(e) && e.kind === 'invalid_grant' && !retried && slot.generation === generation) {
        // 重载前的插件可能刚换过 refresh token：数据库里的和手上的不一样，就用数据库里的再试一次
        const stored = await auth.get(slot.name).catch(() => undefined)
        if (stored?.refreshToken && stored.refreshToken !== rec.refreshToken && stored.keyId === secrets.keyId && slot.generation === generation) {
          slot.rec = { ...stored, scopes: [...stored.scopes] }
          return this.refresh(slot, force, true)
        }
      }
      return this.failed(slot, generation, force, this.classify(e), e, [plain])
    }
    // 刷新期间档案被重新授权或删除了：这次的结果不要了
    if (slot.generation !== generation) {
      this.discard(slot, tokens, plain)
      return this.current(slot)
    }
    const at = this.now()
    // 不管后面的检查过不过，新的 refresh token 都要存下来（旧的可能已经作废）
    const next: AuthRecord = { ...rec, lastRefreshAt: at }
    if (tokens.refreshToken && tokens.refreshToken !== plain) {
      try {
        next.refreshToken = secrets.seal(tokens.refreshToken)
        next.keyId = secrets.keyId
      } catch (e) {
        return this.failed(slot, generation, force, { status: 'AUTH_ERROR', reason: AUTH_TEXT.secretUnavailable }, e)
      }
    }
    slot.rec = next
    let claims: AccessClaims
    try {
      claims = this.check(tokens.accessToken, at)
    } catch (e) {
      return this.failed(slot, generation, force, this.classify(e), e, [plain, tokens.accessToken])
    }
    const problem = this.problemOf(rec, claims)
    if (problem) return this.failed(slot, generation, force, { status: 'AUTH_ERROR', reason: problem })
    slot.rec = { ...next, scopes: claims.scopes, characterName: claims.characterName || rec.characterName, lastSuccessAt: at }
    if (!slot.rec.ownerHash) slot.rec.ownerHash = claims.ownerHash
    slot.access = { token: tokens.accessToken, characterId: claims.characterId, expiresAt: this.expiry(tokens, claims, at), obtainedAt: at }
    slot.backoff.reset()
    slot.retryAt = null
    this.transition(slot, 'OK', '')
    await this.persist(slot)
    return ok(slot.access)
  }

  private async failed(slot: Slot, generation: number, force: boolean, f: Failure, error?: unknown, secrets: readonly string[] = []): Promise<TokenResult> {
    if (slot.generation !== generation) return this.current(slot)
    if (error !== undefined) {
      this.o.ports.logger.debug(`EVE 授权档案 ${slot.name} 刷新失败：${this.safe(error, secrets)}`)
    }
    const now = this.now()
    if (f.status === 'DEGRADED') {
      slot.retryAt = now + slot.backoff.next()
    } else {
      slot.retryAt = now + AUTH_ERROR_RETRY_MINUTES * MINUTE
      slot.access = null
    }
    this.transition(slot, f.status, f.reason)
    await this.persist(slot)
    return this.fallback(slot, force)
  }

  /** 授权、删除没写成数据库时恢复用 */
  private snapshot(slot: Slot): Pick<Slot, 'rec' | 'status' | 'lastError' | 'lastErrorAt' | 'access' | 'retryAt'> {
    return { rec: slot.rec, status: slot.status, lastError: slot.lastError, lastErrorAt: slot.lastErrorAt, access: slot.access, retryAt: slot.retryAt }
  }

  /**
   * 刷新期间档案被删了：SSO 刚换出来的 refresh token 没有人会再用，顺便撤销（尽力而为）。
   * 被重新授权时不撤销（同一个角色的新授权会不会受影响待核实）
   */
  private discard(slot: Slot, tokens: TokenSet, plain: string) {
    if (slot.rec || !tokens.refreshToken || tokens.refreshToken === plain || !this.configured) return
    this.sso.revoke(tokens.refreshToken).catch((e) => {
      this.o.ports.logger.debug(`EVE 授权档案 ${slot.name} 刷新时换出来的令牌没有撤销成功：${isSsoError(e) ? e.brief : 'error'}`)
    })
  }

  /** 刷新的结果作废时：按档案现在的样子回答 */
  private current(slot: Slot): TokenResult {
    const blocked = this.blocked(slot)
    if (blocked !== null) return fail('NEEDS_AUTH', blocked || AUTH_TEXT.notAuthorized)
    return this.fallback(slot, false)
  }

  private check(token: string, now: number): AccessClaims {
    return checkAccessToken(token, { clientId: this.o.settings.sso.clientId, now, issuers: SSO_JWT_ISSUERS })
  }

  /** 刷新拿到的 token 和授权时的对不上 */
  private problemOf(rec: AuthRecord, claims: AccessClaims): string | null {
    if (claims.characterId !== rec.characterId) return AUTH_TEXT.otherCharacter
    if (rec.ownerHash && claims.ownerHash && claims.ownerHash !== rec.ownerHash) return AUTH_TEXT.ownerChanged
    const missing = missingScopes(claims.scopes, ESSENTIAL_SCOPES)
    return missing.length ? AUTH_TEXT.missingScopes(missing) : null
  }

  /** 按 expires_in（相对时间，不受本机时钟偏差影响）；没有时用 JWT 的 exp */
  private expiry(tokens: TokenSet, claims: AccessClaims, at: number): number {
    return tokens.expiresIn !== null ? at + tokens.expiresIn * 1000 : claims.expiresAt
  }

  private classify(e: unknown): Failure {
    if (!isSsoError(e)) return { status: 'DEGRADED', reason: AUTH_TEXT.unavailable(briefOf(e)) }
    switch (e.kind) {
      case 'invalid_grant':
        return { status: 'AUTH_ERROR', reason: AUTH_TEXT.invalidGrant }
      case 'invalid_client':
        return { status: 'AUTH_ERROR', reason: AUTH_TEXT.invalidClient }
      case 'rejected':
        return { status: 'AUTH_ERROR', reason: AUTH_TEXT.rejected(e.brief) }
      case 'bad-token':
        return { status: 'AUTH_ERROR', reason: AUTH_TEXT.badToken(e.message) }
      default:
        return { status: 'DEGRADED', reason: AUTH_TEXT.unavailable(e.brief) }
    }
  }

  // ------------------------------------------------------------------ 授权

  beginAuth(profile: string): { url: string; state: string } {
    const name = profile.trim()
    if (!PROFILE_PATTERN.test(name)) throw new Error(AUTH_TEXT.badProfile)
    if (!this.configured) throw new Error(AUTH_TEXT.notConfigured)
    if (!this.o.ports.secrets.keyId) throw new Error(AUTH_TEXT.secretUnavailable)
    const state = this.states.create(name)
    return { url: this.sso.authorizeUrl(this.o.settings.sso.callbackUrl, state), state }
  }

  async completeAuth(code: string, state: string): Promise<AuthCompletion> {
    const name = typeof state === 'string' && state ? this.states.take(state) : null
    if (!name) return { ok: false, reason: 'bad_state', message: AUTH_TEXT.badState }
    if (!this.configured) return { ok: false, reason: 'not_configured', message: AUTH_TEXT.notConfigured }
    const { secrets, logger, auth } = this.o.ports
    if (!secrets.keyId) return { ok: false, reason: 'not_configured', message: AUTH_TEXT.secretUnavailable }
    if (typeof code !== 'string' || !code || code.length > MAX_CODE_CHARS) return { ok: false, reason: 'code_rejected', message: AUTH_TEXT.badCode }
    await this.ensureLoaded()

    let tokens: TokenSet
    let claims: AccessClaims
    try {
      tokens = await this.sso.exchangeCode(code)
      claims = this.check(tokens.accessToken, this.now())
    } catch (e) {
      logger.warn(`EVE 授权档案 ${name} 授权没有完成：${this.safe(e, [code])}`)
      if (isSsoError(e) && e.kind === 'invalid_grant') return { ok: false, reason: 'code_rejected', message: AUTH_TEXT.codeRejected }
      const failure = this.classify(e)
      if (failure.status === 'DEGRADED') return { ok: false, reason: 'unavailable', message: AUTH_TEXT.exchangeUnavailable(briefOf(e)) }
      return { ok: false, reason: 'exchange_failed', message: failure.reason }
    }
    const missing = missingScopes(claims.scopes, ESSENTIAL_SCOPES)
    if (missing.length) {
      logger.warn(`EVE 授权档案 ${name} 授权没有完成：缺少权限 ${missing.join(' ')}`)
      return { ok: false, reason: 'missing_scopes', message: AUTH_TEXT.missingScopes(missing) }
    }
    if (!tokens.refreshToken) return { ok: false, reason: 'exchange_failed', message: AUTH_TEXT.noRefreshToken }

    let sealed: string
    try {
      sealed = secrets.seal(tokens.refreshToken)
    } catch {
      return { ok: false, reason: 'not_configured', message: AUTH_TEXT.secretUnavailable }
    }
    const at = this.now()
    const rec: AuthRecord = {
      profile: name,
      characterId: claims.characterId,
      characterName: claims.characterName,
      ownerHash: claims.ownerHash,
      scopes: claims.scopes,
      refreshToken: sealed,
      keyId: secrets.keyId,
      status: 'OK',
      lastError: '',
      lastErrorAt: null,
      lastRefreshAt: at,
      lastSuccessAt: at,
      authorizedAt: at,
    }
    // 先改内存、再写数据库（中间不能有 await）：进行中的旧授权的刷新回来时发现 generation 变了，丢掉结果，
    // 不会在数据库里把新授权盖掉；写数据库期间开始的刷新用的已经是新授权
    const slot = this.slot(name)
    const before = this.snapshot(slot)
    slot.generation++
    slot.rec = rec
    slot.status = 'OK'
    slot.lastError = ''
    slot.lastErrorAt = null
    slot.retryAt = null
    slot.access = { token: tokens.accessToken, characterId: claims.characterId, expiresAt: this.expiry(tokens, claims, at), obtainedAt: at }
    try {
      await auth.upsert(rec)
    } catch (e) {
      logger.warn(`EVE 授权档案 ${name} 没能写进数据库：${this.safe(e)}`)
      // 没写成：恢复成授权之前的样子（期间没有别的变化时）；这期间开始的刷新也作废
      if (slot.rec === rec) {
        slot.generation++
        Object.assign(slot, before)
      }
      return { ok: false, reason: 'save_failed', message: AUTH_TEXT.saveFailed }
    }
    slot.backoff.reset()
    logger.info(`EVE 授权档案 ${name} 已授权：角色「${claims.characterName || claims.characterId}」`)
    this.emit(name)
    return { ok: true, profile: name, characterId: claims.characterId, characterName: claims.characterName, structures: await this.probe(name) }
  }

  /** 用这个档案的每个建筑市场：能不能访问、建筑名和星系 */
  private async probe(name: string): Promise<StructureProbe[]> {
    const markets = this.usage().get(name) ?? []
    if (!markets.length) return []
    const auth = this.esiAuth(name)
    // 一次性的缓存：换了角色重新授权时，不能拿上一个角色的结果充数
    const store = new MemoryResponseCache(PROBE_CACHE_BYTES)
    return mapLimit(markets, PROBE_CONCURRENCY, async (m): Promise<StructureProbe> => {
      const base: StructureProbe = { marketKey: m.key, marketName: m.name, structureId: m.location, access: 'error' }
      const id = Number(m.location)
      if (!/^\d+$/.test(m.location) || !Number.isSafeInteger(id) || id <= 0) return { ...base, access: 'not_found' }
      try {
        const res = await this.o.esi.structure(id, { auth, store, staleIfErrorMs: 0, lane: 'interactive' })
        return { ...base, access: 'ok', structureName: res.value.name, systemId: res.value.solarSystemId }
      } catch (e) {
        const status = e instanceof EsiError ? e.status : undefined
        if (status !== 403 && status !== 404) this.o.ports.logger.debug(`探测建筑 ${m.name} 失败：${this.safe(e)}`)
        return { ...base, access: status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'error' }
      }
    })
  }

  async remove(profile: string): Promise<void> {
    await this.ensureLoaded()
    const slot = this.slots.get(profile)
    const rec = slot?.rec ?? null
    // 内存里没有：读入成功时就是真的没有；读入失败时数据库里可能有，照样删
    if (!rec && this.loaded) return
    const { auth, secrets, logger } = this.o.ports
    // 先在内存里作废、再删数据库（中间不能有 await）：删除期间回来的刷新结果会被丢掉，不会把档案写回数据库
    const before = slot ? this.snapshot(slot) : null
    if (slot) {
      slot.generation++
      slot.rec = null
      slot.access = null
    }
    try {
      await auth.remove(profile)
    } catch (e) {
      // 没删成：恢复原样（期间没有重新授权时），可以再删一次
      if (slot && before && !slot.rec) Object.assign(slot, before)
      throw e
    }
    let plain: string | null = null
    if (rec?.refreshToken && secrets.keyId && rec.keyId === secrets.keyId) {
      try {
        plain = secrets.open(rec.refreshToken)
      } catch {
        plain = null
      }
    }
    if (slot && !slot.rec) {
      slot.status = 'NEEDS_AUTH'
      slot.lastError = ''
      slot.lastErrorAt = null
      slot.retryAt = null
      slot.backoff.reset()
    }
    logger.info(`EVE 授权档案 ${profile} 已删除`)
    this.emit(profile)
    if (!plain || !this.configured) return
    // 尽量撤销一次；失败也不影响删除
    try {
      await this.sso.revoke(plain)
    } catch (e) {
      logger.info(`EVE 授权档案 ${profile} 的刷新令牌没有撤销成功（${isSsoError(e) ? e.brief : 'error'}），可以在 EVE 账号管理页手动撤销`)
    }
  }

  // ------------------------------------------------------------------ 按名字搜建筑

  /** 搜索失败的说明：取不到 token 时说档案的原因；4xx（路由、权限名待核实）说被拒绝、给别的找 ID 的办法；其他是暂时的 */
  private searchError(e: unknown): string {
    if (!(e instanceof EsiError)) return AUTH_TEXT.searchFailed('error')
    if (e.kind === 'auth') return e.message
    const status = e.status
    if (e.kind === 'http' && status !== undefined && status >= 400 && status < 500 && ![408, 420, 429].includes(status)) {
      return AUTH_TEXT.searchRejected(`HTTP ${status}`)
    }
    return AUTH_TEXT.searchFailed(status !== undefined ? `HTTP ${status}` : e.kind)
  }

  async searchStructures(profile: string, text: string): Promise<StructureSearchHit[] | CoreFailure> {
    const q = String(text ?? '').replace(/\s+/g, ' ').trim()
    const length = [...q].length
    if (length < STRUCTURE_SEARCH_MIN_CHARS || length > STRUCTURE_SEARCH_MAX_CHARS) {
      return { ok: false, code: 'BAD_ARGUMENT', message: AUTH_TEXT.searchLength }
    }
    const token = await this.getAccessToken(profile)
    if (!token.ok) return { ok: false, code: token.status === 'NEEDS_AUTH' ? 'NOT_CONFIGURED' : 'UPSTREAM_UNAVAILABLE', message: token.reason }
    const rec = this.slots.get(profile)?.rec
    if (rec && !rec.scopes.includes(SSO_SEARCH_SCOPE)) return { ok: false, code: 'NOT_CONFIGURED', message: AUTH_TEXT.noSearchScope }
    const auth = this.esiAuth(profile)
    let ids: number[]
    try {
      ids = (await this.o.esi.searchStructures(Number(token.characterId), q, { auth, lane: 'interactive' })).value
    } catch (e) {
      this.o.ports.logger.warn(`按名字搜建筑失败（授权档案 ${profile}）：${this.safe(e)}`)
      return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: this.searchError(e) }
    }
    const unique = [...new Set(ids)].slice(0, MAX_SEARCH_HITS)
    const hits = await mapLimit(unique, PROBE_CONCURRENCY, async (id): Promise<StructureSearchHit> => {
      try {
        const info = (await this.o.esi.structure(id, { auth, lane: 'interactive' })).value
        return { id: String(id), name: info.name, systemId: info.solarSystemId }
      } catch {
        // 搜得到、但看不到详情（没有停靠权限）：只列 ID
        return { id: String(id), name: '', systemId: null }
      }
    })
    return hits.sort((a, b) => Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  /** KB 人物卡的模糊搜索：用这个档案的角色令牌搜人物，返回人物 ID（令牌不进日志） */
  async searchCharacters(profile: string, text: string): Promise<number[] | CoreFailure> {
    const q = String(text ?? '').replace(/\s+/g, ' ').trim()
    const length = [...q].length
    if (length < STRUCTURE_SEARCH_MIN_CHARS || length > STRUCTURE_SEARCH_MAX_CHARS) {
      return { ok: false, code: 'BAD_ARGUMENT', message: AUTH_TEXT.searchLength }
    }
    const token = await this.getAccessToken(profile)
    if (!token.ok) return { ok: false, code: token.status === 'NEEDS_AUTH' ? 'NOT_CONFIGURED' : 'UPSTREAM_UNAVAILABLE', message: token.reason }
    const rec = this.slots.get(profile)?.rec
    if (rec && !rec.scopes.includes(SSO_SEARCH_SCOPE)) return { ok: false, code: 'NOT_CONFIGURED', message: AUTH_TEXT.noSearchScope }
    try {
      const found = await this.o.esi.searchCharacters(Number(token.characterId), q, { auth: this.esiAuth(profile), lane: 'interactive' })
      return [...new Set(found.value)]
    } catch (e) {
      this.o.ports.logger.warn(`按名字搜人物失败（授权档案 ${profile}）：${this.safe(e)}`)
      return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: this.searchError(e) }
    }
  }
}

export function createAuthService(options: AuthServiceOptions): ManagedAuthService {
  return new SsoAuthService(options)
}
