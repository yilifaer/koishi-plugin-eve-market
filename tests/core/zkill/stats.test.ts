import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyZkillStats, parseZkillStats, zkillCharKillsPath, zkillCharLossesPath, zkillStatsPath } from '../../../src/core/zkill'

const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/pilot', name), 'utf8'))

describe('zkill paths', () => {
  it('fills the character id into the three paths', () => {
    expect(zkillStatsPath(2119876543)).toBe('/api/stats/characterID/2119876543/')
    expect(zkillCharKillsPath(2119876543)).toBe('/api/kills/characterID/2119876543/')
    expect(zkillCharLossesPath(2119876543)).toBe('/api/losses/characterID/2119876543/')
  })
})

describe('parseZkillStats', () => {
  it('reads the full sample', () => {
    const s = parseZkillStats(fixture('zkill-stats-full.json'))
    expect(s).toMatchObject({
      present: true, kills: 290, losses: 52, soloKills: 88, soloLosses: 6, iskKilled: 23_200_000_000, iskLost: 3_100_000_000,
      danger: 82, gang: 38, avgGangSize: 4.6,
    })
    expect(s.topShips).toEqual([{ typeId: 17738, kills: 120 }, { typeId: 11978, kills: 60 }, { typeId: 638, kills: 40 }, { typeId: 587, kills: 20 }])
    expect(s.topSystems[0]).toEqual({ systemId: 30000142, kills: 90 })
    expect(s.groups).toContainEqual({ groupId: 463, kills: 0, losses: 2 })
    expect(s.week).toEqual({ kills: 14, ships: 6, systems: 3, regions: 2 })
    expect(s.labels['tz:eu']).toEqual({ kills: 200, losses: 30 })
    expect(s.labels['loc:w-space']).toEqual({ kills: 10, losses: 1 })
    expect(s.info).toEqual({
      name: 'Hanako Kisaragi', birthday: Date.UTC(2019, 2, 14, 8, 30), corporationId: 98000501, allianceId: 99000501, secStatus: 1.5,
    })
  })

  it('reads cyno leniently', () => {
    expect(parseZkillStats({ shipsLost: 5, cyno: { count: 4, standard: 3, covert: 1, industrial: 0 } }).cyno).toEqual({ count: 4, standard: 3, covert: 1, industrial: 0 })
    expect(parseZkillStats({ shipsLost: 5, cyno: { standard: 2, covert: 1 } }).cyno.count).toBe(3)
    expect(parseZkillStats({ shipsLost: 5, cyno: 'bad' }).cyno).toEqual({ count: 0, standard: 0, covert: 0, industrial: 0 })
    expect(parseZkillStats({ shipsLost: 5 }).cyno.count).toBe(0)
  })

  it('sums activity over the weekdays per UTC hour (sparse string keys)', () => {
    const s = parseZkillStats(fixture('zkill-stats-full.json'))
    expect(s.activityHours).toHaveLength(24)
    expect(s.activityHours[3]).toBe(2)
    expect(s.activityHours[19]).toBe(33)
    expect(s.activityHours[20]).toBe(26)
    expect(s.activityHours.reduce((n, v) => n + v, 0)).toBe(79)
    expect(s.recentLabels['tz:use']).toEqual({ kills: 9, losses: 1 })
  })

  it('reads odd activity shapes as empty', () => {
    for (const activity of [undefined, null, 5, 'x', [], {}, { max: 3, days: ['Sun'] }, { '0': 'x', '1': [], '2': { '5': 'no', '6': -4 } }, { '9': { '1': 5 } }]) {
      expect(parseZkillStats({ shipsDestroyed: 3, activity }).activityHours, JSON.stringify(activity)).toEqual([])
    }
    // 范围外的星期 / 小时忽略，范围内的照加
    expect(parseZkillStats({ shipsDestroyed: 3, activity: { '0': { '5': 2, '24': 9 }, '6': { '5': '3' }, '7': { '5': 100 } } }).activityHours[5]).toBe(5)
  })

  it('sums the activity per weekday too (0 = Sunday)', () => {
    const s = parseZkillStats({ shipsDestroyed: 3, activity: { '0': { '5': 2, '6': 1 }, '6': { '5': '3' }, '3': { '1': 4 } } })
    expect(s.activityDays).toEqual([3, 0, 0, 4, 0, 0, 3])
    expect(parseZkillStats({ shipsDestroyed: 3 }).activityDays).toEqual([])
  })

  it('keeps the attacker-count labels (#:10+)', () => {
    const s = parseZkillStats({ shipsDestroyed: 3, labels: { '#:10+': { shipsLost: 4 }, '#:100+': { shipsLost: 2, shipsDestroyed: 1 }, 'bad key!': { shipsLost: 9 } } })
    expect(s.labels['#:10+']).toEqual({ kills: 0, losses: 4 })
    expect(s.labels['#:100+']).toEqual({ kills: 1, losses: 2 })
    expect(s.labels['bad key!']).toBeUndefined()
  })

  it('returns months sorted oldest first as YYYY-MM', () => {
    const s = parseZkillStats(fixture('zkill-stats-full.json'))
    expect(s.months).toHaveLength(12)
    expect(s.months[0]).toMatchObject({ ym: '2025-11', kills: 12, losses: 3 })
    expect(s.months.at(-1)).toMatchObject({ ym: '2026-10', kills: 9, losses: 1 })
    expect(s.months.map((m) => m.ym)).toEqual([...s.months.map((m) => m.ym)].sort())
  })

  it('never keeps info.description', () => {
    for (const name of ['zkill-stats-full.json', 'zkill-stats-bad-types.json']) {
      const text = JSON.stringify(parseZkillStats(fixture(name)))
      expect(text).not.toMatch(/description|evil\.example|spam\.example|secret blurb|<p>/)
    }
  })

  it('handles a partial sample: missing sections are empty', () => {
    const s = parseZkillStats(fixture('zkill-stats-partial.json'))
    expect(s).toMatchObject({ present: true, kills: 14, losses: 3, soloKills: 1, danger: 55, gang: null })
    expect(s.months).toEqual([])
    expect(s.groups).toEqual([])
    expect(s.topShips).toEqual([])
    expect(s.topSystems).toEqual([])
    expect(s.week).toBeNull()
    expect(s.labels).toEqual({})
  })

  it('treats an all-zero sample as present with no records', () => {
    const s = parseZkillStats(fixture('zkill-stats-zero.json'))
    expect(s.present).toBe(true)
    expect(s.kills + s.losses).toBe(0)
    expect(s.week).toBeNull()
  })

  it.each([['{}', fixture('zkill-stats-empty.json')], ['null', fixture('zkill-stats-null.json')], ['array', []], ['string', 'oops'], ['number', 5], ['undefined', undefined]])(
    'treats %s as no record without throwing',
    (_, raw) => {
      expect(parseZkillStats(raw)).toEqual(emptyZkillStats())
    },
  )

  it('survives wrong types: bad values become empty, numeric strings are accepted', () => {
    const s = parseZkillStats(fixture('zkill-stats-bad-types.json'))
    expect(s.kills).toBe(37)
    expect(s.losses).toBe(0)
    expect(s.iskKilled).toBe(0)
    expect(s.iskLost).toBe(0)
    expect(s.soloKills).toBe(0)
    expect(s.danger).toBe(88)
    // 超范围的比例夹到 100
    expect(s.gang).toBe(100)
    expect(s.months).toEqual([])
    expect(s.groups).toEqual([])
    expect(s.topShips).toEqual([])
    expect(s.week).toBeNull()
    expect(s.labels['tz:eu']).toBeUndefined()
    expect(s.labels['loc:nullsec']).toEqual({ kills: 7, losses: 0 })
    expect(s.info).toEqual({ name: null, birthday: null, corporationId: 98000501, allianceId: null, secStatus: null })
  })

  it('ignores label keys that would replace the prototype', () => {
    const s = parseZkillStats(JSON.parse('{"shipsDestroyed":1,"labels":{"__proto__":{"shipsDestroyed":9},"constructor":{"shipsDestroyed":9},"tz:eu":{"shipsDestroyed":2,"shipsLost":1}}}'))
    expect(Object.getPrototypeOf(s.labels)).toBe(Object.prototype)
    expect(Object.keys(s.labels)).toEqual(['tz:eu'])
  })

  it('falls back to topShips when topAllTime has no ship list', () => {
    const s = parseZkillStats({
      shipsDestroyed: 10,
      topAllTime: [{ type: 'system', data: [{ kills: 3, solarSystemID: 30000142 }] }],
      topShips: [{ shipTypeID: 587, kills: 2 }, { shipTypeID: 17738, kills: 7 }, { shipTypeID: 11978, kills: 0 }],
    })
    expect(s.topShips).toEqual([{ typeId: 17738, kills: 7 }, { typeId: 587, kills: 2 }])
  })

  it('reads a month from year/month fields when the key is not YYYYMM', () => {
    const s = parseZkillStats({ shipsDestroyed: 1, months: { latest: { year: 2026, month: 9, shipsDestroyed: 4 }, '202613': { year: 2026, month: 13 } } })
    expect(s.months).toEqual([{ ym: '2026-09', kills: 4, losses: 0, iskKilled: 0, iskLost: 0 }])
  })
})
