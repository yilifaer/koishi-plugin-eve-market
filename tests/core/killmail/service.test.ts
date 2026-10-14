// KillService：真的 ZkillClient + EsiApi，zKill 和 ESI 都指向本机的假服务。

import { afterEach, describe, expect, it } from 'vitest'
import { createKillService } from '../../../src/core/killmail'
import { createSiteRegistry } from '../../../src/core/sites'
import { isFailure } from '../../../src/core/types'
import type { CoreFailure, ItemInfo, KillService, KillSummary, SystemView } from '../../../src/core/types'
import { ZkillClient } from '../../../src/core/zkill'
import { EsiApi } from '../../../src/core/esi'
import { createModuleStore } from '../../../src/core/ports'
import { FakeZkill, rawZkillKill } from '../../fakes/fake-zkill'
import type { ZkillFault } from '../../fakes/fake-zkill'
import { rawKillmail } from '../../fakes/fake-esi'
import type { RawKillmail } from '../../fakes/fake-esi'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { closeAll, makeEnv, realScheduler } from '../esi/helpers'
import type { Env } from '../esi/helpers'

afterEach(async () => {
  await closeAll()
  await Promise.all(zkills.splice(0).map((z) => z.stop()))
})

const zkills: FakeZkill[] = []
const KILL = 131234567
const HASH = '0123456789abcdef0123456789abcdef01234567'
const MIN = 60_000

const ship = (typeId: number, en: string, zh: string) => ({ typeId, en, zh }) as ItemInfo
const SHIPS = new Map([[638, ship(638, 'Raven', '乌鸦级')], [17738, ship(17738, 'Machariel', '马其顿')], [11978, ship(11978, 'Scimitar', '弯刀级')], [35832, ship(35832, 'Astrahus', '阿斯特拉斯')]])
const view = (id: number, en: string, zh: string, region: string | null = '绝地之域'): SystemView => ({
  id, en, zh, security: -0.38, secClass: 'nullsec' as SystemView['secClass'], constellation: { id: 1, en: 'C', zh: 'C' },
  region: region ? { id: 10000060, en: 'Delve', zh: region } : null,
})
const SYSTEMS = new Map([[30000142, view(30000142, 'Jita', '吉他')], [31000005, view(31000005, 'J000001', 'J000001')], [30000999, view(30000999, 'Nowhere', '无处', null)]])

interface Setup {
  kill?: boolean
  mail?: Partial<RawKillmail>
  zkb?: Parameters<typeof rawZkillKill>[2]
  /** zKill 回老格式（只有 hash 和估值），击杀正文要去 ESI 取 */
  minimal?: boolean
  minIntervalMs?: number
}

interface Made {
  service: KillService
  zkill: FakeZkill
  env: Env
  client: ZkillClient
}

async function make(setup: Setup = {}): Promise<Made> {
  const zkill = await new FakeZkill().start()
  zkills.push(zkill)
  const mail = rawKillmail(setup.mail)
  const env = await makeEnv({ contact: 'me@example.test' }, (f) => {
    f.cacheMode = 'none'
    f.killmails.set(KILL, { hash: HASH, mail })
    f.names.set(2112000101, { name: 'Some Pilot', category: 'character' })
    f.names.set(98000101, { name: 'Some Corp', category: 'corporation' })
    f.names.set(99000101, { name: 'Some Alliance', category: 'alliance' })
    f.names.set(2112000202, { name: 'Other Pilot', category: 'character' })
    f.names.set(98000201, { name: 'Other Corp', category: 'corporation' })
    f.names.set(99000201, { name: 'Other Alliance', category: 'alliance' })
  })
  if (setup.kill !== false) zkill.kills.set(KILL, rawZkillKill(KILL, HASH, setup.zkb, setup.minimal ? 'minimal' : setup.mail))
  const client = new ZkillClient(
    { http: new NodeHttpClient(), clock: env.clock, scheduler: realScheduler, logger: env.logger, store: createModuleStore() },
    { base: zkill.base, userAgent: env.client.userAgent, minIntervalMs: setup.minIntervalMs ?? 0 },
  )
  const service = createKillService({
    zkill: client, esi: env.api, items: { byId: (id) => SHIPS.get(id) }, universe: { system: (id) => SYSTEMS.get(id) },
    clock: env.clock, scheduler: realScheduler, logger: env.logger, namesWaitMs: 150,
  })
  return { service, zkill, env, client }
}

