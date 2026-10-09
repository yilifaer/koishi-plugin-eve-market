// 「服务器状态」（§2.12）：ESI /status 的在线人数、版本、开服时间、VIP 模式，再算出已运行多久和下一次例行维护。
// - 缓存时间以 ESI 的过期头为准（约 30 秒，见 core/esi 的路由）；请求失败的结果记 FAILURE_MEMO_SEC 秒，免得维护时人人都打一次 ESI；
// - 请求失败时最多用 5 分钟内的缓存，但维护时间里、或 ESI 回 503（服务器不在线）时不用：那时的「在线」是假的。

import { DAY_MS, DT_START_UTC, FAILURE_MEMO_SEC, QUERY_DEADLINE_MS } from '../../constants'
import type { EsiApi, EsiResult, EsiServerStatus } from '../esi'
import { isEsiError } from '../esi'
import { inDowntime } from '../market'
import type { Clock, Logger } from '../ports'
import type { CoreFailure, ServerStatus } from '../types'
import { FailureMemo, describeError } from '../util'

export type StatusEsi = Pick<EsiApi, 'serverStatus'>

export interface ServerStatusOptions {
  esi: StatusEsi
  clock: Clock
  logger?: Logger
  /** 默认 QUERY_DEADLINE_MS：到时间还没回来就按「连不上」回答，请求在后台做完、结果进缓存 */
  deadlineMs?: number
}

const DT_OFFSET_MS = (DT_START_UTC.hour * 60 + DT_START_UTC.minute) * 60_000
/** ESI 回这个状态码表示服务器不在线（维护或宕机） */
const OFFLINE_STATUS = 503

/** now 之后最近的一次例行维护（恰好在 11:00 时算明天的） */
export function nextDowntime(now: number): number {
  const today = Math.floor(now / DAY_MS) * DAY_MS + DT_OFFSET_MS
  return today > now ? today : today + DAY_MS
}

function unavailable(message: string): CoreFailure {
  return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message }
}

export class ServerStatusSource {
  private readonly failures: FailureMemo<CoreFailure>

  constructor(private readonly options: ServerStatusOptions) {
    this.failures = new FailureMemo(options.clock, FAILURE_MEMO_SEC * 1000)
  }

  async get(): Promise<ServerStatus | CoreFailure> {
    const remembered = this.failures.get()
    if (remembered) return remembered
    let result: EsiResult<EsiServerStatus>
    try {
      result = await this.options.esi.serverStatus({ deadlineMs: this.options.deadlineMs ?? QUERY_DEADLINE_MS })
    } catch (e) {
      return this.fail(e)
    }
    const now = this.options.clock.now()
    if (result.stale && (inDowntime(now) || result.error?.status === OFFLINE_STATUS)) return this.fail(result.error)
    this.failures.clear()
    const { value } = result
    return {
      players: value.players,
      serverVersion: value.serverVersion,
      startTime: value.startTime,
      vip: value.vip,
      dataTime: result.lastModified ?? result.validatedAt,
      uptimeSec: Math.max(0, Math.floor((now - value.startTime) / 1000)),
      nextDowntime: nextDowntime(now),
      stale: result.stale,
    }
  }

  private fail(error: unknown): CoreFailure {
    const detail = describeError(error)
    this.options.logger?.debug(`服务器状态取不到：${detail}`)
    // 调用方自己的时限到了（请求还在后台继续）不算失败，不记
    return this.failures.remember(unavailable(detail), !(isEsiError(error) && error.abandoned))
  }
}

export function createServerStatus(options: ServerStatusOptions): ServerStatusSource {
  return new ServerStatusSource(options)
}
