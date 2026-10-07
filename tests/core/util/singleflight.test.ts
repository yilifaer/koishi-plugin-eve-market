import { describe, expect, it } from 'vitest'
import { SingleFlight } from '../../../src/core/util'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SingleFlight', () => {
  it('shares one call between concurrent callers', async () => {
    const sf = new SingleFlight<string, number>()
    const d = deferred<number>()
    let calls = 0
    const fn = () => {
      calls++
      return d.promise
    }
    const all = Array.from({ length: 10 }, () => sf.run('10000002:638', fn))
    expect(calls).toBe(1)
    expect(sf.has('10000002:638')).toBe(true)
    d.resolve(42)
    expect(await Promise.all(all)).toEqual(Array(10).fill(42))
    expect(sf.size).toBe(0)
  })

  it('different keys run separately and a finished key runs again', async () => {
    const sf = new SingleFlight<string, string>()
    let calls = 0
    const fn = async () => `r${++calls}`
    expect(await Promise.all([sf.run('a', fn), sf.run('b', fn)])).toEqual(['r1', 'r2'])
    expect(await sf.run('a', fn)).toBe('r3')
  })

  it('shares failures and forgets them afterwards', async () => {
    const sf = new SingleFlight<string, number>()
    const d = deferred<number>()
    const a = sf.run('k', () => d.promise)
    const b = sf.run('k', () => Promise.resolve(1))
    d.reject(new Error('boom'))
    await expect(a).rejects.toThrow('boom')
    await expect(b).rejects.toThrow('boom')
    expect(await sf.run('k', async () => 2)).toBe(2)
  })

  it('a synchronous throw becomes a rejection', async () => {
    const sf = new SingleFlight<string, number>()
    await expect(sf.run('k', () => { throw new Error('sync') })).rejects.toThrow('sync')
    expect(sf.size).toBe(0)
  })
})
