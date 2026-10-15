import { describe, expect, it } from 'vitest'
import { REMARK_LINES, REMARK_RULES, TITLE_COPY, fillTemplate, pickRemarks, pickTitles, tonePool } from '../../../src/core/pilot'
import type { CardFacts } from '../../../src/core/pilot'
import { facts, VALUES } from './fun-helpers'

const matched = (f: CardFacts) => REMARK_RULES.filter((r) => r.test(f)).map((r) => r.id)
const label = (kills: number, losses = 0) => ({ kills, losses })
const group = (groupId: number, losses: number) => ({ groupId, kills: 0, losses })
const days = (weekend: number, weekday: number) => [weekend, weekday, weekday, weekday, weekday, weekday, 0]

describe('remark rules: every id has a positive and a negative case', () => {
  type Case = [string, Parameters<typeof facts>[0], Parameters<typeof facts>[0]]
  const cases: Case[] = [
    ['lowEff', { stats: { iskKilled: 20e9, iskLost: 80e9 } }, { stats: { iskKilled: 40e9, iskLost: 60e9 } }],
    ['highEff', { stats: { iskKilled: 95e9, iskLost: 5e9 } }, { stats: { iskKilled: 89e9, iskLost: 11e9 } }],
    ['lossesGtKills', { stats: { kills: 50, losses: 60 } }, { stats: { kills: 50, losses: 40 } }],
    ['expensiveLosses', { stats: { iskKilled: 10e9, iskLost: 20e9, losses: 20 } }, { stats: { iskKilled: 30e9, iskLost: 20e9 } }],
    ['bigLossRecent', { recentLossValue: 1e9 }, { recentLossValue: 9.9e8 }],
    ['bigKillRecent', { recentKillValue: 1e9 }, { recentKillValue: 9.9e8 }],
    ['bigIsk10b', { recentKillValue: 10e9 }, { recentKillValue: 9.9e9 }],
    ['soloHeavy', { stats: { kills: 100, soloKills: 30 } }, { stats: { kills: 100, soloKills: 29 } }],
    ['blobber', { stats: { gang: 90 } }, { stats: { gang: 89, avgGangSize: 19 } }],
    ['dormant', { dormantMonths: 3 }, { dormantMonths: 2 }],
    ['hotWeek', { stats: { week: { kills: 30, ships: 1, systems: 1, regions: 1 } } }, { stats: { week: { kills: 29, ships: 1, systems: 1, regions: 1 } } }],
    ['oldTimer', { ageDays: 3650 }, { ageDays: 3649 }],
    ['newbie', { ageDays: 89 }, { ageDays: 90 }],
    ['noKills', { stats: { kills: 0, losses: 5 } }, { stats: { kills: 1, losses: 5 } }],
    ['highDanger', { stats: { danger: 85 } }, { stats: { danger: 84 } }],
    ['lowDanger', { stats: { danger: 20 } }, { stats: { danger: 21 } }],
    ['capitalPilot', { topShipGroup: 547 }, { topShipGroup: 27 }],
    ['industrialLosses', { stats: { kills: 2, losses: 10, groups: [group(463, 5)] } }, { stats: { kills: 2, losses: 10, groups: [group(463, 4)] } }],
    ['wormhole', { stats: { kills: 100, labels: { 'loc:w-space': label(50) } } }, { stats: { kills: 100, labels: { 'loc:w-space': label(49) } } }],
    ['ganker', { stats: { kills: 100, labels: { ganked: label(40) } } }, { stats: { kills: 100, labels: { ganked: label(39) } } }],
    ['podded', { stats: { losses: 40, groups: [group(29, 20)] } }, { stats: { losses: 40, groups: [group(29, 19)] } }],
    ['npcDeaths', { stats: { labels: { npc: label(0, 3) } } }, { stats: { labels: { npc: label(0, 2) } } }],
    ['awox', { stats: { labels: { awox: label(0, 1) } } }, { stats: { labels: {} } }],
    ['soloLosses', { stats: { losses: 50, soloLosses: 10 } }, { stats: { losses: 50, soloLosses: 9 } }],
    ['highsecLosses', { stats: { losses: 50, labels: { 'loc:highsec': label(0, 20) } } }, { stats: { losses: 50, labels: { 'loc:highsec': label(0, 19) } } }],
    ['cheapShips', { topShipGroup: 25, stats: { kills: 50 } }, { topShipGroup: 25, stats: { kills: 49 } }],
    ['capitalLoss', { stats: { groups: [group(485, 1)] } }, { stats: { groups: [group(485, 0)] } }],
    ['manyLosses', { stats: { losses: 500 } }, { stats: { losses: 499 } }],
    ['manyKills', { stats: { kills: 1000 } }, { stats: { kills: 999 } }],
    ['weekendWarrior', { stats: { activityDays: days(60, 10) } }, { stats: { activityDays: days(49, 10) } }],
    ['nightOwl', { peak: { beijingStart: 3, beijingEnd: 6 } }, { peak: { beijingStart: 4, beijingEnd: 7 } }],
    ['primeTime', { peak: { beijingStart: 21, beijingEnd: 0 } }, { peak: { beijingStart: 22, beijingEnd: 1 } }],
    ['tinyGang', { stats: { kills: 20, avgGangSize: 3 } }, { stats: { kills: 20, avgGangSize: 3.1 } }],
    ['bigIskLoss', { stats: { iskLost: 1e12 } }, { stats: { iskLost: 9.9e11 } }],
  ]

  it('covers every rule in the table (fallback is the default)', () => {
    expect(cases.map((c) => c[0]).sort()).toEqual(REMARK_RULES.map((r) => r.id).sort())
    expect(Object.keys(REMARK_LINES).sort()).toEqual([...REMARK_RULES.map((r) => r.id), 'fallback'].sort())
  })

  for (const [id, yes, no] of cases) {
    it(id, () => {
      expect(matched(facts(yes)), 'positive').toContain(id)
      expect(matched(facts(no)), 'negative').not.toContain(id)
    })
  }

  it('the base card (a middling player) matches only the quiet rules', () => {
    expect(matched(facts())).toEqual([])
  })

  it('weekend: needs enough samples and the Sunday + Saturday slots', () => {
    expect(matched(facts({ stats: { activityDays: days(10, 1) } }))).not.toContain('weekendWarrior')
    expect(matched(facts({ stats: { activityDays: [] } }))).not.toContain('weekendWarrior')
  })
})

