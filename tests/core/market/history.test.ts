import { describe, expect, it } from 'vitest'
import { createHistoryService, sumByDate, windowStart } from '../../../src/core/market'
import { FakeTime } from '../../fakes/fake-time'
import { FakeHistoryApi, PLEX, RAVEN, THE_FORGE, day, httpError } from './helpers'

const GLOBAL = 19000001
// 编造的套装三件
const A = 20499
const B = 20501
const C = 20503

/** 2026-08-01 起每天一行 */
function daily(from: string, to: string, average: number) {
  const out = []
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(day(new Date(t).toISOString().slice(0, 10), average))
  }
  return out
}

function setup(start?: number) {
  const time = new FakeTime(start)
  const api = new FakeHistoryApi(() => time.now())
  return { time, api, history: createHistoryService({ esi: api, clock: time }) }
}

describe('windowStart', () => {
  it('counts the last N UTC days including today', () => {
    const now = Date.UTC(2026, 9, 7, 6, 20)
    expect(windowStart(now, 30)).toBe('2026-09-08')
    expect(windowStart(now, 1)).toBe('2026-10-07')
    // 北京时间已经是第二天，UTC 还是 10/07
    expect(windowStart(Date.UTC(2026, 9, 7, 23, 59), 90)).toBe('2026-07-10')
  })
})

describe('sumByDate', () => {
  it('adds the parts day by day and keeps only days every part traded', () => {
    expect(sumByDate([
      [day('2026-10-01', 10, 1), day('2026-10-02', 20, 2), day('2026-10-03', 30, 3)],
      [day('2026-10-03', 300, 30), day('2026-10-01', 100, 10)],
    ])).toEqual([
      { date: '2026-10-01', average: 110, highest: 121.00000000000001, lowest: 99, volume: 11, orderCount: 6 },
      { date: '2026-10-03', average: 330, highest: 363, lowest: 297, volume: 33, orderCount: 6 },
    ])
    expect(sumByDate([])).toEqual([])
  })
})

describe('HistoryService', () => {
  it('one item: the points inside the window, oldest first', async () => {
    const { api, history } = setup()
    api.set(THE_FORGE, RAVEN, daily('2026-08-01', '2026-10-06', 250_000_000).reverse())
    const result = await history.get(THE_FORGE, [RAVEN], 30)
    if ('ok' in result) throw new Error('unexpected failure')
    expect(result.points).toHaveLength(29)
    expect(result.points[0].date).toBe('2026-09-08')
    expect(result.points.at(-1)?.date).toBe('2026-10-06')
    expect(result).toMatchObject({ missing: [], stale: false, lastModified: Date.parse('2026-08-01T11:05:00Z') })
    expect(result).not.toHaveProperty('downtime')
    expect(api.calls).toEqual([{ regionId: THE_FORGE, typeId: RAVEN }])
  })

  it('a set: parts summed on the days all of them traded; parts with no history are listed as missing', async () => {
    const { api, history } = setup()
    api.set(THE_FORGE, A, [day('2026-10-04', 10), day('2026-10-05', 10), day('2026-10-06', 10)])
    api.set(THE_FORGE, B, [day('2026-10-04', 20), day('2026-10-06', 20)])
    api.set(THE_FORGE, C, [])
    const result = await history.get(THE_FORGE, [A, B, C, 20505, A], 30)
    if ('ok' in result) throw new Error('unexpected failure')
    expect(result.points.map((p) => [p.date, p.average, p.volume])).toEqual([['2026-10-04', 30, 20], ['2026-10-06', 30, 20]])
    expect(result.missing).toEqual([C, 20505])
    expect(api.calls.filter((c) => c.typeId === A)).toHaveLength(1)
  })

  it('PLEX always uses the global market region', async () => {
    const { api, history } = setup()
    api.set(GLOBAL, PLEX, [day('2026-10-06', 5_000_000)])
    const result = await history.get(THE_FORGE, [PLEX], 30)
    expect('points' in result && result.points).toHaveLength(1)
    expect(api.calls).toEqual([{ regionId: GLOBAL, typeId: PLEX }])
  })

  it('no history anywhere → NO_HISTORY; an ESI failure → UPSTREAM_UNAVAILABLE', async () => {
    const { api, history } = setup()
    expect(await history.get(THE_FORGE, [RAVEN], 30)).toMatchObject({ ok: false, code: 'NO_HISTORY' })
    api.set(THE_FORGE, RAVEN, [])
    expect(await history.get(THE_FORGE, [RAVEN], 30)).toMatchObject({ ok: false, code: 'NO_HISTORY' })
    api.set(THE_FORGE, A, [day('2026-10-06', 1)])
    api.set(THE_FORGE, B, httpError(503, 'GET /markets/{region_id}/history'))
    expect(await history.get(THE_FORGE, [A, B], 30)).toEqual({
      ok: false, code: 'UPSTREAM_UNAVAILABLE', message: 'GET /markets/{region_id}/history HTTP 503',
    })
  })

  it('marks stale data, and downtime when it happens between 11:00 and 11:30 UTC', async () => {
    const { api, history } = setup(Date.UTC(2026, 9, 7, 11, 5))
    api.stale = true
    api.set(THE_FORGE, RAVEN, [day('2026-10-06', 1)])
    expect(await history.get(THE_FORGE, [RAVEN], 30)).toMatchObject({ stale: true, downtime: true })

    const later = setup(Date.UTC(2026, 9, 7, 12, 0))
    later.api.stale = true
    later.api.set(THE_FORGE, RAVEN, [day('2026-10-06', 1)])
    const result = await later.history.get(THE_FORGE, [RAVEN], 30)
    expect(result).toMatchObject({ stale: true })
    expect(result).not.toHaveProperty('downtime')
  })

  it('rejects bad arguments without asking ESI', async () => {
    const { api, history } = setup()
    for (const [region, ids, days] of [[0, [RAVEN], 30], [THE_FORGE, [], 30], [THE_FORGE, [RAVEN], 0], [THE_FORGE, [RAVEN], 401], [THE_FORGE, [RAVEN], 1.5], [THE_FORGE, [-1], 30]] as const) {
      expect(await history.get(region, [...ids], days)).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    }
    expect(api.calls).toEqual([])
  })
})
