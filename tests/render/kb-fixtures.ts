// 人物卡出图测试用的编造数据（人物、军团、联盟、编号都是虚构的）

import type { PilotImageSet, PilotProfile, SystemView } from '../../src/core/types'

/** 1×1 的 PNG */
export const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const sys = (id: number, en: string, security: number, region: string): SystemView => ({
  id, en, zh: en, security, secClass: security >= 0.45 ? 'high' : security > 0 ? 'low' : 'null',
  constellation: null, region: { id: 10000000 + id, en: region, zh: region },
})

const NOW = Date.UTC(2026, 9, 14, 12, 0)

const base: PilotProfile = {
  id: 2119876543,
  name: 'Hanako Kisaragi',
  birthday: Date.UTC(2020, 4, 17, 20, 30),
  security: -2.3,
  title: 'Night Shift',
  corporation: { id: 98000001, name: 'Moonlit Harbor Logistics', ticker: 'MHL' },
  alliance: { id: 99000001, name: 'Fictional Federation', ticker: 'FICT' },
  birthplace: '摄于 Testville III - Fictional Academy',
  totals: { kills: 1284, losses: 312, solo: 331, iskKilled: 845.2e9, iskLost: 61.8e9, danger: 78, gang: 64, efficiency: 93 },
  week: { kills: 37, ships: 20, systems: 6, regions: 2 },
  months: Array.from({ length: 12 }, (_, i) => ({ ym: `2025-${String(i + 1).padStart(2, '0')}`, kills: 30 + i * 8, losses: 5 + (i % 4) * 3 })),
  ships: [
    { typeId: 1001, zh: '乌鸦级', en: 'Raven', kills: 412, share: 33 },
    { typeId: 1002, zh: '毒蜥级', en: 'Gila', kills: 301, share: 23 },
    { typeId: 1003, zh: '', en: 'Mystery Hull', kills: 198, share: 15 },
  ],
  places: [
    { systemId: 30000001, system: sys(30000001, 'Alpha-1', -0.4, 'Nowhere'), kills: 276 },
    { systemId: 30000002, system: sys(30000002, 'Beta-2', -0.5, 'Nowhere'), kills: 188 },
    { systemId: 30000003, system: sys(30000003, 'Gamma', 0.3, 'Elsewhere'), kills: 94 },
  ],
  activity: {
    source: 'killmails',
    samples: 120,
    hoursUtc: Array.from({ length: 24 }, (_, h) => (h >= 18 ? 60 : h < 4 ? 40 : 2)),
    hoursBeijing: Array.from({ length: 24 }, (_, h) => (h >= 2 && h < 8 ? 60 : h >= 12 && h < 16 ? 40 : 2)),
    peak: { beijingStart: 2, beijingEnd: 5, utcStart: 18, utcEnd: 21 },
    zones: [],
    text: '北京 02:00–05:00（EVE 18–21）',
  },
  recentKill: { killId: 1, ship: { typeId: 1002, zh: '毒蜥级', en: 'Gila' }, system: sys(30000001, 'Alpha-1', -0.4, 'Nowhere'), systemId: 30000001, time: Date.UTC(2026, 9, 12, 3), value: 3.2e9 },
  recentLoss: { killId: 2, ship: { typeId: 1003, zh: '', en: 'Mystery Hull' }, system: sys(30000002, 'Beta-2', -0.5, 'Nowhere'), systemId: 30000002, time: Date.UTC(2026, 9, 9, 3), value: 410e6 },
  persona: 'solo',
  personaLabel: '独狼猎手',
  headline: '独狼出没！',
  lede: 'Hanako Kisaragi 是一名出色的独狼猎手。累计击毁 1,284 艘舰船，其中 331 次单杀。',
  mood: '本周火力全开',
  tone: 'mixed',
  titles: ['泡泡大师', '战列舰老炮'],
  remarks: ['Hanako Kisaragi 的击毁价值占比 93%，账面很好看。'],
  letter: { body: 'Hanako Kisaragi今天又出门了，我替船坞祝福一声。', sign: '——一位热心的读者' },
  fortune: { yi: ['蹲门', '买保险'], ji: ['贪最后一发', '关掉预警'], comment: '今日小吉，记得带备用船' },
  ad: '补船厂欢迎Hanako Kisaragi来参观，免费咖啡管够。',
  footer: '数据：zKillboard / 欧服官方接口 · 本报纯属娱乐',
  updatedAt: NOW,
  partial: [],
  zkillFailure: null,
}

export const NOW_MS = NOW

export function soloHunter(): PilotProfile {
  return structuredClone(base)
}

export function rookie(): PilotProfile {
  return {
    ...structuredClone(base),
    id: 2119876544,
    name: 'Mika Tsukishiro',
    birthday: Date.UTC(2026, 8, 1, 8),
    title: null,
    alliance: null,
    totals: { kills: 3, losses: 4, solo: 1, iskKilled: 12e6, iskLost: 20e6, danger: null, gang: null, efficiency: 37.5 },
    months: Array.from({ length: 12 }, (_, i) => ({ ym: `2025-${String(i + 1).padStart(2, '0')}`, kills: i === 11 ? 3 : 0, losses: i === 11 ? 4 : 0 })),
    ships: [{ typeId: 1004, zh: '', en: 'Rookie Ship', kills: 3, share: 100 }],
    places: [{ systemId: 30000009, system: sys(30000009, 'Newbie', 0.9, 'Starter'), kills: 3 }],
    activity: { source: 'labels', samples: 0, hoursUtc: Array(24).fill(0), hoursBeijing: Array(24).fill(0), peak: null, zones: ['eu', 'use'], text: '主要活跃时段：欧洲时段 / 美东时段' },
    recentKill: null,
    recentLoss: null,
    persona: 'rookie',
    personaLabel: '初出茅庐',
    headline: '保护期刚过：Mika Tsukishiro',
    mood: null,
  }
}

export function ghost(): PilotProfile {
  return {
    ...structuredClone(base),
    id: 2119876545,
    name: 'Ren Aoyagi',
    title: null,
    corporation: null,
    alliance: null,
    birthplace: '摄于新伊甸某处',
    totals: { kills: 0, losses: 0, solo: 0, iskKilled: 0, iskLost: 0, danger: null, gang: null, efficiency: null },
    week: null,
    months: Array.from({ length: 12 }, (_, i) => ({ ym: `2025-${String(i + 1).padStart(2, '0')}`, kills: 0, losses: 0 })),
    ships: [],
    places: [],
    activity: null,
    recentKill: null,
    recentLoss: null,
    persona: 'ghost',
    personaLabel: '神秘人物',
    headline: '新伊甸查无此人战绩',
    lede: 'zKillboard 翻遍了档案，没有找到 Ren Aoyagi 的任何击杀或损失。',
    mood: null,
  }
}

export function images(): PilotImageSet {
  return { portrait: PIXEL, corporation: PIXEL, alliance: null, ships: { 1001: PIXEL, 1002: null } }
}

export function emptyImages(): PilotImageSet {
  return { portrait: null, corporation: null, alliance: null, ships: {} }
}
