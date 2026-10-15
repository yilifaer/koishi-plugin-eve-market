// 本报锐评：规则表 + 挑选。每条规则（和每个获得的称号）最多出一句，一张卡放 KB_REMARK_RULES.count 条（现在是 1 条）。
// 候选按具体程度分档（越具体越先上），同档按 hash(人物 ID + 日期 + 规则名) 排，所以同一个人同一天固定、隔天换。
// 句子在 copy/remarks.ts 和 copy/titles.ts；阈值在 constants 的 KB_REMARK_RULES。纯函数。

import {
  KB_REMARK_RULES as R,
  KB_TITLE_RULES as T,
  SHIP_GROUPS_CAPITAL,
  SHIP_GROUPS_CAPITAL_LOSS,
  SHIP_GROUPS_CHEAP,
  SHIP_GROUP_POD,
} from '../../constants'
import type { KbToneMode } from '../types'
import { REMARK_LINES, TITLE_COPY } from './copy'
import { groupLosses, labelLosses } from './facts'
import type { CardFacts } from './facts'
import { PERSONA_RULES, chooseLine, hash32, tonePool } from './persona'
import type { CopyValues } from './persona'
import type { AwardedTitle } from './titles'

interface RemarkRule {
  id: string
  /** 0 最具体 → 3 最泛 */
  tier: 0 | 2 | 3
  test(f: CardFacts): boolean
}

const records = (f: CardFacts) => f.stats.kills + f.stats.losses
const personaTest = (id: string) => PERSONA_RULES.find((r) => r.id === id)!.test
const fromPersona = (id: string) => (f: CardFacts) => personaTest(id)({ stats: f.stats, ageDays: f.ageDays, topShipGroup: f.topShipGroup })
const peakStartIn = (f: CardFacts, [lo, hi]: readonly [number, number]) => f.peak !== null && f.peak.beijingStart >= lo && f.peak.beijingStart <= hi

/** 顺序只影响同档同分时的稳定性；档位决定先上谁 */
export const REMARK_RULES: readonly RemarkRule[] = [
  { id: 'bigIsk10b', tier: 0, test: (f) => (f.recentKillValue ?? 0) >= R.bigKill10b },
  { id: 'bigIskLoss', tier: 0, test: (f) => f.stats.iskLost >= R.bigIskLoss },
  { id: 'capitalLoss', tier: 0, test: (f) => groupLosses(f.stats, SHIP_GROUPS_CAPITAL_LOSS) >= 1 },
  { id: 'awox', tier: 0, test: (f) => (f.stats.labels.awox?.kills ?? 0) + (f.stats.labels.awox?.losses ?? 0) > 0 },
  { id: 'npcDeaths', tier: 0, test: (f) => labelLosses(f.stats, 'npc') >= R.npcDeathsMin },
  { id: 'bigLossRecent', tier: 0, test: (f) => (f.recentLossValue ?? 0) >= R.bigRecent },
  { id: 'bigKillRecent', tier: 0, test: (f) => (f.recentKillValue ?? 0) >= R.bigRecent },
  { id: 'podded', tier: 2, test: (f) => groupLosses(f.stats, [SHIP_GROUP_POD]) >= Math.max(T.podMinCount, f.stats.losses * T.podShare) },
  { id: 'soloLosses', tier: 2, test: (f) => f.stats.soloLosses >= R.soloLossMin && f.stats.soloLosses >= f.stats.losses * R.soloLossShare },
  {
    id: 'highsecLosses',
    tier: 2,
    test: (f) => f.stats.losses >= R.highsecLossMin && labelLosses(f.stats, 'loc:highsec') >= f.stats.losses * R.highsecLossShare,
  },
  {
    id: 'cheapShips',
    tier: 2,
    test: (f) => f.stats.kills >= R.cheapShipsMinKills && f.topShipGroup !== null && SHIP_GROUPS_CHEAP.includes(f.topShipGroup),
  },
  { id: 'capitalPilot', tier: 2, test: (f) => f.topShipGroup !== null && SHIP_GROUPS_CAPITAL.includes(f.topShipGroup) },
  { id: 'industrialLosses', tier: 2, test: fromPersona('industrial') },
  { id: 'wormhole', tier: 2, test: fromPersona('wormhole') },
  { id: 'ganker', tier: 2, test: fromPersona('ganker') },
  {
    id: 'weekendWarrior',
    tier: 2,
    test: ({ stats: s }) => {
      if (s.activityDays.length !== 7) return false
      const total = s.activityDays.reduce((n, v) => n + v, 0)
      // 0 = 周日，6 = 周六
      return total >= R.weekendMinSamples && s.activityDays[0] + s.activityDays[6] >= total * R.weekendShare
    },
  },
  { id: 'nightOwl', tier: 2, test: (f) => peakStartIn(f, R.nightOwlStart) },
  { id: 'primeTime', tier: 2, test: (f) => peakStartIn(f, R.primeTimeStart) },
  { id: 'tinyGang', tier: 2, test: ({ stats: s }) => s.kills >= R.tinyGangMinKills && s.avgGangSize !== null && s.avgGangSize > 0 && s.avgGangSize <= R.tinyGangAvg },
  { id: 'dormant', tier: 2, test: (f) => f.dormantMonths >= R.dormantMonths },
  { id: 'hotWeek', tier: 2, test: ({ stats: s }) => (s.week?.kills ?? 0) >= R.hotWeekKills },
  { id: 'manyLosses', tier: 2, test: ({ stats: s }) => s.losses >= R.manyLosses },
  { id: 'manyKills', tier: 2, test: ({ stats: s }) => s.kills >= R.manyKills },
  { id: 'oldTimer', tier: 2, test: (f) => f.ageDays !== null && f.ageDays >= R.oldTimerYears * 365 },
  { id: 'newbie', tier: 2, test: (f) => f.ageDays !== null && f.ageDays < R.newbieDays },
  { id: 'noKills', tier: 2, test: ({ stats: s }) => s.kills === 0 && s.losses > 0 },
  { id: 'soloHeavy', tier: 2, test: ({ stats: s }) => s.soloKills >= R.soloHeavyMin && s.soloKills >= s.kills * R.soloHeavyShare },
  {
    id: 'blobber',
    tier: 2,
    test: ({ stats: s }) => s.kills >= R.blobberMinKills && ((s.gang ?? 0) >= R.blobberGang || (s.avgGangSize ?? 0) >= R.blobberAvgGang),
  },
  { id: 'highDanger', tier: 3, test: ({ stats: s }) => (s.danger ?? 0) >= R.highDanger && s.kills + s.losses >= R.dangerMinRecords },
  { id: 'lowDanger', tier: 3, test: ({ stats: s }) => s.danger !== null && s.danger <= R.lowDanger && s.kills + s.losses >= R.dangerMinRecords },
  { id: 'lowEff', tier: 3, test: (f) => f.stats.iskKilled + f.stats.iskLost > 0 && records(f) >= R.effMinRecords && eff(f) < R.lowEff },
  { id: 'highEff', tier: 3, test: (f) => f.stats.iskKilled + f.stats.iskLost > 0 && records(f) >= R.effMinRecords && eff(f) >= R.highEff },
  { id: 'lossesGtKills', tier: 3, test: ({ stats: s }) => s.losses > s.kills && s.losses >= R.lossesGtKillsMin },
  { id: 'expensiveLosses', tier: 3, test: ({ stats: s }) => s.iskLost > s.iskKilled && s.losses >= R.lossesGtKillsMin },
]

