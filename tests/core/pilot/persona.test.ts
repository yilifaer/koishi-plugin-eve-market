import { describe, expect, it } from 'vitest'
import { KB_ARCHETYPE_RULES as R, SHIP_GROUPS_CAPITAL, SHIP_GROUPS_INDUSTRIAL } from '../../../src/constants'
import {
  ACTIVITY_TEXT, BIRTHPLACE_TEXT, FOOTER_TEXT, MOOD_TEXT, PERSONA_COPY, ZONE_NAMES, composeCopy, fillTemplate, hash32, pickMood, pickPersona,
} from '../../../src/core/pilot'
import type { PersonaInput } from '../../../src/core/pilot'
import type { PersonaId } from '../../../src/core/types'
import { emptyZkillStats } from '../../../src/core/zkill'
import type { ZkillStats } from '../../../src/core/zkill'

function input(over: Partial<ZkillStats> = {}, extra: Partial<Omit<PersonaInput, 'stats'>> = {}): PersonaInput {
  return { stats: { ...emptyZkillStats(), present: true, kills: 300, losses: 100, ...over }, ageDays: 1000, topShipGroup: 25, ...extra }
}

describe('pickPersona: rule table, first match wins', () => {
  it('ghost: no records at all (beats everything)', () => {
    expect(pickPersona(input({ kills: 0, losses: 0 }, { ageDays: 5 }))).toBe('ghost')
  })

  it('rookie: under 90 days or under 10 records (boundaries)', () => {
    expect(pickPersona(input({}, { ageDays: R.rookieDays - 1 }))).toBe('rookie')
    expect(pickPersona(input({}, { ageDays: R.rookieDays }))).not.toBe('rookie')
    expect(pickPersona(input({ kills: 5, losses: R.rookieMinRecords - 6 }))).toBe('rookie')
    expect(pickPersona(input({ kills: 5, losses: R.rookieMinRecords - 5 }))).not.toBe('rookie')
    // 不知道建号时间时只看记录数
    expect(pickPersona(input({}, { ageDays: null }))).not.toBe('rookie')
  })

  it('capital: top ship group is a capital group', () => {
    for (const group of SHIP_GROUPS_CAPITAL) expect(pickPersona(input({}, { topShipGroup: group }))).toBe('capital')
    expect(pickPersona(input({}, { topShipGroup: 25 }))).not.toBe('capital')
    expect(pickPersona(input({}, { topShipGroup: null }))).not.toBe('capital')
  })

  it('industrial: >= 5 losses, half of them industrial ships, fewer kills than losses', () => {
    const groups = (losses: number) => [{ groupId: SHIP_GROUPS_INDUSTRIAL[0], kills: 0, losses }, { groupId: 25, kills: 0, losses: 0 }]
    expect(pickPersona(input({ kills: 4, losses: 10, groups: groups(5) }))).toBe('industrial')
    expect(pickPersona(input({ kills: 4, losses: 10, groups: groups(4) }))).not.toBe('industrial')
    expect(pickPersona(input({ kills: 10, losses: 10, groups: groups(10) }))).not.toBe('industrial')
    expect(pickPersona(input({ kills: 1, losses: 4, groups: groups(4) }, { ageDays: 1000 }))).not.toBe('industrial')
    // 多个工业组加起来
    const split = SHIP_GROUPS_INDUSTRIAL.slice(0, 2).map((groupId) => ({ groupId, kills: 0, losses: 3 }))
    expect(pickPersona(input({ kills: 4, losses: 10, groups: split }))).toBe('industrial')
  })

  it('wormhole: half of the kills in w-space', () => {
    const labels = (n: number) => ({ 'loc:w-space': { kills: n, losses: 0 } })
    expect(pickPersona(input({ kills: 100, losses: 10, labels: labels(50) }))).toBe('wormhole')
    expect(pickPersona(input({ kills: 100, losses: 10, labels: labels(49) }))).not.toBe('wormhole')
    expect(pickPersona(input({ kills: 29, losses: 1, labels: labels(29) }))).not.toBe('wormhole')
  })

  it('ganker: 40% of the kills labelled ganked', () => {
    const labels = (n: number) => ({ ganked: { kills: n, losses: 0 } })
    expect(pickPersona(input({ kills: 100, losses: 10, labels: labels(40) }))).toBe('ganker')
    expect(pickPersona(input({ kills: 100, losses: 10, labels: labels(39) }))).not.toBe('ganker')
    expect(pickPersona(input({ kills: 49, losses: 1, labels: labels(49) }))).not.toBe('ganker')
  })

  it('solo: >= 20 solo kills and >= 25% of the kills', () => {
    expect(pickPersona(input({ kills: 80, soloKills: 20 }))).toBe('solo')
    expect(pickPersona(input({ kills: 80, soloKills: 19 }))).not.toBe('solo')
    expect(pickPersona(input({ kills: 81, soloKills: 20 }))).not.toBe('solo')
  })

  it('fleet: gang >= 85 and >= 100 kills', () => {
    expect(pickPersona(input({ kills: 100, gang: 85 }))).toBe('fleet')
    expect(pickPersona(input({ kills: 100, gang: 84 }))).not.toBe('fleet')
    expect(pickPersona(input({ kills: 99, gang: 99 }))).not.toBe('fleet')
  })

  it('reaper: danger >= 85 and >= 50 kills', () => {
    expect(pickPersona(input({ kills: 50, losses: 10, danger: 85 }))).toBe('reaper')
    expect(pickPersona(input({ kills: 50, losses: 10, danger: 84 }))).not.toBe('reaper')
    expect(pickPersona(input({ kills: 49, losses: 10, danger: 99 }))).not.toBe('reaper')
  })

  it('underdog: more losses than kills and >= 20 losses', () => {
    expect(pickPersona(input({ kills: 19, losses: 20 }))).toBe('underdog')
    expect(pickPersona(input({ kills: 20, losses: 20 }))).not.toBe('underdog')
    expect(pickPersona(input({ kills: 5, losses: 19 }))).not.toBe('underdog')
  })

  it('pilot: everything else', () => {
    expect(pickPersona(input())).toBe('pilot')
  })

  it('earlier rules win over later ones', () => {
    // 独狼条件和舰队条件都满足 → 独狼
    expect(pickPersona(input({ kills: 200, soloKills: 100, gang: 95, danger: 95 }))).toBe('solo')
    // 旗舰条件 + 独狼条件 → 旗舰
    expect(pickPersona(input({ kills: 200, soloKills: 100 }, { topShipGroup: SHIP_GROUPS_CAPITAL[0] }))).toBe('capital')
  })
})

