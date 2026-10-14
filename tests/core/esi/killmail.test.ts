import { afterEach, describe, expect, it } from 'vitest'
import { EsiError, parseKillmail } from '../../../src/core/esi'
import { rawKillmail } from '../../fakes/fake-esi'
import { closeAll, makeEnv } from './helpers'

afterEach(closeAll)

const HASH = '0123456789abcdef0123456789abcdef01234567'

describe('EsiApi.killmail', () => {
  it('fetches the public killmail and renames the fields', async () => {
    const mail = rawKillmail()
    const env = await makeEnv({}, (f) => f.killmails.set(131234567, { hash: HASH, mail }))
    const res = await env.api.killmail(131234567, HASH)
    expect(res.value).toEqual({
      killId: 131234567,
      time: Date.UTC(2026, 9, 14, 12, 34, 56),
      systemId: 30000142,
      victim: { characterId: 2112000101, corporationId: 98000101, allianceId: 99000101, factionId: null, shipTypeId: 638 },
      attackers: [
        { characterId: 2112000201, corporationId: 98000201, allianceId: null, factionId: null, shipTypeId: 17738, finalBlow: false },
        { characterId: 2112000202, corporationId: 98000201, allianceId: 99000201, factionId: null, shipTypeId: 11978, finalBlow: true },
      ],
    })
    expect(env.fake.requests[0].path).toBe(`/killmails/131234567/${HASH}`)
    expect(env.fake.requests[0].headers.authorization).toBeUndefined()
  })

  it('caches for 30 days when the response has no cache headers', async () => {
    const env = await makeEnv({}, (f) => {
      f.cacheMode = 'none'
      f.killmails.set(131234567, { hash: HASH, mail: rawKillmail() })
    })
    await env.api.killmail(131234567, HASH)
    env.clock.advance(29 * 86_400_000)
    expect((await env.api.killmail(131234567, HASH)).cached).toBe(true)
    expect(env.fake.requests).toHaveLength(1)
    env.clock.advance(2 * 86_400_000)
    expect((await env.api.killmail(131234567, HASH)).cached).toBe(false)
  })

  it('fails with an HTTP error for a wrong hash (422) or an unknown killmail (404)', async () => {
    const env = await makeEnv({}, (f) => f.killmails.set(131234567, { hash: HASH, mail: rawKillmail() }))
    const wrong = await env.api.killmail(131234567, 'f'.repeat(40)).catch((e: unknown) => e)
    expect(wrong).toBeInstanceOf(EsiError)
    expect(wrong).toMatchObject({ kind: 'http', status: 422 })
    const missing = await env.api.killmail(999, HASH).catch((e: unknown) => e)
    expect(missing).toMatchObject({ kind: 'http', status: 404 })
  })

  it('rejects a malformed id or hash before requesting', async () => {
    const env = await makeEnv()
    expect(() => env.api.killmail(0, HASH)).toThrow(RangeError)
    expect(() => env.api.killmail(1, 'xyz')).toThrow(RangeError)
    expect(() => env.api.killmail(1, HASH.toUpperCase())).toThrow(RangeError)
    expect(env.fake.requests).toHaveLength(0)
  })
})

describe('parseKillmail', () => {
  it('accepts a victim without a pilot (structure, drone) and attackers that are NPCs', () => {
    const parsed = parseKillmail(rawKillmail({
      victim: { corporation_id: 98000101, ship_type_id: 35832, damage_taken: 1 },
      attackers: [{ faction_id: 500010, final_blow: true, damage_done: 100, security_status: 0, ship_type_id: 1 }],
    }))
    expect(parsed.victim).toEqual({ characterId: null, corporationId: 98000101, allianceId: null, factionId: null, shipTypeId: 35832 })
    expect(parsed.attackers[0]).toMatchObject({ characterId: null, factionId: 500010, finalBlow: true })
  })

  it('treats a missing final_blow as false and allows an empty attacker list', () => {
    const mail = rawKillmail({ attackers: [] })
    expect(parseKillmail(mail).attackers).toEqual([])
    const noFlag = { ...mail, attackers: [{ character_id: 1 }] }
    expect(parseKillmail(noFlag).attackers[0].finalBlow).toBe(false)
  })

  it.each([
    ['not an object', null],
    ['no killmail_id', { ...rawKillmail(), killmail_id: undefined }],
    ['bad time', { ...rawKillmail(), killmail_time: 'yesterday' }],
    ['system as a string', { ...rawKillmail(), solar_system_id: '30000142' }],
    ['no victim', { ...rawKillmail(), victim: undefined }],
    ['victim without a ship', { ...rawKillmail(), victim: { character_id: 1 } }],
    ['attackers not a list', { ...rawKillmail(), attackers: {} }],
    ['fractional id', { ...rawKillmail(), killmail_id: 1.5 }],
  ])('throws a shape error: %s', (_, json) => {
    expect(() => parseKillmail(json)).toThrow()
  })
})
