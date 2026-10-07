import { describe, expect, it } from 'vitest'
import { Pool, mapLimit } from '../../../src/core/util'
import { flush } from '../../fakes/fake-time'

describe('Pool', () => {
  it('never runs more than the limit at once and keeps FIFO order', async () => {
    const pool = new Pool(2)
    let running = 0
    let peak = 0
    const started: number[] = []
    const gates: Array<() => void> = []
    const tasks = [0, 1, 2, 3, 4].map((i) => pool.run(async () => {
      started.push(i)
      running++
      peak = Math.max(peak, running)
      await new Promise<void>((resolve) => gates.push(resolve))
      running--
      return i
    }))
    await flush()
    expect(started).toEqual([0, 1])
    expect(pool.active).toBe(2)
    expect(pool.waiting).toBe(3)
    while (gates.length) {
      gates.shift()!()
      await flush()
    }
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4])
    expect(started).toEqual([0, 1, 2, 3, 4])
    expect(peak).toBe(2)
    expect(pool.active).toBe(0)
  })

  it('a failing task frees its slot', async () => {
    const pool = new Pool(1)
    await expect(pool.run(async () => { throw new Error('x') })).rejects.toThrow('x')
    await expect(pool.run(() => { throw new Error('sync') })).rejects.toThrow('sync')
    expect(await pool.run(async () => 'ok')).toBe('ok')
    expect(pool.active).toBe(0)
  })

  it('aborting a queued task removes it without running it', async () => {
    const pool = new Pool(1)
    let release!: () => void
    const first = pool.run(() => new Promise<void>((resolve) => { release = resolve }))
    const controller = new AbortController()
    let ran = false
    const second = pool.run(async () => { ran = true }, controller.signal)
    await flush()
    expect(pool.waiting).toBe(1)
    controller.abort(new Error('stop'))
    await expect(second).rejects.toThrow('stop')
    expect(pool.waiting).toBe(0)
    release()
    await first
    expect(ran).toBe(false)
    expect(pool.active).toBe(0)
    const aborted = new AbortController()
    aborted.abort()
    await expect(pool.run(async () => 1, aborted.signal)).rejects.toBeTruthy()
  })

  it('two pools do not share slots', async () => {
    const background = new Pool(1)
    const interactive = new Pool(1)
    let release!: () => void
    const slow = background.run(() => new Promise<void>((resolve) => { release = resolve }))
    expect(await interactive.run(async () => 'fast')).toBe('fast')
    release()
    await slow
  })

  it('mapLimit keeps the input order', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([30, 10, 20, 0], 2, async (ms, i) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, ms))
      running--
      return `${i}:${ms}`
    })
    expect(out).toEqual(['0:30', '1:10', '2:20', '3:0'])
    expect(peak).toBe(2)
  })

  it('rejects a bad limit', () => {
    expect(() => new Pool(0)).toThrow()
  })
})
