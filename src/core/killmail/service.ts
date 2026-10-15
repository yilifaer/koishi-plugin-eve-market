// KillService：击杀编号 → 摘要。先问 zKill 要击杀正文、hash 和估值（响应里没有正文才用 hash 向欧服接口取击杀详情），
// 最后查受害者和最后一击的名字（失败不影响摘要，名字写 null）。同一编号并发合并；成功的摘要放 24 小时；
// zKill 的 `[]`（没收录）和网络失败的缓存在 ZkillClient 里。

import {
  ABYSS_SYSTEM_PREFIX,
  DEADLINE_GUARD_MS,
  KILL_CACHE_HOURS,
  KILL_BR_WINDOW_MIN,
  KILL_CACHE_MAX,
  KILL_ZKILL_MAX_BYTES,
  KILL_NAMES_WAIT_MS,
  KILL_NEGATIVE_CACHE_MIN,
  QUERY_DEADLINE_MS,
} from '../../constants'
import { isEsiError } from '../esi'
import type { EsiApi, EsiKillParty, EsiKillmail } from '../esi'
import type { Clock, Logger, Scheduler } from '../ports'
import type { CoreFailure, FailureCode, ItemInfo, KillOptions, KillParty, KillService, KillSummary, SystemView } from '../types'
import { checkBuiltinUrl } from '../sites'
import { parseBrLink, relatedBrUrl } from '../universe'
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
/** 已解析的 zKill 击杀暂存：条数少、时间短 */
const PARSED_MAX = 20
const PARSED_MINUTES = 10
/** 时限快到了也至少给名字这么久 */
const MIN_NAMES_WAIT_MS = 300

const p2 = (n: number) => String(n).padStart(2, '0')

/** UTC，精确到分钟（秒向下取整）：YYYYMMDDHHmm */
function minuteStamp(ms: number): string | null {
  const d = new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS)
  const year = d.getUTCFullYear()
  if (!(year >= 1000 && year <= 9999)) return null
  return `${year}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`
}

/** Warbeacon 的时间范围写法：击杀时间前后各 KILL_BR_WINDOW_MIN 分钟；拼完过一遍网站规则 */
function warbeaconUrl(systemId: number, timeMs: number): string | null {
  if (!Number.isInteger(systemId) || !/^\d{8}$/.test(String(systemId)) || !Number.isFinite(timeMs)) return null
  const start = minuteStamp(timeMs - KILL_BR_WINDOW_MIN * MINUTE_MS)
  const end = minuteStamp(timeMs + KILL_BR_WINDOW_MIN * MINUTE_MS)
  if (!start || !end) return null
  return checkBuiltinUrl('warbeacon', `https://warbeacon.net/br/related/${systemId}/${start}/${end}/`)
}

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
  /** zKill 已解析但 ESI 还没取成功的击杀：短时间内重试不再问 zKill（原始 JSON 不缓存） */
  private readonly parsedMails: LruCache<number, Exclude<ReturnType<typeof parseZkillKill>, 'not-found'>>
  private readonly flights = new SingleFlight<string, KillSummary | CoreFailure>()

  constructor(private readonly deps: KillServiceDeps) {
    this.parsedMails = new LruCache({ max: PARSED_MAX, ttlMs: PARSED_MINUTES * MINUTE_MS, now: () => deps.clock.now() })
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
    const deadlineMs = opts.deadlineMs ?? QUERY_DEADLINE_MS
    const deadlineAt = this.deps.clock.now() + deadlineMs
    const flight = this.flights.run(`${killId}:${hash ?? ''}`, () => this.build(killId, hash, deadlineAt))
    const waited = await withDeadline(flight, deadlineMs, this.deps.scheduler)
    return waited.done ? waited.value : failure('DEADLINE', '时限到了，后台继续取')
  }

  relatedBrUrl(s: KillSummary): string | null {
    return this.relatedUrls(s).br
  }

  relatedUrls(s: KillSummary): { br: string | null; warbeacon: string | null } {
    if (s.abyssal || !s.system?.region) return { br: null, warbeacon: null }
    const br = relatedBrUrl(s.systemId, s.time)
    return { br: br ? parseBrLink(br)?.url ?? null : null, warbeacon: warbeaconUrl(s.systemId, s.time) }
  }

  // ------------------------------------------------------------------ 取数据

  private async build(killId: number, userHash: string | null, deadlineAt: number): Promise<KillSummary | CoreFailure> {
    const { zkill, esi, logger } = this.deps
    let hash = userHash
    let zkb: { value: number | null; npc: boolean; solo: boolean; awox: boolean } | null = null
    let mail: EsiKillmail | null = null
    if (!hash) {
      let parsed = this.parsedMails.get(killId)
      if (!parsed) {
        const path = zkillKillPath(killId)
        const got = await zkill.getJson(path, {
          // 原始 JSON 不缓存（最大 2 MB），摘要由本服务缓存；只留空结果的负缓存
          emptyTtlMs: KILL_NEGATIVE_CACHE_MIN * MINUTE_MS,
          maxBytes: KILL_ZKILL_MAX_BYTES,
        })
        if (!got.ok) return this.logged(killId, fromZkill(got))
        let result
        try {
          result = parseZkillKill(got.json, killId)
        } catch (e) {
          return this.logged(killId, fromZkill(zkill.markBad(path, `响应格式不对：${describeError(e)}`)))
        }
        if (result === 'not-found') return this.logged(killId, failure('KILL_NOT_FOUND', 'zKill 上没有这个击杀'))
        parsed = result
        this.parsedMails.set(killId, parsed)
      }
      hash = parsed.hash
      zkb = parsed
      mail = parsed.body
    }

    // zKill 已经给了完整击杀就不问欧服接口，只查名字；老格式或欧服链接才去取
    if (!mail) {
      try {
        mail = (await esi.killmail(killId, hash)).value
      } catch (e) {
        return this.logged(killId, this.esiFailure(e, userHash !== null))
      }
    }

    const final = mail.attackers.find((a) => a.finalBlow) ?? null
    const { names, complete } = await this.names([mail.victim, ...(final ? [final] : [])], deadlineAt)
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
    // 名字没查全就不缓存，免得慢一次就整天显示未知
    if (!userHash && complete) {
      this.cache.set(killId, summary)
      this.parsedMails.delete(killId)
    }
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

  /** 受害者和最后一击的人物、军团、联盟名字；最多等 KILL_NAMES_WAIT_MS，但不能拖过整张卡的时限，失败就都是未知 */
  private async names(parties: EsiKillParty[], deadlineAt: number): Promise<{ names: Map<number, string>; complete: boolean }> {
    const ids = [...new Set(parties.flatMap((p) => [p.characterId, p.corporationId, p.allianceId]).filter((id): id is number => id !== null))]
    const out = new Map<number, string>()
    if (!ids.length) return { names: out, complete: true }
    const left = deadlineAt - this.deps.clock.now() - DEADLINE_GUARD_MS
    const deadlineMs = Math.max(MIN_NAMES_WAIT_MS, Math.min(this.deps.namesWaitMs ?? KILL_NAMES_WAIT_MS, left))
    try {
      const { value } = await this.deps.esi.names(ids, { deadlineMs })
      for (const n of value) out.set(n.id, n.name)
    } catch (e) {
      this.deps.logger.debug('击杀名字查不到，写未知：%s', describeError(e))
    }
    return { names: out, complete: ids.every((id) => out.has(id)) }
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
