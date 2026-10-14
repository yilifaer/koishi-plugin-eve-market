// JaniceService：估价编号 → JaniceView。先看内存缓存（估价的价格创建时就定了，内容不会变，放 6 小时），
// 「没有这份估价」记 10 分钟，Janice 连不上记 30 秒；同一编号并发合并；价格乘上这份估价自己的比例
// （Janice 的接口返回 100% 的数字，比例只存着，网页显示时才乘）；物品中文名按 typeId 查词库。
// status() 只给 { configured, lastError }，不含密钥。

import {
  FAILURE_MEMO_SEC,
  JANICE_CACHE_HOURS,
  JANICE_CACHE_MAX,
  JANICE_CODE_RE,
  JANICE_NEGATIVE_CACHE_MIN,
} from '../../constants'
import type { Clock, Logger, Scheduler } from '../ports'
import type {
  CoreFailure, FailureCode, ItemInfo, JaniceDesignation, JaniceGetOptions, JanicePricing, JanicePricingVariant,
  JanicePrices, JaniceService, JaniceStatus, JaniceView,
} from '../types'
import { FailureMemo, LruCache, SingleFlight, withDeadline } from '../util'
import type { JaniceClient } from './client'
import { readAppraisal } from './shape'
import type { JaniceAppraisal, JaniceRawPrices } from './shape'

export interface JaniceServiceDeps {
  client: JaniceClient
  items: { byId(id: number): ItemInfo | undefined }
  clock: Clock
  scheduler: Scheduler
  logger: Logger
}

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
/** 比例的合法范围：(0, 10]，1 = 100% */
const MAX_PERCENTAGE = 10

const PRICINGS: readonly JanicePricing[] = ['buy', 'split', 'sell', 'purchase']
const VARIANTS: readonly JanicePricingVariant[] = ['immediate', 'top5percent']
const DESIGNATIONS: readonly JaniceDesignation[] = ['appraisal', 'wtb', 'wts']

function pick<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return allowed.find((a) => a === value) ?? null
}

/** 乘比例后向下取整到整 ISK；乘出来差一点点就是整数的（0.93 × 1000 = 930.0000000000001 一类）按整数算 */
function scaled(value: number, percentage: number): number {
  const x = value * percentage
  const near = Math.round(x)
  return Math.abs(x - near) < 1e-6 ? near : Math.floor(x)
}

function scaledPrices(p: JaniceRawPrices, percentage: number): JanicePrices {
  return { sell: scaled(p.sell, percentage), buy: scaled(p.buy, percentage), split: scaled(p.split, percentage) }
}

function failure(code: FailureCode, message: string): CoreFailure {
  return { ok: false, code, message }
}

/** 其他失败原样用 client 给的；只有「服务本身有问题」的才记进 lastError */
const SERVICE_ERRORS: ReadonlySet<FailureCode> = new Set(['JANICE_BAD_KEY', 'JANICE_BUSY', 'JANICE_DOWN', 'JANICE_BAD_RESPONSE'])

export function createJaniceService(deps: JaniceServiceDeps): JaniceService {
  return new Service(deps)
}

class Service implements JaniceService {
  private readonly cache: LruCache<string, JaniceView>
  private readonly notFound: LruCache<string, CoreFailure>
  private readonly down: FailureMemo<CoreFailure>
  private readonly flights = new SingleFlight<string, JaniceView | CoreFailure>()
  private lastError: JaniceStatus['lastError']

  constructor(private readonly deps: JaniceServiceDeps) {
    const now = () => deps.clock.now()
    this.cache = new LruCache({ max: JANICE_CACHE_MAX, ttlMs: JANICE_CACHE_HOURS * HOUR_MS, now })
    this.notFound = new LruCache({ max: JANICE_CACHE_MAX, ttlMs: JANICE_NEGATIVE_CACHE_MIN * MINUTE_MS, now })
    this.down = new FailureMemo(deps.clock, FAILURE_MEMO_SEC * 1000)
  }

  status(): JaniceStatus {
    return this.lastError
      ? { configured: this.deps.client.configured, lastError: { ...this.lastError } }
      : { configured: this.deps.client.configured }
  }

  async get(code: string, opts: JaniceGetOptions = {}): Promise<JaniceView | CoreFailure> {
    if (!this.deps.client.configured) return failure('NOT_CONFIGURED', 'Janice 密钥没有填')
    if (!JANICE_CODE_RE.test(code)) return failure('BAD_ARGUMENT', '估价编号格式不对')
    const hit = this.cache.get(code)
    if (hit) return hit
    const missing = this.notFound.get(code)
    if (missing) return missing
    const remembered = this.down.get()
    if (remembered) return remembered
    const flight = this.flights.run(code, () => this.load(code))
    if (opts.deadlineMs === undefined) return flight
    const waited = await withDeadline(flight, opts.deadlineMs, this.deps.scheduler)
    // 时限到了：读取在后台继续，结果写进缓存
    return waited.done ? waited.value : failure('DEADLINE', `${opts.deadlineMs} 毫秒内没有结果`)
  }

  private async load(code: string): Promise<JaniceView | CoreFailure> {
    const { client, clock } = this.deps
    const fetched = await client.fetchAppraisal(code)
    if (!fetched.ok) {
      if (fetched.code === 'JANICE_NOT_FOUND') this.notFound.set(code, fetched)
      else if (fetched.code === 'JANICE_DOWN' && !client.stopped) this.down.remember(fetched)
      if (SERVICE_ERRORS.has(fetched.code)) this.lastError = { code: fetched.code, at: clock.now() }
      return fetched
    }
    const appraisal = readAppraisal(fetched.json)
    if (!appraisal) {
      this.lastError = { code: 'JANICE_BAD_RESPONSE', at: clock.now() }
      this.deps.logger.warn('Janice 响应缺编号或价格，已忽略')
      return failure('JANICE_BAD_RESPONSE', '响应缺编号或价格')
    }
    this.lastError = undefined
    this.down.clear()
    const view = this.view(code, appraisal)
    this.cache.set(code, view)
    return view
  }

  private view(code: string, a: JaniceAppraisal): JaniceView {
    const valid = a.percentage !== null && a.percentage > 0 && a.percentage <= MAX_PERCENTAGE
    const percentage = valid ? a.percentage! : 1
    return {
      code,
      market: a.market,
      pricing: pick(PRICINGS, a.pricing),
      variant: pick(VARIANTS, a.variant),
      designation: pick(DESIGNATIONS, a.designation),
      percentage,
      percentageGuessed: !valid,
      totals: scaledPrices(a.totals, percentage),
      items: a.items.map((i) => ({
        typeId: i.typeId,
        en: i.en,
        zh: this.deps.items.byId(i.typeId)?.zh || null,
        amount: i.amount,
        prices: scaledPrices(i.totals, percentage),
      })),
      itemTypes: a.items.length,
      units: a.items.reduce((n, i) => n + i.amount, 0),
      packagedVolume: a.packagedVolume,
      datasetAt: a.datasetAt,
      expiresAt: a.expiresAt,
      failedLines: a.failedLines,
    }
  }
}
