import { describe, expect, it } from 'vitest'
import { KB_TITLE_SHIP_GROUPS } from '../../../src/constants'
import {
  ACTIVITY_TEXT, AD_LINES, BIRTHPLACE_TEXT, FOOTER_TEXT, FORTUNE_LINES, LETTER_LINES, MOOD_LINES, PERSONA_LABEL, PERSONA_LINES, REMARK_LINES,
  REMARK_RULES, TITLE_COPY, ZONE_NAMES, fillTemplate,
} from '../../../src/core/pilot'
import type { PersonaId } from '../../../src/core/types'

const TONES = ['gentle', 'snarky'] as const
const PERSONAS = Object.keys(PERSONA_LINES) as PersonaId[]

const FORBIDDEN = [
  '他', '她', '他们', '她们', '兄弟', '姐妹', '小哥', '妹子', '哥', '姐', '王子', '公主', '奶妈', '佬', '爷', '傻', '蠢', '笨', '废物', '脑残',
  '垃圾', '菜狗', '厕所', '没朋友', 'http',
]
/** 以前的红线：性别、地域、族群、脏话 */
const BANNED = /[男女]|哥们|姑娘|小伙|大叔|大妈|汉子|娘|美女|帅哥|菜鸡|弱智|白痴|智障|滚|妈|操你|操蛋|尼玛|卧槽|混蛋|王八|畜生|死全家|黑人|白人|老外|洋人|鬼子|阿三|猴|北方|南方|外地|农村|乡下|穷鬼|屌|逼/

/** 占位符按 3 个字算；headline 里的 {name} 不算（名字长度不定） */
const width = (text: string, nameFree = false) => text.replace(/\{(\w+)\}/g, (_, k: string) => (nameFree && k === 'name' ? '' : 'xxx')).length

interface Line {
  where: string
  text: string
  max: number
  min?: number
  nameFree?: boolean
}

function allLines(): Line[] {
  const out: Line[] = []
  for (const p of PERSONAS) {
    for (const t of TONES) {
      PERSONA_LINES[p][t].headlines.forEach((x) => out.push({ where: `headline ${p}/${t}`, text: x, max: 18, nameFree: true }))
      PERSONA_LINES[p][t].ledes.forEach((x) => out.push({ where: `lede ${p}/${t}`, text: x, max: 70 }))
    }
  }
  for (const [id, v] of Object.entries(REMARK_LINES)) for (const t of TONES) v[t].forEach((x) => out.push({ where: `remark ${id}/${t}`, text: x, max: 40 }))
  for (const [id, v] of Object.entries(TITLE_COPY)) {
    out.push({ where: `title label ${id}`, text: v.label, max: 8 })
    for (const t of TONES) v.remarks[t].forEach((x) => out.push({ where: `title remark ${id}/${t}`, text: x, max: 40 }))
  }
  for (const t of TONES) {
    LETTER_LINES[t].forEach((l) => {
      out.push({ where: `letter ${t}`, text: l.body, max: 80 })
      out.push({ where: `sign ${t}`, text: l.sign, max: 20 })
    })
    FORTUNE_LINES[t].yi.forEach((x) => out.push({ where: `yi ${t}`, text: x, max: 8, min: 2 }))
    FORTUNE_LINES[t].ji.forEach((x) => out.push({ where: `ji ${t}`, text: x, max: 8, min: 2 }))
    FORTUNE_LINES[t].comments.forEach((x) => out.push({ where: `comment ${t}`, text: x, max: 24 }))
    AD_LINES[t].forEach((x) => out.push({ where: `ad ${t}`, text: x, max: 50 }))
    for (const [k, v] of Object.entries(MOOD_LINES)) v[t].forEach((x) => out.push({ where: `mood ${k}/${t}`, text: x, max: 14 }))
  }
  return out
}

