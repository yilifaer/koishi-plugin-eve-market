// PilotProfiles：真的 EsiApi + ZkillClient + PilotProfiles，ESI 和 zKill 都指向本机的假服务。

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BEIJING_UTC_OFFSET_HOURS, KB_CARD_CACHE_MIN, KB_RECENT_MAX_DAYS } from '../../../src/constants'
import { PilotProfiles } from '../../../src/core/pilot'
import type { PilotProfileDeps } from '../../../src/core/pilot'
import { createModuleStore } from '../../../src/core/ports'
import { isFailure } from '../../../src/core/types'
import type { CoreFailure, ItemInfo, PilotProfile, SystemView } from '../../../src/core/types'
import { ZkillClient } from '../../../src/core/zkill'
import { rawCharacter } from '../../fakes/fake-esi'
import { FakeZkill, rawZkillKill } from '../../fakes/fake-zkill'
import type { RawZkillKill } from '../../fakes/fake-zkill'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { closeAll, makeEnv, realScheduler } from '../esi/helpers'
import type { Env } from '../esi/helpers'

const zkills: FakeZkill[] = []
const clients: ZkillClient[] = []
afterEach(async () => {
  clients.splice(0).forEach((c) => c.stop())
  await closeAll()
  await Promise.all(zkills.splice(0).map((z) => z.stop()))
})

const HANAKO = 2119876543
const HASH = '0123456789abcdef0123456789abcdef01234567'
const MIN = 60_000
const DAY = 86_400_000
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/pilot', name), 'utf8'))