const eff = (f: CardFacts) => (f.stats.iskKilled / (f.stats.iskKilled + f.stats.iskLost)) * 100

/** 同一类话题只留一条：左边命中了，右边就不再出 */
const SUPERSEDES: Record<string, readonly string[]> = {
  bigIsk10b: ['bigKillRecent'],
  bigIskLoss: ['bigLossRecent', 'expensiveLosses'],
  capitalLoss: ['bigLossRecent'],
}

/** 获得的称号排在具体规则之后、泛泛的规则之前 */
const TITLE_TIER = 1

export interface RemarkContext {
  values: CopyValues
  tone: KbToneMode
  /** 人物 ID + UTC 日期，作为挑选的种子 */
  seed: string
  /** 这张卡上已经用过的句子 */
  used: Set<string>
}

/** 挑锐评。战绩暂缺、没有记录的人不挑（不拿数据不全的人开涮） */
export function pickRemarks(f: CardFacts, titles: AwardedTitle[], ctx: RemarkContext): string[] {
  if (f.persona === 'unknown' || f.persona === 'ghost') return []
  const matched = REMARK_RULES.filter((r) => r.test(f))
  const dropped = new Set(matched.flatMap((r) => SUPERSEDES[r.id] ?? []))
  const candidates: Array<{ id: string; tier: number; order: number; lines: readonly string[] }> = []
  for (const r of matched) {
    if (dropped.has(r.id)) continue
    candidates.push({ id: r.id, tier: r.tier, order: hash32(`${ctx.seed}:order:${r.id}`), lines: tonePool(ctx.tone, REMARK_LINES[r.id]) })
  }
  // 称号按得分顺序（不打乱）
  titles.forEach((t, i) => candidates.push({ id: `title:${t.id}`, tier: TITLE_TIER, order: i, lines: tonePool(ctx.tone, TITLE_COPY[t.id].remarks) }))
  candidates.sort((a, b) => a.tier - b.tier || a.order - b.order)

  const out: string[] = []
  for (const c of candidates) {
    if (out.length >= R.count) break
    const line = chooseLine(c.lines, ctx.values, `${ctx.seed}:remark:${c.id}`, ctx.used)
    if (line) out.push(line)
  }
  if (!out.length) {
    const line = chooseLine(tonePool(ctx.tone, REMARK_LINES.fallback), ctx.values, `${ctx.seed}:remark:fallback`, ctx.used)
    if (line) out.push(line)
  }
  return out
}
