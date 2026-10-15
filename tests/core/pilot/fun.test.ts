import { describe, expect, it } from 'vitest'
import { AD_LINES, FORTUNE_LINES, LETTER_LINES, composeFun, fillTemplate, formatPeak, pickAd, pickFortune, pickLetter } from '../../../src/core/pilot'
import type { FunInput } from '../../../src/core/pilot'
import { facts, VALUES } from './fun-helpers'

const TONES = ['gentle', 'snarky', 'mixed'] as const

function input(over: Partial<FunInput> = {}): FunInput {
  return {
    characterId: 2119876543,
    dayKey: '2026-10-14',
    tone: 'mixed',
    facts: facts({
      stats: { kills: 1200, losses: 600, iskKilled: 20e9, iskLost: 90e9, week: { kills: 40, ships: 1, systems: 1, regions: 1 } },
      recentKillValue: 12e9,
      shipGroups: [{ groupId: 834, kills: 500 }],
      totalKills: 1200,
      persona: 'underdog',
    }),
    values: VALUES,
    mood: { weekKills: 40, months: [], recentKillValue: 12e9, recentLossValue: null },
    ...over,
  }
}

const cardLines = (c: ReturnType<typeof composeFun>) => [
  c.headline, c.lede, ...(c.mood ? [c.mood] : []), ...c.remarks, ...(c.letter ? [c.letter.body] : []), ...c.fortune.yi, ...c.fortune.ji, c.fortune.comment, ...(c.ad ? [c.ad] : []),
]

describe('composeFun', () => {
  it('fills every section', () => {
    const c = composeFun(input())
    // 近期击落 120 亿的船，所以多一个百亿猎手
    expect(c.titles).toEqual(['百亿猎手', '隐轰投弹高手'])
    expect(c.remarks).toHaveLength(1)
    expect(c.letter?.sign.startsWith('——')).toBe(true)
    expect(c.fortune.yi).toHaveLength(2)
    expect(c.fortune.ji).toHaveLength(2)
    expect(c.fortune.comment).not.toBe('')
    expect(c.ad).not.toBeNull()
    expect(c.mood).not.toBeNull()
    expect(cardLines(c).join('')).not.toMatch(/[{}]/)
  })

  it('is deterministic per person per day, and differs on other days and for other people', () => {
    const a = composeFun(input())
    expect(composeFun(input())).toEqual(a)
    const days = new Set<string>()
    const people = new Set<string>()
    for (let d = 1; d <= 20; d++) {
      days.add(JSON.stringify(composeFun(input({ dayKey: `2026-10-${String(d).padStart(2, '0')}` }))))
      people.add(JSON.stringify(composeFun(input({ characterId: 2100000000 + d }))))
    }
    expect(days.size).toBeGreaterThan(10)
    expect(people.size).toBeGreaterThan(10)
  })

  it('no duplicate lines on one card, across 300 cards', () => {
    for (const tone of TONES) {
      for (let id = 1; id <= 100; id++) {
        const c = composeFun(input({ characterId: id, tone, dayKey: `2026-10-${String(id % 28 + 1).padStart(2, '0')}` }))
        const lines = cardLines(c)
        expect(new Set(lines).size, `${tone}/${id}`).toBe(lines.length)
        expect(new Set(c.fortune.yi).size).toBe(2)
        expect(new Set(c.fortune.ji).size).toBe(2)
        expect(new Set(c.titles).size).toBe(c.titles.length)
      }
    }
  })

  it('tone pools: gentle uses only gentle lines, snarky only snarky lines', () => {
    const fill = (xs: readonly string[]) => xs.map((t) => fillTemplate(t, VALUES))
    for (let id = 1; id <= 30; id++) {
      for (const tone of ['gentle', 'snarky'] as const) {
        const c = composeFun(input({ characterId: id, tone }))
        expect(fill(FORTUNE_LINES[tone].yi), tone).toEqual(expect.arrayContaining(c.fortune.yi))
        expect(fill(FORTUNE_LINES[tone].ji)).toEqual(expect.arrayContaining(c.fortune.ji))
        expect(fill(FORTUNE_LINES[tone].comments)).toContain(c.fortune.comment)
        expect(fill(AD_LINES[tone])).toContain(c.ad)
        expect(LETTER_LINES[tone].map((l) => fillTemplate(l.sign, VALUES))).toContain(c.letter!.sign)
      }
    }
  })

  it('mixed mode shows both tones across many cards', () => {
    const gentleAds = new Set(AD_LINES.gentle.map((t) => fillTemplate(t, VALUES)))
    const seen = { gentle: false, snarky: false }
    for (let id = 1; id <= 60; id++) {
      const ad = composeFun(input({ characterId: id })).ad!
      if (gentleAds.has(ad)) seen.gentle = true
      else seen.snarky = true
    }
    expect(seen).toEqual({ gentle: true, snarky: true })
  })

  it('unknown: no mood, titles, remarks or letter, but the safe sections stay', () => {
    const c = composeFun(input({ facts: facts({ persona: 'unknown' }), values: { name: 'Hanako Kisaragi' } }))
    expect(c.mood).toBeNull()
    expect(c.titles).toEqual([])
    expect(c.remarks).toEqual([])
    expect(c.letter).toBeNull()
    expect(c.fortune.yi).toHaveLength(2)
    expect(c.headline.length).toBeGreaterThan(0)
  })

  it('ghost: no mood, titles or remarks', () => {
    const c = composeFun(input({ facts: facts({ persona: 'ghost', stats: { kills: 0, losses: 0 } }), values: { name: 'Hanako Kisaragi' } }))
    expect(c.mood).toBeNull()
    expect(c.titles).toEqual([])
    expect(c.remarks).toEqual([])
    expect(c.letter).not.toBeNull()
  })

  it('placeholders without a value are skipped, never printed', () => {
    for (let id = 1; id <= 40; id++) {
      const c = composeFun(input({ characterId: id, values: { name: 'Hanako Kisaragi' } }))
      expect(cardLines(c).join(''), String(id)).not.toMatch(/[{}]/)
    }
  })
})

