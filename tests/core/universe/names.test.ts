import { describe, expect, it } from 'vitest'
import { DataNotReadyError } from '../../../src/core/data'
import { EsiError } from '../../../src/core/esi'
import type { EsiName, EsiResult } from '../../../src/core/esi'
import { UniverseNames, secClassOf } from '../../../src/core/universe'
import type { NamesEsi } from '../../../src/core/universe'
import { staticDataService } from '../../fixtures/data/load'
import { ManualClock } from '../items/helpers'

const JITA = 30000142
const KIMOTORO = 20000020
const THE_FORGE = 10000002
/** 编造的、数据里没有的 ID */
const NEW_SYSTEM = 30999001
const NEW_REGION = 10999001

class FakeNames implements NamesEsi {
  readonly calls: number[][] = []
  readonly table = new Map<number, EsiName>()
  fail = false

  async names(ids: readonly number[]): Promise<EsiResult<EsiName[]>> {
    this.calls.push([...ids])
    if (this.fail) throw new EsiError('http', 'ESI 出错', { route: 'POST /universe/names', status: 502 })
    const value = ids.flatMap((id) => this.table.get(id) ?? [])
    return { value, lastModified: null, expiresAt: 0, validatedAt: 0, cached: false, stale: false }
  }
}

function names(esi?: FakeNames, clock = new ManualClock()) {
  return new UniverseNames({ data: staticDataService(), clock, esi })
}

describe('secClassOf', () => {
  it('uses the true security, 0.45 and 0 are the boundaries', () => {
    expect([0.945913, 0.45, 0.450343].map((s) => secClassOf(s))).toEqual(['high', 'high', 'high'])
    expect([0.4499, 0.44779, 0.01, 0.0001].map((s) => secClassOf(s))).toEqual(['low', 'low', 'low', 'low'])
    expect([0, -0.044546, -1].map((s) => secClassOf(s))).toEqual(['null', 'null', 'null'])
  })

  it('wormhole space and Pochven count as null-sec whatever the number says', () => {
    expect(secClassOf(-0.99, 11000031)).toBe('null')
    expect(secClassOf(0.5, 10000070)).toBe('null')
    expect(secClassOf(0.5, THE_FORGE)).toBe('high')
  })
})

describe('UniverseNames: from the data', () => {
  const n = names()

  it('regions, constellations, systems and factions in both languages', () => {
    expect(n.known('region', THE_FORGE)).toEqual({ id: THE_FORGE, en: 'The Forge', zh: '伏尔戈' })
    expect(n.known('constellation', KIMOTORO)).toEqual({ id: KIMOTORO, en: 'Kimotoro', zh: '木本呂' })
    expect(n.known('system', JITA)).toEqual({ id: JITA, en: 'Jita', zh: '吉他' })
    expect(n.known('faction', 500019)).toEqual({ id: 500019, en: "Sansha's Nation", zh: '萨沙共和国' })
    expect(n.known('system', NEW_SYSTEM)).toBeUndefined()
  })

  it('system view with constellation, region and security class', () => {
    expect(n.system(JITA)).toEqual({
      id: JITA, en: 'Jita', zh: '吉他', security: 0.945913, secClass: 'high',
      constellation: { id: KIMOTORO, en: 'Kimotoro', zh: '木本呂' },
      region: { id: THE_FORGE, en: 'The Forge', zh: '伏尔戈' },
    })
    expect(n.system(30001398)?.secClass).toBe('low') // Aunenen 0.44779
    expect(n.system(30000062)?.secClass).toBe('high') // Iosantin 0.450343
    expect(n.system(31000005)).toMatchObject({ en: 'Thera', secClass: 'null' })
    expect(n.system(NEW_SYSTEM)).toBeUndefined()
  })

  it('before the data is loaded nothing is known', () => {
    const early = new UniverseNames({ data: { current: () => { throw new DataNotReadyError() } }, clock: new ManualClock() })
    expect(early.known('system', JITA)).toBeUndefined()
    expect(early.system(JITA)).toBeUndefined()
  })
})

describe('UniverseNames: ESI fills the gaps', () => {
  it('data first, ESI only for the missing IDs, matching category only, the ID itself as a last resort', async () => {
    const esi = new FakeNames()
    esi.table.set(NEW_SYSTEM, { id: NEW_SYSTEM, name: 'New System', category: 'solar_system' })
    esi.table.set(NEW_REGION, { id: NEW_REGION, name: 'New Region', category: 'region' })
    const n = names(esi)
    const got = await n.lookup('system', [JITA, NEW_SYSTEM, NEW_REGION, JITA])
    expect(esi.calls).toEqual([[NEW_SYSTEM, NEW_REGION]])
    expect([...got.values()]).toEqual([
      { id: JITA, en: 'Jita', zh: '吉他' },
      { id: NEW_SYSTEM, en: 'New System', zh: '' },
      // 分类不对（是星域不是星系）：不收
      { id: NEW_REGION, en: String(NEW_REGION), zh: '' },
    ])
  })

  it('remembers ESI names for a week', async () => {
    const esi = new FakeNames()
    esi.table.set(NEW_SYSTEM, { id: NEW_SYSTEM, name: 'New System', category: 'solar_system' })
    const clock = new ManualClock()
    const n = names(esi, clock)
    await n.lookup('system', [NEW_SYSTEM])
    await n.lookup('system', [NEW_SYSTEM])
    expect(esi.calls).toHaveLength(1)
    clock.advance(7 * 24 * 3600 * 1000)
    await n.lookup('system', [NEW_SYSTEM])
    expect(esi.calls).toHaveLength(2)
  })

  it('an ESI error is not cached and falls back to the ID', async () => {
    const esi = new FakeNames()
    esi.fail = true
    const n = names(esi)
    expect((await n.lookup('faction', [500999])).get(500999)).toEqual({ id: 500999, en: '500999', zh: '' })
    esi.fail = false
    esi.table.set(500999, { id: 500999, name: 'New Faction', category: 'faction' })
    expect((await n.lookup('faction', [500999])).get(500999)).toEqual({ id: 500999, en: 'New Faction', zh: '' })
  })

  it('without ESI, or with IDs ESI cannot take, only the data and the ID', async () => {
    expect([...(await names().lookup('region', [THE_FORGE, NEW_REGION])).values()].map((p) => p.en)).toEqual(['The Forge', String(NEW_REGION)])
    const esi = new FakeNames()
    expect((await names(esi).lookup('system', [0, -5])).get(0)).toEqual({ id: 0, en: '0', zh: '' })
    expect(esi.calls).toEqual([])
  })
})
