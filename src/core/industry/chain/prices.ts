// 拆到原料的取价：整棵树的物品合成一份清单，材料市场只请求一次，成品市场另取，回退市场只补缺的。

import { CHAIN_QUERY_DEADLINE_MS } from '../../../constants'
import type { Access, IndustrySettings, MarketDef, MarketRegistry, PriceSide, TypeId } from '../../types'

export interface ChainUnit { unit: number; fallback: boolean; dataTime: number | null }

/** 一侧（材料或成品）的价格；和 service.ts 的 SidePrices 同形 */
export interface ChainSide {
  market?: MarketDef
  side: PriceSide
  units: Map<TypeId, ChainUnit>
  /** 配置的市场整个不能用（或者根本没有可用的市场） */
  unavailable: boolean
  fallback?: MarketDef
}

export interface ChainPriceBook { material: ChainSide; product: ChainSide }

/** 取一侧的价格（service 里的 priceSide，带着回退市场和时限） */
export type PriceSideFn = (
  market: MarketDef | undefined, fallback: MarketDef | undefined, side: PriceSide,
  wanted: Array<{ typeId: TypeId; qty: number }>, deadlineAt: number,
) => Promise<ChainSide>

export interface PriceDeps {
  markets: Pick<MarketRegistry, 'configured'>
  settings: Pick<IndustrySettings, 'materialPriceType' | 'productPriceType'>
  priceSide: PriceSideFn
  now(): number
}

/** 一次拆解用的价格：ids 是整棵树的物品（数量用不上，报价只看单价）；没赶上时限的物品是缺价格 */
export async function fetchChainPrices(
  deps: PriceDeps, access: Access, ids: Iterable<TypeId>, product: { typeId: TypeId; qty: number },
): Promise<ChainPriceBook> {
  const deadlineAt = deps.now() + CHAIN_QUERY_DEADLINE_MS
  const fallback = deps.markets.configured('industry.fallbackMarket', access)
  const wanted = [...ids].map((typeId) => ({ typeId, qty: 1 }))
  const [material, productSide] = await Promise.all([
    deps.priceSide(deps.markets.configured('industry.materialMarket', access), fallback, deps.settings.materialPriceType, wanted, deadlineAt),
    deps.priceSide(deps.markets.configured('industry.productMarket', access), fallback, deps.settings.productPriceType, [product], deadlineAt),
  ])
  return { material, product: productSide }
}

/** 材料市场的单价；没有价格时 null（任何情况下都不当成 0） */
export function unitOf(book: ChainPriceBook, typeId: TypeId): number | null {
  return book.material.units.get(typeId)?.unit ?? null
}
