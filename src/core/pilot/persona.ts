// 人设和导语：规则表按顺序命中第一条（阈值在 constants 的 KB_ARCHETYPE_RULES），文案全在 persona-text.ts。
// 纯函数；同一个人同一天选到的标题、导语固定（hash(人物 ID + UTC 日期)），换天变化，也让成品缓存有效。

import { KB_ARCHETYPE_RULES as R, SHIP_GROUPS_CAPITAL, SHIP_GROUPS_INDUSTRIAL } from '../../constants'
import type { PersonaId } from '../types'
import type { ZkillStats } from '../zkill'
import { MOOD_TEXT, PERSONA_COPY } from './persona-text'

export interface PersonaInput {
  stats: ZkillStats
  /** 建号天数；不知道时 null */
  ageDays: number | null
  /** 王牌座驾第一名的 groupId；不知道时 null */
  topShipGroup: number | null
}

interface Rule {
  id: PersonaId
  test(i: PersonaInput): boolean
}

const label = (s: ZkillStats, key: string) => s.labels[key]?.kills ?? 0

/** 顺序就是优先级 */
export const PERSONA_RULES: readonly Rule[] = [
  { id: 'ghost', test: ({ stats: s }) => s.kills + s.losses === 0 },
  { id: 'rookie', test: ({ stats: s, ageDays }) => (ageDays !== null && ageDays < R.rookieDays) || s.kills + s.losses < R.rookieMinRecords },
  {
    id: 'capital',
    test: ({ topShipGroup }) => topShipGroup !== null && SHIP_GROUPS_CAPITAL.includes(topShipGroup),
  },
  {
    id: 'industrial',
    test: ({ stats: s }) => {
      if (s.losses < R.industrialMinLosses || s.kills >= s.losses) return false
      const industrial = s.groups.filter((g) => SHIP_GROUPS_INDUSTRIAL.includes(g.groupId)).reduce((sum, g) => sum + g.losses, 0)
      return industrial >= s.losses * R.industrialLossShare
    },
  },
  { id: 'wormhole', test: ({ stats: s }) => s.kills >= R.wormholeMinKills && label(s, 'loc:w-space') >= s.kills * R.wormholeShare },
  { id: 'ganker', test: ({ stats: s }) => s.kills >= R.gankerMinKills && label(s, 'ganked') >= s.kills * R.gankerShare },
  { id: 'solo', test: ({ stats: s }) => s.soloKills >= R.soloMinKills && s.soloKills >= s.kills * R.soloShare },
  { id: 'fleet', test: ({ stats: s }) => (s.gang ?? 0) >= R.fleetGang && s.kills >= R.fleetMinKills },
  { id: 'reaper', test: ({ stats: s }) => (s.danger ?? 0) >= R.reaperDanger && s.kills >= R.reaperMinKills },
  { id: 'underdog', test: ({ stats: s }) => s.losses > s.kills && s.losses >= R.underdogMinLosses },
]

export function pickPersona(input: PersonaInput): PersonaId {
  return PERSONA_RULES.find((rule) => rule.test(input))?.id ?? 'pilot'
}

// ------------------------------------------------------------------ 文案

/** 模板里能用的数据；缺的写 undefined，用到它的模板就跳过 */
export type CopyValues = Partial<Record<'name' | 'kills' | 'losses' | 'solo' | 'eff' | 'isk' | 'k7' | 'ship' | 'system' | 'region' | 'years', string>>

/** FNV-1a 32 位 */
export function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 填模板；用到的数据缺了返回 null */
export function fillTemplate(template: string, values: CopyValues): string | null {
  let missing = false
  const text = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = values[key as keyof CopyValues]
    if (v === undefined) missing = true
    return v ?? ''
  })
  return missing ? null : text
}

function choose(templates: readonly string[], values: CopyValues, seed: string): string {
  const usable = templates.map((t) => fillTemplate(t, values)).filter((t): t is string => t !== null)
  // 每个人设都有只用 {name} 的模板（测试守着），所以 usable 不会是空的；万一空了退回名字
  return usable.length ? usable[hash32(seed) % usable.length] : values.name ?? ''
}

/** 标题和导语。dayKey 是 UTC 日期（YYYY-MM-DD） */
export function composeCopy(persona: PersonaId, characterId: number, dayKey: string, values: CopyValues): { headline: string; lede: string } {
  const copy = PERSONA_COPY[persona]
  return {
    headline: choose(copy.headlines, values, `${characterId}:${dayKey}:headline`),
    lede: choose(copy.ledes, values, `${characterId}:${dayKey}:lede`),
  }
}

export interface MoodInput {
  weekKills: number | null
  /** 最近 KB_MONTHS 个月，从早到晚 */
  months: Array<{ kills: number; losses: number }>
  /** 近期大击杀、大损失的价值（没有时 null） */
  recentKillValue: number | null
  recentLossValue: number | null
  /** 已经格式化好的 ISK */
  iskOf(value: number): string
}

/** 近况一句，按顺序：本周火力全开 → 潜水 → 近日大击杀 → 近日大损失 */
export function pickMood(input: MoodInput): string | null {
  if ((input.weekKills ?? 0) >= R.moodWeekKills) return MOOD_TEXT.hotWeek
  let idle = 0
  while (idle < input.months.length && input.months[input.months.length - 1 - idle].kills + input.months[input.months.length - 1 - idle].losses === 0) idle++
  const everActive = idle < input.months.length
  if (input.months.length && idle >= R.moodDormantMonths) return everActive ? MOOD_TEXT.dormant(idle) : MOOD_TEXT.dormantLong
  if ((input.recentKillValue ?? 0) >= R.moodBigValue) return fillTemplate(MOOD_TEXT.bigKill, { isk: input.iskOf(input.recentKillValue!) })
  if ((input.recentLossValue ?? 0) >= R.moodBigValue) return fillTemplate(MOOD_TEXT.bigLoss, { isk: input.iskOf(input.recentLossValue!) })
  return null
}
