// NPC 空间站、星系、星域市场的数据源（§6.3.2）：按 (星域, 物品) 取全部页的订单，按地点过滤在本地做，
// 所以 Jita 和伏尔戈里的其他市场共用一次请求。不做整个星域的同步。
// - 同一个 (星域, 物品) 同时只请求一次（汇总层的 single-flight，按通道分开：交互请求加入后台请求时
//   要让 HTTP 层把它提到交互池，HTTP 层另有一层合并）；
// - 没过期的直接用，过期之前绝不重新请求（缓存时间以 ESI 为准）；
// - 每个调用方有自己的时限，到了就先回去，请求照样在后台做完、写进缓存；
// - 出错或超时时用 60 分钟内的旧数据（标出），再旧就算不可用。最近的订单放在模块级存储里，插件重载后还在。

import { REGION_ORDERS_STALE_MIN } from '../../constants'
import type { EsiApi, EsiLane, EsiRegionOrder } from '../esi'
import type { Clock, ModuleStore, Scheduler } from '../ports'
import type { SafeErrorInfo } from '../types'
import { LruCache, SingleFlight, withDeadline } from '../util'
import { errorInfo } from './errors'

export type RegionOrdersApi = Pick<EsiApi, 'regionOrders'>

export interface RegionBook {
  /** 这个星域里这个物品的全部订单（买卖都有） */
  orders: readonly EsiRegionOrder[]
  lastModified: number | null
  /** 最近一次确认（200 或 304）的时间 */
  validatedAt: number
  expiresAt: number
}

export type RegionRead =
  | { status: 'ok'; book: RegionBook }
  /** 出错或超时，用的是不超过 staleMs 的旧数据；error 是出错的原因（超时时没有） */
  | { status: 'stale'; book: RegionBook; error?: SafeErrorInfo }
  | { status: 'timeout' }
  | { status: 'unavailable'; error: SafeErrorInfo }

export interface RegionSourceOptions {
  api: RegionOrdersApi
  clock: Clock
  scheduler: Scheduler
  /** 出错时最多用多旧的数据（毫秒） */
  staleMs?: number
  /** 记住最近几组 (星域, 物品) 的订单（订单对象和 ESI 缓存共用，这里只多一个数组） */
  memory?: number
  /** 给了就把最近的订单放在这里（插件重载后超时、出错时照样有旧数据可用） */
  store?: ModuleStore
}

type Fetched = Extract<RegionRead, { status: 'ok' | 'stale' }>

const DEFAULT_MEMORY = 1024
export const REGION_BOOKS_KEY = 'market/region-books'

export class RegionSource {
  private readonly flights = new SingleFlight<string, Fetched>()
  private readonly last: LruCache<string, RegionBook>
  private readonly staleMs: number

  constructor(private readonly options: RegionSourceOptions) {
    this.staleMs = options.staleMs ?? REGION_ORDERS_STALE_MIN * 60_000
    const create = () => new LruCache<string, RegionBook>({ max: options.memory ?? DEFAULT_MEMORY })
    this.last = options.store ? options.store.get(REGION_BOOKS_KEY, create) : create()
  }

  /** 没过期的订单已经在手上（批量查价判断要不要发慢提示） */
  fresh(regionId: number, typeId: number): boolean {
    const book = this.last.peek(keyOf(regionId, typeId))
    return !!book && this.options.clock.now() < book.expiresAt
  }

  /** lane：比较用的报价走后台通道，不占交互请求的位置 */
  async read(regionId: number, typeId: number, deadlineMs: number, lane: EsiLane = 'interactive'): Promise<RegionRead> {
    const key = keyOf(regionId, typeId)
    const known = this.last.get(key)
    if (known && this.options.clock.now() < known.expiresAt) return { status: 'ok', book: known }
    try {
      const got = await withDeadline(this.fetch(key, regionId, typeId, lane), Math.max(0, deadlineMs), this.options.scheduler)
      if (got.done) return got.value
      return this.fallback(key) ?? { status: 'timeout' }
    } catch (e) {
      const error = errorInfo(e)
      return this.fallback(key, error) ?? { status: 'unavailable', error }
    }
  }

  private fetch(key: string, regionId: number, typeId: number, lane: EsiLane): Promise<Fetched> {
    return this.flights.run(`${key}:${lane}`, async () => {
      const result = await this.options.api.regionOrders(regionId, typeId, { lane, staleIfErrorMs: this.staleMs })
      const book: RegionBook = {
        orders: result.value,
        lastModified: result.lastModified,
        validatedAt: result.validatedAt,
        expiresAt: result.expiresAt,
      }
      if (!result.stale) {
        this.last.set(key, book)
        return { status: 'ok', book }
      }
      // ESI 出错，客户端退回了它的旧缓存；手上有更新的就用手上的
      const known = this.last.peek(key)
      const newer = known && known.validatedAt > book.validatedAt ? known : book
      const stale: Fetched = { status: 'stale', book: newer }
      if (result.error) stale.error = result.error.info()
      return stale
    })
  }

  private fallback(key: string, error?: SafeErrorInfo): Fetched | undefined {
    const known = this.last.peek(key)
    if (!known || this.options.clock.now() - known.validatedAt > this.staleMs) return undefined
    const stale: Fetched = { status: 'stale', book: known }
    if (error) stale.error = error
    return stale
  }
}

function keyOf(regionId: number, typeId: number): string {
  return `${regionId}:${typeId}`
}
