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
    const raw = [rawZkillKill(131234567, HASH, { totalValue: 4.5e8, npc: true, solo: true, awox: false })]
    expect(parseZkillKill(raw, 131234567)).toEqual({ hash: HASH, value: 4.5e8, npc: true, solo: true, awox: false })
  })

  it('lowercases the hash', () => {
    expect(parseZkillKill([rawZkillKill(1, HASH.toUpperCase())], 1)).toMatchObject({ hash: HASH })
  })

  it('returns not-found for an empty list', () => {
    expect(parseZkillKill([], 1)).toBe('not-found')
  })

  it('tolerates a missing totalValue and missing flags', () => {
    const raw = [{ killmail_id: 7, zkb: { hash: HASH } }]
    expect(parseZkillKill(raw, 7)).toEqual({ hash: HASH, value: null, npc: false, solo: false, awox: false })
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