const ship = (typeId: number, en: string, zh: string, groupId = 25) => ({ typeId, en, zh, groupId }) as ItemInfo
const SHIPS = new Map([
  [17738, ship(17738, 'Machariel', '马其顿级')], [11978, ship(11978, 'Scimitar', '弯刀级', 832)], [638, ship(638, 'Raven', '乌鸦级', 27)],
  [587, ship(587, 'Rifter', '裂谷级')], [23919, ship(23919, 'Aeon', '永恒级', 659)],
])
const view = (id: number, en: string, zh: string, region = '绝地之域'): SystemView => ({
  id, en, zh, security: -0.38, secClass: 'null', constellation: { id: 1, en: 'C', zh: 'C' }, region: { id: 10000060, en: 'Delve', zh: region },
})
const SYSTEMS = new Map([[30000142, view(30000142, 'Jita', '吉他', '伏尔戈')], [30000144, view(30000144, 'Perimeter', '外围星系')]])
const format = { compact: (v: number) => (v >= 1e12 ? `${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : String(v)) }

interface Opts {
  stats?: unknown
  /** 不放统计（zKill 回 {}） */
  noStats?: boolean
  kills?: RawZkillKill[]
  losses?: RawZkillKill[]
  char?: Partial<ReturnType<typeof rawCharacter>> | null
  minIntervalMs?: number
  recentDeadlineMs?: number
  birthplaceWaitMs?: number
  history?: boolean
  homeStation?: boolean
  station?: 'zh' | 'en-only' | 'missing'
  corp?: boolean
}

interface Made {
  profiles: PilotProfiles
  zkill: FakeZkill
  env: Env
  client: ZkillClient
}

async function make(o: Opts = {}): Promise<Made> {
  const zkill = await new FakeZkill().start()
  zkills.push(zkill)
  const env = await makeEnv({ contact: 'me@example.test' }, (f) => {
    f.cacheMode = 'none'
    if (o.char !== null) f.characters.set(HANAKO, rawCharacter({ title: '<color=0xffffffff><b>Quartermaster</b></color>', description: 'secret blurb', ...o.char }))
    if (o.corp !== false) {
      f.corporations.set(98000501, { name: 'Moonlit Harbor Logistics', ticker: 'MHL', home_station_id: 60009001 })
      f.alliances.set(99000501, { name: 'Fictional Federation', ticker: 'FICT' })
    }
    if (o.history !== false) {
      f.corpHistory.set(HANAKO, [
        { corporation_id: 98000501, record_id: 77, start_date: '2023-01-01T00:00:00Z' },
        { corporation_id: 1000115, record_id: 5, start_date: '2019-03-14T08:30:00Z' },
        { corporation_id: 98000777, record_id: 31, start_date: '2021-06-01T00:00:00Z' },
      ])
      f.corporations.set(1000115, { name: 'Fictional Academy', ticker: 'FACAD', ...(o.homeStation === false ? {} : { home_station_id: 60009999 }) })
    }
    if (o.station !== 'missing') {
      f.stations.set(60009999, { name: 'Fictional IV - Moon 2 - Test Assembly Plant', system_id: 30009999, ...(o.station === 'en-only' ? {} : { zhName: '虚构 IV - 卫星 2 - 测试组装厂' }) })
    }
  })
  if (!o.noStats) zkill.stats.set(HANAKO, o.stats ?? fixture('zkill-stats-full.json'))
  zkill.charKills.set(HANAKO, o.kills ?? [])
  zkill.charLosses.set(HANAKO, o.losses ?? [])
  const client = new ZkillClient(
    { http: new NodeHttpClient(), clock: env.clock, scheduler: realScheduler, logger: env.logger, store: createModuleStore() },
    { base: zkill.base, userAgent: env.client.userAgent, minIntervalMs: o.minIntervalMs ?? 0 },
  )
  clients.push(client)
  const deps: PilotProfileDeps = {
    esi: env.api, zkill: client, items: { byId: (id) => SHIPS.get(id) }, universe: { system: (id) => SYSTEMS.get(id) }, format,
    clock: env.clock, scheduler: realScheduler, logger: env.logger,
    recentDeadlineMs: o.recentDeadlineMs, birthplaceWaitMs: o.birthplaceWaitMs,
  }
  return { profiles: new PilotProfiles(deps), zkill, env, client }
}

const ok = (r: PilotProfile | CoreFailure): PilotProfile => {
  if (isFailure(r)) throw new Error(`应该成功：${r.code} ${r.message}`)
  return r
}

let nextKill = 131_000_000
/** 在 daysAgo 天前的某个 UTC 小时发生的击杀 / 损失；shipTypeId 是被击毁的船 */
function mail(env: Env, daysAgo: number, hourUtc: number, value: number, shipTypeId = 638, systemId = 30000142): RawZkillKill {
  const day = new Date(env.clock.now() - daysAgo * DAY)
  const time = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc, 15, 0)).toISOString().replace('.000Z', 'Z')
  return rawZkillKill(++nextKill, HASH, { totalValue: value }, { killmail_time: time, solar_system_id: systemId, victim: { ship_type_id: shipTypeId, damage_taken: 100 } })
}

/** 12 条以上的样本，主要集中在 UTC 12–14 点 */
function busy(env: Env, count = 14): RawZkillKill[] {
  return Array.from({ length: count }, (_, i) => mail(env, 1 + (i % 20), i < 11 ? 12 + (i % 3) : 3 + i, 1e8 + i))
}

describe('PilotProfiles: a complete card', () => {
  async function full() {
    const made = await make()
    made.zkill.charKills.set(HANAKO, [
      ...busy(made.env),
      mail(made.env, 2, 12, 3.2e9, 638, 30000144),
      mail(made.env, 2, 13, 9e9, 11978),
      mail(made.env, KB_RECENT_MAX_DAYS + 5, 12, 80e9, 17738),
    ])
    made.zkill.charLosses.set(HANAKO, [mail(made.env, 4, 13, 2.1e8, 587), mail(made.env, 6, 14, 6.5e8, 17738), mail(made.env, 40, 14, 90e9, 17738)])
    return made
  }

  it('assembles identity, organisations, totals, ships, places and months', async () => {
    const { profiles, env } = await full()
    const p = ok(await profiles.profile(HANAKO))
    expect(p).toMatchObject({
      id: HANAKO, name: 'Hanako Kisaragi', birthday: Date.UTC(2019, 2, 14, 8, 30), security: 1.5, title: 'Quartermaster',
      corporation: { id: 98000501, name: 'Moonlit Harbor Logistics', ticker: 'MHL' },
      alliance: { id: 99000501, name: 'Fictional Federation', ticker: 'FICT' },
      partial: [], zkillFailure: null,
    })
    expect(p.totals).toEqual({ kills: 290, losses: 52, solo: 88, iskKilled: 23_200_000_000, iskLost: 3_100_000_000, danger: 82, gang: 38, efficiency: 88.2 })
    expect(p.week).toEqual({ kills: 14, ships: 6, systems: 3, regions: 2 })
    expect(p.ships.map((s) => [s.typeId, s.zh, s.en, s.kills, s.share])).toEqual([
      [17738, '马其顿级', 'Machariel', 120, 41],
      [11978, '弯刀级', 'Scimitar', 60, 21],
      [638, '乌鸦级', 'Raven', 40, 14],
      [587, '裂谷级', 'Rifter', 20, 7],
    ])
    expect(p.places.map((x) => [x.systemId, x.system?.zh, x.kills])).toEqual([[30000142, '吉他', 90], [30000144, '外围星系', 50], [31000005, undefined, 10]])
    expect(p.months).toHaveLength(12)
    expect(p.months.map((m) => m.ym)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
    // 2 月没有记录，补 0；2025-10 之前的月份不在窗口里
    expect(p.months[3]).toEqual({ ym: '2026-02', kills: 0, losses: 0 })
    expect(p.months[0]).toEqual({ ym: '2025-11', kills: 12, losses: 3 })
    expect(env.fake.requests.length).toBeGreaterThan(0)
  })

  it('never carries the zKill description or raw html anywhere', async () => {
    const { profiles } = await full()
    const text = JSON.stringify(ok(await profiles.profile(HANAKO)))
    expect(text).not.toMatch(/secret blurb|evil\.example|spam\.example|<color|<b>|description/)
  })

  it('persona, copy, footer and updatedAt', async () => {
    const { profiles, env } = await full()
    const p = ok(await profiles.profile(HANAKO))
    expect(p.persona).toBe('solo')
    expect(p.personaLabel).toBe('独狼猎手')
    expect(`${p.headline}${p.lede}`).toContain('Hanako Kisaragi')
    expect(p.footer).toContain('zKillboard')
    expect(p.updatedAt).toBe(env.clock.now())
    // 近 7 天 14 次击毁，没到 30；大击杀也不到 10B
    expect(p.mood).toBeNull()
  })

  it('recent big kill / loss: highest value inside the window, victim ship, system and time', async () => {
    const { profiles } = await full()
    const p = ok(await profiles.profile(HANAKO))
    expect(p.recentKill).toMatchObject({ value: 9e9, ship: { typeId: 11978, zh: '弯刀级', en: 'Scimitar' }, systemId: 30000142 })
    expect(p.recentKill?.system?.zh).toBe('吉他')
    expect(p.recentLoss).toMatchObject({ value: 6.5e8, ship: { typeId: 17738, zh: '马其顿级' } })
    // 窗口之外的 80B / 90B 不显示
    expect(p.recentKill!.time).toBeGreaterThan(p.updatedAt - KB_RECENT_MAX_DAYS * DAY)
  })

  it('active hours: Beijing time first, EVE time in brackets', async () => {
    const { profiles } = await full()
    const a = ok(await profiles.profile(HANAKO)).activity!
    expect(a.source).toBe('killmails')
    expect(a.samples).toBe(20)
    expect(a.peak).toMatchObject({ utcStart: 12, utcEnd: 15, beijingStart: 20, beijingEnd: 23 })
    expect(a.text).toBe('北京 20:00–23:00（EVE 12–15）')
    expect(a.hoursUtc).toHaveLength(24)
    expect(a.hoursUtc.reduce((n, v) => n + v, 0)).toBe(20)
    for (let h = 0; h < 24; h++) expect(a.hoursBeijing[h]).toBe(a.hoursUtc[(h - BEIJING_UTC_OFFSET_HOURS + 24) % 24])
  })

  it('birthplace caption: smallest record_id corp → home station → localized station name', async () => {
    const { profiles } = await full()
    expect(ok(await profiles.profile(HANAKO)).birthplace).toBe('摄于 虚构 IV - 卫星 2 - 测试组装厂')
  })

  it('uses at most 3 zKill requests (stats, kills, losses) and follows the stats 302', async () => {
    const { profiles, zkill, env } = await full()
    ok(await profiles.profile(HANAKO))
    expect(zkill.count(/^\/api\/stats\/characterID\/\d+\/$/)).toBe(1)
    expect(zkill.count(/^\/api\/stats\/characterID\/\d+\/kills\/$/)).toBe(1)
    expect(zkill.count(/^\/api\/kills\/characterID\//)).toBe(1)
    expect(zkill.count(/^\/api\/losses\/characterID\//)).toBe(1)
    expect(zkill.requests).toHaveLength(4)
    expect(zkill.requests.every((r) => r.userAgent === env.client.userAgent && r.accept === 'application/json')).toBe(true)
  })

  it('goes through the shared queue: requests are serial and spaced by the minimum interval', async () => {
    const { profiles, zkill } = await make({ minIntervalMs: 70 })
    zkill.charKills.set(HANAKO, [])
    ok(await profiles.profile(HANAKO))
    const at = zkill.times
    expect(at).toHaveLength(4)
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(60)
  })

  it('caches the finished card for an hour: no new requests, then refetch after expiry', async () => {
    const { profiles, zkill, env } = await full()
    const first = ok(await profiles.profile(HANAKO))
    const sent = [zkill.requests.length, env.fake.requests.length]
    expect(ok(await profiles.profile(HANAKO))).toBe(first)
    expect(ok(await profiles.profile(HANAKO, { recent: false }))).toBe(first)
    expect([zkill.requests.length, env.fake.requests.length]).toEqual(sent)
    env.clock.advance((KB_CARD_CACHE_MIN + 1) * MIN)
    ok(await profiles.profile(HANAKO))
    expect(zkill.requests.length).toBeGreaterThan(sent[0])
  })

  it('merges concurrent calls for the same character', async () => {
    const { profiles, zkill, env } = await full()
    const results = await Promise.all([profiles.profile(HANAKO), profiles.profile(HANAKO), profiles.profile(HANAKO)])
    expect(new Set(results.map((r) => ok(r))).size).toBe(1)
    expect(env.fake.count(new RegExp(`/characters/${HANAKO}$`))).toBe(1)
    expect(zkill.count(/stats/)).toBe(2)
  })
})

describe('PilotProfiles: activity fallbacks', () => {
  it('fewer than 10 samples: time-zone labels instead of hours', async () => {
    const made = await make()
    made.zkill.charKills.set(HANAKO, [mail(made.env, 1, 12, 1e8), mail(made.env, 2, 13, 1e8)])
    const a = ok(await made.profiles.profile(HANAKO)).activity!
    expect(a).toMatchObject({ source: 'labels', samples: 2, peak: null, zones: ['eu', 'use', 'au'], text: '主要时区：欧洲 / 美东 / 澳洲' })
  })

  it('recent: false makes no list requests and uses the labels', async () => {
    const { profiles, zkill } = await make()
    const p = ok(await profiles.profile(HANAKO, { recent: false }))
    expect(zkill.count(/\/api\/(kills|losses)\//)).toBe(0)
    expect(p.activity?.source).toBe('labels')
    expect(p.recentKill).toBeNull()
    expect(p.partial).toEqual([])
    // 之后要近期数据的请求不会被这份不带近期数据的缓存满足
    ok(await profiles.profile(HANAKO))
    expect(zkill.count(/\/api\/kills\//)).toBe(1)
  })

  it('no hours and no labels: no activity line', async () => {
    const { profiles } = await make({ stats: { shipsDestroyed: 40, shipsLost: 10, iskDestroyed: 1e9, iskLost: 1e8 } })
    const p = ok(await profiles.profile(HANAKO))
    expect(p.activity).toBeNull()
  })
})

describe('PilotProfiles: partial results', () => {
  it('the lists time out: only the recent section and the hours are dropped, the card is not cached', async () => {
    const { profiles, zkill } = await make({ recentDeadlineMs: 150 })
    zkill.hang = /^\/api\/(kills|losses)\//
    const started = Date.now()
    const p = ok(await profiles.profile(HANAKO))
    expect(Date.now() - started).toBeLessThan(2500)
    expect(p.partial).toEqual(['recent'])
    expect(p.recentKill).toBeNull()
    expect(p.recentLoss).toBeNull()
    expect(p.activity?.source).toBe('labels')
    expect(p.totals.kills).toBe(290)
    expect(p.ships).toHaveLength(4)
    expect(p.zkillFailure).toBeNull()
    // 没缓存：列表还卡着的时候，下一次仍然是缺项的结果（不会把「暂时没取到」当成成品放一小时）
    const again = ok(await profiles.profile(HANAKO))
    expect(again).not.toBe(p)
    expect(again.partial).toEqual(['recent'])
  })

  it('one list that cannot be read keeps the other', async () => {
    const made = await make()
    made.zkill.charKills.set(HANAKO, busy(made.env))
    made.zkill.charLosses.set(HANAKO, { not: 'an array' })
    const p = ok(await made.profiles.profile(HANAKO))
    expect(p.partial).toEqual(['recent'])
    expect(p.activity?.source).toBe('killmails')
    expect(p.recentKill).not.toBeNull()
    expect(p.recentLoss).toBeNull()
  })

  it('zKill down: still a profile from ESI, persona unknown, reason attached, not cached', async () => {
    const { profiles, zkill } = await make()
    zkill.faults.push({ kind: 'status', status: 500 })
    const p = ok(await profiles.profile(HANAKO))
    expect(p.partial).toEqual(['zkill'])
    expect(p.zkillFailure).toMatchObject({ ok: false, code: 'ZKILL_UNAVAILABLE' })
    expect(p).toMatchObject({ name: 'Hanako Kisaragi', persona: 'unknown', personaLabel: '战绩暂缺', activity: null, ships: [], recentKill: null })
    expect(p.totals.kills).toBe(0)
    expect(p.corporation?.ticker).toBe('MHL')
    expect(p.headline).toContain('Hanako Kisaragi')
    expect(p.mood).toBeNull()
    // 没有拿 zKill 的数据去查列表
    expect(zkill.count(/\/api\/(kills|losses)\//)).toBe(0)
  })

  it('zKill throttled: ZKILL_THROTTLED with retryAt', async () => {
    const { profiles, zkill, env } = await make()
    zkill.faults.push({ kind: 'rate-limit', retryAfter: 120 })
    const p = ok(await profiles.profile(HANAKO))
    expect(p.partial).toEqual(['zkill'])
    expect(p.zkillFailure).toMatchObject({ code: 'ZKILL_THROTTLED', retryAt: env.clock.now() + 120_000 })
  })

  it('zKill blocked by Cloudflare: ZKILL_THROTTLED too', async () => {
    const { profiles, zkill } = await make()
    zkill.faults.push({ kind: 'challenge' })
    expect(ok(await profiles.profile(HANAKO)).zkillFailure).toMatchObject({ code: 'ZKILL_THROTTLED' })
  })

  it('stats that cannot be read are treated as no record, never an error', async () => {
    const { profiles } = await make({ stats: 'garbage' })
    const p = ok(await profiles.profile(HANAKO))
    expect(p.partial).toEqual([])
    expect(p.persona).toBe('ghost')
  })
})

describe('PilotProfiles: no record, rookies and special personas', () => {
  it('never on zKill: ghost, no list requests, no mood', async () => {
    const { profiles, zkill } = await make({ noStats: true })
    const p = ok(await profiles.profile(HANAKO))
    expect(p).toMatchObject({ persona: 'ghost', partial: [], mood: null, activity: null })
    expect(p.totals).toMatchObject({ kills: 0, losses: 0, efficiency: null })
    expect(zkill.count(/\/api\/(kills|losses)\//)).toBe(0)
  })

  it('a character younger than 90 days is a rookie', async () => {
    const { profiles, env } = await make({ char: { birthday: new Date(Date.UTC(2026, 8, 1)).toISOString() } })
    expect(env.clock.now()).toBeGreaterThan(0)
    expect(ok(await profiles.profile(HANAKO)).persona).toBe('rookie')
  })

  it('a capital top ship makes a capital pilot', async () => {
    const stats = { ...(fixture('zkill-stats-full.json') as object), topAllTime: [{ type: 'ship', data: [{ kills: 100, shipTypeID: 23919 }] }] }
    const { profiles } = await make({ stats })
    expect(ok(await profiles.profile(HANAKO)).persona).toBe('capital')
  })

  it('dormant pilots get the 潜水 mood', async () => {
    const stats = { shipsDestroyed: 60, shipsLost: 40, iskDestroyed: 5e9, iskLost: 2e9, months: { '202401': { year: 2024, month: 1, shipsDestroyed: 60, shipsLost: 40 } } }
    const { profiles } = await make({ stats })
    const p = ok(await profiles.profile(HANAKO))
    expect(p.mood).toBe('已潜水一年以上')
    expect(p.months.every((m) => m.kills === 0)).toBe(true)
  })
})

describe('PilotProfiles: ESI trouble', () => {
  it('an id that is not a character: NOT_A_CHARACTER, remembered for a while', async () => {
    const { profiles, env } = await make({ char: null })
    expect(await profiles.profile(HANAKO)).toMatchObject({ ok: false, code: 'NOT_A_CHARACTER' })
    expect(await profiles.profile(HANAKO)).toMatchObject({ ok: false, code: 'NOT_A_CHARACTER' })
    expect(env.fake.count(new RegExp(`/characters/${HANAKO}$`))).toBe(1)
    expect(await profiles.profile(0)).toMatchObject({ ok: false, code: 'NOT_A_CHARACTER' })
    expect(await profiles.profile(1.5)).toMatchObject({ ok: false, code: 'NOT_A_CHARACTER' })
  })

  it('ESI down: UPSTREAM_UNAVAILABLE', async () => {
    const { profiles, env } = await make()
    env.fake.fault('GET', /^\/characters\/\d+$/, { status: 500 }, 5)
    expect(await profiles.profile(HANAKO)).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
  })

  it('does not hit zKill lists when ESI says there is no such character', async () => {
    const { profiles, zkill } = await make({ char: null })
    await profiles.profile(HANAKO)
    expect(zkill.count(/\/api\/(kills|losses)\//)).toBe(0)
  })

  it('corporation unknown: no organisation, partial corp, not cached', async () => {
    const { profiles, env } = await make({ corp: false })
    const p = ok(await profiles.profile(HANAKO))
    expect(p.corporation).toBeNull()
    expect(p.alliance).toBeNull()
    expect(p.partial).toEqual(['corp'])
    const before = env.fake.requests.length
    ok(await profiles.profile(HANAKO))
    expect(env.fake.requests.length).toBeGreaterThan(before)
  })

  it('a character without an alliance has alliance null and no partial', async () => {
    const { profiles } = await make({ char: { alliance_id: undefined } })
    const p = ok(await profiles.profile(HANAKO))
    expect(p.alliance).toBeNull()
    expect(p.partial).toEqual([])
  })

  it('deadline: DEADLINE now, the work continues and the next call is served from the cache', async () => {
    const { profiles, env, zkill } = await make()
    env.fake.fault('GET', /^\/characters\/\d+$/, { delayMs: 250 })
    const started = Date.now()
    expect(await profiles.profile(HANAKO, { deadlineMs: 60 })).toMatchObject({ ok: false, code: 'DEADLINE' })
    expect(Date.now() - started).toBeLessThan(200)
    await new Promise((r) => setTimeout(r, 900))
    const sent = zkill.requests.length
    expect(ok(await profiles.profile(HANAKO)).name).toBe('Hanako Kisaragi')
    expect(zkill.requests.length).toBe(sent)
  })
})

describe('PilotProfiles: birthplace caption', () => {
  const FALLBACK = '摄于新伊甸某处'

  it('English name when there is no localized name', async () => {
    const { profiles } = await make({ station: 'en-only' })
    expect(ok(await profiles.profile(HANAKO)).birthplace).toBe('摄于 Fictional IV - Moon 2 - Test Assembly Plant')
  })

  it.each([
    ['no corporation history', { history: false }],
    ['no home station', { homeStation: false }],
    ['station gone', { station: 'missing' as const }],
  ])('falls back to 新伊甸某处 when %s, and that is not a partial result', async (_, opts) => {
    const { profiles } = await make(opts)
    const p = ok(await profiles.profile(HANAKO))
    expect(p.birthplace).toBe(FALLBACK)
    expect(p.partial).toEqual([])
  })

  it('a temporary ESI failure also falls back, but marks the card partial (not cached)', async () => {
    const { profiles, env } = await make()
    env.fake.fault('GET', /corporationhistory$/, { status: 503 }, 5)
    const p = ok(await profiles.profile(HANAKO))
    expect(p.birthplace).toBe(FALLBACK)
    expect(p.partial).toEqual(['birthplace'])
  })

  it('a slow chain times out into the fallback without holding the card', async () => {
    const { profiles, env } = await make({ birthplaceWaitMs: 80 })
    env.fake.fault('GET', /corporationhistory$/, { delayMs: 400 })
    const started = Date.now()
    const p = ok(await profiles.profile(HANAKO))
    expect(Date.now() - started).toBeLessThan(380)
    expect(p.birthplace).toBe(FALLBACK)
    expect(p.partial).toEqual(['birthplace'])
  })
})

describe('PilotProfiles: title', () => {
  it('omitted when empty, cleaned and capped otherwise', async () => {
    const none = await make({ char: { title: '' } })
    expect(ok(await none.profiles.profile(HANAKO)).title).toBeNull()
    const markup = await make({ char: { title: '<b></b>' } })
    expect(ok(await markup.profiles.profile(HANAKO)).title).toBeNull()
    const long = await make({ char: { title: `<color=0xff00ff00>${'Chief '.repeat(10)}</color>` } })
    const t = ok(await long.profiles.profile(HANAKO)).title!
    expect([...t].length).toBeLessThanOrEqual(20)
    expect(t).not.toContain('<')
    const link = await make({ char: { title: 'Join https://recruit.example/x' } })
    expect(ok(await link.profiles.profile(HANAKO)).title).toBe('Join')
  })
})
