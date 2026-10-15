import { describe, expect, it } from 'vitest'
import { KB_TITLES_MAX, KB_TITLE_RULES as R, KB_TITLE_SHIP_GROUPS } from '../../../src/constants'
import { TITLE_COPY, pickTitles } from '../../../src/core/pilot'
import { facts } from './fun-helpers'

const ids = (f: ReturnType<typeof facts>) => pickTitles(f).map((t) => t.id)
const group = (groupId: number, losses: number) => ({ groupId, kills: 0, losses })
const label = (losses: number) => ({ kills: 0, losses })

describe('ship titles', () => {
  for (const [id, groups] of Object.entries(KB_TITLE_SHIP_GROUPS)) {
    it(`${id}: share >= 20% awards it, small counts and small shares do not`, () => {
      expect(TITLE_COPY[id], id).toBeDefined()
      // 占一半
      expect(ids(facts({ shipGroups: [{ groupId: groups[0], kills: 100 }], totalKills: 200 }))).toEqual([id])
      // 次数不够 10
      expect(ids(facts({ shipGroups: [{ groupId: groups[0], kills: R.shipMinAppearances - 1 }], totalKills: 10 }))).toEqual([])
      // 占比不到 20% 且不是第一名
      expect(ids(facts({ shipGroups: [{ groupId: 1, kills: 300 }, { groupId: groups[0], kills: 40 }], totalKills: 1000 }))).toEqual([])
    })
  }

  it('boundary: exactly 20% and exactly 10 appearances count', () => {
    const f = (kills: number, total: number) => facts({ shipGroups: [{ groupId: 1, kills: 999 }, { groupId: 831, kills }], totalKills: total })
    expect(ids(f(20, 100))).toEqual(['interceptor'])
    expect(ids(f(19, 100))).toEqual([])
    expect(ids(f(R.shipMinAppearances, R.shipMinAppearances * 5))).toEqual(['interceptor'])
  })

  it('being the number one group with 10+ appearances is enough even under 20%', () => {
    expect(ids(facts({ shipGroups: [{ groupId: 831, kills: 12 }, { groupId: 1, kills: 11 }], totalKills: 300 }))).toEqual(['interceptor'])
    expect(ids(facts({ shipGroups: [{ groupId: 831, kills: 9 }], totalKills: 300 }))).toEqual([])
  })

  it('multi-group titles add the groups together', () => {
    // 拦截舰 + 重拦各 6 次，合起来 12 次，占 40%
    expect(ids(facts({ shipGroups: [{ groupId: 541, kills: 6 }, { groupId: 894, kills: 6 }], totalKills: 30 }))).toEqual(['bubbler'])
    expect(ids(facts({ shipGroups: [{ groupId: 893, kills: 5 }, { groupId: 833, kills: 3 }, { groupId: 906, kills: 4 }], totalKills: 30 }))).toEqual(['ewar'])
  })

  it('no total kills, no ship title', () => {
    expect(ids(facts({ shipGroups: [{ groupId: 831, kills: 50 }], totalKills: 0 }))).toEqual([])
  })
})

