// 称号、锐评、整活儿测试共用的编造数据

import type { CardFacts } from '../../../src/core/pilot'
import { emptyZkillStats } from '../../../src/core/zkill'
import type { ZkillStats } from '../../../src/core/zkill'

export function stats(over: Partial<ZkillStats> = {}): ZkillStats {
  return {
    ...emptyZkillStats(), present: true, kills: 300, losses: 100, soloKills: 10, iskKilled: 500e9, iskLost: 200e9, danger: 50, gang: 50, avgGangSize: 8, ...over,
  }
}

export function facts(over: Partial<Omit<CardFacts, 'stats'>> & { stats?: Partial<ZkillStats> } = {}): CardFacts {
  const { stats: s, ...rest } = over
  return {
    stats: stats(s),
    ageDays: 1000,
    persona: 'pilot',
    topShipGroup: 27,
    shipGroups: [],
    totalKills: 300,
    dormantMonths: 0,
    peak: null,
    recentKillValue: null,
    recentLossValue: null,
    ...rest,
  }
}

/** 一个所有占位符都有值的数据，编造的 */
export const VALUES = {
  name: 'Hanako Kisaragi', kills: '300', losses: '100', solo: '88', eff: '71%', isk: '500.00B', iskLost: '200.00B', k7: '14', ship: '马其顿级',
  system: 'Testville', region: 'Fictional Reach', years: '7', gang: '64%', danger: '78%', avgGang: '8.5', bigKill: '乌鸦级', bigKillIsk: '12.00B',
  bigLoss: '渡鸦级', bigLossIsk: '3.00B', dormant: '5个月', peak: '21–24 点',
}