describe('extras', () => {
  const ctx = (tone: (typeof TONES)[number], seed = '1:2026-10-14') => ({ values: VALUES, tone, seed, used: new Set<string>() })

  it('letter: body is filled, sign belongs to the same letter', () => {
    for (const tone of TONES) {
      const l = pickLetter(ctx(tone))!
      const owner = [...LETTER_LINES.gentle, ...LETTER_LINES.snarky].find((x) => fillTemplate(x.body, VALUES) === l.body)
      expect(fillTemplate(owner!.sign, VALUES)).toBe(l.sign)
    }
  })

  it('letter: sign placeholders are filled, missing value skips the letter', () => {
    const l = pickLetter(ctx('gentle'))!
    expect(l.sign).not.toMatch(/[{}]/)
    for (const tone of TONES) for (let i = 0; i < 30; i++) {
      const got = pickLetter({ ...ctx(tone, `${i}:2026-10-14`), values: { name: 'Hanako Kisaragi' } })
      if (got) expect(`${got.body}${got.sign}`).not.toMatch(/[{}]/)
    }
    expect(fillTemplate('——被{name}击毁过的读者', { name: 'Hanako Kisaragi' })).toBe('——被 Hanako Kisaragi 击毁过的读者')
    expect(fillTemplate('——被{name}击毁过的读者', {})).toBeNull()
  })

  it('peak: midnight end is 24, crossing midnight says next day', () => {
    expect(formatPeak(21, 0)).toBe('21–24 点')
    expect(formatPeak(20, 23)).toBe('20–23 点')
    expect(formatPeak(22, 1)).toBe('22–次日1 点')
  })

  it('fortune: 2 + 2 distinct items and a comment', () => {
    for (const tone of TONES) {
      const f = pickFortune(ctx(tone))
      expect(new Set([...f.yi, ...f.ji]).size).toBe(4)
      expect(f.comment.length).toBeGreaterThan(0)
    }
  })

  it('ad: one line, changes with the seed', () => {
    const seen = new Set<string | null>()
    for (let d = 1; d <= 20; d++) seen.add(pickAd(ctx('mixed', `1:2026-10-${d}`)))
    expect(seen.size).toBeGreaterThan(3)
  })
})
