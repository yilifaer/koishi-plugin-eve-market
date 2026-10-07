import { describe, expect, it } from 'vitest'
import { MemoryResponseCache } from '../../../src/core/esi'
import type { EsiCacheEntry } from '../../../src/core/esi'

const entry = (bytes: number, value: unknown = bytes): EsiCacheEntry => ({ value, lastModified: null, expiresAt: 0, validatedAt: 0, bytes })

describe('MemoryResponseCache', () => {
  it('keeps the total size under the budget by dropping the least recently used', () => {
    const cache = new MemoryResponseCache(100)
    cache.set('a', entry(40))
    cache.set('b', entry(40))
    expect(cache.get('a')?.value).toBe(40)
    cache.set('c', entry(40))
    // b 最久没用，被丢掉
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
    expect(cache.bytes).toBe(80)
    expect(cache.size).toBe(2)
  })

  it('replacing an entry updates the size', () => {
    const cache = new MemoryResponseCache(100)
    cache.set('a', entry(60))
    cache.set('a', entry(10, 'new'))
    expect(cache.bytes).toBe(10)
    expect(cache.get('a')?.value).toBe('new')
    expect(cache.delete('a')).toBe(true)
    expect(cache.delete('a')).toBe(false)
    expect(cache.bytes).toBe(0)
  })

  it('always keeps the newest entry even when it alone is over budget', () => {
    const cache = new MemoryResponseCache(100)
    cache.set('a', entry(50))
    cache.set('big', entry(500))
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('big')?.bytes).toBe(500)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })

  it('rejects a non-positive budget', () => {
    expect(() => new MemoryResponseCache(0)).toThrow(RangeError)
  })
})
