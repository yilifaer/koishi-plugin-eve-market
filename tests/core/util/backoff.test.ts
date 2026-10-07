import { describe, expect, it } from 'vitest'
import { Backoff, jitter, randomBetween, sleep, withDeadline } from '../../../src/core/util'
import { FakeTime } from '../../fakes/fake-time'

const MIN = 60_000

describe('Backoff', () => {
  it('walks the steps and then stays on the last one', () => {
    const b = new Backoff([1 * MIN, 5 * MIN, 15 * MIN, 60 * MIN])
    expect(b.peek()).toBe(MIN)
    expect([b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([MIN, 5 * MIN, 15 * MIN, 60 * MIN, 60 * MIN])
    expect(b.attempts).toBe(5)
    b.reset()
    expect(b.next()).toBe(MIN)
  })

  it('needs at least one step', () => {
    expect(() => new Backoff([])).toThrow()
  })

  it('random helpers use the injected source', () => {
    expect(randomBetween(500, 1500, () => 0)).toBe(500)
    expect(randomBetween(500, 1500, () => 0.5)).toBe(1000)
    expect(jitter(1000, 0.1, () => 0)).toBeCloseTo(900)
    expect(jitter(1000, 0.1, () => 0.5)).toBeCloseTo(1000)
    expect(jitter(1000, 0.1, () => 0.999999)).toBeCloseTo(1100, 2)
  })
})

describe('sleep / withDeadline', () => {
  it('sleep resolves on the fake clock and can be aborted', async () => {
    const time = new FakeTime()
    let done = false
    const p = sleep(time, 1000).then(() => { done = true })
    await time.advance(999)
    expect(done).toBe(false)
    await time.advance(1)
    await p
    expect(done).toBe(true)

    const controller = new AbortController()
    const q = sleep(time, 1000, controller.signal)
    controller.abort(new Error('dispose'))
    await expect(q).rejects.toThrow('dispose')
    expect(time.pending).toBe(0)
  })

  it('returns the value when it arrives in time', async () => {
    const time = new FakeTime()
    const task = sleep(time, 500).then(() => 'quote')
    const result = withDeadline(task, 6000, time)
    await time.advance(500)
    expect(await result).toEqual({ done: true, value: 'quote' })
    expect(time.pending).toBe(0)
  })

  it('gives up at the deadline but lets the task finish in the background', async () => {
    const time = new FakeTime()
    let finished = false
    const task = sleep(time, 10_000).then(() => { finished = true })
    const result = withDeadline(task, 6000, time)
    await time.advance(6000)
    expect(await result).toEqual({ done: false })
    await time.advance(4000)
    expect(finished).toBe(true)
  })

  it('rethrows errors before the deadline and swallows later ones', async () => {
    const time = new FakeTime()
    const early = withDeadline(Promise.reject(new Error('503')), 1000, time)
    await expect(early).rejects.toThrow('503')

    const late = sleep(time, 2000).then(() => { throw new Error('late') })
    const result = withDeadline(late, 1000, time)
    await time.advance(2000)
    expect(await result).toEqual({ done: false })
  })
})
