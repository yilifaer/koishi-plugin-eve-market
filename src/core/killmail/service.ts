// KillService：击杀编号 → 摘要。先问 zKill 要 hash 和估值，再用 hash 向欧服接口取击杀详情，
// 最后查受害者和最后一击的名字（失败不影响摘要，名字写 null）。同一编号并发合并；成功的摘要放 24 小时；
// zKill 的 `[]`（没收录）和网络失败的缓存在 ZkillClient 里。

import {
  ABYSS_SYSTEM_PREFIX,
  KILL_CACHE_HOURS,
  KILL_CACHE_MAX,
  KILL_NAMES_WAIT_MS,
  KILL_NEGATIVE_CACHE_MIN,
  QUERY_DEADLINE_MS,
} from '../../constants'
import { isEsiError } from '../esi'
import type { EsiApi, EsiKillParty } from '../esi'
import type { Clock, Logger, Scheduler } from '../ports'
import type { CoreFailure, FailureCode, ItemInfo, KillOptions, KillParty, KillService, KillSummary, SystemView } from '../types'
import { relatedBrUrl } from '../universe'
import { LruCache, SingleFlight, describeError, withDeadline } from '../util'
import type { ZkillClient, ZkillFailure } from '../zkill'
import { parseZkillKill, zkillKillPath } from './zkill'

export interface KillServiceDeps {
  zkill: ZkillClient
  esi: EsiApi
  items: { byId(id: number): ItemInfo | undefined }
  universe: { system(id: number): SystemView | undefined }
  clock: Clock
  scheduler: Scheduler
  logger: Logger
  /** 查名字最多等多久，默认 KILL_NAMES_WAIT_MS（测试里调小） */
  namesWaitMs?: number
}

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

function failure(code: FailureCode, message: string, extra: Partial<CoreFailure> = {}): CoreFailure {
  return { ok: false, code, message, ...extra }
}

function fromZkill(f: ZkillFailure): CoreFailure {
  switch (f.kind) {
    case 'throttled':
    case 'blocked':
      return failure('ZKILL_THROTTLED', f.message, f.retryAt === undefined ? {} : { retryAt: f.retryAt })
    case 'deadline':
      return failure('DEADLINE', f.message)
    default:
      return failure('ZKILL_UNAVAILABLE', f.message)
  }
}

export function createKillService(deps: KillServiceDeps): KillService {
  return new Service(deps)
}

class Service implements KillService {
  private readonly cache: LruCache<number, KillSummary>
  private readonly flights = new SingleFlight<string, KillSummary | CoreFailure>()

  constructor(private readonly deps: KillServiceDeps) {
    this.cache = new LruCache({ max: KILL_CACHE_MAX, ttlMs: KILL_CACHE_HOURS * HOUR_MS, now: () => deps.clock.now() })
  }

  async summary(killId: number, opts: KillOptions = {}): Promise<KillSummary | CoreFailure> {
    if (!Number.isSafeInteger(killId) || killId <= 0) return failure('KILL_NOT_FOUND', '击杀编号不对')
    const hash = opts.hash ?? null
    // 带 hash 的结果没有估值，不进缓存，也不用缓存里的（那份有估值）
    if (!hash) {
      const hit = this.cache.get(killId)
      if (hit) return hit
    }
    const flight = this.flights.run(`${killId}:${hash ?? ''}`, () => this.build(killId, hash))
    const waited = await withDeadline(flight, opts.deadlineMs ?? QUERY_DEADLINE_MS, this.deps.scheduler)
    return waited.done ? waited.value : failure('DEADLINE', '时限到了，后台继续取')
  }

  relatedBrUrl(s: KillSummary): string | null {
    if (s.abyssal || !s.system?.region) return null
    return relatedBrUrl(s.systemId, s.time)
  }

  // ------------------------------------------------------------------ 取数据

