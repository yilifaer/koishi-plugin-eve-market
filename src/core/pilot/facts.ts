// 称号和锐评判断用的事实：从 zKill 统计和资料里整理出来的一份只读数据。

import type { PersonaId } from '../types'
import type { ZkillStats } from '../zkill'

export interface CardFacts {
  stats: ZkillStats
  /** 建号天数；不知道时 null */
  ageDays: number | null
  persona: PersonaId
  /** 王牌座驾第一名的 groupId；不知道时 null */
  topShipGroup: number | null
  /** 王牌座驾（topAllTime）按船组合并后的击毁次数，从多到少 */
  shipGroups: Array<{ groupId: number; kills: number }>
  /** 全部击毁次数（分母）：统计里的击毁数和座驾次数之和取大的 */
  totalKills: number
  /** 最近连续几个月没有记录；不知道月度数据时 0 */
  dormantMonths: number
  /** 最活跃时段（北京时间整点）；只有时区标签或没有数据时 null */
  peak: { beijingStart: number; beijingEnd: number } | null
  recentKillValue: number | null
  recentLossValue: number | null
}

/** 一组船组在损失里的次数 */
export function groupLosses(stats: ZkillStats, groupIds: readonly number[]): number {
  return stats.groups.filter((g) => groupIds.includes(g.groupId)).reduce((n, g) => n + g.losses, 0)
}

/** 一组标签在击毁里的次数 */
export function labelKills(stats: ZkillStats, ...keys: string[]): number {
  return keys.reduce((n, k) => n + (stats.labels[k]?.kills ?? 0), 0)
}

/** 一组标签在损失里的次数 */
export function labelLosses(stats: ZkillStats, ...keys: string[]): number {
  return keys.reduce((n, k) => n + (stats.labels[k]?.losses ?? 0), 0)
}

/** 北京时间最活跃时段文案：结束为 0 点写 24，其余跨零点写「22–次日1 点」 */
export function formatPeak(beijingStart: number, beijingEnd: number): string {
  if (beijingEnd === 0) return `${beijingStart}–24 点`
  if (beijingEnd < beijingStart) return `${beijingStart}–次日${beijingEnd} 点`
  return `${beijingStart}–${beijingEnd} 点`
}
