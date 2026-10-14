// PilotService.profile：ESI 的人物、军团、联盟，加 zKill 的统计（并行），统计之后再取击杀 / 损失两个列表
// （近期大击杀 / 大损失 + 作息，列表那一段有单独的时限，超时只丢这一段）。
// 只有 ESI 的人物信息取不到才算失败；zKill 取不到时返回带 partial 的资料。完整的资料缓存 KB_CARD_CACHE_MIN 分钟，
// 有缺项的不缓存（缺的部分很快会补上，不能让「暂时没取到」占一小时）。同一个人并发合并。

import {
  BEIJING_UTC_OFFSET_HOURS,
  KB_ACTIVITY_MIN_SAMPLES,
  KB_ACTIVITY_SPAN_HOURS,
  KB_BIRTHPLACE_WAIT_MS,
  KB_CACHE_MAX,
  KB_CARD_CACHE_MIN,
  KB_DEADLINE_MS,
  KB_LIST_CACHE_MIN,
  KB_MONTHS,
  KB_NEGATIVE_CACHE_MIN,
  KB_PLACES_MAX,
  KB_RECENT_DEADLINE_MS,
  KB_RECENT_MAX_DAYS,
  KB_SHIPS_MAX,
  KB_STATS_CACHE_MIN,
  ZKILL_LIST_MAX_BYTES,
  ZKILL_LIST_TIMEOUT_MS,
  ZKILL_STATS_MAX_BYTES,
  ZKILL_STATS_TIMEOUT_MS,
} from '../../constants'
import { isEsiError } from '../esi'
import type { EsiApi, EsiCharacter, EsiStation } from '../esi'
import { parseZkillKillList } from '../killmail'
import type { ZkillListKill } from '../killmail'
import type { Clock, Logger, Scheduler } from '../ports'
import { isFailure } from '../types'
import type {
  CoreFailure, ItemInfo, PersonaId, PilotActivity, PilotKill, PilotOptions, PilotPlace, PilotProfile, PilotRef, PilotShip,
  PilotZone, PriceFormatter, SystemView,
} from '../types'
import { LruCache, SingleFlight, describeError, withDeadline } from '../util'
import { emptyZkillStats, parseZkillStats, zkillCharKillsPath, zkillCharLossesPath, zkillStatsPath } from '../zkill'
import type { ZkillClient, ZkillFailure, ZkillStats } from '../zkill'
import { cleanTitle } from './clean'
import { composeCopy, pickMood, pickPersona } from './persona'
import type { CopyValues } from './persona'
import { ACTIVITY_TEXT, BIRTHPLACE_TEXT, FOOTER_TEXT, PERSONA_COPY, ZONE_NAMES } from './persona-text'

export interface PilotProfileDeps {
  esi: EsiApi
  zkill: ZkillClient
  items: { byId(id: number): ItemInfo | undefined }
  universe: { system(id: number): SystemView | undefined }
  format: Pick<PriceFormatter, 'compact'>
  clock: Clock
  scheduler: Scheduler
  logger: Logger
  /** 列表（近期大击杀 / 作息）最多等多久，默认 KB_RECENT_DEADLINE_MS（测试里调小） */
  recentDeadlineMs?: number
  /** 出生地最多等多久，默认 KB_BIRTHPLACE_WAIT_MS */
  birthplaceWaitMs?: number
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const ZONES: readonly PilotZone[] = ['au', 'eu', 'ru', 'use', 'usw']

const failure = (code: CoreFailure['code'], message: string, extra: Partial<CoreFailure> = {}): CoreFailure => ({ ok: false, code, message, ...extra })

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

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 最近 KB_MONTHS 个月（含本月）的 YYYY-MM，从早到晚 */
function recentMonths(now: number): string[] {
  const d = new Date(now)
  const out: string[] = []
  for (let k = KB_MONTHS - 1; k >= 0; k--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1))
    out.push(`${m.getUTCFullYear()}-${pad2(m.getUTCMonth() + 1)}`)
  }
  return out
}

