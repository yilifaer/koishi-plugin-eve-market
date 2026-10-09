import { afterEach, describe, expect, it } from 'vitest'
import { TIMEZONE } from '../../../src/constants'
import { formatClock } from '../../../src/core/format'
import { createServerStatus, nextDowntime } from '../../../src/core/universe'
import type { CoreFailure, ServerStatus } from '../../../src/core/types'
import { closeAll, makeEnv } from '../esi/helpers'

const STATUS = /^\/status$/
/** ISO 时间 → 毫秒 */
const at = (iso: string) => Date.parse(iso)

afterEach(closeAll)

async function setup(start = '2026-10-07T06:20:00Z') {
  const env = await makeEnv({}, (fake) => {
    fake.serverStatus = { players: 21873, server_version: '3012345', start_time: '2026-10-06T11:04:00Z' }
  })
  env.clock.t = at(start)
  return { env, status: createServerStatus({ esi: env.api, clock: env.clock, logger: env.logger }) }
}

function ok(value: ServerStatus | CoreFailure): ServerStatus {
  if ('ok' in value) throw new Error(`失败了：${value.message}`)
  return value
}

describe('nextDowntime', () => {
  it('is today at 11:00 EVE time before it, tomorrow from 11:00 on', () => {
    expect(nextDowntime(at('2026-10-07T06:20:00Z'))).toBe(at('2026-10-07T11:00:00Z'))
    expect(nextDowntime(at('2026-10-07T10:59:59Z'))).toBe(at('2026-10-07T11:00:00Z'))
    expect(nextDowntime(at('2026-10-07T11:00:00Z'))).toBe(at('2026-10-08T11:00:00Z'))
    expect(nextDowntime(at('2026-10-07T11:20:00Z'))).toBe(at('2026-10-08T11:00:00Z'))
    expect(nextDowntime(at('2026-10-31T23:59:00Z'))).toBe(at('2026-11-01T11:00:00Z'))
  })

  it('shows as 19:00 Beijing time and 11:00 EVE time', () => {
    const now = at('2026-10-07T14:20:00Z')
    const next = nextDowntime(now)
    expect(formatClock(next, now, TIMEZONE)).toBe('10/08 19:00')
    expect(formatClock(next, now, 'UTC')).toBe('10/08 11:00')
    expect(formatClock(now, now, TIMEZONE)).toBe('22:20')
  })
})

describe('server status', () => {
  it('players, version, start time, uptime, next downtime; vip is false when ESI leaves it out', async () => {
    const s = await setup()
    const got = ok(await s.status.get())
    expect(got).toMatchObject({
      players: 21873,
      serverVersion: '3012345',
      startTime: at('2026-10-06T11:04:00Z'),
      vip: false,
      uptimeSec: 19 * 3600 + 16 * 60,
      nextDowntime: at('2026-10-07T11:00:00Z'),
      stale: false,
    })
    expect(got.dataTime).toEqual(expect.any(Number))
  })

  it('VIP mode', async () => {
    const s = await setup()
    s.env.fake.serverStatus = { ...s.env.fake.serverStatus, vip: true }
    expect(ok(await s.status.get()).vip).toBe(true)
  })

  it('a start time in the future does not give a negative uptime', async () => {
    const s = await setup('2026-10-06T11:00:00Z')
    expect(ok(await s.status.get()).uptimeSec).toBe(0)
  })

  it('cached for about 30 seconds (ESI cache headers)', async () => {
    const { env: e, status } = await setup()
    await status.get()
    e.clock.advance(29_000)
    await status.get()
    expect(e.fake.count(STATUS)).toBe(1)
    e.clock.advance(2_000)
    await status.get()
    expect(e.fake.count(STATUS)).toBe(2)
  })

  it('no answer from ESI → UPSTREAM_UNAVAILABLE; the failure is remembered for 30 seconds', async () => {
    const { env: e, status } = await setup()
    e.fake.fault('GET', STATUS, { status: 502 }, 2)
    expect(await status.get()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    const asked = e.fake.count(STATUS)
    e.clock.advance(20_000)
    expect(await status.get()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    expect(e.fake.count(STATUS)).toBe(asked)
    e.clock.advance(11_000)
    expect(ok(await status.get()).players).toBe(21873)
  })

  it('outside downtime a short ESI hiccup shows the last answer, marked stale', async () => {
    const { env: e, status } = await setup()
    await status.get()
    e.clock.advance(60_000)
    e.fake.fault('GET', STATUS, { status: 502 }, 2)
    expect(ok(await status.get())).toMatchObject({ players: 21873, stale: true })
  })

  it('503 means the server is offline: never the old answer', async () => {
    const { env: e, status } = await setup()
    await status.get()
    e.clock.advance(60_000)
    e.fake.fault('GET', STATUS, { status: 503, body: { error: 'The datasource tranquility is temporarily unavailable' } }, 2)
    expect(await status.get()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
  })

  it('during downtime (11:00–11:30) an old "online" is never shown', async () => {
    const { env: e, status } = await setup('2026-10-07T10:59:00Z')
    expect(ok(await status.get()).nextDowntime).toBe(at('2026-10-07T11:00:00Z'))
    e.clock.advance(2 * 60_000)
    e.fake.fault('GET', STATUS, { destroy: true }, 2)
    expect(await status.get()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
  })

  it('a slow ESI answers "unavailable" at the deadline without remembering it; the late answer is used next time', async () => {
    const e = await makeEnv()
    const status = createServerStatus({ esi: e.api, clock: e.clock, deadlineMs: 50 })
    const release = e.fake.hold(STATUS)
    expect(await status.get()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(ok(await status.get()).players).toBe(23456)
    expect(e.fake.count(STATUS)).toBe(1)
  })
})
