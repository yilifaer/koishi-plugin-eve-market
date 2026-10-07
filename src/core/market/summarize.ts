// 订单 → 报价的两侧（§6.3.3、§6.3.4）。
// 卖单、买单都只算在这个地点的：空间站按 location_id（所有者选的口径：只算挂在本站的买单，不看射程），
// 星系按 system_id，星域和建筑不再过滤。买单还要 min_volume ≤ 数量。
// 没有的一侧是 null，绝不当成 0；中间价只在同一个市场两侧都有时才算。

import type { Side } from '../types'

/** 星域订单和建筑订单共有的字段（建筑订单没有 systemId） */
export interface MarketOrder {
  isBuyOrder: boolean
  price: number
  volumeRemain: number
  minVolume: number
  locationId: number
  systemId?: number
}

/** 按地点过滤；都不写 = 全部 */
export interface OrderScope {
  locationId?: number
  systemId?: number
}

export interface Summary {
  sell: Side | null
  buy: Side | null
  mid: number | null
}

class SideBuilder {
  private best = 0
  private volumeAtBest = 0
  private orders = 0
  private totalVolume = 0

  constructor(private readonly better: (a: number, b: number) => boolean) {}

  add(order: MarketOrder) {
    if (!this.orders || this.better(order.price, this.best)) {
      this.best = order.price
      this.volumeAtBest = 0
    }
    if (order.price === this.best) this.volumeAtBest += order.volumeRemain
    this.orders++
    this.totalVolume += order.volumeRemain
  }

  build(): Side | null {
    return this.orders ? { best: this.best, volumeAtBest: this.volumeAtBest, orders: this.orders, totalVolume: this.totalVolume } : null
  }
}

function inScope(order: MarketOrder, scope: OrderScope): boolean {
  if (scope.locationId !== undefined && order.locationId !== scope.locationId) return false
  return scope.systemId === undefined || order.systemId === scope.systemId
}

/** 坏数据（价格或剩余数量不是正数）不算，免得出现 0 ISK */
function usable(order: MarketOrder): boolean {
  return order.price > 0 && Number.isFinite(order.price) && order.volumeRemain > 0
}

export function summarize(orders: readonly MarketOrder[], scope: OrderScope = {}, qty = 1): Summary {
  const sell = new SideBuilder((a, b) => a < b)
  const buy = new SideBuilder((a, b) => a > b)
  for (const order of orders) {
    if (!usable(order) || !inScope(order, scope)) continue
    if (!order.isBuyOrder) sell.add(order)
    else if (order.minVolume <= qty) buy.add(order)
  }
  const s = sell.build()
  const b = buy.build()
  return { sell: s, buy: b, mid: s && b ? (s.best + b.best) / 2 : null }
}
