// 本机的假 Janice：真实的 HTTP 服务，测试把 janiceBase 指过来。按编号返回编造的估价 JSON；
// 可以注入 401 / 403 / 404 / 429（带或不带 Retry-After）/ 500 / 卡住 / 缺字段 / 超大响应。记录每个请求的头。
// 所有编号、价格、物品数量都是编造的。

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeItem {
  eid: number
  name: string
  amount: number
  /** 这一行的 sell / buy / split 小计（接口返回的数，已是估价的比例） */
  sell: number
  buy: number
  split: number
}

export interface RawJanice {
  id: number
  created: string
  expires: string
  datasetTime: string
  code: string | null
  designation: string
  pricing: string
  pricingVariant: string
  pricePercentage?: unknown
  comment: string | null
  isCompactized: boolean
  input: string | null
  failures: string | null
  market: { id: number; name: string }
  totalVolume: number
  totalPackagedVolume: number
  effectivePrices?: { totalBuyPrice: number; totalSplitPrice: number; totalSellPrice: number }
  items: unknown[]
  [key: string]: unknown
}

export const DEFAULT_ITEMS: FakeItem[] = [
  { eid: 34, name: 'Tritanium', amount: 1000, sell: 6000, buy: 5000, split: 5500 },
  { eid: 35, name: 'Pyerite', amount: 250, sell: 4000, buy: 3000, split: 3500 },
]

function rawItem(i: FakeItem) {
  const prices = (k: 'sell' | 'buy' | 'split') => ({
    [`${k}Price`]: i[k] / i.amount,
    [`${k}PriceTotal`]: i[k],
  })
  const block = { ...prices('buy'), ...prices('split'), ...prices('sell') }
  return {
    id: i.eid * 10,
    amount: i.amount,
    buyOrderCount: 3,
    buyVolume: 5000,
    sellOrderCount: 4,
    sellVolume: 8000,
    effectivePrices: block,
    immediatePrices: block,
    top5AveragePrices: block,
    totalVolume: i.amount * 0.01,
    totalPackagedVolume: i.amount * 0.01,
    itemType: { eid: i.eid, name: i.name, volume: 0.01, packagedVolume: 0.01 },
  }
}

/** 默认：Jita 4-4，buy 的即时价，100%，两种物品（总价 sell 10000 / buy 8000 / split 9000），没有认不出的行 */
export function rawJanice(code = 'AbC123', over: Partial<RawJanice> = {}, items: FakeItem[] = DEFAULT_ITEMS): RawJanice {
  const sum = (k: 'sell' | 'buy' | 'split') => items.reduce((n, i) => n + i[k], 0)
  return {
    id: 4242,
    created: '2026-10-14T10:00:00Z',
    expires: '2026-10-21T10:00:00Z',
    datasetTime: '2026-10-14T09:50:00Z',
    code,
    designation: 'appraisal',
    pricing: 'buy',
    pricingVariant: 'immediate',
    pricePercentage: 1,
    comment: 'made-up comment',
    isCompactized: false,
    input: 'made-up pasted text',
    failures: null,
    market: { id: 2, name: 'Jita 4-4' },
    totalVolume: 12.5,
    totalPackagedVolume: 12.5,
    effectivePrices: { totalBuyPrice: sum('buy'), totalSplitPrice: sum('split'), totalSellPrice: sum('sell') },
    immediatePrices: { totalBuyPrice: sum('buy'), totalSplitPrice: sum('split'), totalSellPrice: sum('sell') },
    top5AveragePrices: { totalBuyPrice: sum('buy'), totalSplitPrice: sum('split'), totalSellPrice: sum('sell') },
    items: items.map(rawItem),
    ...over,
  }
}

export type JaniceFault =
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'rate-limit'; retryAfter?: number }
  | { kind: 'huge'; bytes: number }
  | { kind: 'hang' }
  | { kind: 'raw'; body: string }

export interface JaniceLogEntry {
  path: string
  /** X-ApiKey 请求头 */
  apiKey: string | undefined
  userAgent: string | undefined
  accept: string | undefined
}

export class FakeJanice {
  server!: http.Server
  base = ''
  readonly requests: JaniceLogEntry[] = []
  /** 设了以后，只有带这个密钥的请求才算有效；其他的（含没带）估价和 /markets 都回 400（和真实的 Janice 一样）。不设 = 任何密钥都有效 */
  validKey?: string
  /** 编号 → 返回的内容；没有的回 400 + ProblemDetails */
  appraisals = new Map<string, unknown>()
  /** 下 N 个请求依次出的故障（用完恢复正常） */
  faults: JaniceFault[] = []
  /** 回应之前先等它（测慢提示：外面放行以后才回正常内容） */
  hold?: Promise<void>
  private held: http.ServerResponse[] = []

  async start() {
    this.server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  stop() {
    this.held.splice(0).forEach((r) => r.destroy())
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** 编造一份估价放进去 */
  add(code: string, over: Partial<RawJanice> = {}, items?: FakeItem[]) {
    this.appraisals.set(code, rawJanice(code, over, items))
    return this
  }

  count(pattern: RegExp = /./) {
    return this.requests.filter((r) => pattern.test(r.path)).length
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = req.url ?? ''
    const key = req.headers['x-apikey']
    this.requests.push({
      path,
      apiKey: Array.isArray(key) ? key.join(',') : key,
      userAgent: req.headers['user-agent'],
      accept: req.headers.accept,
    })
    await this.hold
    const fault = this.faults.shift()
    if (fault) return this.fault(fault, res)
    const keyOk = this.validKey === undefined || key === this.validKey
    if (!keyOk) return this.problem(res, 400, path)
    if (path === '/api/rest/v2/markets') return this.json(res, 200, [{ id: 2, name: 'Jita 4-4' }])
    const m = /^\/api\/rest\/v2\/appraisal\/([A-Za-z0-9]+)$/.exec(path)
    if (m && this.appraisals.has(m[1])) return this.json(res, 200, this.appraisals.get(m[1]))
    this.problem(res, 400, path)
  }

  private problem(res: http.ServerResponse, status: number, path: string) {
    this.json(res, status, { type: 'about:blank', title: 'Bad Request', status, detail: 'Bad Request', instance: path })
  }

  private json(res: http.ServerResponse, status: number, value: unknown) {
    res.statusCode = status
    res.setHeader('Content-Type', status === 200 ? 'application/json' : 'application/problem+json')
    res.end(JSON.stringify(value))
  }

  private fault(fault: JaniceFault, res: http.ServerResponse) {
    switch (fault.kind) {
      case 'status':
        res.statusCode = fault.status
        return void res.end(fault.body ?? '')
      case 'rate-limit':
        res.statusCode = 429
        if (fault.retryAfter !== undefined) res.setHeader('Retry-After', String(fault.retryAfter))
        return void res.end('Too Many Requests')
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
