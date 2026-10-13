// 自动挑建筑：排序和排序用的成本（纯函数）。

import type { IndustryResult } from '../types'
import type { AdjustedPrices } from './indices'

export interface Ranked<T> { item: T; cost: number; time: number; isDefault: boolean; row: number }

/** 成本按整 ISK 比（取整后相同算一样；逐对比差值的话传递性不成立，排序结果会看输入顺序） */
const whole = (cost: number) => Math.round(cost)

/** 成本升序（取整到 ISK 后相同算一样）→ 时间升序 → 默认建筑在前 → 行号升序 */
export function rankStructures<T>(list: readonly Ranked<T>[]): Ranked<T>[] {
  return [...list].sort((a, b) => {
    if (whole(a.cost) !== whole(b.cost)) return whole(a.cost) - whole(b.cost)
    return a.time - b.time || Number(b.isDefault) - Number(a.isDefault) || a.row - b.row
  })
}

/** 排序用的总成本：材料按市场价，缺了用调整价顶上（都没有按 0）+ 工作成本；不改结果卡上的数字 */
export function rankingCost(result: IndustryResult, adjusted: AdjustedPrices | null): number {
  const materials = result.materials.reduce(
    (sum, m) => sum + m.quantity * (m.unit ?? adjusted?.byType.get(m.item.typeId) ?? 0), 0)
  return materials + (result.jobCost?.total ?? 0)
}
