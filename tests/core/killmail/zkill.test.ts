import { describe, expect, it } from 'vitest'
import { parseZkillKill, zkillKillPath } from '../../../src/core/killmail'
import { rawZkillKill } from '../../fakes/fake-zkill'

const HASH = '0123456789abcdef0123456789abcdef01234567'

describe('zkillKillPath', () => {
  it('fills the id into the trailing-slash path', () => {
    expect(zkillKillPath(131234567)).toBe('/api/killID/131234567/')
  })
})

describe('parseZkillKill', () => {
  it('reads hash, value and flags', () => {
    const raw = [rawZkillKill(131234567, HASH, { totalValue: 4.5e8, npc: true, solo: true, awox: false }, 'minimal')]
    expect(parseZkillKill(raw, 131234567)).toEqual({ hash: HASH, value: 4.5e8, npc: true, solo: true, awox: false, body: null })
  })

  it('reads the full killmail body when present', () => {
    const r = parseZkillKill([rawZkillKill(131234567, HASH)], 131234567)
    if (r === 'not-found') throw new Error('should be found')
    expect(r.body).toEqual({
      killId: 131234567,
      time: Date.UTC(2026, 9, 14, 12, 34, 56),
      systemId: 30000142,
      victim: { characterId: 2112000101, corporationId: 98000101, allianceId: 99000101, factionId: null, shipTypeId: 638 },
      attackers: [
        { characterId: 2112000201, corporationId: 98000201, allianceId: null, factionId: null, shipTypeId: 17738, finalBlow: false },
        { characterId: 2112000202, corporationId: 98000201, allianceId: 99000201, factionId: null, shipTypeId: 11978, finalBlow: true },
      ],
    })
  })

  it('has no body when the victim cannot be read', () => {
    const raw = [{ ...rawZkillKill(7, HASH), victim: { damage_taken: 1 } }]
    expect(parseZkillKill(raw, 7)).toMatchObject({ hash: HASH, body: null })
  })

  it('lowercases the hash', () => {
    expect(parseZkillKill([rawZkillKill(1, HASH.toUpperCase())], 1)).toMatchObject({ hash: HASH })
  })

  it('returns not-found for an empty list', () => {
    expect(parseZkillKill([], 1)).toBe('not-found')
  })

  it('tolerates a missing totalValue and missing flags', () => {
    const raw = [{ killmail_id: 7, zkb: { hash: HASH } }]
    expect(parseZkillKill(raw, 7)).toEqual({ hash: HASH, value: null, npc: false, solo: false, awox: false, body: null })
  })

  it.each([
    ['an object instead of a list', { killmail_id: 1 }],
    ['null', null],
    ['an HTML string', '<html></html>'],
    ['a row that is not an object', [5]],
    ['a different killmail_id', [rawZkillKill(2)]],
    ['no killmail_id', [{ zkb: { hash: HASH } }]],
    ['no zkb', [{ killmail_id: 1 }]],
    ['no hash', [{ killmail_id: 1, zkb: { totalValue: 1 } }]],
    ['a short hash', [rawZkillKill(1, HASH.slice(1))]],
    ['a non-hex hash', [rawZkillKill(1, 'z'.repeat(40))]],
    ['totalValue as a string', [{ killmail_id: 1, zkb: { hash: HASH, totalValue: '5' } }]],
    ['npc as a string', [{ killmail_id: 1, zkb: { hash: HASH, npc: 'yes' } }]],
  ])('throws a shape error for %s', (_, raw) => {
    expect(() => parseZkillKill(raw, 1)).toThrow()
  })
})
