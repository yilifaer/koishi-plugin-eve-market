// 本机的假 ESI（含最简单的 SSO）：真实的 HTTP 服务，测试把 ESI、SSO 的地址指过来。
// 按 2026-08-18 的规范返回缓存头、条件请求、分页、限流头和错误额度头；可以注入故障、卡住请求、
// 在返回之前改数据（模拟翻页途中数据更新）。所有 ID、名字都是编造的（SDE 里的公共数据除外）。

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SSO_SCOPES } from '../../src/constants'

// ------------------------------------------------------------------ 原始数据（ESI 的字段名）

export interface RawOrder {
  order_id: number
  type_id: number
  location_id: number
  system_id: number
  is_buy_order: boolean
  price: number
  volume_remain: number
  volume_total: number
  min_volume: number
  range: string
  duration: number
  issued: string
}

let nextOrderId = 6_100_000_000

export function rawOrder(o: Partial<RawOrder> = {}): RawOrder {
  return {
    order_id: ++nextOrderId,
    type_id: 638,
    location_id: 60003760,
    system_id: 30000142,
    is_buy_order: false,
    price: 250_000_000,
    volume_remain: 3,
    volume_total: 5,
    min_volume: 1,
    range: 'region',
    duration: 90,
    issued: '2026-10-01T08:00:00Z',
    ...o,
  }
}

export interface RawHistory {
  date: string
  average: number
  highest: number
  lowest: number
  volume: number
  order_count: number
}

export interface RawType {
  type_id: number
  name: string
  description: string
  group_id: number
  market_group_id?: number
  published: boolean
  volume?: number
  packaged_volume?: number
  capacity?: number
  portion_size?: number
}

// ------------------------------------------------------------------ 入侵、服务器状态（ESI 的字段名）

export interface RawIncursion {
  constellation_id: number
  faction_id: number
  has_boss: boolean
  infested_solar_systems: number[]
  /** 0–1 */
  influence: number
  staging_solar_system_id: number
  state: 'established' | 'mobilizing' | 'withdrawing'
  type: string
}

/** 默认：萨沙共和国在木本呂（Jita 所在的星座）立足 */
export function rawIncursion(o: Partial<RawIncursion> = {}): RawIncursion {
  return {
    constellation_id: 20000020,
    faction_id: 500019,
    has_boss: false,
    infested_solar_systems: [30000142, 30000144, 30000145],
    influence: 0.64,
    staging_solar_system_id: 30000142,
    state: 'established',
    type: 'Incursion',
    ...o,
  }
}

/** vip 只在 VIP 模式时出现 */
export interface RawServerStatus {
  players: number
  server_version: string
  start_time: string
  vip?: boolean
}

// ------------------------------------------------------------------ 击杀详情（ESI 的字段名，编造的 ID）

export interface RawKillParty {
  character_id?: number
  corporation_id?: number
  alliance_id?: number
  faction_id?: number
  ship_type_id?: number
}

export interface RawKillmail {
  killmail_id: number
  killmail_time: string
  solar_system_id: number
  victim: RawKillParty & { damage_taken: number; ship_type_id: number }
  attackers: Array<RawKillParty & { final_blow: boolean; damage_done: number; security_status: number; weapon_type_id?: number }>
}

/** 默认：乌鸦级在 Jita 被两个人击毁，第二个打了最后一击 */
export function rawKillmail(o: Partial<RawKillmail> = {}): RawKillmail {
  return {
    killmail_id: 131234567,
    killmail_time: '2026-10-14T12:34:56Z',
    solar_system_id: 30000142,
    victim: { character_id: 2112000101, corporation_id: 98000101, alliance_id: 99000101, ship_type_id: 638, damage_taken: 51234 },
    attackers: [
      { character_id: 2112000201, corporation_id: 98000201, ship_type_id: 17738, weapon_type_id: 2977, final_blow: false, damage_done: 20000, security_status: -1.2 },
      { character_id: 2112000202, corporation_id: 98000201, alliance_id: 99000201, ship_type_id: 11978, weapon_type_id: 2977, final_blow: true, damage_done: 31234, security_status: 0.5 },
    ],
    ...o,
  }
}

// ------------------------------------------------------------------ 请求记录和故障

export interface EsiLogEntry {
  method: string
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  body: string
  /** 回复的状态码（故障、卡住的请求在回复后才填） */
  status?: number
}

