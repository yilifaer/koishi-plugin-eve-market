import { describe, expect, it } from 'vitest'
import { createItemResolver } from '../../../src/core/items'
import { createModuleStore } from '../../../src/core/ports'
import type { ModuleStore } from '../../../src/core/ports'
import type { GlossaryData } from '../../../src/core/types'
import { loadFixtureData, loadFixtureGlossary, loadSnapshotData, staticDataService } from '../../fixtures/data/load'

/** 记下每个键被建了几次 */
function countingStore(): ModuleStore & { built: Map<string, number> } {
  const inner = createModuleStore()
  const built = new Map<string, number>()
  return {
    built,
    get<T>(key: string, create: () => T): T {
      return inner.get(key, () => {
        built.set(key, (built.get(key) ?? 0) + 1)
        return create()
      })
    },
  }
}

describe('index lifecycle', () => {
  it('reuses the index from the module store after a plugin reload', () => {
    const store = createModuleStore()
    const data = staticDataService()
    const first = createItemResolver({ data, store, aliases: [] })
    const raven = first.byId(638)
    const second = createItemResolver({ data, store, aliases: [] })
    expect(second.byId(638)).toBe(raven)
    expect(second.resolve('乌鸦', { scope: 'market' })).toMatchObject({ kind: 'unique' })
  })

  it('rebuilds right away when the data changes, and stops listening after dispose', () => {
    const data = staticDataService()
    let reads = 0
    const items = createItemResolver({ data: { ...data, current: () => { reads++; return data.current() } }, store: createModuleStore(), aliases: [] })
    expect(items.byId(16240)).toBeUndefined()
    reads = 0
    data.update(loadSnapshotData())
    expect(reads).toBe(1)
    expect(items.byId(16240)?.en).toBe('Catalyst')
    expect(items.stats().items).toBe(27309)
    items.dispose()
    reads = 0
    data.update(loadFixtureData())
    expect(reads).toBe(0)
  })

  it('rebuilds only the alias layer when the glossary changes', () => {
    const store = countingStore()
    const data = staticDataService()
    const items = createItemResolver({ data, store, aliases: [] })
    items.warm()
    expect(items.resolve('海万王', { scope: 'market' }).kind).toBe('unique')
    const empty: GlossaryData = { ...loadFixtureGlossary(), key: 'empty', entries: [] }
    data.update(loadFixtureData(), empty)
    expect(items.resolve('海万王', { scope: 'market' }).kind).not.toBe('unique')
    expect(store.built.get('data-memo/items/index')).toBe(1)
  })

  it('logs instead of throwing when a rebuild fails', () => {
    const warnings: unknown[][] = []
    const data = staticDataService()
    const items = createItemResolver({
      data: { ...data, current: () => { throw new Error('数据还没好') } },
      store: createModuleStore(),
      aliases: [],
      logger: { debug() {}, info() {}, warn: (...a: unknown[]) => { warnings.push(a) }, error() {} },
    })
    data.update(loadFixtureData())
    expect(warnings).toHaveLength(1)
    items.dispose()
  })
})