describe('copy templates', () => {
  const ALL: PersonaId[] = ['ghost', 'rookie', 'capital', 'industrial', 'wormhole', 'ganker', 'solo', 'fleet', 'reaper', 'underdog', 'pilot', 'unknown']
  const texts = (): string[] => [
    ...ALL.flatMap((p) => [PERSONA_COPY[p].label, ...PERSONA_COPY[p].headlines, ...PERSONA_COPY[p].ledes]),
    MOOD_TEXT.hotWeek, MOOD_TEXT.dormant(3), MOOD_TEXT.dormantLong, MOOD_TEXT.bigKill, MOOD_TEXT.bigLoss,
    FOOTER_TEXT, BIRTHPLACE_TEXT.at('X'), BIRTHPLACE_TEXT.fallback, ACTIVITY_TEXT.peak('20:00', '23:00', 12, 15), ACTIVITY_TEXT.zones(['A', 'B']),
    ...Object.values(ZONE_NAMES),
  ]
  const names = { name: 'Hanako Kisaragi' }

  it('every persona has at least 3 headlines and 3 ledes', () => {
    for (const p of ALL) {
      expect(PERSONA_COPY[p].headlines.length, p).toBeGreaterThanOrEqual(3)
      expect(PERSONA_COPY[p].ledes.length, p).toBeGreaterThanOrEqual(3)
    }
  })

  it('every persona has a headline and a lede that need only the name', () => {
    for (const p of ALL) {
      expect(PERSONA_COPY[p].headlines.some((t) => fillTemplate(t, names) !== null), `${p} headline`).toBe(true)
      expect(PERSONA_COPY[p].ledes.some((t) => fillTemplate(t, names) !== null), `${p} lede`).toBe(true)
      const { headline, lede } = composeCopy(p, 2119876543, '2026-10-14', names)
      expect(headline.length).toBeGreaterThan(0)
      expect(lede.length).toBeGreaterThan(0)
      expect(`${headline}${lede}`).not.toMatch(/[{}]/)
    }
  })

  it('only known placeholders are used', () => {
    const known = new Set(['name', 'kills', 'losses', 'solo', 'eff', 'isk', 'k7', 'ship', 'system', 'region', 'years'])
    for (const t of texts()) for (const m of t.matchAll(/\{(\w+)\}/g)) expect(known.has(m[1]), `${t} → ${m[1]}`).toBe(true)
  })

  it('skips templates whose data is missing', () => {
    expect(fillTemplate('{name}打了{kills}次', names)).toBeNull()
    expect(fillTemplate('{name}打了{kills}次', { ...names, kills: '12' })).toBe('Hanako Kisaragi打了12次')
    const { lede } = composeCopy('solo', 1, '2026-10-14', names)
    expect(lede).not.toMatch(/单杀|\d/)
  })

  it('the same character on the same day gets the same lines; other days can differ', () => {
    const values = { ...names, kills: '300', losses: '100', solo: '88', eff: '88%', isk: '23.20B', k7: '14', ship: '马其顿级', system: '吉他', region: '伏尔戈', years: '7' }
    const a = composeCopy('solo', 2119876543, '2026-10-14', values)
    expect(composeCopy('solo', 2119876543, '2026-10-14', values)).toEqual(a)
    const seen = new Set<string>()
    for (let day = 1; day <= 28; day++) seen.add(composeCopy('solo', 2119876543, `2026-10-${String(day).padStart(2, '0')}`, values).headline)
    expect(seen.size).toBeGreaterThan(1)
    // 不同人物同一天也会分散
    const people = new Set<string>()
    for (let id = 1; id <= 30; id++) people.add(composeCopy('solo', id, '2026-10-14', values).lede)
    expect(people.size).toBeGreaterThan(1)
  })

  it('hash32 is stable', () => {
    expect(hash32('abc')).toBe(hash32('abc'))
    expect(hash32('abc')).not.toBe(hash32('abd'))
    expect(hash32('')).toBe(0x811c9dc5)
  })

  it('has no gender words or pronouns, region or ethnicity jokes, or swearing', () => {
    const banned = /[他她男女]|兄弟|哥们|老哥|小哥|姐|姑娘|小伙|大叔|大妈|汉子|娘|爷们|美女|帅哥|傻|蠢|废物|垃圾|菜鸡|脑残|弱智|白痴|智障|滚|妈|操|尼玛|卧槽|混蛋|王八|畜生|死全家|黑人|白人|老外|洋人|棒子|鬼子|阿三|猴|北方|南方|外地|农村|乡下|穷鬼|屌|逼/
    for (const t of texts()) expect(t, t).not.toMatch(banned)
  })

  it('keeps the tone sharp: the owner-approved jokes are in the table', () => {
    const all = ALL.flatMap((p) => [...PERSONA_COPY[p].headlines, ...PERSONA_COPY[p].ledes]).join('\n')
    expect(all).toContain('移动靶')
    expect(all).toContain('保险公司 VIP')
    expect(all).toContain('击毁数还没损失数多')
  })
})