describe('loss titles', () => {
  const lose = (n: number, extra: Parameters<typeof facts>[0] = {}) => facts({ ...extra, stats: { losses: n, ...(extra.stats ?? {}) } })

  it('bait: 10+ attacker buckets >= 50% of losses and >= 10 losses', () => {
    const labels = (a: number, b = 0) => ({ '#:10+': label(a), '#:25+': label(b) })
    expect(ids(lose(20, { stats: { labels: labels(6, 4) } }))).toEqual(['bait'])
    expect(ids(lose(20, { stats: { labels: labels(5, 4) } }))).toEqual([])
    expect(ids(lose(9, { stats: { labels: labels(9) } }))).toEqual([])
  })

  it('pod: capsules >= 50% of losses and >= 20', () => {
    expect(ids(lose(40, { stats: { groups: [group(29, 20)] } }))).toEqual(['pod'])
    expect(ids(lose(40, { stats: { groups: [group(29, 19)] } }))).toEqual([])
    expect(ids(lose(60, { stats: { groups: [group(29, 29)] } }))).toEqual([])
    expect(ids(lose(15, { stats: { groups: [group(29, 15)] } }))).toEqual([])
  })

  it('rookieShips: corvettes + shuttles >= 10', () => {
    expect(ids(lose(100, { stats: { groups: [group(237, 6), group(31, 4)] } }))).toEqual(['rookieShips'])
    expect(ids(lose(100, { stats: { groups: [group(237, 6), group(31, 3)] } }))).toEqual([])
  })

  it('freighter: any freighter or jump freighter loss', () => {
    expect(ids(lose(100, { stats: { groups: [group(513, 1)] } }))).toEqual(['freighter'])
    expect(ids(lose(100, { stats: { groups: [group(902, 1)] } }))).toEqual(['freighter'])
    expect(ids(lose(100, { stats: { groups: [group(513, 0)] } }))).toEqual([])
  })

  it('miner: barges + exhumers >= 30% of losses and >= 5', () => {
    expect(ids(lose(20, { stats: { groups: [group(463, 3), group(543, 3)] } }))).toEqual(['miner'])
    expect(ids(lose(20, { stats: { groups: [group(463, 5)] } }))).toEqual([])
    expect(ids(lose(100, { stats: { groups: [group(463, 29)] } }))).toEqual([])
    expect(ids(lose(10, { stats: { groups: [group(463, 4)] } }))).toEqual([])
  })

  it('soloLoser: solo losses >= 20% and >= 10 losses', () => {
    expect(ids(lose(50, { stats: { labels: { solo: label(10) } } }))).toEqual(['soloLoser'])
    expect(ids(lose(50, { stats: { labels: { solo: label(9) } } }))).toEqual([])
    expect(ids(lose(9, { stats: { labels: { solo: label(9) } } }))).toEqual([])
  })

  it('highsecVictim: high-sec losses >= 50% and >= 10 losses', () => {
    expect(ids(lose(20, { stats: { labels: { 'loc:highsec': label(10) } } }))).toEqual(['highsecVictim'])
    expect(ids(lose(20, { stats: { labels: { 'loc:highsec': label(9) } } }))).toEqual([])
    expect(ids(lose(9, { stats: { labels: { 'loc:highsec': label(9) } } }))).toEqual([])
  })

  it('no losses, no loss titles', () => {
    expect(ids(facts({ stats: { losses: 0, groups: [group(29, 99)], labels: { solo: label(9) } } }))).toEqual([])
  })
})

describe('kill titles', () => {
  const kl = (n: number) => ({ kills: n, losses: 0 })
  const win = (labels: Record<string, { kills: number; losses: number }>, over: Parameters<typeof facts>[0] = {}) =>
    facts({ ...over, stats: { kills: 200, losses: 0, ...(over.stats ?? {}), labels } })

  it('capitalKiller: capital label kills >= 5', () => {
    expect(ids(win({ capital: kl(5) }))).toEqual(['capitalKiller'])
    expect(ids(win({ capital: kl(4) }))).toEqual([])
  })

  it('whaleHunter: isk:10b+ kills >= 3, or a recent kill worth 10B', () => {
    expect(ids(win({ 'isk:10b+': kl(3) }))).toEqual(['whaleHunter'])
    expect(ids(win({ 'isk:10b+': kl(2) }))).toEqual([])
    expect(ids(win({}, { recentKillValue: 10e9 }))).toEqual(['whaleHunter'])
    expect(pickTitles(win({}, { recentKillValue: 10e9 }))[0].score).toBe(R.whaleRecentScore)
    expect(ids(win({}, { recentKillValue: 9.9e9 }))).toEqual([])
  })

  it('fwVeteran: sum of fw:* kills >= 50', () => {
    expect(ids(win({ 'fw:amarr': kl(30), 'fw:gallente': kl(20) }))).toEqual(['fwVeteran'])
    expect(ids(win({ 'fw:amarr': kl(30), 'fw:gallente': kl(19) }))).toEqual([])
  })

  it('awoxSuspect: awox kills >= 3 and >= 1% of kills, low score', () => {
    expect(ids(win({ awox: kl(3) }))).toEqual(['awoxSuspect'])
    expect(ids(win({ awox: kl(2) }))).toEqual([])
    expect(ids(win({ awox: kl(3) }, { stats: { kills: 301 } }))).toEqual([])
    expect(ids(win({ awox: kl(3) }, { stats: { kills: 300 } }))).toEqual(['awoxSuspect'])
    expect(pickTitles(win({ awox: kl(3) }))[0].score).toBe(R.awoxScore)
  })

  it('bigBattle: #:100+ kills >= 20, or >= 10% of kills with >= 50 kills', () => {
    expect(ids(win({ '#:100+': kl(20) }))).toEqual(['bigBattle'])
    expect(ids(win({ '#:100+': kl(19) }))).toEqual([])
    expect(ids(win({ '#:100+': kl(6) }, { stats: { kills: 60 } }))).toEqual(['bigBattle'])
    expect(ids(win({ '#:100+': kl(5) }, { stats: { kills: 60 } }))).toEqual([])
    // 击毁不到 50，占比再高也不算
    expect(ids(win({ '#:100+': kl(6) }, { stats: { kills: 49 } }))).toEqual([])
    expect(ids(win({ '#:100+': kl(5) }, { stats: { kills: 50 } }))).toEqual(['bigBattle'])
  })

  it('lowsecRanger: >= 50% of kills in low-sec with >= 30 kills', () => {
    expect(ids(win({ 'loc:lowsec': kl(100) }))).toEqual(['lowsecRanger'])
    expect(ids(win({ 'loc:lowsec': kl(99) }))).toEqual([])
    expect(ids(win({ 'loc:lowsec': kl(29) }, { stats: { kills: 29 } }))).toEqual([])
  })

  it('nullsecResident: >= 80% of kills in null-sec with >= 50 kills', () => {
    expect(ids(win({ 'loc:nullsec': kl(160) }))).toEqual(['nullsecResident'])
    expect(ids(win({ 'loc:nullsec': kl(159) }))).toEqual([])
    expect(ids(win({ 'loc:nullsec': kl(40) }, { stats: { kills: 40 } }))).toEqual([])
    expect(pickTitles(win({ 'loc:nullsec': kl(160) }))[0].score).toBe(R.nullsecScore)
  })

  it('nullsecResident gives way to more distinctive titles', () => {
    const got = ids(win({ 'loc:nullsec': kl(180), capital: kl(5), 'isk:10b+': kl(3), awox: kl(3) }))
    expect(got).not.toContain('nullsecResident')
  })

  it('share-of-kills titles need 20+ kills', () => {
    expect(ids(win({ 'loc:lowsec': kl(19) }, { stats: { kills: 19 } }))).toEqual([])
  })

  it('soloKing: solo kills >= 100', () => {
    expect(ids(win({}, { stats: { soloKills: 100 } }))).toEqual(['soloKing'])
    expect(ids(win({}, { stats: { soloKills: 99 } }))).toEqual([])
  })

  it('no kills, no kill titles', () => {
    expect(ids(win({ capital: kl(9), awox: kl(2) }, { stats: { kills: 0 } }))).toEqual([])
  })

  it('the cap is 3', () => {
    const got = ids(win({ awox: kl(3), 'isk:10b+': kl(3), capital: kl(5), '#:100+': kl(30) }))
    expect(got).toHaveLength(KB_TITLES_MAX)
    expect(got[0]).toBe('awoxSuspect')
  })
})

