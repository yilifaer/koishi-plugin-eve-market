// 提炼的纯公式（炼金术用）。

import { SCRAP_BASE, SCRAP_PER_LEVEL } from '../../constants'

export type ReprocessRounding = 'per-unit' | 'batch'

/** 废料处理技能 level 级的产出率：0.5 × (1 + 0.02 × L) */
export function scrapYield(level: number): number {
  return SCRAP_BASE * (1 + SCRAP_PER_LEVEL * level)
}

/** per-unit：每个单位先取整再乘个数（保守）；batch：整批一起取整 */
export function reprocessOut(qtyPerUnit: number, units: number, yieldFraction: number, mode: ReprocessRounding): number {
  // 先四舍五入到 9 位，免得 73 × 0.55 这类乘积差一点点被 floor 少算 1
  const exact = (n: number) => Math.floor(Number(n.toFixed(9)))
  return mode === 'per-unit' ? exact(qtyPerUnit * yieldFraction) * units : exact(qtyPerUnit * yieldFraction * units)
}