/** 按小时（UTC）统计，找最活跃的连续 KB_ACTIVITY_SPAN_HOURS 小时；样本不够时用 zKill 的时区标签 */
function buildActivity(times: number[], stats: ZkillStats): PilotActivity | null {
  const rotate = (hours: number[]) => hours.map((_, h) => hours[(h - BEIJING_UTC_OFFSET_HOURS + 24) % 24])
  if (times.length >= KB_ACTIVITY_MIN_SAMPLES) {
    const hoursUtc = Array.from({ length: 24 }, () => 0)
    for (const t of times) hoursUtc[new Date(t).getUTCHours()]++
    let best = 0
    let bestSum = -1
    for (let start = 0; start < 24; start++) {
      let sum = 0
      for (let k = 0; k < KB_ACTIVITY_SPAN_HOURS; k++) sum += hoursUtc[(start + k) % 24]
      if (sum > bestSum) {
        bestSum = sum
        best = start
      }
    }
    const beijingStart = (best + BEIJING_UTC_OFFSET_HOURS) % 24
    const beijingEnd = (beijingStart + KB_ACTIVITY_SPAN_HOURS) % 24
    const utcEnd = (best + KB_ACTIVITY_SPAN_HOURS) % 24
    return {
      source: 'killmails',
      samples: times.length,
      hoursUtc,
      hoursBeijing: rotate(hoursUtc),
      peak: { beijingStart, beijingEnd, utcStart: best, utcEnd },
      zones: [],
      text: ACTIVITY_TEXT.peak(`${pad2(beijingStart)}:00`, `${pad2(beijingEnd)}:00`, best, utcEnd),
    }
  }
  const zones = ZONES
    .map((z) => ({ zone: z, n: (stats.labels[`tz:${z}`]?.kills ?? 0) + (stats.labels[`tz:${z}`]?.losses ?? 0) }))
    .filter((z) => z.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((z) => z.zone)
  if (!zones.length) return null
  const hoursUtc = Array.from({ length: 24 }, () => 0)
  return {
    source: 'labels',
    samples: times.length,
    hoursUtc,
    hoursBeijing: rotate(hoursUtc),
    peak: null,
    zones,
    text: ACTIVITY_TEXT.zones(zones.map((z) => ZONE_NAMES[z])),
  }
}

interface Lists {
  kills: ZkillListKill[] | null
  losses: ZkillListKill[] | null
}

export class PilotProfiles {
  private readonly cache: LruCache<string, PilotProfile>
  private readonly notCharacter: LruCache<number, true>
  private readonly flights = new SingleFlight<string, PilotProfile | CoreFailure>()

  constructor(private readonly deps: PilotProfileDeps) {
    const now = () => deps.clock.now()
    this.cache = new LruCache({ max: KB_CACHE_MAX, ttlMs: KB_CARD_CACHE_MIN * MINUTE_MS, now })
    this.notCharacter = new LruCache({ max: KB_CACHE_MAX, ttlMs: KB_NEGATIVE_CACHE_MIN * MINUTE_MS, now })
  }

  async profile(id: number, opts: PilotOptions = {}): Promise<PilotProfile | CoreFailure> {
    if (!Number.isSafeInteger(id) || id <= 0 || this.notCharacter.has(id)) return failure('NOT_A_CHARACTER', '这个 ID 不是人物')
    const recent = opts.recent !== false
    // 带近期数据的资料也满足不要近期数据的请求
    const hit = this.cache.get(`${id}:1`) ?? (recent ? undefined : this.cache.get(`${id}:0`))
    if (hit) return hit
    const flight = this.flights.run(`${id}:${recent ? 1 : 0}`, () => this.build(id, recent))
    const waited = await withDeadline(flight, opts.deadlineMs ?? KB_DEADLINE_MS, this.deps.scheduler)
    return waited.done ? waited.value : failure('DEADLINE', '时限到了，后台继续取')
  }

  private async build(id: number, recent: boolean): Promise<PilotProfile | CoreFailure> {
    try {
      return await this.assemble(id, recent)
    } catch (e) {
      this.deps.logger.warn('人物 %d 的资料组装失败：%s', id, describeError(e))
      return failure('UPSTREAM_UNAVAILABLE', describeError(e))
    }
  }

  // ------------------------------------------------------------------ 取数据

  private async assemble(id: number, recent: boolean): Promise<PilotProfile | CoreFailure> {
    const { esi, clock } = this.deps
    const statsJob = this.fetchStats(id)
    const char = await this.fetchCharacter(id)
    if (isFailure(char)) {
      if (char.code === 'NOT_A_CHARACTER') this.notCharacter.set(id, true)
      return char
    }
    const [corp, alliance, birth, zk] = await Promise.all([
      this.fetchRef(() => esi.corporation(char.corporationId), char.corporationId),
      char.allianceId === null ? Promise.resolve<PilotRef | null | undefined>(null) : this.fetchRef(() => esi.alliance(char.allianceId!), char.allianceId),
      this.birthplace(id),
      statsJob,
    ])
    const stats = zk.stats
    let lists: Lists | null = null
    if (recent && !zk.failure && stats.kills + stats.losses > 0) lists = await this.fetchLists(id)

    const now = clock.now()
    const partial: PilotProfile['partial'] = []
    if (zk.failure) partial.push('zkill')
    if (recent && !zk.failure && stats.kills + stats.losses > 0 && (!lists || !lists.kills || !lists.losses)) partial.push('recent')
    if (corp === undefined || alliance === undefined) partial.push('corp')
    if (birth.failed) partial.push('birthplace')
    return this.compose(id, char, { corp: corp ?? null, alliance: alliance ?? null }, birth.caption, zk, lists, partial, now)
  }

  private async fetchCharacter(id: number): Promise<EsiCharacter | CoreFailure> {
    try {
      return (await this.deps.esi.character(id)).value
    } catch (e) {
      if (isEsiError(e)) {
        if (e.kind === 'http' && (e.status === 404 || e.status === 400)) return failure('NOT_A_CHARACTER', '欧服没有这个人物')
        if (e.kind === 'deadline') return failure('DEADLINE', e.message)
      }
      return failure('UPSTREAM_UNAVAILABLE', describeError(e))
    }
  }

  /** 军团 / 联盟：取不到返回 undefined（调用方记 partial），不影响整张卡 */
  private async fetchRef(
    call: () => Promise<{ value: { name: string; ticker: string } }>,
    id: number,
  ): Promise<PilotRef | undefined> {
    try {
      const { name, ticker } = (await call()).value
      return { id, name, ...(ticker ? { ticker } : {}) }
    } catch (e) {
      this.deps.logger.debug('军团或联盟 %d 的信息取不到：%s', id, describeError(e))
      return undefined
    }
  }

  private async fetchStats(id: number): Promise<{ stats: ZkillStats; failure: CoreFailure | null; at: number }> {
    const { zkill, clock, logger } = this.deps
    const path = zkillStatsPath(id)
    const got = await zkill.getJson(path, {
      timeoutMs: ZKILL_STATS_TIMEOUT_MS,
      maxBytes: ZKILL_STATS_MAX_BYTES,
      ttlMs: KB_STATS_CACHE_MIN * MINUTE_MS,
      emptyTtlMs: KB_NEGATIVE_CACHE_MIN * MINUTE_MS,
    })
    if (!got.ok) {
      logger.debug('人物 %d 的 zKill 统计取不到：%s', id, got.kind)
      return { stats: emptyZkillStats(), failure: fromZkill(got), at: clock.now() }
    }
    return { stats: parseZkillStats(got.json), failure: null, at: clock.now() }
  }

  /** 击杀、损失两个列表：一起限时 recentDeadlineMs，哪个没取到哪个是 null */
  private async fetchLists(id: number): Promise<Lists> {
    const { zkill } = this.deps
    const one = async (path: string): Promise<ZkillListKill[] | null> => {
      const got = await zkill.getJson(path, {
        timeoutMs: ZKILL_LIST_TIMEOUT_MS,
        maxBytes: ZKILL_LIST_MAX_BYTES,
        ttlMs: KB_LIST_CACHE_MIN * MINUTE_MS,
        emptyTtlMs: KB_NEGATIVE_CACHE_MIN * MINUTE_MS,
        deadlineMs: this.deps.recentDeadlineMs ?? KB_RECENT_DEADLINE_MS,
      })
      if (!got.ok) return null
      try {
        return parseZkillKillList(got.json)
      } catch (e) {
        zkill.markBad(path, `响应格式不对：${describeError(e)}`)
        return null
      }
    }
    const [kills, losses] = await Promise.all([one(zkillCharKillsPath(id)), one(zkillCharLossesPath(id))])
    return { kills, losses }
  }

  /** 出生地：军团史里 record_id 最小的是新手军团 → 它的母港 → 站名（先中文再英文）。查不到写兜底说法 */
  private async birthplace(id: number): Promise<{ caption: string; failed: boolean }> {
    const { esi, scheduler, logger } = this.deps
    const fallback = { caption: BIRTHPLACE_TEXT.fallback, failed: false }
    const lookup = async (): Promise<{ caption: string; failed: boolean }> => {
      try {
        const history = (await esi.corporationHistory(id)).value
        if (!history.length) return fallback
        const first = history.reduce((a, b) => (b.recordId < a.recordId ? b : a))
        const home = (await esi.corporation(first.corporationId)).value.homeStationId
        if (home === null) return fallback
        let station: EsiStation | null = null
        try {
          station = (await esi.station(home, { language: 'zh' })).value
        } catch {
          station = null
        }
        if (!station?.name) station = (await esi.station(home)).value
        return station.name ? { caption: BIRTHPLACE_TEXT.at(station.name), failed: false } : fallback
      } catch (e) {
        // 404（军团或空间站已经不存在）是真的查不到；其他是暂时的，这份资料不缓存
        const missing = isEsiError(e) && e.kind === 'http' && e.status === 404
        logger.debug('人物 %d 的出生地查不到：%s', id, describeError(e))
        return { caption: BIRTHPLACE_TEXT.fallback, failed: !missing }
      }
    }
    const waited = await withDeadline(lookup(), this.deps.birthplaceWaitMs ?? KB_BIRTHPLACE_WAIT_MS, scheduler)
    return waited.done ? waited.value : { caption: BIRTHPLACE_TEXT.fallback, failed: true }
  }

  // ------------------------------------------------------------------ 组装

  private shipRef(typeId: number): { typeId: number; zh: string; en: string } {
    const item = this.deps.items.byId(typeId)
    return { typeId, zh: item?.zh ?? '', en: item?.en || `#${typeId}` }
  }

  /** 时间窗口内价值最高的一条；同价取最近的 */
  private pickBig(list: ZkillListKill[] | null, now: number): PilotKill | null {
    if (!list) return null
    const since = now - KB_RECENT_MAX_DAYS * DAY_MS
    let best: ZkillListKill | null = null
    for (const k of list) {
      if (k.value <= 0 || k.body.time < since) continue
      if (!best || k.value > best.value || (k.value === best.value && k.body.time > best.body.time)) best = k
    }
    if (!best) return null
    const typeId = best.body.victim.shipTypeId
    return {
      killId: best.killId,
      ship: typeId === null ? null : this.shipRef(typeId),
      system: this.deps.universe.system(best.body.systemId) ?? null,
      systemId: best.body.systemId,
      time: best.body.time,
      value: best.value,
    }
  }

  private compose(
    id: number,
    char: EsiCharacter,
    orgs: { corp: PilotRef | null; alliance: PilotRef | null },
    birthplace: string,
    zk: { stats: ZkillStats; failure: CoreFailure | null; at: number },
    lists: Lists | null,
    partial: PilotProfile['partial'],
    now: number,
  ): PilotProfile {
    const { format } = this.deps
    const stats = zk.stats
    const known = !zk.failure
    const totalKills = Math.max(stats.kills, stats.topShips.reduce((n, s) => n + s.kills, 0))

    const ships: PilotShip[] = stats.topShips.slice(0, KB_SHIPS_MAX).map((s) => ({
      ...this.shipRef(s.typeId),
      kills: s.kills,
      share: totalKills > 0 ? Math.round((s.kills / totalKills) * 100) : 0,
    }))
    const places: PilotPlace[] = stats.topSystems.slice(0, KB_PLACES_MAX).map((s) => ({
      system: this.deps.universe.system(s.systemId) ?? null,
      systemId: s.systemId,
      kills: s.kills,
    }))
    const byMonth = new Map(stats.months.map((m) => [m.ym, m]))
    const months = recentMonths(now).map((ym) => ({ ym, kills: byMonth.get(ym)?.kills ?? 0, losses: byMonth.get(ym)?.losses ?? 0 }))
    const traded = stats.iskKilled + stats.iskLost
    const efficiency = traded > 0 ? Math.round((stats.iskKilled / traded) * 1000) / 10 : null

    const recentKill = this.pickBig(lists?.kills ?? null, now)
    const recentLoss = this.pickBig(lists?.losses ?? null, now)
    const times = [...(lists?.kills ?? []), ...(lists?.losses ?? [])].map((k) => k.body.time)
    const activity = known ? buildActivity(times, stats) : null

    const ageDays = (now - char.birthday) / DAY_MS
    const topShipGroup = ships.length ? this.deps.items.byId(ships[0].typeId)?.groupId ?? null : null
    const persona: PersonaId = known ? pickPersona({ stats, ageDays, topShipGroup }) : 'unknown'

    const years = Math.floor(ageDays / 365)
    const place = places[0]?.system
    const values: CopyValues = { name: char.name }
    if (known) {
      Object.assign(values, { kills: String(stats.kills), losses: String(stats.losses), solo: String(stats.soloKills) })
      if (efficiency !== null) values.eff = `${Math.round(efficiency)}%`
      if (stats.iskKilled > 0) values.isk = format.compact(stats.iskKilled)
      if (stats.week) values.k7 = String(stats.week.kills)
      if (ships[0]) values.ship = ships[0].zh || ships[0].en
      if (place) {
        values.system = place.zh || place.en
        const region = place.region
        if (region) values.region = region.zh || region.en
      }
      if (years >= 1) values.years = String(years)
    }
    const dayKey = new Date(now).toISOString().slice(0, 10)
    const copy = composeCopy(persona, id, dayKey, values)
    const mood = persona === 'ghost' || persona === 'unknown'
      ? null
      : pickMood({
        weekKills: stats.week?.kills ?? null,
        months,
        recentKillValue: recentKill?.value ?? null,
        recentLossValue: recentLoss?.value ?? null,
        iskOf: (v) => format.compact(v),
      })

    const profile: PilotProfile = {
      id,
      name: char.name,
      birthday: char.birthday,
      security: char.securityStatus ?? stats.info.secStatus,
      title: cleanTitle(char.title),
      corporation: orgs.corp,
      alliance: orgs.alliance,
      birthplace,
      totals: {
        kills: stats.kills,
        losses: stats.losses,
        solo: stats.soloKills,
        iskKilled: stats.iskKilled,
        iskLost: stats.iskLost,
        danger: stats.danger,
        gang: stats.gang,
        efficiency,
      },
      week: stats.week,
      months,
      ships,
      places,
      activity,
      recentKill,
      recentLoss,
      persona,
      personaLabel: PERSONA_COPY[persona].label,
      headline: copy.headline,
      lede: copy.lede,
      mood,
      footer: FOOTER_TEXT,
      updatedAt: zk.at,
      partial,
      zkillFailure: zk.failure,
    }
    if (!partial.length) this.cache.set(`${id}:${lists ? 1 : 0}`, profile)
    return profile
  }
}
