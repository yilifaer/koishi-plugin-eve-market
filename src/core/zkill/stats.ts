// zKill 人物统计的宽松解析。字段名按 2026-10-14 的真实响应核对：缺字段、类型不对都当作没有，绝不抛异常。
// 人物简介（info.description）带链接和广告，一律不读、不保留。字段名猜错只改这一个文件和 ZKILL_STATS_PATH。

import { ZKILL_CHAR_KILLS_PATH, ZKILL_CHAR_LOSSES_PATH, ZKILL_STATS_PATH } from '../../constants'

export interface ZkillMonth {
  /** YYYY-MM */
  ym: string
  kills: number
  losses: number
  iskKilled: number
  iskLost: number
}

export interface ZkillGroupStat {
  groupId: number
  kills: number
  losses: number
}

/** 时区、位置、规模之类的标签统计，键是 zKill 的标签名（tz:eu、loc:w-space、solo、capital…） */
export interface ZkillLabelStat {
  kills: number
  losses: number
}

export interface ZkillStats {
  /** 响应里有可用的统计；`{}`、null、垃圾内容、从没上过 zKill 的人都是 false */
  present: boolean
  kills: number
  losses: number
  soloKills: number
  soloLosses: number
  iskKilled: number
  iskLost: number
  /** 0–100；没有时 null */
  danger: number | null
  gang: number | null
  avgGangSize: number | null
  /** 有记录的月份，按时间从早到晚 */
  months: ZkillMonth[]
  groups: ZkillGroupStat[]
  /** 全部时间最常击毁时驾驶的船（topAllTime 的 ship），击杀数从多到少 */
  topShips: Array<{ typeId: number; kills: number }>
  /** 全部时间最常出没的星系（topAllTime 的 system） */
  topSystems: Array<{ systemId: number; kills: number }>
  labels: Record<string, ZkillLabelStat>
  /** 近 7 天（activepvp）；没有时 null */
  week: { kills: number; ships: number; systems: number; regions: number } | null
  info: {
    name: string | null
    /** 毫秒 */
    birthday: number | null
    corporationId: number | null
    allianceId: number | null
    secStatus: number | null
  }
}

/** 人物 ID → 统计地址 */
export function zkillStatsPath(characterId: number): string {
  return ZKILL_STATS_PATH.replace('{id}', String(characterId))
}

export function zkillCharKillsPath(characterId: number): string {
  return ZKILL_CHAR_KILLS_PATH.replace('{id}', String(characterId))
}

export function zkillCharLossesPath(characterId: number): string {
  return ZKILL_CHAR_LOSSES_PATH.replace('{id}', String(characterId))
}

type Obj = Record<string, unknown>

function obj(v: unknown): Obj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** 数字或纯数字字符串；其他 null */
function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v)
  return null
}

/** 计数、金额：非负数，其他 0 */
function count(v: unknown): number {
  const n = numOrNull(v)
  return n !== null && n > 0 ? n : 0
}

function ratio(v: unknown): number | null {
  const n = numOrNull(v)
  return n === null ? null : Math.min(100, Math.max(0, n))
}

function id(v: unknown): number | null {
  const n = numOrNull(v)
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null
}

