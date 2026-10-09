import { describe, expect, it } from 'vitest'
import { FailureMemo } from '../../../src/core/util'
import { FakeTime } from '../../fakes/fake-time'

describe('FailureMemo', () => {
  it('returns the remembered failure until it expires, and keep = false only passes it through', async () => {
    const time = new FakeTime(0)
    const memo = new FailureMemo<string>(time, 30_000)
    expect(memo.get()).toBeNull()
    expect(memo.remember('down')).toBe('down')
    await time.advance(29_999)
    expect(memo.get()).toBe('down')
    await time.advance(1)
    expect(memo.get()).toBeNull()
    expect(memo.remember('deadline', false)).toBe('deadline')
    expect(memo.get()).toBeNull()
    memo.remember('down')
    memo.clear()
    expect(memo.get()).toBeNull()
  })
})
