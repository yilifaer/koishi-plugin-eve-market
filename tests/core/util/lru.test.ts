import { describe, expect, it } from 'vitest'
import { LruCache } from '../../../src/core/util'
import { FakeTime } from '../../fakes/fake-time'

describe('LruCache', () => {
  it('drops the least recently used entry when full', () => {
    const lru = new LruCache<string, number>({ max: 2 })
    lru.set('a', 1).set('b', 2)
    expect(lru.get('a')).toBe(1) // a 变成最近用过
    lru.set('c', 3)
    expect(lru.has('b')).toBe(false)
    expect(lru.keys()).toEqual(['a', 'c'])
    expect(lru.size).toBe(2)
  })

  it('peek does not change the order', () => {
    const lru = new LruCache<string, number>({ max: 2 })
    lru.set('a', 1).set('b', 2)
    expect(lru.peek('a')).toBe(1)
    lru.set('c', 3)
    expect(lru.has('a')).toBe(false)
  })

  it('overwriting a key moves it to the end', () => {
    const lru = new LruCache<string, number>({ max: 2 })
    lru.set('a', 1).set('b', 2).set('a', 10).set('c', 3)
    expect(lru.keys()).toEqual(['a', 'c'])
    expect(lru.get('a')).toBe(10)
  })

  it('expires entries by the injected clock', async () => {
    const time = new FakeTime()
    const lru = new LruCache<string, string>({ max: 10, ttlMs: 1000, now: () => time.now() })
    lru.set('a', 'x')
    lru.set('forever', 'y', 0)
    lru.set('long', 'z', 5000)
    await time.advance(999)
    expect(lru.get('a')).toBe('x')
    await time.advance(1)
    expect(lru.get('a')).toBeUndefined()
    expect(lru.has('long')).toBe(true)
    await time.advance(10_000)
    expect(lru.prune()).toBe(1)
    expect(lru.keys()).toEqual(['forever'])
  })

  it('refuses ttl without a clock and a bad max', () => {
    expect(() => new LruCache({ max: 2, ttlMs: 10 })).toThrow()
    expect(() => new LruCache({ max: 0 })).toThrow()
    expect(() => new LruCache<string, number>({ max: 2 }).set('a', 1, 100)).toThrow()
  })

  it('delete and clear', () => {
    const lru = new LruCache<number, number>({ max: 3 })
    lru.set(1, 1).set(2, 2)
    expect(lru.delete(1)).toBe(true)
    expect(lru.delete(1)).toBe(false)
    lru.clear()
    expect(lru.size).toBe(0)
  })
})