function parseTime(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const text = v.trim()
  // zKill 可能写 `2013-05-12 03:21:00`（UTC，没有时区），补成 ISO
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? `${text.replace(' ', 'T')}${text.length === 16 ? ':00' : ''}Z` : text
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function parseMonths(raw: unknown): ZkillMonth[] {
  const src = obj(raw)
  if (!src) return []
  const out = new Map<string, ZkillMonth>()
  for (const [key, value] of Object.entries(src)) {
    const m = obj(value)
    if (!m) continue
    let year = id(m.year)
    let month = id(m.month)
    const k = /^(\d{4})(\d{2})$/.exec(key)
    if (k) {
      year = Number(k[1])
      month = Number(k[2])
    }
    if (!year || !month || month > 12) continue
    const ym = `${year}-${String(month).padStart(2, '0')}`
    out.set(ym, {
      ym, kills: count(m.shipsDestroyed), losses: count(m.shipsLost), iskKilled: count(m.iskDestroyed), iskLost: count(m.iskLost),
    })
  }
  return [...out.values()].sort((a, b) => a.ym.localeCompare(b.ym))
}

function parseGroups(raw: unknown): ZkillGroupStat[] {
  const src = obj(raw)
  if (!src) return []
  const out: ZkillGroupStat[] = []
  for (const [key, value] of Object.entries(src)) {
    const g = obj(value)
    const groupId = id(g?.groupID) ?? id(key)
    if (!g || !groupId) continue
    out.push({ groupId, kills: count(g.shipsDestroyed), losses: count(g.shipsLost) })
  }
  return out
}

function topAllTime(raw: unknown, type: string, idKey: string): Array<{ id: number; kills: number }> {
  for (const entry of arr(raw)) {
    const e = obj(entry)
    if (!e || e.type !== type) continue
    const rows: Array<{ id: number; kills: number }> = []
    for (const row of arr(e.data)) {
      const r = obj(row)
      const rowId = id(r?.[idKey])
      if (r && rowId) rows.push({ id: rowId, kills: count(r.kills) })
    }
    return rows.sort((a, b) => b.kills - a.kills)
  }
  return []
}

/** 不能做对象键的名字（会改掉原型） */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function parseLabels(raw: unknown): Record<string, ZkillLabelStat> {
  const src = obj(raw)
  const out: Record<string, ZkillLabelStat> = {}
  if (!src) return out
  for (const [key, value] of Object.entries(src)) {
    const l = obj(value)
    if (l && /^[\w:+-]{1,32}$/.test(key) && !UNSAFE_KEYS.has(key)) out[key] = { kills: count(l.shipsDestroyed), losses: count(l.shipsLost) }
  }
  return out
}

function parseWeek(raw: unknown): ZkillStats['week'] {
  const a = obj(raw)
  if (!a) return null
  const pick = (key: string) => count(obj(a[key])?.count)
  const week = { kills: pick('kills'), ships: pick('ships'), systems: pick('systems'), regions: pick('regions') }
  return a.kills === undefined ? null : week
}

function parseInfo(raw: unknown): ZkillStats['info'] {
  const i = obj(raw)
  // 只读这几个字段；description 等其他内容一律丢掉
  return {
    name: typeof i?.name === 'string' && i.name.trim() ? i.name.trim().slice(0, 64) : null,
    birthday: parseTime(i?.birthday),
    corporationId: id(i?.corporationID),
    allianceId: id(i?.allianceID),
    secStatus: numOrNull(i?.secStatus),
  }
}

/** 空统计：没有记录的人，或解析不了的响应 */
export function emptyZkillStats(): ZkillStats {
  return {
    present: false, kills: 0, losses: 0, soloKills: 0, soloLosses: 0, iskKilled: 0, iskLost: 0,
    danger: null, gang: null, avgGangSize: null, months: [], groups: [], topShips: [], topSystems: [], labels: {}, week: null,
    info: { name: null, birthday: null, corporationId: null, allianceId: null, secStatus: null },
  }
}

/** 宽松解析：缺字段、类型不对都当没有，不抛异常 */
export function parseZkillStats(json: unknown): ZkillStats {
  const r = obj(json)
  if (!r || !Object.keys(r).length) return emptyZkillStats()
  const topShips = topAllTime(r.topAllTime, 'ship', 'shipTypeID')
  const fallbackShips = arr(r.topShips)
    .map((row) => obj(row))
    .map((row) => ({ id: id(row?.shipTypeID), kills: count(row?.kills) }))
    .filter((row): row is { id: number; kills: number } => row.id !== null && row.kills > 0)
    .sort((a, b) => b.kills - a.kills)
  const stats: ZkillStats = {
    present: true,
    kills: count(r.shipsDestroyed),
    losses: count(r.shipsLost),
    soloKills: count(r.soloKills),
    soloLosses: count(r.soloLosses),
    iskKilled: count(r.iskDestroyed),
    iskLost: count(r.iskLost),
    danger: ratio(r.dangerRatio),
    gang: ratio(r.gangRatio),
    avgGangSize: numOrNull(r.avgGangSize),
    months: parseMonths(r.months),
    groups: parseGroups(r.groups),
    topShips: (topShips.length ? topShips : fallbackShips).map((s) => ({ typeId: s.id, kills: s.kills })),
    topSystems: topAllTime(r.topAllTime, 'system', 'solarSystemID').map((s) => ({ systemId: s.id, kills: s.kills })),
    labels: parseLabels(r.labels),
    week: parseWeek(r.activepvp),
    info: parseInfo(r.info),
  }
  return stats
}