const ok = (r: KillSummary | CoreFailure): KillSummary => {
  if (isFailure(r)) throw new Error(`应该成功：${r.code} ${r.message}`)
  return r
}
const bad = (r: KillSummary | CoreFailure): CoreFailure => {
  if (!isFailure(r)) throw new Error('应该失败')
  return r
}
const esiCalls = (m: Made, pattern: RegExp) => m.env.fake.requests.filter((r) => pattern.test(r.path)).length

describe('KillService.summary: happy path', () => {
  it('combines zKill (hash, value, flags) with the ESI killmail, names, ship and system', async () => {
    const m = await make({ zkb: { totalValue: 452_000_000, npc: false, solo: false } })
    expect(ok(await m.service.summary(KILL))).toEqual({
      killId: KILL,
      time: Date.UTC(2026, 9, 14, 12, 34, 56),
      system: SYSTEMS.get(30000142),
      systemId: 30000142,
      victim: { character: 'Some Pilot', corporation: 'Some Corp', alliance: 'Some Alliance', shipTypeId: 638, ship: SHIPS.get(638) },
      attackers: 2,
      finalBlow: { character: 'Other Pilot', corporation: 'Other Corp', alliance: 'Other Alliance', shipTypeId: 11978, ship: SHIPS.get(11978) },
      value: 452_000_000,
      flags: { npc: false, solo: false, awox: false },
      abyssal: false,
    })
  })

  it('identifies itself to zKill with the ESI User-Agent (including the contact) and asks for JSON', async () => {
    const m = await make()
    ok(await m.service.summary(KILL))
    expect(m.zkill.requests).toEqual([{ path: `/api/killID/${KILL}/`, userAgent: m.env.client.userAgent, accept: 'application/json' }])
    expect(m.env.client.userAgent).toContain('me@example.test')
  })

  it('handles a full killmail with hundreds of attackers (over the default 64 KB limit)', async () => {
    const attackers = Array.from({ length: 600 }, (_, i) => ({
      character_id: 2112100000 + i, corporation_id: 98000201, alliance_id: 99000201, ship_type_id: 11978,
      final_blow: i === 0, damage_done: 10, security_status: 0.5,
    }))
    const m = await make({ mail: { attackers } })
    expect(JSON.stringify(rawZkillKill(KILL, HASH, {}, { attackers })).length).toBeGreaterThan(64 * 1024)
    const s = ok(await m.service.summary(KILL))
    expect(s.attackers).toBe(600)
    expect(s.finalBlow?.ship).toEqual(SHIPS.get(11978))
  })

  it('passes the zKill flags through', async () => {
    const m = await make({ zkb: { npc: true, solo: true, awox: true } })
    expect(ok(await m.service.summary(KILL)).flags).toEqual({ npc: true, solo: true, awox: true })
  })

  it('has no pilot on a structure loss and keeps the corporation', async () => {
    const m = await make({ mail: { victim: { corporation_id: 98000101, alliance_id: 99000101, ship_type_id: 35832, damage_taken: 9 } } })
    const s = ok(await m.service.summary(KILL))
    expect(s.victim).toEqual({ character: null, corporation: 'Some Corp', alliance: 'Some Alliance', shipTypeId: 35832, ship: SHIPS.get(35832) })
  })

  it('leaves finalBlow null when no attacker is marked, and counts a kill with no attackers', async () => {
    const m = await make({ mail: { attackers: [] } })
    const s = ok(await m.service.summary(KILL))
    expect([s.finalBlow, s.attackers]).toEqual([null, 0])
  })

  it('uses null for a ship that the item data does not know', async () => {
    const m = await make({ mail: { victim: { character_id: 2112000101, corporation_id: 98000101, ship_type_id: 99999999, damage_taken: 1 } } })
    expect(ok(await m.service.summary(KILL)).victim).toMatchObject({ shipTypeId: 99999999, ship: null })
  })

  it('has system null when the data does not know the system', async () => {
    const m = await make({ mail: { solar_system_id: 30009999 } })
    const s = ok(await m.service.summary(KILL))
    expect([s.system, s.systemId]).toEqual([null, 30009999])
    expect(m.service.relatedBrUrl(s)).toBeNull()
  })

  it('asks for the names of the victim and the final blow in one request (at most 6 ids)', async () => {
    const m = await make()
    ok(await m.service.summary(KILL))
    const names = m.env.fake.requests.filter((r) => r.path === '/universe/names')
    expect(names).toHaveLength(1)
    expect(JSON.parse(names[0].body)).toEqual([98000101, 98000201, 99000101, 99000201, 2112000101, 2112000202])
  })
})

