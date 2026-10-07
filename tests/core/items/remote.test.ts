import { describe, expect, it } from 'vitest'
import { looksLikeFullName } from '../../../src/core/items'
import { esiType, FakeRemoteEsi, fixtureResolver, ManualClock, MemoryBlobCache } from './helpers'

const DAY = 24 * 3600 * 1000
// 编造的新物品
const NEW_SHIP = esiType({ typeId: 990001, name: 'Testudo Navy Issue', groupId: 27, marketGroupId: 80 })
const NOT_MARKET = esiType({ typeId: 990002, name: 'Testudo Prototype', marketGroupId: null })

function setup() {
  const esi = new FakeRemoteEsi()
  esi.add(NEW_SHIP, { en: 'Testudo Navy Issue', zh: '龟甲级海军型' })
  esi.add(NOT_MARKET, { en: 'Testudo Prototype' })
  const cache = new MemoryBlobCache()
  const clock = new ManualClock()
  const items = fixtureResolver({ remote: { esi, cache, clock } })
  return { esi, cache, clock, items }
}

describe('looksLikeFullName', () => {
  it('only lets through things that could be a whole name', () => {
    expect(looksLikeFullName('Testudo Navy Issue')).toBe(true)
    expect(looksLikeFullName('龟甲')).toBe(true)
    expect(looksLikeFullName('x')).toBe(false)
    expect(looksLikeFullName('Raven*10')).toBe(false)
    expect(looksLikeFullName('12345')).toBe(false)
    expect(looksLikeFullName('#123')).toBe(false)
    expect(looksLikeFullName('--')).toBe(false)
    expect(looksLikeFullName('a'.repeat(101))).toBe(false)
  })
})

describe('resolveRemote', () => {
  it('finds a new market item by its exact English name', async () => {
    const { esi, items } = setup()
    expect(items.resolve('Testudo Navy Issue', { scope: 'market' }).kind).toBe('none')
    const item = await items.resolveRemote('testudo navy issue')
    expect(item).toMatchObject({
      typeId: 990001, en: 'Testudo Navy Issue', zh: '', groupId: 27, categoryId: 6, marketGroupId: 80,
      volume: 486000, packagedVolume: 50000, portionSize: 1, capacity: 800,
    })
    expect(esi.calls).toEqual(['ids en testudo navy issue', 'type 990001'])
  })

  it('asks in Chinese first for a Chinese name and keeps the Chinese name', async () => {
    const { esi, items } = setup()
    const item = await items.resolveRemote('龟甲级海军型')
    expect(item).toMatchObject({ typeId: 990001, en: 'Testudo Navy Issue', zh: '龟甲级海军型' })
    expect(esi.calls[0]).toBe('ids zh 龟甲级海军型')
    expect(items.commandName(item!)).toBe('Testudo Navy Issue')
  })

  it('does not use items without a market group', async () => {
    const { items } = setup()
    expect(await items.resolveRemote('Testudo Prototype')).toBeNull()
  })

  it('caches results, including not found, for 7 days', async () => {
    const { esi, cache, clock, items } = setup()
    await items.resolveRemote('Testudo Navy Issue')
    expect(await items.resolveRemote('Nothing Like This')).toBeNull()
    const calls = esi.calls.length
    expect(calls).toBe(4)
    expect(await items.resolveRemote('TESTUDO  NAVY ISSUE')).toMatchObject({ typeId: 990001 })
    expect(await items.resolveRemote('Nothing Like This')).toBeNull()
    expect(esi.calls).toHaveLength(calls)
    expect(cache.entries.size).toBe(2)
    expect([...cache.entries.keys()].every((k) => /^items\/remote\/[0-9a-f]{32}$/.test(k))).toBe(true)

    // 换一个识别器（插件重载）：从 BlobCache 读
    const again = fixtureResolver({ remote: { esi, cache, clock } })
    expect(await again.resolveRemote('Testudo Navy Issue')).toMatchObject({ typeId: 990001 })
    expect(esi.calls).toHaveLength(calls)

    // 7 天以后重新问
    clock.advance(7 * DAY + 1)
    const later = fixtureResolver({ remote: { esi, cache, clock } })
    await later.resolveRemote('Testudo Navy Issue')
    expect(esi.calls.length).toBeGreaterThan(calls)
  })

  it('sends one request for concurrent lookups of the same name', async () => {
    const { esi, items } = setup()
    const results = await Promise.all(Array.from({ length: 10 }, () => items.resolveRemote('Testudo Navy Issue')))
    expect(results.every((r) => r?.typeId === 990001)).toBe(true)
    expect(esi.calls.filter((c) => c.startsWith('ids'))).toHaveLength(1)
  })

  it('does not cache failures', async () => {
    const { esi, cache, items } = setup()
    esi.fail = true
    expect(await items.resolveRemote('Testudo Navy Issue')).toBeNull()
    expect(cache.entries.size).toBe(0)
    esi.fail = false
    expect(await items.resolveRemote('Testudo Navy Issue')).toMatchObject({ typeId: 990001 })
  })

  it('ignores broken cache entries', async () => {
    const { esi, cache, clock, items } = setup()
    await items.resolveRemote('Testudo Navy Issue')
    for (const [key, entry] of cache.entries) cache.entries.set(key, { ...entry, body: Buffer.from('not json') })
    const fresh = fixtureResolver({ remote: { esi, cache, clock } })
    expect(await fresh.resolveRemote('Testudo Navy Issue')).toMatchObject({ typeId: 990001 })
  })

  it('skips queries that do not look like a name, and works without ESI', async () => {
    const { esi, items } = setup()
    expect(await items.resolveRemote('Raven*10')).toBeNull()
    expect(await items.resolveRemote('500')).toBeNull()
    expect(esi.calls).toEqual([])
    expect(await fixtureResolver().resolveRemote('Testudo Navy Issue')).toBeNull()
  })

  it('returns the local item when ESI names one the data already has', async () => {
    const { esi, items } = setup()
    esi.add({ ...NEW_SHIP, typeId: 638, name: 'Raven' }, { en: 'Old Raven Name' })
    expect(await items.resolveRemote('Old Raven Name')).toBe(items.byId(638))
  })
})
