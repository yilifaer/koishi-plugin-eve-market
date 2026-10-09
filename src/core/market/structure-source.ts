// 建筑市场（有授权档案的那种）在价格服务里的接口。整站同步和订单簿在 structure.ts；
// 没有接上它时用 pendingStructures()：一律「需要授权」，群里看到的和授权异常同一句话。
// 授权档案留空的建筑不走这里，由价格服务从星域订单里按建筑 ID 过滤。

import type { MarketAvailability, MarketDef, MarketSourceStatus, QuoteReason, TypeId } from '../types'
import type { MarketOrder } from './summarize'

export type StructureRead =
  /** stale 时 reason 写明是同步异常还是正在刷新 */
  | { status: 'ok' | 'stale'; reason?: QuoteReason; orders: readonly MarketOrder[]; dataTime: number | null; detail?: string }
  | { status: 'unavailable' | 'auth_error' | 'not_ready'; reason: QuoteReason; detail?: string }

export interface StructureSource {
  /** 只读内存，不等 ESI。orders：这个物品在建筑里的全部订单（买卖都要），过滤和汇总由价格服务做 */
  read(market: MarketDef, typeId: TypeId): StructureRead
  available(market: MarketDef): MarketAvailability
  /** 有人查了：恢复暂停的同步；数据太旧时最多等 waitMs 毫秒 */
  touch(market: MarketDef, waitMs: number): Promise<void>
  /** 只重新同步其中已经过期或出错的 */
  resync(markets: readonly MarketDef[]): Promise<void>
  status(market: MarketDef): MarketSourceStatus
}

export function pendingStructures(): StructureSource {
  return {
    read: () => ({ status: 'not_ready', reason: 'needs_auth' }),
    available: () => ({ status: 'not_ready', reason: 'needs_auth' }),
    touch: async () => {},
    resync: async () => {},
    status: (market) => {
      const status: MarketSourceStatus = {
        marketKey: market.key,
        name: market.name,
        type: market.type,
        source: 'structure',
        state: 'NEEDS_AUTH',
        paused: false,
        lastRequestAt: null,
        lastSyncAt: null,
        lastSuccessAt: null,
        lastError: null,
        lastErrorAt: null,
        pages: null,
        orders: null,
      }
      if (market.authProfile) status.authProfile = market.authProfile
      return status
    },
  }
}
