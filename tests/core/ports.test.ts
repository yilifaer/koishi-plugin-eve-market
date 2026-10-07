import { describe, expect, it } from 'vitest'
import { createModuleStore } from '../../src/core/ports'

describe('createModuleStore', () => {
  it('creates a value once per key and keeps returning it', () => {
    const store = createModuleStore()
    let made = 0
    const a = store.get('esi', () => ({ id: ++made }))
    expect(store.get('esi', () => ({ id: ++made }))).toBe(a)
    expect(store.get('data', () => ({ id: ++made }))).toEqual({ id: 2 })
    expect(made).toBe(2)
  })

  it('separate stores do not share state', () => {
    const one = createModuleStore()
    const two = createModuleStore()
    one.get('x', () => new Map([['k', 1]]))
    expect(two.get('x', () => new Map<string, number>()).size).toBe(0)
  })
})