describe('pickMood', () => {
  const idle = (n: number) => Array.from({ length: 12 }, (_, i) => ({ kills: i < 12 - n ? 3 : 0, losses: 0 }))
  const base = { weekKills: 0, months: idle(0), recentKillValue: null, recentLossValue: null, iskOf: (v: number) => `${v / 1e9}B` }

  it('hot week at 30 kills', () => {
    expect(pickMood({ ...base, weekKills: R.moodWeekKills })).toBe('本周火力全开')
    expect(pickMood({ ...base, weekKills: R.moodWeekKills - 1 })).toBeNull()
    expect(pickMood({ ...base, weekKills: null })).toBeNull()
  })

  it('dormant after 3 empty months, counting the months', () => {
    expect(pickMood({ ...base, months: idle(2) })).toBeNull()
    expect(pickMood({ ...base, months: idle(3) })).toBe('已潜水 3 个月')
    expect(pickMood({ ...base, months: idle(7) })).toBe('已潜水 7 个月')
    expect(pickMood({ ...base, months: idle(12) })).toBe(MOOD_TEXT.dormantLong)
  })

  it('big kill and big loss from 10B', () => {
    expect(pickMood({ ...base, recentKillValue: 10e9 })).toBe('近日猎获 10B')
    expect(pickMood({ ...base, recentKillValue: 9.9e9 })).toBeNull()
    expect(pickMood({ ...base, recentLossValue: 12e9 })).toContain('12B')
  })

  it('order: hot week, dormant, big kill, big loss', () => {
    expect(pickMood({ ...base, weekKills: 40, recentKillValue: 20e9 })).toBe('本周火力全开')
    expect(pickMood({ ...base, months: idle(4), recentKillValue: 20e9 })).toBe('已潜水 4 个月')
    expect(pickMood({ ...base, recentKillValue: 20e9, recentLossValue: 30e9 })).toBe('近日猎获 20B')
  })
})