export interface Fault {
  status?: number
  body?: unknown
  /** 原样发送的响应体（例如坏的 JSON） */
  raw?: string
  headers?: Record<string, string>
  delayMs?: number
  /** 直接断开连接 */
  destroy?: boolean
}

export type CacheMode = 'cache-control' | 'expires' | 'none'

interface Resource {
  /** Last-Modified（毫秒） */
  modified: number
}

interface Bucket {
  limit: number
  windowMs: number
  spent: Array<{ at: number; cost: number }>
}

const HTTP_DATE = (ms: number) => new Date(ms).toUTCString()

function costOf(status: number): number {
  if (status === 429) return 0
  if (status < 300) return 2
  if (status < 400) return 1
  if (status < 500) return 5
  return 0
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

export class FakeEsi {
  server!: http.Server
  base = ''
  /** 服务器的时间；测试可以换成假时钟 */
  clock: () => number = () => Date.now()
  /** 服务器的「今天」，比它新的 X-Compatibility-Date 回 400 */
  today = '2026-10-07'
  /** 真实 ESI 每页 1000 条 */
  pageSize = 1000
  cacheMode: CacheMode = 'cache-control'
  /** 各路由的缓存秒数（按路由模板），没写的用 300 */
  maxAge: Record<string, number> = { status: 30, history: 3600, prices: 3600, systems: 3600, incursions: 300, universe: 86400 }

  readonly requests: EsiLogEntry[] = []
  faults: Array<{ method: string; pattern: RegExp; fault: Fault; times: number }> = []
  /** 在回复之前调用（可以在这里改数据，模拟翻页途中数据更新） */
  beforeRespond: ((req: EsiLogEntry) => void | Promise<void>) | null = null
  /** 正在处理的请求数和最大值（检查并发） */
  inFlight = 0
  peakInFlight = 0
  private holds: Array<{ pattern: RegExp; match?: (req: EsiLogEntry) => boolean; release: Promise<void> }> = []

  // 数据
  regionOrders = new Map<number, RawOrder[]>()
  structureOrders = new Map<number, RawOrder[]>()
  history = new Map<string, RawHistory[]>()
  prices: Array<{ type_id: number; adjusted_price?: number; average_price?: number }> = []
  industrySystems: Array<{ solar_system_id: number; cost_indices: Array<{ activity: string; cost_index: number }> }> = []
  incursions: unknown[] = []
  serverStatus: RawServerStatus = { players: 23456, server_version: '3000001', start_time: '2026-10-07T11:05:12Z', vip: false }
  types = new Map<number, RawType>()
  names = new Map<number, { name: string; category: string }>()
  /** 名字 → ID，按语言分开（en、zh），名字不区分大小写 */
  idNames: Record<string, Map<string, { category: string; id: number; name: string }>> = { en: new Map(), zh: new Map() }
  structureInfo = new Map<number, { name: string; owner_id: number; solar_system_id: number; type_id?: number }>()
  /** 访问这些建筑回 403 */
  forbiddenStructures = new Set<number>()
  searchResults = new Map<string, number[]>()
  /** 击杀详情：击杀编号 → hash 和内容（hash 对不上回 422，没有回 404） */
  killmails = new Map<number, { hash: string; mail: RawKillmail }>()

  /** 限流组（按 2026-08-18 的规范） */
  buckets: Record<string, Bucket> = {
    'market-order': { limit: 12000, windowMs: 900_000, spent: [] },
    industry: { limit: 150, windowMs: 900_000, spent: [] },
    incursion: { limit: 150, windowMs: 900_000, spent: [] },
    status: { limit: 600, windowMs: 900_000, spent: [] },
  }
  /** 旧的错误额度：每个窗口 100 次 4xx/5xx */
  errorLimit = { limit: 100, windowMs: 60_000, windowStart: 0, errors: 0 }
  private resources = new Map<string, Resource>()

  // SSO
  sso = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    characterId: 2112000001,
    characterName: 'Test Pilot',
    ownerHash: 'fake-owner-hash-1',
    scopes: [...SSO_SCOPES] as string[],
    /** JWT 的 scp 写成字符串（只有一个权限时 SSO 就是这样） */
    scpAsString: false,
    accessTtlSec: 1199,
    /** 刷新时换新的 refresh token */
    rotateRefresh: true,
  }
  /** 有效的 access token（建筑市场等授权路由认这些） */
  accessTokens = new Set<string>()
  refreshTokens = new Set<string>()
  private codes = new Map<string, { redirectUri: string }>()

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => void this.handle(req, res, Buffer.concat(chunks).toString('utf8')))
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  // ------------------------------------------------------------------ 测试用的操作

  fault(method: string, pattern: RegExp, fault: Fault, times = 1) {
    this.faults.push({ method, pattern, fault, times })
  }

  /** 匹配的请求一直等到调用返回的函数；match 可以再按请求体挑（例如只挡刷新、不挡用授权码换 token） */
  hold(pattern: RegExp, match?: (req: EsiLogEntry) => boolean): () => void {
    let release!: () => void
    const entry = { pattern, match, release: new Promise<void>((resolve) => (release = resolve)) }
    this.holds.push(entry)
    return () => {
      this.holds = this.holds.filter((h) => h !== entry)
      release()
    }
  }

  /** 改了数据以后调用：Last-Modified 往后挪，ETag 跟着变 */
  touch(resource: string, at = this.clock()) {
    const old = this.resources.get(resource)?.modified ?? 0
    this.resources.set(resource, { modified: Math.max(at, old + 1000) })
  }

  count(pattern: RegExp, method = 'GET') {
    return this.requests.filter((r) => r.method === method && pattern.test(r.path)).length
  }

  /** 不走授权流程，直接发一对 token */
  issueTokens(): { access: string; refresh: string } {
    const access = this.jwt()
    const refresh = `rt-${randomBytes(12).toString('hex')}`
    this.accessTokens.add(access)
    this.refreshTokens.add(refresh)
    return { access, refresh }
  }

  /** 把一个 access token 作废（模拟过期） */
  expire(access: string) {
    this.accessTokens.delete(access)
  }

  // ------------------------------------------------------------------ 处理

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    const url = new URL(req.url ?? '/', this.base)
    const entry: EsiLogEntry = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body }
    this.requests.push(entry)
    this.inFlight++
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight)
    try {
      for (const hold of this.holds.filter((h) => h.pattern.test(entry.path) && (!h.match || h.match(entry)))) await hold.release
      await this.beforeRespond?.(entry)
      const fault = this.faults.find((f) => f.method === entry.method && f.pattern.test(entry.path))
      if (fault) {
        if (--fault.times <= 0) this.faults.splice(this.faults.indexOf(fault), 1)
        if (fault.fault.delayMs) await new Promise((r) => setTimeout(r, fault.fault.delayMs))
        if (fault.fault.destroy) {
          entry.status = 0
          req.socket.destroy()
          return
        }
        if (fault.fault.status || fault.fault.raw !== undefined || fault.fault.body !== undefined) {
          const status = fault.fault.status ?? 500
          this.reply(res, entry, status, fault.fault.raw ?? JSON.stringify(fault.fault.body ?? { error: 'Internal server error' }), {
            ...this.limitHeaders(entry, status),
            ...fault.fault.headers,
          })
          return
        }
      }
      if (entry.path.startsWith('/v2/oauth/')) return this.handleSso(entry, res)
      return this.route(entry, res)
    } finally {
      this.inFlight--
    }
  }

  private reply(res: http.ServerResponse, entry: EsiLogEntry, status: number, body: string, headers: Record<string, string> = {}) {
    entry.status = status
    res.statusCode = status
    if (body) res.setHeader('Content-Type', 'application/json; charset=utf-8')
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
    res.end(body)
  }

  private error(res: http.ServerResponse, entry: EsiLogEntry, status: number, message: string, group?: string) {
    this.reply(res, entry, status, JSON.stringify({ error: message }), this.limitHeaders(entry, status, group))
  }

  private route(entry: EsiLogEntry, res: http.ServerResponse) {
    const date = entry.headers['x-compatibility-date']
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return this.error(res, entry, 400, 'X-Compatibility-Date header is required')
    if (date > this.today) return this.error(res, entry, 400, 'X-Compatibility-Date is in the future')
    if (/^\/(latest|legacy|dev|v\d+)\//.test(entry.path)) return this.error(res, entry, 404, 'Versioned routes are not served here')

    const { method, path, query } = entry
    let m: RegExpExecArray | null
    if (method === 'GET' && (m = /^\/markets\/(\d+)\/orders$/.exec(path))) {
      const region = Number(m[1])
      const type = query.get('type_id')
      const side = query.get('order_type')
      if (side !== 'all' && side !== 'buy' && side !== 'sell') return this.error(res, entry, 400, 'order_type is required', 'market-order')
      const orders = (this.regionOrders.get(region) ?? [])
        .filter((o) => !type || o.type_id === Number(type))
        .filter((o) => side === 'all' || o.is_buy_order === (side === 'buy'))
      return this.paged(entry, res, `orders:${region}`, orders, 'orders', 'market-order')
    }
    if (method === 'GET' && (m = /^\/markets\/structures\/(\d+)$/.exec(path))) {
      const id = Number(m[1])
      if (!this.authorized(entry)) return this.error(res, entry, 401, 'authentication failure')
      if (this.forbiddenStructures.has(id)) return this.error(res, entry, 403, 'Market access denied')
      const orders = (this.structureOrders.get(id) ?? []).map(({ system_id: _, ...o }) => o)
      return this.paged(entry, res, `structure:${id}`, orders, 'orders')
    }
    if (method === 'GET' && (m = /^\/markets\/(\d+)\/history$/.exec(path))) {
      const rows = this.history.get(`${m[1]}:${query.get('type_id')}`)
      if (!rows) return this.error(res, entry, 404, 'Type not found')
      return this.json(entry, res, `history:${m[1]}:${query.get('type_id')}`, rows, 'history')
    }
    if (method === 'GET' && path === '/markets/prices') return this.json(entry, res, 'prices', this.prices, 'prices')
    if (method === 'GET' && path === '/industry/systems') return this.json(entry, res, 'systems', this.industrySystems, 'systems', 'industry')
    if (method === 'GET' && path === '/incursions') return this.json(entry, res, 'incursions', this.incursions, 'incursions', 'incursion')
    if (method === 'GET' && path === '/status') return this.json(entry, res, 'status', this.serverStatus, 'status', 'status')
    if (method === 'GET' && (m = /^\/killmails\/(\d+)\/([0-9a-f]{40})$/.exec(path))) {
      const hit = this.killmails.get(Number(m[1]))
      if (!hit) return this.error(res, entry, 404, 'Not found')
      if (hit.hash !== m[2]) return this.error(res, entry, 422, 'Invalid killmail_id and/or killmail_hash')
      return this.json(entry, res, `killmail:${m[1]}`, hit.mail, 'killmail')
    }
    if (method === 'GET' && (m = /^\/universe\/types\/(\d+)$/.exec(path))) {
      const type = this.types.get(Number(m[1]))
      return type ? this.json(entry, res, `type:${m[1]}`, type, 'universe') : this.error(res, entry, 404, 'Type not found')
    }
    if (method === 'GET' && (m = /^\/universe\/structures\/(\d+)$/.exec(path))) {
      if (!this.authorized(entry)) return this.error(res, entry, 401, 'authentication failure')
      const info = this.structureInfo.get(Number(m[1]))
      if (!info || this.forbiddenStructures.has(Number(m[1]))) return this.error(res, entry, 403, 'Forbidden')
      return this.json(entry, res, `structure-info:${m[1]}`, info, 'universe')
    }
    if (method === 'GET' && (m = /^\/characters\/(\d+)\/search$/.exec(path))) {
      if (!this.authorized(entry)) return this.error(res, entry, 401, 'authentication failure')
      const hits = this.searchResults.get(query.get('search') ?? '') ?? []
      return this.json(entry, res, `search:${query.get('search')}`, hits.length ? { structure: hits } : {}, 'search')
    }
    if (method === 'POST' && path === '/universe/names') {
      const ids = this.parseBody(entry)
      if (!Array.isArray(ids) || !ids.length) return this.error(res, entry, 400, 'Invalid body')
      const out = []
      for (const id of ids) {
        const hit = this.names.get(Number(id))
        if (!hit) return this.error(res, entry, 404, 'Ensure all IDs are valid before resolving')
        out.push({ id: Number(id), ...hit })
      }
      return this.reply(res, entry, 200, JSON.stringify(out), this.limitHeaders(entry, 200))
    }
    if (method === 'POST' && path === '/universe/ids') {
      const names = this.parseBody(entry)
      if (!Array.isArray(names) || !names.length) return this.error(res, entry, 400, 'Invalid body')
      const lang = String(entry.headers['accept-language'] ?? 'en').split(/[,;-]/)[0]
      const table = this.idNames[lang] ?? this.idNames.en
      const out: Record<string, Array<{ id: number; name: string }>> = {}
      for (const name of names) {
        const hit = table.get(String(name).toLowerCase())
        if (hit) (out[hit.category] ??= []).push({ id: hit.id, name: hit.name })
      }
      return this.reply(res, entry, 200, JSON.stringify(out), { 'Content-Language': lang, ...this.limitHeaders(entry, 200) })
    }
    return this.error(res, entry, 404, 'Not found')
  }

  private parseBody(entry: EsiLogEntry): unknown {
    try {
      return JSON.parse(entry.body)
    } catch {
      return undefined
    }
  }

  private authorized(entry: EsiLogEntry): boolean {
    const auth = entry.headers.authorization
    return typeof auth === 'string' && auth.startsWith('Bearer ') && this.accessTokens.has(auth.slice(7))
  }

  private modified(resource: string): number {
    let r = this.resources.get(resource)
    if (!r) {
      r = { modified: Math.floor(this.clock() / 1000) * 1000 - 60_000 }
      this.resources.set(resource, r)
    }
    return r.modified
  }

  private cacheHeaders(maxAgeKey: string): Record<string, string> {
    const sec = this.maxAge[maxAgeKey] ?? 300
    const now = this.clock()
    if (this.cacheMode === 'cache-control') return { 'Cache-Control': `public, max-age=${sec}` }
    if (this.cacheMode === 'expires') return { Expires: HTTP_DATE(now + sec * 1000), Date: HTTP_DATE(now) }
    return {}
  }

  /** 普通 JSON：ETag、Last-Modified、缓存头；If-None-Match 对上时回 304 */
  private json(entry: EsiLogEntry, res: http.ServerResponse, resource: string, value: unknown, maxAgeKey: string, group?: string, extra: Record<string, string> = {}) {
    const body = JSON.stringify(value)
    const modified = this.modified(resource)
    const etag = `"${createHash('sha1').update(`${modified}:${body}`).digest('hex').slice(0, 20)}"`
    const headers = { ETag: etag, 'Last-Modified': HTTP_DATE(modified), ...this.cacheHeaders(maxAgeKey), ...extra }
    if (group) {
      const retryAfter = this.exhausted(group)
      if (retryAfter !== null) {
        return this.reply(res, entry, 429, JSON.stringify({ error: 'Too many requests' }), { ...this.limitHeaders(entry, 429, group), 'Retry-After': String(retryAfter) })
      }
    }
    if (entry.headers['if-none-match'] === etag) {
      return this.reply(res, entry, 304, '', { ...headers, ...this.limitHeaders(entry, 304, group) })
    }
    return this.reply(res, entry, 200, body, { ...headers, ...this.limitHeaders(entry, 200, group) })
  }

  private paged(entry: EsiLogEntry, res: http.ServerResponse, resource: string, rows: unknown[], maxAgeKey: string, group?: string) {
    const pages = Math.max(1, Math.ceil(rows.length / this.pageSize))
    const page = Number(entry.query.get('page') ?? 1)
    if (!Number.isInteger(page) || page < 1 || page > pages) return this.error(res, entry, 404, 'Requested page does not exist!', group)
    const slice = rows.slice((page - 1) * this.pageSize, page * this.pageSize)
    return this.json(entry, res, resource, slice, maxAgeKey, group, { 'X-Pages': String(pages) })
  }

  /** 这个组的额度用完时返回 Retry-After 的秒数 */
  private exhausted(group: string): number | null {
    const bucket = this.buckets[group]
    const now = this.clock()
    bucket.spent = bucket.spent.filter((s) => s.at > now - bucket.windowMs)
    const used = bucket.spent.reduce((sum, s) => sum + s.cost, 0)
    if (used + costOf(200) <= bucket.limit) return null
    const oldest = bucket.spent[0]?.at ?? now
    return Math.max(1, Math.ceil((oldest + bucket.windowMs - now) / 1000))
  }

  /** 有限流组的路由带 X-Ratelimit-*，其他路由带旧的错误额度头 */
  private limitHeaders(entry: EsiLogEntry, status: number, group?: string): Record<string, string> {
    const now = this.clock()
    if (group) {
      const bucket = this.buckets[group]
      bucket.spent = bucket.spent.filter((s) => s.at > now - bucket.windowMs)
      const cost = costOf(status)
      if (cost) bucket.spent.push({ at: now, cost })
      const used = bucket.spent.reduce((sum, s) => sum + s.cost, 0)
      return {
        'X-Ratelimit-Group': group,
        'X-Ratelimit-Limit': `${bucket.limit}/${Math.round(bucket.windowMs / 60_000)}m`,
        'X-Ratelimit-Remaining': String(Math.max(0, bucket.limit - used)),
        'X-Ratelimit-Used': String(cost),
      }
    }
    const e = this.errorLimit
    if (now - e.windowStart >= e.windowMs) {
      e.windowStart = now
      e.errors = 0
    }
    if (status >= 400) e.errors++
    return {
      'X-ESI-Error-Limit-Remain': String(Math.max(0, e.limit - e.errors)),
      'X-ESI-Error-Limit-Reset': String(Math.ceil((e.windowStart + e.windowMs - now) / 1000)),
    }
  }

  // ------------------------------------------------------------------ SSO（最小实现）

  private jwt(): string {
    const now = Math.floor(this.clock() / 1000)
    const s = this.sso
    const payload = {
      scp: s.scpAsString && s.scopes.length === 1 ? s.scopes[0] : s.scopes,
      jti: randomBytes(8).toString('hex'),
      kid: 'JWT-Signature-Key',
      sub: `CHARACTER:EVE:${s.characterId}`,
      azp: s.clientId,
      tenant: 'tranquility',
      tier: 'live',
      region: 'world',
      aud: [s.clientId, 'EVE Online'],
      name: s.characterName,
      owner: s.ownerHash,
      exp: now + s.accessTtlSec,
      iat: now,
      iss: 'https://login.eveonline.com',
    }
    return [base64url(JSON.stringify({ alg: 'RS256', kid: 'JWT-Signature-Key', typ: 'JWT' })), base64url(JSON.stringify(payload)), base64url(randomBytes(32))].join('.')
  }

  private handleSso(entry: EsiLogEntry, res: http.ServerResponse) {
    const s = this.sso
    if (entry.method === 'GET' && entry.path === '/v2/oauth/authorize') {
      const q = entry.query
      if (q.get('response_type') !== 'code' || q.get('client_id') !== s.clientId || !q.get('redirect_uri') || !q.get('state')) {
        return this.reply(res, entry, 400, JSON.stringify({ error: 'invalid_request' }))
      }
      const code = `code-${randomBytes(8).toString('hex')}`
      this.codes.set(code, { redirectUri: q.get('redirect_uri')! })
      const target = new URL(q.get('redirect_uri')!)
      target.searchParams.set('code', code)
      target.searchParams.set('state', q.get('state')!)
      entry.status = 302
      res.statusCode = 302
      res.setHeader('Location', target.toString())
      return res.end()
    }
    const basic = `Basic ${Buffer.from(`${s.clientId}:${s.clientSecret}`).toString('base64')}`
    const form = new URLSearchParams(entry.body)
    const ssoError = (status: number, error: string, description: string) =>
      this.reply(res, entry, status, JSON.stringify({ error, error_description: description }))
    if (entry.method === 'POST' && entry.path === '/v2/oauth/token') {
      if (entry.headers.authorization !== basic) return ssoError(401, 'invalid_client', 'Client authentication failed')
      const grant = form.get('grant_type')
      if (grant === 'authorization_code') {
        const code = form.get('code') ?? ''
        if (!this.codes.delete(code)) return ssoError(400, 'invalid_grant', 'Authorization code is invalid or expired')
        return this.tokenReply(entry, res)
      }
      if (grant === 'refresh_token') {
        const refresh = form.get('refresh_token') ?? ''
        if (!this.refreshTokens.has(refresh)) return ssoError(400, 'invalid_grant', 'Invalid refresh token')
        if (s.rotateRefresh) this.refreshTokens.delete(refresh)
        return this.tokenReply(entry, res, s.rotateRefresh ? undefined : refresh)
      }
      return ssoError(400, 'unsupported_grant_type', 'Unsupported grant type')
    }
    if (entry.method === 'POST' && entry.path === '/v2/oauth/revoke') {
      if (entry.headers.authorization !== basic) return ssoError(401, 'invalid_client', 'Client authentication failed')
      this.refreshTokens.delete(form.get('token') ?? '')
      return this.reply(res, entry, 200, '')
    }
    return ssoError(404, 'not_found', 'Not found')
  }

  private tokenReply(entry: EsiLogEntry, res: http.ServerResponse, keepRefresh?: string) {
    const access = this.jwt()
    const refresh = keepRefresh ?? `rt-${randomBytes(12).toString('hex')}`
    this.accessTokens.add(access)
    this.refreshTokens.add(refresh)
    const body = { access_token: access, expires_in: this.sso.accessTtlSec, token_type: 'Bearer', refresh_token: refresh }
    return this.reply(res, entry, 200, JSON.stringify(body), { 'Cache-Control': 'no-store' })
  }
}