describe('pickRemarks', () => {
  const ctx = (over: Partial<Parameters<typeof pickRemarks>[2]> = {}) => ({ values: VALUES, tone: 'mixed' as const, seed: '2119876543:2026-10-14', used: new Set<string>(), ...over })
  const busy = facts({
    stats: { kills: 1200, losses: 600, iskKilled: 20e9, iskLost: 90e9, danger: 90, gang: 95, soloLosses: 200, week: { kills: 40, ships: 1, systems: 1, regions: 1 } },
    recentKillValue: 12e9,
    recentLossValue: 2e9,
    ageDays: 4000,
    shipGroups: [{ groupId: 834, kills: 500 }],
    totalKills: 1200,
  })

  it('picks exactly one, even when many rules match', () => {
    expect(matched(busy).length).toBeGreaterThan(3)
    expect(pickRemarks(busy, pickTitles(busy), ctx())).toHaveLength(1)
    const short = facts({ stats: { kills: 0, losses: 5 }, ageDays: 40, recentLossValue: 2e9 })
    expect(matched(short).length).toBeGreaterThan(2)
    expect(pickRemarks(short, [], ctx())).toHaveLength(1)
  })

  it('the one line comes from the most specific matching rule', () => {
    // 有近期大损失（第 0 档），泛泛的「损失多于击毁」（第 3 档）不该上
    const f = facts({ stats: { kills: 5, losses: 40 }, recentLossValue: 2e9 })
    const generic = tonePool('mixed', REMARK_LINES.lossesGtKills).map((t) => fillTemplate(t, VALUES))
    for (let d = 1; d <= 10; d++) expect(generic).not.toContain(pickRemarks(f, [], ctx({ seed: `3:2026-10-${d}` }))[0])
  })

  it('is deterministic per person per day, and changes on other days', () => {
    const a = pickRemarks(busy, pickTitles(busy), ctx())
    expect(pickRemarks(busy, pickTitles(busy), ctx())).toEqual(a)
    const seen = new Set<string>()
    for (let d = 1; d <= 20; d++) seen.add(pickRemarks(busy, pickTitles(busy), ctx({ seed: `2119876543:2026-10-${String(d).padStart(2, '0')}` })).join('|'))
    expect(seen.size).toBeGreaterThan(5)
  })

  it('no duplicate lines, and at most one line per rule or title', () => {
    for (let d = 1; d <= 28; d++) {
      const out = pickRemarks(busy, pickTitles(busy), ctx({ seed: `7:2026-10-${d}` }))
      expect(new Set(out).size).toBe(out.length)
    }
    // 一条规则只出一句：每句能对上不同的规则或称号池
    const out = pickRemarks(busy, pickTitles(busy), ctx())
    const pools = [...Object.values(REMARK_LINES), ...Object.values(TITLE_COPY).map((t) => t.remarks)]
    for (const line of out) {
      const owners = pools.filter((p) => tonePool('mixed', p as { gentle: readonly string[]; snarky: readonly string[] }).some((t) => fillTemplate(t, VALUES) === line))
      expect(owners.length, line).toBeGreaterThanOrEqual(1)
    }
  })

  it('awarded titles contribute their remarks, after the most specific rules', () => {
    const f = facts({ shipGroups: [{ groupId: 834, kills: 150 }], totalKills: 200, stats: { kills: 200, losses: 50 } })
    const titles = pickTitles(f)
    expect(titles.map((t) => t.id)).toEqual(['bomber'])
    for (const tone of ['gentle', 'snarky'] as const) {
      const out = pickRemarks(f, titles, ctx({ tone }))
      expect(out.some((line) => TITLE_COPY.bomber.remarks[tone].some((t) => fillTemplate(t, VALUES) === line)), tone).toBe(true)
    }
  })

  it('a bigger kill supersedes the smaller one', () => {
    const f = facts({ recentKillValue: 12e9, recentLossValue: 2e9 })
    for (let d = 1; d <= 10; d++) {
      const out = pickRemarks(f, [], ctx({ seed: `1:2026-10-${d}` }))
      const small = REMARK_LINES.bigKillRecent.gentle.concat(REMARK_LINES.bigKillRecent.snarky).map((t) => fillTemplate(t, VALUES))
      expect(out.some((l) => small.includes(l))).toBe(false)
    }
  })

  it('falls back when nothing matches; the fallback uses the tone pool', () => {
    for (const tone of ['gentle', 'snarky'] as const) {
      const out = pickRemarks(facts(), [], ctx({ tone }))
      expect(out).toHaveLength(1)
      expect(REMARK_LINES.fallback[tone].map((t) => fillTemplate(t, VALUES))).toContain(out[0])
    }
  })

  it('skips lines whose placeholder has no value', () => {
    const f = facts({ recentKillValue: 12e9 })
    // 没有 bigKill / bigKillIsk：大击杀的句子全部跳过，退回别的（这里是兜底）
    const out = pickRemarks(f, [], ctx({ values: { name: 'Hanako Kisaragi' } }))
    expect(out.join('')).not.toMatch(/\{/)
    expect(out).toHaveLength(1)
  })

  it('ghost and unknown get no remarks', () => {
    for (const persona of ['ghost', 'unknown'] as const) expect(pickRemarks({ ...busy, persona }, [], ctx())).toEqual([])
  })

  it('tone pools: gentle only gentle, snarky only snarky', () => {
    for (let d = 1; d <= 20; d++) {
      const seed = `5:2026-10-${d}`
      const g = pickRemarks(busy, [], ctx({ tone: 'gentle', seed }))
      const s = pickRemarks(busy, [], ctx({ tone: 'snarky', seed }))
      const fill = (xs: readonly string[]) => xs.map((t) => fillTemplate(t, VALUES))
      const gentle = Object.values(REMARK_LINES).flatMap((v) => fill(v.gentle))
      const snarky = Object.values(REMARK_LINES).flatMap((v) => fill(v.snarky))
      for (const line of g) expect(gentle).toContain(line)
      for (const line of s) expect(snarky).toContain(line)
    }
  })
})