describe('KillService.summary: killmail body from zKill', () => {
  it('a full zKill body: ESI killmail is not requested, only names', async () => {
    const m = await make()
    ok(await m.service.summary(KILL))
    expect(esiCalls(m, /^\/killmails\//)).toBe(0)
    expect(esiCalls(m, /^\/universe\/names$/)).toBe(1)
  })

  it('a minimal zKill body: falls back to the ESI killmail with the same result', async () => {
    const full = ok(await (await make()).service.summary(KILL))
    const m = await make({ minimal: true })
    expect(ok(await m.service.summary(KILL))).toEqual(full)
    expect(esiCalls(m, /^\/killmails\//)).toBe(1)
  })
})

describe('KillService.summary: caches and single flight', () => {
  it('serves a repeat from memory without asking zKill or ESI', async () => {
    const m = await make()
    const first = ok(await m.service.summary(KILL))
    const before = [m.zkill.requests.length, m.env.fake.requests.length]
    expect(ok(await m.service.summary(KILL))).toEqual(first)
    expect([m.zkill.requests.length, m.env.fake.requests.length]).toEqual(before)
  })

  it('asks zKill again after 24 hours but the immutable ESI killmail stays cached', async () => {
    const m = await make({ minimal: true })
    ok(await m.service.summary(KILL))
    m.env.clock.advance(24 * 3_600_000 + 1)
    ok(await m.service.summary(KILL))
    expect(m.zkill.requests).toHaveLength(2)
    expect(esiCalls(m, /^\/killmails\//)).toBe(1)
  })

  it('merges concurrent callers for the same kill into one zKill request, no ESI killmail and one names request', async () => {
    const m = await make()
    const all = await Promise.all(Array.from({ length: 6 }, () => m.service.summary(KILL)))
    expect(all.every((r) => !isFailure(r))).toBe(true)
    expect(m.zkill.requests).toHaveLength(1)
    expect(esiCalls(m, /^\/killmails\//)).toBe(0)
    expect(esiCalls(m, /^\/universe\/names$/)).toBe(1)
  })

  it('remembers "not found" for 5 minutes, then asks zKill again', async () => {
    const m = await make({ kill: false })
    expect(bad(await m.service.summary(KILL)).code).toBe('KILL_NOT_FOUND')
    m.env.clock.advance(5 * MIN - 1)
    expect(bad(await m.service.summary(KILL)).code).toBe('KILL_NOT_FOUND')
    expect(m.zkill.requests).toHaveLength(1)
    // 过一会儿被收录了
    m.zkill.kills.set(KILL, rawZkillKill(KILL, HASH))
    m.env.clock.advance(1)
    ok(await m.service.summary(KILL))
    expect(m.zkill.requests).toHaveLength(2)
  })
})

describe('KillService.summary: zKill failures', () => {
  const cases: Array<[string, ZkillFault, string]> = [
    ['HTTP 500', { kind: 'status', status: 500 }, 'ZKILL_UNAVAILABLE'],
    ['a JSON body of the wrong shape', { kind: 'raw', body: '{"error":"x"}' }, 'ZKILL_UNAVAILABLE'],
    ['a body that is not JSON', { kind: 'raw', body: 'nope' }, 'ZKILL_UNAVAILABLE'],
    ['an oversized body (> 64 KB)', { kind: 'huge', bytes: 70 * 1024 }, 'ZKILL_UNAVAILABLE'],
    ['a row without a hash', { kind: 'raw', body: JSON.stringify([{ killmail_id: KILL, zkb: {} }]) }, 'ZKILL_UNAVAILABLE'],
  ]
  it.each(cases)('%s -> %s', async (_, fault, code) => {
    const m = await make()
    m.zkill.faults.push(fault)
    expect(bad(await m.service.summary(KILL)).code).toBe(code)
    expect(esiCalls(m, /^\/killmails\//)).toBe(0)
  })

  it('remembers a failure for 30 seconds, then tries again', async () => {
    const m = await make()
    m.zkill.faults.push({ kind: 'status', status: 502 })
    expect(bad(await m.service.summary(KILL)).code).toBe('ZKILL_UNAVAILABLE')
    expect(bad(await m.service.summary(KILL)).code).toBe('ZKILL_UNAVAILABLE')
    expect(m.zkill.requests).toHaveLength(1)
    m.env.clock.advance(30_000)
    ok(await m.service.summary(KILL))
    expect(m.zkill.requests).toHaveLength(2)
  })

  it('does not keep a badly-shaped answer as a good cached one', async () => {
    const m = await make()
    m.zkill.faults.push({ kind: 'raw', body: '[{"killmail_id":131234567}]' })
    expect(bad(await m.service.summary(KILL)).code).toBe('ZKILL_UNAVAILABLE')
    m.env.clock.advance(30_000)
    ok(await m.service.summary(KILL))
  })

  it('429 -> ZKILL_THROTTLED with the time to retry, and no more requests while paused', async () => {
    const m = await make()
    const t0 = m.env.clock.now()
    m.zkill.faults.push({ kind: 'rate-limit', retryAfter: 90 })
    expect(bad(await m.service.summary(KILL))).toMatchObject({ code: 'ZKILL_THROTTLED', retryAt: t0 + 90_000 })
    expect(bad(await m.service.summary(KILL + 1))).toMatchObject({ code: 'ZKILL_THROTTLED', retryAt: t0 + 90_000 })
    expect(m.zkill.requests).toHaveLength(1)
  })

  it('a Cloudflare challenge -> ZKILL_THROTTLED paused for 5 minutes', async () => {
    const m = await make()
    const t0 = m.env.clock.now()
    m.zkill.faults.push({ kind: 'challenge' })
    expect(bad(await m.service.summary(KILL))).toMatchObject({ code: 'ZKILL_THROTTLED', retryAt: t0 + 5 * MIN })
    expect(m.env.logger.at('warn')).toHaveLength(1)
  })

  it('a stuck zKill -> DEADLINE at the caller deadline', async () => {
    const m = await make()
    m.zkill.faults.push({ kind: 'hang' })
    expect(bad(await m.service.summary(KILL, { deadlineMs: 80 })).code).toBe('DEADLINE')
  })
})

describe('KillService.summary: ESI failures', () => {
  it('ESI 5xx -> ESI_UNAVAILABLE', async () => {
    const m = await make({ minimal: true })
    m.env.fake.fault('GET', /^\/killmails\//, { status: 503 }, 5)
    expect(bad(await m.service.summary(KILL)).code).toBe('ESI_UNAVAILABLE')
  })

  it('ESI does not know the hash zKill gave -> ESI_UNAVAILABLE (not "not found")', async () => {
    const m = await make({ minimal: true })
    m.env.fake.killmails.set(KILL, { hash: 'f'.repeat(40), mail: rawKillmail() })
    expect(bad(await m.service.summary(KILL)).code).toBe('ESI_UNAVAILABLE')
  })

  it('an unreadable ESI body -> ESI_UNAVAILABLE', async () => {
    const m = await make({ minimal: true })
    m.env.fake.fault('GET', /^\/killmails\//, { status: 200, raw: '{"killmail_id":1}' })
    expect(bad(await m.service.summary(KILL)).code).toBe('ESI_UNAVAILABLE')
  })

  it('zKill answered but ESI is down: a retry does not ask zKill again', async () => {
    const m = await make({ minimal: true })
    m.env.fake.fault('GET', /^\/killmails\//, { status: 503 }, 5)
    bad(await m.service.summary(KILL))
    m.env.fake.faults = []
    m.env.clock.advance(60_000)
    ok(await m.service.summary(KILL))
    expect(m.zkill.requests).toHaveLength(1)
  })

  it('a slow ESI -> DEADLINE for this caller, and the next call gets the finished result', async () => {
    const m = await make({ minimal: true })
    const release = m.env.fake.hold(/^\/killmails\//)
    expect(bad(await m.service.summary(KILL, { deadlineMs: 100 })).code).toBe('DEADLINE')
    release()
    await new Promise((r) => setTimeout(r, 100))
    ok(await m.service.summary(KILL))
    expect(m.zkill.requests).toHaveLength(1)
  })
})

describe('KillService.summary: names', () => {
  it('writes null names when the name lookup fails, and still returns the summary', async () => {
    const m = await make()
    m.env.fake.fault('POST', /^\/universe\/names$/, { status: 500 }, 5)
    const s = ok(await m.service.summary(KILL))
    expect(s.victim).toMatchObject({ character: null, corporation: null, alliance: null, ship: SHIPS.get(638) })
    expect(s.finalBlow).toMatchObject({ character: null, corporation: null, alliance: null })
  })

  it('writes null names when the lookup is too slow (does not hold up the card)', async () => {
    const m = await make()
    m.env.fake.hold(/^\/universe\/names$/)
    const started = Date.now()
    const s = ok(await m.service.summary(KILL, { deadlineMs: 5000 }))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(s.victim.character).toBeNull()
  })

  it('does not cache a summary with missing names: the next call asks for names again', async () => {
    const m = await make()
    m.env.fake.fault('POST', /^\/universe\/names$/, { status: 500 }, 2)
    expect(ok(await m.service.summary(KILL)).victim.character).toBeNull()
    m.env.clock.advance(60_000)
    expect(ok(await m.service.summary(KILL)).victim.character).toBe('Some Pilot')
    expect(esiCalls(m, /^\/universe\/names$/)).toBeGreaterThan(1)
    const again = esiCalls(m, /^\/universe\/names$/)
    expect(ok(await m.service.summary(KILL)).victim.character).toBe('Some Pilot')
    expect(esiCalls(m, /^\/universe\/names$/)).toBe(again)
  })

  it('leaves a name null when ESI does not know the id (whole lookup is 404)', async () => {
    const m = await make()
    m.env.fake.names.delete(2112000101)
    const s = ok(await m.service.summary(KILL))
    expect(s.victim.character).toBeNull()
    expect(s.victim.ship).toBe(SHIPS.get(638))
  })
})

describe('KillService.summary: abyss and bad arguments', () => {
  it('marks a system id starting with 32 as abyssal', async () => {
    const m = await make({ mail: { solar_system_id: 32000005 } })
    const s = ok(await m.service.summary(KILL))
    expect(s.abyssal).toBe(true)
    expect(m.service.relatedBrUrl(s)).toBeNull()
  })

  it('a wormhole system (31...) is not abyssal', async () => {
    const m = await make({ mail: { solar_system_id: 31000005 } })
    const s = ok(await m.service.summary(KILL))
    expect(s.abyssal).toBe(false)
    expect(m.service.relatedBrUrl(s)).toBe('https://br.evetools.org/related/31000005/202610141200')
  })

  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2])('rejects the kill id %s without any request', async (id) => {
    const m = await make()
    expect(bad(await m.service.summary(id)).code).toBe('KILL_NOT_FOUND')
    expect(m.zkill.requests).toHaveLength(0)
  })
})

describe('KillService.summary: with the hash from an ESI link', () => {
  it('skips zKill; there is no value or flags', async () => {
    const m = await make({ kill: false })
    const s = ok(await m.service.summary(KILL, { hash: HASH }))
    expect([s.value, s.flags, s.victim.character]).toEqual([null, { npc: false, solo: false, awox: false }, 'Some Pilot'])
    expect(m.zkill.requests).toHaveLength(0)
  })

  it('a wrong hash or unknown kill -> KILL_NOT_FOUND', async () => {
    const m = await make({ kill: false })
    expect(bad(await m.service.summary(KILL, { hash: 'f'.repeat(40) })).code).toBe('KILL_NOT_FOUND')
    expect(bad(await m.service.summary(KILL + 1, { hash: HASH })).code).toBe('KILL_NOT_FOUND')
  })

  it('does not put the value-less result in the cache used for plain ids', async () => {
    const m = await make()
    ok(await m.service.summary(KILL, { hash: HASH }))
    expect(ok(await m.service.summary(KILL)).value).toBe(452_000_000)
  })
})

describe('KillService.relatedBrUrl', () => {
  it('uses the UTC hour of the kill, floored', async () => {
    const m = await make()
    expect(m.service.relatedBrUrl(ok(await m.service.summary(KILL)))).toBe('https://br.evetools.org/related/30000142/202610141200')
  })

  it('is null when the data has no region for the system', async () => {
    const m = await make({ mail: { solar_system_id: 30000999 } })
    expect(m.service.relatedBrUrl(ok(await m.service.summary(KILL)))).toBeNull()
  })

  it('is null when the system id does not have 8 digits', async () => {
    const m = await make()
    const s = ok(await m.service.summary(KILL))
    expect(m.service.relatedBrUrl({ ...s, systemId: 3000014, system: SYSTEMS.get(30000142)! })).toBeNull()
  })
})

describe('KillService.relatedUrls', () => {
  const summaryAt = async (iso: string, mail: Partial<RawKillmail> = {}) => {
    const m = await make({ mail: { killmail_time: iso, ...mail } })
    return { m, s: ok(await m.service.summary(KILL)) }
  }
  const wb = (sys: number, a: string, b: string) => `https://warbeacon.net/br/related/${sys}/${a}/${b}/`

  it('gives the whole-hour BR address and the +-60 minute Warbeacon range', async () => {
    const { m, s } = await summaryAt('2026-10-14T12:34:56Z')
    expect(m.service.relatedUrls(s)).toEqual({
      br: 'https://br.evetools.org/related/30000142/202610141200',
      warbeacon: wb(30000142, '202610141134', '202610141334'),
    })
  })

  it('keeps minute precision and floors the seconds', async () => {
    const { m, s } = await summaryAt('2026-10-14T12:00:59Z')
    expect(m.service.relatedUrls(s).warbeacon).toBe(wb(30000142, '202610141100', '202610141300'))
  })

  it('crosses midnight in both directions', async () => {
    const a = await summaryAt('2026-10-14T00:20:00Z')
    expect(a.m.service.relatedUrls(a.s).warbeacon).toBe(wb(30000142, '202610132320', '202610140120'))
    const b = await summaryAt('2026-10-14T23:30:00Z')
    expect(b.m.service.relatedUrls(b.s).warbeacon).toBe(wb(30000142, '202610142230', '202610150030'))
  })

  it('crosses the year boundary in both directions', async () => {
    const a = await summaryAt('2027-01-01T00:10:00Z')
    expect(a.m.service.relatedUrls(a.s).warbeacon).toBe(wb(30000142, '202612312310', '202701010110'))
    const b = await summaryAt('2026-12-31T23:59:59Z')
    expect(b.m.service.relatedUrls(b.s).warbeacon).toBe(wb(30000142, '202612312259', '202701010059'))
  })

  it('is null for both on an abyssal kill or a system without a region', async () => {
    const a = await summaryAt('2026-10-14T12:34:56Z', { solar_system_id: 32000005 })
    expect(a.m.service.relatedUrls(a.s)).toEqual({ br: null, warbeacon: null })
    const b = await summaryAt('2026-10-14T12:34:56Z', { solar_system_id: 30000999 })
    expect(b.m.service.relatedUrls(b.s)).toEqual({ br: null, warbeacon: null })
  })

  it.each([3000014, 300001420])('is null for both when the system id has %s digits', async (id) => {
    const { m, s } = await summaryAt('2026-10-14T12:34:56Z')
    expect(m.service.relatedUrls({ ...s, systemId: id })).toEqual({ br: null, warbeacon: null })
  })

  it('a wormhole kill has both addresses', async () => {
    const { m, s } = await summaryAt('2026-10-14T12:34:56Z', { solar_system_id: 31000005 })
    expect(m.service.relatedUrls(s)).toEqual({
      br: 'https://br.evetools.org/related/31000005/202610141200',
      warbeacon: wb(31000005, '202610141134', '202610141334'),
    })
  })

  it('the Warbeacon address is accepted by the built-in site rule', async () => {
    const { m, s } = await summaryAt('2026-10-14T12:34:56Z')
    const registry = createSiteRegistry({ sites: [{ id: 'warbeacon', builtin: true, name: 'Warbeacon', auto: true, maxImages: 1, host: '', pathPrefix: '' }] })
    const url = m.service.relatedUrls(s).warbeacon!
    expect(registry.parse(url)?.url).toBe(url)
  })
})
