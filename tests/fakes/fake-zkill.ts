// 本机的假 zKill：真实的 HTTP 服务，测试把 zkillBase 指过来。记录收到的 User-Agent；
// 可以返回正常 JSON、`[]`、429 + Retry-After、403 的验证页、超大响应、卡住的请求。所有 ID 和 hash 都是编造的。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { rawKillmail } from './fake-esi'
import type { RawKillmail } from './fake-esi'

/** 真实响应是完整击杀 + zkb；minimal 的是老格式，只有 killmail_id 和 zkb */
export interface RawZkillKill extends Partial<Omit<RawKillmail, 'killmail_id'>> {
  killmail_id: number
  zkb: {
    hash: string
    totalValue?: number
    fittedValue?: number
    droppedValue?: number
    destroyedValue?: number
    points?: number
    npc?: boolean
    solo?: boolean
    awox?: boolean
    locationID?: number
    labels?: string[]
  }
}

/** 默认：完整击杀（和 fake-esi 的默认击杀一致），估值 4.52 亿，有人击杀，不是单杀；body 传 'minimal' 得到老格式，传对象改击杀正文 */
export function rawZkillKill(
  killId = 131234567,
  hash = '0123456789abcdef0123456789abcdef01234567',
  zkb: Partial<RawZkillKill['zkb']> = {},
  body: Partial<RawKillmail> | 'minimal' = {},
): RawZkillKill {
  return {
    ...(body === 'minimal' ? {} : rawKillmail({ ...body, killmail_id: killId })),
    killmail_id: killId,
    zkb: {
      hash, totalValue: 452_000_000, fittedValue: 120_000_000, droppedValue: 30_000_000, destroyedValue: 422_000_000,
      points: 12, npc: false, solo: false, awox: false, locationID: 40009077, labels: ['pvp'], ...zkb,
    },
  }
}

export type ZkillFault =
  | { kind: 'status'; status: number; body?: string; headers?: Record<string, string> }
  | { kind: 'rate-limit'; retryAfter?: number }
  | { kind: 'challenge' }
  | { kind: 'huge'; bytes: number }
  | { kind: 'hang' }
  | { kind: 'raw'; body: string }

export interface ZkillLogEntry {
  path: string
  userAgent: string | undefined
  accept: string | undefined
}

export class FakeZkill {
  server!: http.Server
  base = ''
  readonly requests: ZkillLogEntry[] = []
  /** requests 里每个请求到达的时间（Date.now()） */
  readonly times: number[] = []
  /** 击杀编号 → 返回的内容；没有的回 `[]` */
  kills = new Map<number, RawZkillKill>()
  /** 其他固定路径 → 返回的 JSON */
  routes = new Map<string, unknown>()
  /** KB 人物卡：人物统计（没有的回 `{}`）。真实服务器对 /api/stats/characterID/<id>/ 回 302，统计在 `.../kills/` */
  stats = new Map<number, unknown>()
  /** 为 false 时统计直接在 /api/stats/characterID/<id>/ 返回，不跳转 */
  redirectStats = true
  /** 人物的击杀、损失列表（完整击杀 + zkb；没有的回 `[]`；测试也可以放读不懂的内容） */
  charKills = new Map<number, RawZkillKill[] | unknown>()
  charLosses = new Map<number, RawZkillKill[] | unknown>()
  /** 最近 7 天的列表（pastSeconds/604800）；没放的回 `[]` */
  weekKills = new Map<number, RawZkillKill[] | unknown>()
  weekLosses = new Map<number, RawZkillKill[] | unknown>()
  /** 路径匹配这个的请求回一个超大的响应（7 MB，比 KB 列表的 6 MB 上限大） */
  oversize: RegExp | null = null
  /** 路径匹配这个的请求一直不回应（连接保持到 stop） */
  hang: RegExp | null = null
  /** 下 N 个请求依次出的故障（用完恢复正常） */
  faults: ZkillFault[] = []
  private held: http.ServerResponse[] = []

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  stop() {
    this.held.splice(0).forEach((r) => r.destroy())
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  count(pattern: RegExp) {
    return this.requests.filter((r) => pattern.test(r.path)).length
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = req.url ?? ''
    this.times.push(Date.now())
    this.requests.push({ path, userAgent: req.headers['user-agent'], accept: req.headers.accept })
    const fault = this.faults.shift()
    if (fault) return this.fault(fault, res)
    if (this.hang?.test(path)) return void this.held.push(res)
    if (this.oversize?.test(path)) return this.fault({ kind: 'huge', bytes: 7 * 1024 * 1024 }, res)
    const m = /^\/api\/killID\/(\d+)\/$/.exec(path)
    if (m) return this.json(res, this.kills.has(Number(m[1])) ? [this.kills.get(Number(m[1]))] : [])
    const stats = /^\/api\/stats\/characterID\/(\d+)\/(kills\/)?$/.exec(path)
    if (stats) {
      if (this.redirectStats && !stats[2]) {
        res.statusCode = 302
        res.setHeader('Location', `/api/stats/characterID/${stats[1]}/kills/`)
        return void res.end()
      }
      return this.json(res, this.stats.get(Number(stats[1])) ?? {})
    }
    const list = /^\/api\/(kills|losses)\/characterID\/(\d+)\/(pastSeconds\/604800\/)?$/.exec(path)
    if (list) {
      const weekly = list[3] ? (list[1] === 'kills' ? this.weekKills : this.weekLosses) : null
      return this.json(res, (weekly ?? (list[1] === 'kills' ? this.charKills : this.charLosses)).get(Number(list[2])) ?? [])
    }
    if (this.routes.has(path)) return this.json(res, this.routes.get(path))
    res.statusCode = 404
    res.end('Not found')
  }

  private json(res: http.ServerResponse, value: unknown) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(value))
  }

  private fault(fault: ZkillFault, res: http.ServerResponse) {
    switch (fault.kind) {
      case 'status':
        res.statusCode = fault.status
        for (const [k, v] of Object.entries(fault.headers ?? {})) res.setHeader(k, v)
        return void res.end(fault.body ?? '')
      case 'rate-limit':
        res.statusCode = 429
        if (fault.retryAfter !== undefined) res.setHeader('Retry-After', String(fault.retryAfter))
        return void res.end('Too Many Requests')
      case 'challenge':
        res.statusCode = 403
        res.setHeader('Content-Type', 'text/html; charset=UTF-8')
        res.setHeader('cf-mitigated', 'challenge')
        return void res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>')
      case 'huge':
        res.setHeader('Content-Type', 'application/json')
        return void res.end(`[${'0,'.repeat(Math.ceil(fault.bytes / 2))}0]`)
      case 'raw':
        res.setHeader('Content-Type', 'application/json')
        return void res.end(fault.body)
      case 'hang':
        this.held.push(res)
    }
  }
}