describe('cyno title', () => {
  const cy = (count: number, losses: number) => facts({ stats: { losses, cyno: { count, standard: count, covert: 0, industrial: 0 } } })

  it('awarded at 3 cyno losses, or 20% of 10+ losses', () => {
    expect(ids(cy(3, 100))).toEqual(['cyno'])
    expect(ids(cy(2, 100))).toEqual([])
    expect(ids(cy(2, 10))).toEqual(['cyno'])
    expect(ids(cy(2, 11))).toEqual([])
    expect(ids(cy(1, 9))).toEqual([])
  })

  it('has the owner label', () => {
    expect(TITLE_COPY.cyno.label).toBe('诱导驾驶员')
    expect(TITLE_COPY.bait.label).toBe('众矢之的')
  })
})

describe('guard rails', () => {
  it('6 kills / 1 loss with an awox and a big battle kill gets nothing', () => {
    const f = facts({ stats: { kills: 6, losses: 1, labels: { awox: { kills: 1, losses: 0 }, '#:100+': { kills: 1, losses: 0 } } } })
    expect(ids(f)).toEqual([])
  })

  it('miner share needs 10+ losses', () => {
    expect(ids(facts({ stats: { losses: 9, groups: [group(463, 5)] } }))).toEqual([])
  })
})

describe('title picking', () => {
  const many = facts({
    shipGroups: [{ groupId: 834, kills: 100 }, { groupId: 831, kills: 80 }, { groupId: 27, kills: 60 }, { groupId: 25, kills: 50 }],
    totalKills: 300,
    stats: { losses: 50, groups: [group(29, 25), group(513, 1)] },
  })

  it('keeps the top 3 by score', () => {
    const got = pickTitles(many)
    expect(got).toHaveLength(KB_TITLES_MAX)
    // 货舰 0.6，隐轰 0.33，蛋舱 0.5 → 货舰、蛋舱、隐轰
    expect(got.map((t) => t.id)).toEqual(['freighter', 'pod', 'bomber'])
    expect(got.map((t) => t.score)).toEqual([...got.map((t) => t.score)].sort((a, b) => b - a))
    expect(got[0].label).toBe(TITLE_COPY.freighter.label)
  })

  it('ties keep table order', () => {
    const tie = facts({ shipGroups: [{ groupId: 831, kills: 50 }, { groupId: 834, kills: 50 }], totalKills: 200 })
    expect(ids(tie)).toEqual(['bomber', 'interceptor'])
  })

  it('ghost and unknown never get titles', () => {
    for (const persona of ['ghost', 'unknown'] as const) expect(ids({ ...many, persona })).toEqual([])
  })
})
