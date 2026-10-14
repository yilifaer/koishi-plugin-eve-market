// 每日维护（11:00–11:30 UTC，北京时间 19:00 左右）：这段时间取不到价格时，整张卡片只写一句说明。

import { inDowntime } from '../../core/market'
import { QUOTE } from './text'

/** missing：这张卡片上有取不到的价格（缺价格、超时、市场不可用）；now 不写 = 不判断 */
export function downtimeWarnings(now: number | undefined, missing: boolean): string[] {
  return missing && now !== undefined && inDowntime(now) ? [QUOTE.downtimeNotice] : []
}
