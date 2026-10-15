import { describe, expect, it } from 'vitest'
import { KB_ARCHETYPE_RULES as R, SHIP_GROUPS_CAPITAL, SHIP_GROUPS_INDUSTRIAL } from '../../../src/constants'
import {
  PERSONA_LABEL, PERSONA_LINES, composeCopy, fillTemplate, hash32, spaceCjk, idleMonths, pickMood, pickMoodKey, pickPersona, tonePool,
} from '../../../src/core/pilot'
import type { MoodInput, PersonaInput } from '../../../src/core/pilot'
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

  it('pacifist: no kills, at least one loss, account 5 years or older (before rookie)', () => {
    const year = 365
    expect(pickPersona(input({ kills: 0, losses: 11 }, { ageDays: 5 * year }))).toBe('pacifist')
    // 记录很少的老号也算（先于 rookie）
    expect(pickPersona(input({ kills: 0, losses: 1 }, { ageDays: 8 * year }))).toBe('pacifist')
    expect(pickPersona(input({ kills: 0, losses: 11 }, { ageDays: 5 * year - 1 }))).not.toBe('pacifist')
    expect(pickPersona(input({ kills: 1, losses: 11 }, { ageDays: 8 * year }))).not.toBe('pacifist')
    expect(pickPersona(input({ kills: 0, losses: 0 }, { ageDays: 8 * year }))).toBe('ghost')
    expect(pickPersona(input({ kills: 0, losses: 11 }, { ageDays: null }))).not.toBe('pacifist')
  })

  it('sleeper: account >= 3 years with under 10 records; wins over rookie, rookie keeps young accounts', () => {
    const year = 365
    // 2005 年建号只有 6 条记录
    expect(pickPersona(input({ kills: 4, losses: 2 }, { ageDays: 20 * year }))).toBe('sleeper')
    expect(pickPersona(input({ kills: 4, losses: 2 }, { ageDays: R.sleeperMinYears * year }))).toBe('sleeper')
    expect(pickPersona(input({ kills: 4, losses: 2 }, { ageDays: R.sleeperMinYears * year - 1 }))).toBe('rookie')
    expect(pickPersona(input({ kills: 4, losses: 2 }, { ageDays: 30 }))).toBe('rookie')
    // 记录够多就不是沉睡老号；不知道建号时间也不是
    expect(pickPersona(input({ kills: 5, losses: R.rookieMinRecords - 5 }, { ageDays: 20 * year }))).not.toBe('sleeper')
    expect(pickPersona(input({ kills: 4, losses: 2 }, { ageDays: null }))).toBe('rookie')
    // 没有击毁的老号仍是和平主义者，没有记录仍是神秘人物
    expect(pickPersona(input({ kills: 0, losses: 2 }, { ageDays: 8 * year }))).toBe('pacifist')
    expect(pickPersona(input({ kills: 0, losses: 0 }, { ageDays: 8 * year }))).toBe('ghost')
  })

  it('sleeper copy: label, and at least 15 headlines and ledes in each tone', () => {
    expect(PERSONA_LABEL.sleeper).toBe('沉睡老号')
    for (const t of ['gentle', 'snarky'] as const) {
      expect(PERSONA_LINES.sleeper[t].headlines.length).toBeGreaterThanOrEqual(15)
      expect(PERSONA_LINES.sleeper[t].ledes.length).toBeGreaterThanOrEqual(15)
    }
    const all = (['gentle', 'snarky'] as const).flatMap((t) => [...PERSONA_LINES.sleeper[t].headlines, ...PERSONA_LINES.sleeper[t].ledes])
    for (const l of all) expect(l, l).not.toMatch(/新手|萌新|新人|第一艘|保护期/)
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
  const ALL = Object.keys(PERSONA_LINES) as PersonaId[]
  const names = { name: 'Hanako Kisaragi' }

  it('every persona has a name, a label, and copy in both tones', () => {
    expect(ALL).toHaveLength(14)
    for (const p of ALL) {
      expect(PERSONA_LABEL[p], p).toBeTruthy()
      const { headline, lede } = composeCopy(p, 2119876543, '2026-10-14', names)
      expect(headline.length).toBeGreaterThan(0)
      expect(lede.length).toBeGreaterThan(0)
      expect(`${headline}${lede}`).not.toMatch(/[{}]/)
    }
    expect(PERSONA_LABEL.pacifist).toBe('和平主义者')
  })

  it('skips templates whose data is missing', () => {
    expect(fillTemplate('{name}打了{kills}次', names)).toBeNull()
    expect(fillTemplate('{name}打了{kills}次', { ...names, kills: '12' })).toBe('Hanako Kisaragi 打了 12 次')
    for (const tone of ['gentle', 'snarky', 'mixed'] as const) {
      const { lede } = composeCopy('solo', 1, '2026-10-14', names, tone)
      expect(lede, tone).not.toMatch(/\d/)
    }
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

  it('tone modes pick from the right pools', () => {
    const lines = { gentle: ['g1', 'g2'], snarky: ['s1'] }
    expect(tonePool('gentle', lines)).toEqual(['g1', 'g2'])
    expect(tonePool('snarky', lines)).toEqual(['s1'])
    expect(tonePool('mixed', lines)).toEqual(['g1', 'g2', 's1'])
    const values = { ...names, kills: '300', losses: '100', solo: '88', eff: '88%', isk: '23.20B', k7: '14', ship: '马其顿级', system: '吉他', region: '伏尔戈', years: '7' }
    const pools = (tone: 'gentle' | 'snarky') => new Set([...PERSONA_LINES.solo[tone].headlines])
    const seen = { gentle: false, snarky: false }
    for (let day = 1; day <= 60; day++) {
      const key = `2026-09-${String(day % 30 + 1).padStart(2, '0')}`
      for (const id of [1, 2, 3, 4]) {
        const g = composeCopy('solo', id, key, values, 'gentle').headline
        const s = composeCopy('solo', id, key, values, 'snarky').headline
        expect([...pools('gentle')].some((t) => fillTemplate(t, values) === g), g).toBe(true)
        expect([...pools('snarky')].some((t) => fillTemplate(t, values) === s), s).toBe(true)
        const m = composeCopy('solo', id, key, values, 'mixed').headline
        if ([...pools('gentle')].some((t) => fillTemplate(t, values) === m)) seen.gentle = true
        if ([...pools('snarky')].some((t) => fillTemplate(t, values) === m)) seen.snarky = true
      }
    }
    // 混合两边都会选到
    expect(seen).toEqual({ gentle: true, snarky: true })
  })

  it('hash32 is stable', () => {
    expect(hash32('abc')).toBe(hash32('abc'))
    expect(hash32('abc')).not.toBe(hash32('abd'))
    expect(hash32('')).toBe(0x811c9dc5)
  })
})

describe('pickMood', () => {
  const idle = (n: number) => Array.from({ length: 12 }, (_, i) => ({ kills: i < 12 - n ? 3 : 0, losses: 0 }))
  const base: MoodInput = { weekKills: 0, months: idle(0), recentKillValue: null, recentLossValue: null }
  const key = (over: Partial<MoodInput>) => pickMoodKey({ ...base, ...over })

  it('hot week at 30 kills', () => {
    expect(key({ weekKills: R.moodWeekKills })).toBe('hotWeek')
    expect(key({ weekKills: R.moodWeekKills - 1 })).toBeNull()
    expect(key({ weekKills: null })).toBeNull()
  })

  it('dormant after 3 empty months, counting the months', () => {
    expect(key({ months: idle(2) })).toBeNull()
    expect(key({ months: idle(3) })).toBe('dormant')
    expect(idleMonths(idle(7))).toBe(7)
    expect(idleMonths(idle(0))).toBe(0)
    expect(key({ months: [] })).toBeNull()
  })

  it('big kill and big loss from 10B', () => {
    expect(key({ recentKillValue: 10e9 })).toBe('bigKill')
    expect(key({ recentKillValue: 9.9e9 })).toBeNull()
    expect(key({ recentLossValue: 12e9 })).toBe('bigLoss')
  })

  it('order: hot week, dormant, big kill, big loss', () => {
    expect(key({ weekKills: 40, recentKillValue: 20e9 })).toBe('hotWeek')
    expect(key({ months: idle(4), recentKillValue: 20e9 })).toBe('dormant')
    expect(key({ recentKillValue: 20e9, recentLossValue: 30e9 })).toBe('bigKill')
  })

  it('fills the line with the values and skips lines whose data is missing', () => {
    const values = { name: 'A', dormant: '5个月', bigKillIsk: '12.0B' }
    for (const tone of ['gentle', 'snarky', 'mixed'] as const) {
      expect(pickMood({ ...base, months: idle(5) }, values, tone, '1:2026-10-14', new Set())).toMatch(/5/)
      expect(pickMood({ ...base, recentKillValue: 12e9 }, values, tone, '1:2026-10-14', new Set())).toContain('12.0B')
      // 没有大损失的金额：这一类的句子都用到金额，整条跳过
      expect(pickMood({ ...base, recentLossValue: 12e9 }, values, tone, '1:2026-10-14', new Set())).toBeNull()
      expect(pickMood(base, values, tone, '1:2026-10-14', new Set())).toBeNull()
    }
  })
})

describe('spaceCjk', () => {
  it('adds a space between latin / digits and Chinese, not next to Chinese punctuation', () => {
    expect(spaceCjk('Kaito Minamoto不是飞船')).toBe('Kaito Minamoto 不是飞船')
    expect(spaceCjk('价值3B')).toBe('价值 3B')
    expect(spaceCjk('3B，好')).toBe('3B，好')
    expect(spaceCjk('（Kaito）击毁')).toBe('（Kaito）击毁')
    expect(spaceCjk('已经有空格 ABC 了')).toBe('已经有空格 ABC 了')
    expect(spaceCjk('纯中文')).toBe('纯中文')
  })

  it('fillTemplate applies it to the filled text', () => {
    expect(fillTemplate('{name}不是飞船', { name: 'Kaito Minamoto' })).toBe('Kaito Minamoto 不是飞船')
  })
})
