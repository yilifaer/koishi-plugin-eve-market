// 打包体积和运费（§6.6）：
//   collateral = Σ qty × 基准市场出售价            （常见的运输合同做法）
//   contracts  = maxVolume > 0 ? max(1, ⌈体积 ÷ maxVolume⌉) : 1
//   fee        = 体积 × iskPerM3 + collateral × collateralPct / 100
//   landed     = 调整后总价 + fee                    （到货成本）
// 只在估价市场是基准市场时算，最多 MAX_FREIGHT_ROUTES 条，按路线的可见范围过滤。

import { MAX_FREIGHT_ROUTES } from '../../constants'
import type { Access, AppraisalResult, FreightRoute, ItemInfo } from '../types'

export type FreightLine = AppraisalResult['freight'][number]

/** 一种物品打包以后的体积（船按打包后的体积，数据里已经按 packagedVolume ?? volume 填好） */
export function packagedM3(item: ItemInfo, quantity: number): number {
  return quantity * item.packagedVolume
}

/** 本群能看到的路线，按表格顺序，最多 MAX_FREIGHT_ROUTES 条 */
export function visibleRoutes(routes: readonly FreightRoute[], access: Access): FreightRoute[] {
  return routes.filter((r) => r.visibility === 'public' || access.allowed).slice(0, MAX_FREIGHT_ROUTES)
}

export function contractsFor(volume: number, maxVolume: number): number {
  return maxVolume > 0 ? Math.max(1, Math.ceil(volume / maxVolume)) : 1
}

export interface FreightBasis {
  /** 打包体积（m³） */
  volume: number
  /** 押金：按基准市场出售价的合计 */
  collateral: number
  /** 调整后总价 */
  adjusted: number
}

export function freightFor(route: FreightRoute, basis: FreightBasis): FreightLine {
  const fee = basis.volume * route.iskPerM3 + basis.collateral * route.collateralPct / 100
  return { route: route.name, fee, contracts: contractsFor(basis.volume, route.maxVolume), landed: basis.adjusted + fee }
}