describe('copy tables: scan everything', () => {
  const lines = allLines()

  it('has a lot of copy', () => {
    expect(lines.length).toBeGreaterThan(1500)
  })

  it('no forbidden words, no banned words (gender, region, swearing, links)', () => {
    const fixed = [...Object.values(PERSONA_LABEL), FOOTER_TEXT, BIRTHPLACE_TEXT.at('X'), BIRTHPLACE_TEXT.fallback, ACTIVITY_TEXT.peak(20, 23, 12, 15), ACTIVITY_TEXT.zones(['A']), ...Object.values(ZONE_NAMES)]
    for (const text of [...lines.map((l) => l.text), ...fixed]) {
      for (const w of FORBIDDEN) expect(text.includes(w), `${w} in ${text}`).toBe(false)
      expect(text, text).not.toMatch(BANNED)
    }
  })

  it('length limits', () => {
    for (const l of lines) {
      const n = width(l.text, l.nameFree)
      expect(n, `${l.where}: ${l.text} (${n})`).toBeLessThanOrEqual(l.max)
      expect(n, `${l.where}: ${l.text}`).toBeGreaterThanOrEqual(l.min ?? 1)
    }
  })

  it('signs start with the dash', () => {
    for (const t of TONES) for (const l of LETTER_LINES[t]) expect(l.sign.startsWith('——'), l.sign).toBe(true)
  })

  it('title pool has no duplicates and bait/cyno are renamed', () => {
    for (const [id, v] of Object.entries(TITLE_COPY)) for (const t of TONES) expect(new Set(v.remarks[t]).size, `${id}/${t}`).toBe(v.remarks[t].length)
    expect(TITLE_COPY.cyno.label).toBe('诱导驾驶员')
    expect(TITLE_COPY.bait.label).toBe('众矢之的')
  })

  it('only known placeholders are used', () => {
    const known = new Set([
      'name', 'kills', 'losses', 'solo', 'eff', 'isk', 'iskLost', 'k7', 'ship', 'system', 'region', 'years', 'gang', 'danger', 'avgGang',
      'bigKill', 'bigKillIsk', 'bigLoss', 'bigLossIsk', 'dormant', 'peak',
    ])
    for (const l of lines) for (const m of l.text.matchAll(/\{(\w+)\}/g)) expect(known.has(m[1]), `${l.where}: ${l.text}`).toBe(true)
    for (const l of lines) expect(l.text.replace(/\{\w+\}/g, ''), l.text).not.toMatch(/[{}]/)
  })

  it('no duplicate lines inside one pool', () => {
    for (const [id, v] of Object.entries(REMARK_LINES)) for (const t of TONES) expect(new Set(v[t]).size, `${id}/${t}`).toBe(v[t].length)
    for (const t of TONES) {
      expect(new Set(AD_LINES[t]).size).toBe(AD_LINES[t].length)
      expect(new Set(LETTER_LINES[t].map((l) => l.body)).size).toBe(LETTER_LINES[t].length)
      expect(new Set(FORTUNE_LINES[t].yi).size).toBe(FORTUNE_LINES[t].yi.length)
      expect(new Set(FORTUNE_LINES[t].ji).size).toBe(FORTUNE_LINES[t].ji.length)
    }
  })

  it('every persona and tone has a name-only headline and lede (and enough of both)', () => {
    for (const p of PERSONAS) {
      for (const t of TONES) {
        const { headlines, ledes } = PERSONA_LINES[p][t]
        expect(headlines.length, `${p}/${t} headlines`).toBeGreaterThanOrEqual(3)
        expect(ledes.length, `${p}/${t} ledes`).toBeGreaterThanOrEqual(3)
        expect(headlines.some((x) => fillTemplate(x, { name: 'Hanako Kisaragi' }) !== null), `${p}/${t} headline`).toBe(true)
        expect(ledes.some((x) => fillTemplate(x, { name: 'Hanako Kisaragi' }) !== null), `${p}/${t} lede`).toBe(true)
      }
    }
  })

  it('every remark rule has copy in both tones, and a name-only line for the rules that always apply', () => {
    for (const r of REMARK_RULES) for (const t of TONES) expect(REMARK_LINES[r.id]?.[t].length, `${r.id}/${t}`).toBeGreaterThanOrEqual(3)
    for (const t of TONES) expect(REMARK_LINES.fallback[t].some((x) => fillTemplate(x, { name: 'A' }) !== null)).toBe(true)
  })

  it('title copy: every ship title and loss title has copy; letters and fortune have enough lines', () => {
    for (const id of [...Object.keys(KB_TITLE_SHIP_GROUPS), 'bait', 'cyno', 'pod', 'rookieShips', 'freighter', 'miner', 'soloLoser', 'highsecVictim',
      'capitalKiller', 'whaleHunter', 'fwVeteran', 'awoxSuspect', 'bigBattle', 'lowsecRanger', 'nullsecResident', 'soloKing']) {
      expect(TITLE_COPY[id], id).toBeDefined()
      for (const t of TONES) expect(TITLE_COPY[id].remarks[t].length, `${id}/${t}`).toBeGreaterThanOrEqual(3)
    }
    expect(Object.keys(TITLE_COPY)).toHaveLength(37)
    for (const t of TONES) {
      expect(LETTER_LINES[t].length).toBeGreaterThanOrEqual(10)
      expect(FORTUNE_LINES[t].yi.length).toBeGreaterThanOrEqual(10)
      expect(FORTUNE_LINES[t].ji.length).toBeGreaterThanOrEqual(10)
      expect(FORTUNE_LINES[t].comments.length).toBeGreaterThanOrEqual(5)
      expect(AD_LINES[t].length).toBeGreaterThanOrEqual(5)
    }
  })

  it('no curly quotes anywhere in the copy (use corner quotes)', () => {
    const fixed = [...Object.values(PERSONA_LABEL), FOOTER_TEXT, ACTIVITY_TEXT.zonesPrefix, ...Object.values(ZONE_NAMES)]
    for (const text of [...lines.map((l) => l.text), ...fixed]) expect(text, text).not.toMatch(/[\u201c\u201d\u2018\u2019]/)
  })

  it('dormant months are written as counts of months, never a bare 月', () => {
    for (const l of lines) expect(l.text, l.text).not.toMatch(/\{dormant\}月/)
    for (const t of TONES) {
      const text = MOOD_LINES.dormant[t].map((x) => fillTemplate(x, { dormant: '5个月' }))
      for (const x of text) expect(x, String(x)).toMatch(/5 个月/)
      // 一整年没记录写「一年多」，句子要读得通（不能出现「一年多个月」）
      for (const x of MOOD_LINES.dormant[t].map((y) => fillTemplate(y, { dormant: '一年多' }))) expect(x, String(x)).not.toMatch(/一年多个?月/)
    }
    // 占位符自带单位，句子里不能再写「个月」
    for (const l of lines) expect(l.text, l.text).not.toMatch(/\{dormant\}个?月/)
  })

  it('activity wording: peak ends at 24 instead of 0, zones have no prefix of their own', () => {
    expect(ACTIVITY_TEXT.peak(21, 0, 13, 16)).toBe('北京 21:00–24:00（EVE 13–16）')
    expect(ACTIVITY_TEXT.peak(2, 5, 18, 21)).toBe('北京 02:00–05:00（EVE 18–21）')
    expect(ACTIVITY_TEXT.peak(5, 8, 21, 0)).toBe('北京 05:00–08:00（EVE 21–24）')
    expect(ACTIVITY_TEXT.zones(['美东时段', '澳洲时段'])).toBe('美东时段 / 澳洲时段')
  })

  it('no real-looking ids or links in the copy', () => {
    for (const l of lines) expect(l.text, l.text).not.toMatch(/\d{6,}|www\.|\.com|\.net/)
  })
})