  private async build(killId: number, userHash: string | null): Promise<KillSummary | CoreFailure> {
    const { zkill, esi, logger } = this.deps
    let hash = userHash
    let zkb: { value: number | null; npc: boolean; solo: boolean; awox: boolean } | null = null
    if (!hash) {
      const path = zkillKillPath(killId)
      const got = await zkill.getJson(path, { ttlMs: KILL_CACHE_HOURS * HOUR_MS, emptyTtlMs: KILL_NEGATIVE_CACHE_MIN * MINUTE_MS })
      if (!got.ok) return this.logged(killId, fromZkill(got))
      let parsed
      try {
        parsed = parseZkillKill(got.json, killId)
      } catch (e) {
        return this.logged(killId, fromZkill(zkill.markBad(path, `响应格式不对：${describeError(e)}`)))
      }
      if (parsed === 'not-found') return this.logged(killId, failure('KILL_NOT_FOUND', 'zKill 上没有这个击杀'))
      hash = parsed.hash
      zkb = parsed
    }

    let mail
    try {
      mail = (await esi.killmail(killId, hash)).value
    } catch (e) {
      return this.logged(killId, this.esiFailure(e, userHash !== null))
    }

    const final = mail.attackers.find((a) => a.finalBlow) ?? null
    const names = await this.names([mail.victim, ...(final ? [final] : [])])
    const summary: KillSummary = {
      killId,
      time: mail.time,
      system: this.deps.universe.system(mail.systemId) ?? null,
      systemId: mail.systemId,
      victim: this.party(mail.victim, names),
      attackers: mail.attackers.length,
      finalBlow: final ? this.party(final, names) : null,
      value: zkb?.value ?? null,
      flags: { npc: zkb?.npc ?? false, solo: zkb?.solo ?? false, awox: zkb?.awox ?? false },
      abyssal: String(mail.systemId).startsWith(ABYSS_SYSTEM_PREFIX),
    }
    if (!userHash) this.cache.set(killId, summary)
    logger.debug('击杀 %d 摘要已取到', killId)
    return summary
  }

  /** 失败写一行日志（只有编号和原因，不写 hash） */
  private logged(killId: number, f: CoreFailure): CoreFailure {
    this.deps.logger.debug('击杀 %d 取不到：%s %s', killId, f.code, f.message ?? '')
    return f
  }

  private esiFailure(e: unknown, hashFromUser: boolean): CoreFailure {
    if (isEsiError(e)) {
      if (e.kind === 'deadline') return failure('DEADLINE', e.message)
      // 用户给的 hash 对不上或没有这个击杀；zKill 给的 hash 欧服不认，是欧服那边的问题
      if (hashFromUser && e.kind === 'http' && (e.status === 404 || e.status === 422)) return failure('KILL_NOT_FOUND', '欧服接口没有这个击杀')
    }
    return failure('ESI_UNAVAILABLE', describeError(e))
  }

  // ------------------------------------------------------------------ 名字

  /** 受害者和最后一击的人物、军团、联盟名字；只等一小会儿，失败就都是未知 */
  private async names(parties: EsiKillParty[]): Promise<Map<number, string>> {
    const ids = [...new Set(parties.flatMap((p) => [p.characterId, p.corporationId, p.allianceId]).filter((id): id is number => id !== null))]
    const out = new Map<number, string>()
    if (!ids.length) return out
    try {
      const { value } = await this.deps.esi.names(ids, { deadlineMs: this.deps.namesWaitMs ?? KILL_NAMES_WAIT_MS })
      for (const n of value) out.set(n.id, n.name)
    } catch (e) {
      this.deps.logger.debug('击杀名字查不到，写未知：%s', describeError(e))
    }
    return out
  }

  private party(p: EsiKillParty, names: Map<number, string>): KillParty {
    const name = (id: number | null) => (id === null ? null : names.get(id) ?? null)
    return {
      character: name(p.characterId),
      corporation: name(p.corporationId),
      alliance: name(p.allianceId),
      shipTypeId: p.shipTypeId,
      ship: p.shipTypeId === null ? null : this.deps.items.byId(p.shipTypeId) ?? null,
    }
  }
}
