// 人设和导语：规则表按顺序命中第一条（阈值在 constants 的 KB_ARCHETYPE_RULES），文案全在 copy/ 目录。
// 纯函数；同一个人同一天选到的标题、导语固定（hash(人物 ID + UTC 日期)），换天变化，也让成品缓存有效。

import { KB_ARCHETYPE_RULES as R, SHIP_GROUPS_CAPITAL, SHIP_GROUPS_INDUSTRIAL } from '../../constants'
import type { KbToneMode, PersonaId } from '../types'
import type { ZkillStats } from '../zkill'
import { MOOD_LINES, PERSONA_LINES } from './copy'
import type { MoodKey, ToneLines } from './copy'

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
  { id: 'pacifist', test: ({ stats: s, ageDays }) => s.kills === 0 && s.losses >= 1 && ageDays !== null && ageDays >= R.pacifistMinYears * 365 },
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

export type CopyKey =
  | 'name' | 'kills' | 'losses' | 'solo' | 'eff' | 'isk' | 'iskLost' | 'k7' | 'ship' | 'system' | 'region' | 'years'
  | 'gang' | 'danger' | 'avgGang' | 'bigKill' | 'bigKillIsk' | 'bigLoss' | 'bigLossIsk' | 'dormant' | 'peak'

/** 模板里能用的数据；缺的写 undefined，用到它的模板就跳过 */
export type CopyValues = Partial<Record<CopyKey, string>>

/** FNV-1a 32 位 */
export function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 拉丁字母 / 数字和汉字相邻时补一个空格（不碰中文标点） */
export function spaceCjk(text: string): string {
  return text.replace(/([A-Za-z0-9])(?=[\u4e00-\u9fff])|([\u4e00-\u9fff])(?=[A-Za-z0-9])/g, (_, a: string | undefined, b: string | undefined) => `${a ?? b} `)
}

/** 填模板；用到的数据缺了返回 null；中英文相邻处补空格 */
export function fillTemplate(template: string, values: CopyValues): string | null {
  let missing = false
  const text = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = values[key as keyof CopyValues]
    if (v === undefined) missing = true
    return v ?? ''
  })
  return missing ? null : spaceCjk(text)
}

/** 按语气取句子池：毒舌只取毒舌的，温和只取温和的，混合是两份接在一起 */
export function tonePool<T>(tone: KbToneMode, lines: ToneLines<readonly T[]>): readonly T[] {
  if (tone === 'snarky') return lines.snarky
  if (tone === 'gentle') return lines.gentle
  return [...lines.gentle, ...lines.snarky]
}

/**
 * 从模板里挑一句：先填模板（缺数据的跳过）、去掉这张卡上已经用过的句子，再按 seed 的 hash 选；一句都没有返回 null。
 * 选中的句子记进 used，保证同一张卡上不出现重复的句子
 */
export function chooseLine(templates: readonly string[], values: CopyValues, seed: string, used: Set<string>): string | null {
  const usable = templates.map((t) => fillTemplate(t, values)).filter((t): t is string => t !== null && !used.has(t))
  if (!usable.length) return null
  const line = usable[hash32(seed) % usable.length]
  used.add(line)
  return line
}

/** 标题和导语。dayKey 是 UTC 日期（YYYY-MM-DD） */
export function composeCopy(
  persona: PersonaId,
  characterId: number,
  dayKey: string,
  values: CopyValues,
  tone: KbToneMode = 'mixed',
  used: Set<string> = new Set(),
): { headline: string; lede: string } {
  const lines = PERSONA_LINES[persona]
  const pick = (kind: 'headlines' | 'ledes'): string =>
    // 每个人设每种语气都有只用 {name} 的模板（测试守着），所以不会是空的；万一空了退回名字
    chooseLine(tonePool(tone, { gentle: lines.gentle[kind], snarky: lines.snarky[kind] }), values, `${characterId}:${dayKey}:${kind}`, used) ?? values.name ?? ''
  return { headline: pick('headlines'), lede: pick('ledes') }
}

export interface MoodInput {
  weekKills: number | null
  /** 最近 KB_MONTHS 个月，从早到晚 */
  months: Array<{ kills: number; losses: number }>
  /** 近期大击杀、大损失的价值（没有时 null） */
  recentKillValue: number | null
  recentLossValue: number | null
}

/** 最近连续几个月没有记录 */
export function idleMonths(months: Array<{ kills: number; losses: number }>): number {
  let idle = 0
  while (idle < months.length && months[months.length - 1 - idle].kills + months[months.length - 1 - idle].losses === 0) idle++
  return idle
}

/** 近况属于哪一类，按顺序：本周火力全开 → 潜水 → 近日大击杀 → 近日大损失 */
export function pickMoodKey(input: MoodInput): MoodKey | null {
  if ((input.weekKills ?? 0) >= R.moodWeekKills) return 'hotWeek'
  if (input.months.length && idleMonths(input.months) >= R.moodDormantMonths) return 'dormant'
  if ((input.recentKillValue ?? 0) >= R.moodBigValue) return 'bigKill'
  if ((input.recentLossValue ?? 0) >= R.moodBigValue) return 'bigLoss'
  return null
}

/** 近况一句；没有可说的返回 null */
export function pickMood(input: MoodInput, values: CopyValues, tone: KbToneMode, seed: string, used: Set<string>): string | null {
  const key = pickMoodKey(input)
  return key ? chooseLine(tonePool(tone, MOOD_LINES[key]), values, `${seed}:mood`, used) : null
}
