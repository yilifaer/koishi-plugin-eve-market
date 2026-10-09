// HistoryService（§6.8 的数据部分）：ESI 的星域成交历史，每天一行。
// - 按 (星域, 物品) 缓存，缓存时间和出错时用多旧的数据以 ESI 客户端的路由设置为准；
// - PLEX 这类全局市场物品总是用全局市场星域；
// - 多个物品（植入体套装）按日期对齐后相加，缺件的日子不算；成交额按件算好再相加；完全没有历史的物品列进 missing；
// - 窗口是最近 days 个 UTC 日（含今天）。

import { DAY_MS, GLOBAL_MARKET_REGION, GLOBAL_MARKET_TYPES } from '../../constants'
import { isEsiError } from '../esi'
import type { EsiApi, EsiHistoryDay, EsiResult } from '../esi'
import type { Clock } from '../ports'
import type { CoreFailure, HistoryPoint, HistoryResult, HistoryService, TypeId } from '../types'
import { inDowntime } from './downtime'
import { errorDetail, errorInfo } from './errors'

export type HistoryApi = Pick<EsiApi, 'history'>

export interface HistoryServiceOptions {
  esi: HistoryApi
  clock: Clock
}

/** ESI 给大约 13 个月 */
export const MAX_HISTORY_DAYS = 400

function failure(code: CoreFailure['code'], message: string): CoreFailure {
  return { ok: false, code, message }
}

function regionFor(regionId: number, typeId: TypeId): number {
  return GLOBAL_MARKET_TYPES.includes(typeId) ? GLOBAL_MARKET_REGION : regionId
}

/** 窗口的第一天（YYYY-MM-DD，UTC） */
export function windowStart(now: number, days: number): string {
  const today = Math.floor(now / DAY_MS) * DAY_MS
  return new Date(today - (days - 1) * DAY_MS).toISOString().slice(0, 10)
}

/** 物品不存在于这个星域的历史里时 ESI 回 404：当作没有成交，不算出错 */
function isNoHistory(error: unknown): boolean {
  return isEsiError(error) && error.kind === 'http' && error.status === 404
}

/**
 * 各件按日期对齐后相加，只留每一件都有成交的日子。
 * 成交额（turnover）是各件的 volume × average 之和：相加后的成交量乘相加后的均价会多算好几倍
 */
export function sumByDate(series: ReadonlyArray<readonly EsiHistoryDay[]>): HistoryPoint[] {
  if (!series.length) return []
  const sums = new Map<string, Required<HistoryPoint> & { parts: number }>()
  for (const days of series) {
    for (const d of days) {
      const sum = sums.get(d.date)
      if (!sum) {
        sums.set(d.date, { ...d, turnover: d.volume * d.average, parts: 1 })
        continue
      }
      sum.average += d.average
      sum.highest += d.highest
      sum.lowest += d.lowest
      sum.volume += d.volume
      sum.orderCount += d.orderCount
      sum.turnover += d.volume * d.average
      sum.parts++
    }
  }
  return [...sums.values()]
    .filter((s) => s.parts === series.length)
    .map(({ parts: _, ...point }) => point)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

class History implements HistoryService {
  constructor(private readonly options: HistoryServiceOptions) {}

  async get(regionId: number, typeIds: TypeId[], days: number): Promise<HistoryResult | CoreFailure> {
    const ids = [...new Set(typeIds)]
    if (!Number.isSafeInteger(regionId) || regionId <= 0) return failure('BAD_ARGUMENT', `星域 ID 不对：${regionId}`)
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) return failure('BAD_ARGUMENT', '物品 ID 不对')
    if (!Number.isInteger(days) || days < 1 || days > MAX_HISTORY_DAYS) return failure('BAD_ARGUMENT', `天数要在 1–${MAX_HISTORY_DAYS} 之间`)

    const settled = await Promise.allSettled(ids.map((id) => this.options.esi.history(regionFor(regionId, id), id)))
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected' && !isNoHistory(s.reason))
    if (failed) return failure('UPSTREAM_UNAVAILABLE', errorDetail(errorInfo(failed.reason)))

    const now = this.options.clock.now()
    const from = windowStart(now, days)
    const found: Array<EsiResult<EsiHistoryDay[]>> = []
    const missing: TypeId[] = []
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled' && s.value.value.length) found.push(s.value)
      else missing.push(ids[i])
    })
    if (!found.length) return failure('NO_HISTORY', '这些物品在这个星域没有成交历史')

    const modified = found.map((r) => r.lastModified).filter((t): t is number => t !== null)
    const result: HistoryResult = {
      points: sumByDate(found.map((r) => r.value.filter((d) => d.date >= from))),
      missing,
      lastModified: modified.length ? Math.max(...modified) : null,
      stale: found.some((r) => r.stale),
    }
    if (result.stale && inDowntime(now)) result.downtime = true
    return result
  }
}

export function createHistoryService(options: HistoryServiceOptions): HistoryService {
  return new History(options)
}
