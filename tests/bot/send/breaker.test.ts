import { describe, expect, it } from 'vitest'
import { Breaker } from '../../../src/bot/send/breaker'
import { EchoLog, echoChannel } from '../../../src/bot/send/echo'
import { LogGate } from '../../../src/bot/send/log-gate'

const MIN = 60_000

describe('Breaker', () => {
  it('opens after 3 markdown failures within 10 minutes, for 30 minutes', () => {
    const breaker = new Breaker()
    expect(breaker.fail(0)).toBe(false)
    expect(breaker.fail(4 * MIN)).toBe(false)
    expect(breaker.isOpen(5 * MIN)).toBe(false)
    expect(breaker.fail(9 * MIN)).toBe(true)
    expect(breaker.isOpen(9 * MIN)).toBe(true)
    expect(breaker.status(10 * MIN)).toEqual({ open: true, until: 39 * MIN, recentFailures: 0, trips: 1, lastTripAt: 9 * MIN })
    expect(breaker.isOpen(39 * MIN - 1)).toBe(true)
    expect(breaker.isOpen(39 * MIN)).toBe(false)
    expect(breaker.status(40 * MIN).open).toBe(false)
  })

  it('forgets failures older than the window', () => {
    const breaker = new Breaker()
    breaker.fail(0)
    breaker.fail(2 * MIN)
    expect(breaker.fail(11 * MIN)).toBe(false)
    expect(breaker.status(11 * MIN).recentFailures).toBe(2)
    expect(breaker.fail(11.5 * MIN)).toBe(true)
  })

  it('ignores failures while open and starts over after the cooldown', () => {
    const breaker = new Breaker({ failures: 2, windowMs: MIN, cooldownMs: 5 * MIN })
    breaker.fail(0)
    expect(breaker.fail(1)).toBe(true)
    expect(breaker.fail(2)).toBe(false)
    expect(breaker.fail(5 * MIN + 1)).toBe(false)
    expect(breaker.isOpen(5 * MIN + 2)).toBe(false)
  })
})

describe('EchoLog', () => {
  it('remembers what was sent in a channel for 60 seconds', () => {
    const echo = new EchoLog()
    echo.record('qq:G1', '查价 乌鸦级\n第二行', 1000)
    expect(echo.seen('qq:G1', '查价 乌鸦级\n第二行', 1000 + 59_999)).toBe(true)
    expect(echo.seen('qq:G1', '  查价  乌鸦级\r\n第二行 ', 2000)).toBe(true)
    expect(echo.seen('qq:G2', '查价 乌鸦级\n第二行', 2000)).toBe(false)
    expect(echo.seen('qq:G1', '查价 乌鸦级', 2000)).toBe(false)
    expect(echo.seen('qq:G1', '查价 乌鸦级\n第二行', 61_000)).toBe(false)
  })

  it('ignores empty text and keys channels by platform', () => {
    const echo = new EchoLog()
    echo.record('qq:G1', '   ', 0)
    expect(echo.seen('qq:G1', '   ', 0)).toBe(false)
    expect(echoChannel({ platform: 'qq', channelId: 'G1' })).toBe('qq:G1')
  })

  it('keeps a bounded number of entries per channel', () => {
    const echo = new EchoLog()
    for (let i = 0; i < 60; i++) echo.record('qq:G1', `第 ${i} 条`, i)
    expect(echo.seen('qq:G1', '第 0 条', 100)).toBe(false)
    expect(echo.seen('qq:G1', '第 59 条', 100)).toBe(true)
  })
})

describe('LogGate', () => {
  it('lets each key through once per hour', () => {
    const gate = new LogGate()
    expect(gate.allow('fail:40054010', 0)).toBe(true)
    expect(gate.allow('fail:40054010', 59 * MIN)).toBe(false)
    expect(gate.allow('fail:40034128', 59 * MIN)).toBe(true)
    expect(gate.allow('fail:40054010', 60 * MIN)).toBe(true)
  })
})
