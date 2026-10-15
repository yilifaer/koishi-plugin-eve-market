// 称号：按 zKill 统计给每个人最多 KB_TITLES_MAX 个。船型称号看某类船的出场占比，损失类称号看损失的构成。
// 每个称号算一个分数（占比），分数高的优先，同分按下面表里的顺序。纯函数，阈值在 constants。

import {
  KB_LABELS_GANG10,
  KB_TITLES_MAX,
  KB_TITLE_RULES as R,
  KB_TITLE_SHIP_GROUPS,
  SHIP_GROUPS_FREIGHTER,
  SHIP_GROUPS_MINER,
  SHIP_GROUPS_ROOKIE,
  SHIP_GROUP_POD,
} from '../../constants'
import { TITLE_COPY } from './copy'
import { groupLosses, labelKills, labelLosses } from './facts'
import type { CardFacts } from './facts'

export interface AwardedTitle {
  id: string
  label: string
  /** 排序用的分数（占比，0–1） */
  score: number
}

/** 损失类称号：返回分数，不满足返回 null；losses 是总损失（大于 0） */
type LossTest = (f: CardFacts, losses: number) => number | null

const LOSS_TITLES: Array<[string, LossTest]> = [
  // 带诱导的损失：次数够，或损失不少时占比够
  ['cyno', (f, losses) => {
    const n = f.stats.cyno.count
    return n >= R.cynoMinCount || (losses >= Math.max(R.cynoShareMinLosses, R.shareMinLosses) && n >= losses * R.cynoShare) ? Math.min(1, n / losses) : null
  }],
  ['bait', (f, losses) => {
    const n = labelLosses(f.stats, ...KB_LABELS_GANG10)
    return losses >= R.baitMinLosses && n >= losses * R.baitShare ? n / losses : null
  }],
  ['pod', (f, losses) => {
    const n = groupLosses(f.stats, [SHIP_GROUP_POD])
    return n >= R.podMinCount && n >= losses * R.podShare ? n / losses : null
  }],
  ['rookieShips', (f, losses) => {
    const n = groupLosses(f.stats, SHIP_GROUPS_ROOKIE)
    return n >= R.rookieShipsMinLosses ? n / losses : null
  }],
  ['freighter', (f) => (groupLosses(f.stats, SHIP_GROUPS_FREIGHTER) >= R.freighterMinLosses ? R.freighterScore : null)],
  ['miner', (f, losses) => {
    const n = groupLosses(f.stats, SHIP_GROUPS_MINER)
    return losses >= R.shareMinLosses && n >= R.minerMinLosses && n >= losses * R.minerShare ? n / losses : null
  }],
  ['soloLoser', (f, losses) => {
    const n = labelLosses(f.stats, 'solo')
    return losses >= R.soloLossMinLosses && n >= losses * R.soloLossShare ? n / losses : null
  }],
  ['highsecVictim', (f, losses) => {
    const n = labelLosses(f.stats, 'loc:highsec')
    return losses >= R.highsecMinLosses && n >= losses * R.highsecShare ? n / losses : null
  }],
]

/** 击毁类称号：返回分数，不满足返回 null；kills 是全部击毁（大于 0） */
type KillTest = (f: CardFacts, kills: number) => number | null

// 表里靠前的更具体（更少见），同分时优先
const KILL_TITLES: Array<[string, KillTest]> = [
  ['awoxSuspect', (f, kills) => {
    const n = labelKills(f.stats, 'awox')
    return n >= R.awoxMinKills && n >= kills * R.awoxMinShare ? R.awoxScore : null
  }],
  ['whaleHunter', (f, kills) => {
    const n = labelKills(f.stats, 'isk:10b+')
    if (n >= R.whaleMinKills) return Math.min(1, n / kills)
    return (f.recentKillValue ?? 0) >= R.whaleRecentValue ? R.whaleRecentScore : null
  }],
  ['capitalKiller', (f, kills) => {
    const n = labelKills(f.stats, 'capital')
    return n >= R.capitalKillerMinKills ? Math.min(1, n / kills) : null
  }],
  ['bigBattle', (f, kills) => {
    const n = labelKills(f.stats, '#:100+')
    return n >= R.bigBattleMinKills || (kills >= R.bigBattleShareMinKills && n >= kills * R.bigBattleShare) ? Math.min(1, n / kills) : null
  }],
  ['fwVeteran', (f, kills) => {
    const n = Object.entries(f.stats.labels).filter(([k]) => k.startsWith('fw:')).reduce((s, [, v]) => s + v.kills, 0)
    return n >= R.fwMinKills ? Math.min(1, n / kills) : null
  }],
  ['nullsecResident', (f, kills) => {
    const n = labelKills(f.stats, 'loc:nullsec')
    return kills >= R.nullsecMinKills && n >= kills * R.nullsecShare ? R.nullsecScore : null
  }],
  ['lowsecRanger', (f, kills) => {
    const n = labelKills(f.stats, 'loc:lowsec')
    return kills >= Math.max(R.lowsecMinKills, R.shareMinKills) && n >= kills * R.lowsecShare ? Math.min(1, n / kills) : null
  }],
  ['soloKing', (f, kills) => (f.stats.soloKills >= R.soloKingMinKills ? Math.min(1, f.stats.soloKills / kills) : null)],
]

/** 船型称号的分数：占比达标，或它是第一名的船组且次数够 */
function shipScore(f: CardFacts, groups: readonly number[]): number | null {
  if (f.totalKills <= 0) return null
  const count = f.shipGroups.filter((g) => groups.includes(g.groupId)).reduce((n, g) => n + g.kills, 0)
  if (count < R.shipMinAppearances) return null
  const share = count / f.totalKills
  const top = f.shipGroups[0]
  const isTop = top !== undefined && groups.includes(top.groupId)
  return share >= R.shipShare || isTop ? share : null
}

/** 称号（战绩暂缺、没有记录的人没有称号），最多 KB_TITLES_MAX 个 */
export function pickTitles(f: CardFacts): AwardedTitle[] {
  if (f.persona === 'unknown' || f.persona === 'ghost') return []
  const out: AwardedTitle[] = []
  const add = (id: string, score: number | null) => {
    if (score !== null && TITLE_COPY[id]) out.push({ id, label: TITLE_COPY[id].label, score })
  }
  for (const [id, groups] of Object.entries(KB_TITLE_SHIP_GROUPS)) add(id, shipScore(f, groups))
  if (f.stats.kills > 0) for (const [id, test] of KILL_TITLES) add(id, test(f, f.stats.kills))
  if (f.stats.losses > 0) for (const [id, test] of LOSS_TITLES) add(id, test(f, f.stats.losses))
  // Array.sort 是稳定的：同分按加入顺序（船型表在前，其次击毁类，损失类在后）
  return out.sort((a, b) => b.score - a.score).slice(0, KB_TITLES_MAX)
}
