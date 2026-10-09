import { afterEach, describe, expect, it } from 'vitest'
import { DataNotReadyError } from '../../../src/core/data'
import { createIncursions, createServerStatus } from '../../../src/core/universe'
import type { CoreFailure, Incursion, IncursionsResult } from '../../../src/core/types'
import { rawIncursion } from '../../fakes/fake-esi'
import { staticDataService } from '../../fixtures/data/load'
import { closeAll, makeEnv } from '../esi/helpers'
import { universe } from './helpers'

const INCURSIONS = /^\/incursions$/

// 小数据集里的星座和星系
const KIMOTORO = 20000020 // 伏尔戈，高安
const MEKASHTAD = 20000009 // 德里克，Iosantin 0.450343
const MINNEN = 20000205 // 长征，Aunenen 0.44779
const ELFRARD = 20000355 // 摩登赫斯，Egbinger 0.034555
const KH730 = 20000132 // 大荒野，代号星系
const JITA = 30000142
const PERIMETER = 30000144
const NEW_CALDARI = 30000145
const IOSANTIN = 30000062
const AUNENEN = 30001398
const EGBINGER = 30002420
const NIH = 30000900
const JPL = 30000901
const NK = 30000902
const SANSHA = 500019
// 编造的、数据里没有的 ID
const NEW_CONSTELLATION = 20999001
const NEW_SYSTEM = 30999001
const NEW_FACTION = 500999

afterEach(closeAll)

async function setup(list: unknown[]) {
  const env = await makeEnv({}, (fake) => {
    fake.incursions = list
  })
  const source = createIncursions({ esi: env.api, data: staticDataService(), clock: env.clock, logger: env.logger })
  return { env, source }
}

function ok(value: IncursionsResult | CoreFailure): IncursionsResult {
  if ('ok' in value) throw new Error(`失败了：${value.message}`)
  return value
}

const brief = (i: Incursion) => `${i.secClass} ${i.constellation.en} @${i.staging?.en}`

describe('incursions', () => {
  it('names in both languages from the data, staging system first, influence and boss as given', async () => {
    const { source } = await setup([rawIncursion({ infested_solar_systems: [PERIMETER, JITA, NEW_CALDARI], influence: 0.64, has_boss: true })])
    const [one, ...rest] = ok(await source.get()).incursions
    expect(rest).toEqual([])
    expect(one).toEqual({
      constellation: { id: KIMOTORO, en: 'Kimotoro', zh: '木本呂' },
      region: { id: 10000002, en: 'The Forge', zh: '伏尔戈' },
      staging: { id: JITA, en: 'Jita', zh: '吉他', security: 0.945913 },
      secClass: 'high',
      state: 'established',
      influence: 0.64,
      hasBoss: true,
      faction: { id: SANSHA, en: "Sansha's Nation", zh: '萨沙共和国' },
      systems: [
        { id: JITA, en: 'Jita', zh: '吉他', security: 0.945913 },
        { id: PERIMETER, en: 'Perimeter', zh: '皮尔米特', security: 0.949 },
        { id: NEW_CALDARI, en: 'New Caldari', zh: '新加达里', security: 0.949 },
      ],
    })
  })

  it('sorted high → low → null-sec by the staging system, higher security first within a class', async () => {
    const { source } = await setup([
      rawIncursion({ constellation_id: KH730, staging_solar_system_id: NIH, infested_solar_systems: [NIH, JPL, NK], state: 'withdrawing' }),
      rawIncursion({ constellation_id: ELFRARD, staging_solar_system_id: EGBINGER, infested_solar_systems: [EGBINGER], state: 'mobilizing' }),
      rawIncursion({ constellation_id: MEKASHTAD, staging_solar_system_id: IOSANTIN, infested_solar_systems: [IOSANTIN] }),
      rawIncursion({ constellation_id: MINNEN, staging_solar_system_id: AUNENEN, infested_solar_systems: [AUNENEN] }),
      rawIncursion(),
    ])
    const list = ok(await source.get()).incursions
    expect(list.map(brief)).toEqual([
      'high Kimotoro @Jita',
      'high Mekashtad @Iosantin',
      'low Minnen @Aunenen',
      'low Elfrard @Egbinger',
      'null 730-KH @NIH-02',
    ])
    expect(list.map((i) => i.state)).toEqual(['established', 'established', 'established', 'mobilizing', 'withdrawing'])
    // 代号星座、星系没有中文名
    expect(list[4].constellation).toEqual({ id: KH730, en: '730-KH', zh: '' })
    expect(list[4].region).toEqual({ id: 10000011, en: 'Great Wildlands', zh: '大荒野' })
  })

  it('IDs missing from the data show as the ID itself, never through /universe/names', async () => {
    const { env, source } = await setup([rawIncursion({
      constellation_id: NEW_CONSTELLATION, faction_id: NEW_FACTION, staging_solar_system_id: NEW_SYSTEM, infested_solar_systems: [NEW_SYSTEM, AUNENEN],
    })])
    const [one] = ok(await source.get()).incursions
    expect(one.constellation).toEqual({ id: NEW_CONSTELLATION, en: String(NEW_CONSTELLATION), zh: '' })
    expect(one.region).toBeNull()
    expect(one.faction).toEqual({ id: NEW_FACTION, en: String(NEW_FACTION), zh: '' })
    expect(one.staging).toMatchObject({ id: NEW_SYSTEM, en: String(NEW_SYSTEM), zh: '' })
    expect(one.staging?.security).toBeNaN()
    // 集结星系不知道时按其他被入侵星系分类
    expect(one.secClass).toBe('low')
    expect(one.systems.map((s) => s.en)).toEqual([String(NEW_SYSTEM), 'Aunenen'])
    expect(env.fake.count(/^\/universe\/names$/, 'POST')).toBe(0)
  })

  it('nothing known at all counts as null-sec; influence is kept between 0 and 1; duplicates are dropped', async () => {
    const { source } = await setup([
      rawIncursion({ staging_solar_system_id: NEW_SYSTEM, infested_solar_systems: [NEW_SYSTEM], influence: 1.2 }),
      rawIncursion({ infested_solar_systems: [JITA, PERIMETER, PERIMETER], influence: -0.1 }),
    ])
    const list = ok(await source.get()).incursions
    expect(list.map((i) => [i.secClass, i.influence])).toEqual([['high', 0], ['null', 1]])
    expect(list[0].systems.map((s) => s.id)).toEqual([JITA, PERIMETER])
  })

  it('no incursions → an empty list', async () => {
    const { source } = await setup([])
    expect(ok(await source.get())).toMatchObject({ incursions: [], stale: false, dataTime: expect.any(Number) })
  })

  it('cached for 5 minutes; after that an ESI error falls back to the last list, marked stale', async () => {
    const { env, source } = await setup([rawIncursion()])
    await source.get()
    env.clock.advance(4 * 60_000)
    await source.get()
    expect(env.fake.count(INCURSIONS)).toBe(1)
    env.clock.advance(2 * 60_000)
    env.fake.fault('GET', INCURSIONS, { status: 502 }, 2)
    const stale = ok(await source.get())
    expect(stale.stale).toBe(true)
    expect(stale.incursions.map(brief)).toEqual(['high Kimotoro @Jita'])
  })

  it('ESI down with nothing cached → UPSTREAM_UNAVAILABLE, remembered for 30 seconds', async () => {
    const { env, source } = await setup([rawIncursion()])
    env.fake.fault('GET', INCURSIONS, { status: 500 }, 2)
    expect(await source.get()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    const asked = env.fake.count(INCURSIONS)
    expect(await source.get()).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    expect(env.fake.count(INCURSIONS)).toBe(asked)
    env.clock.advance(31_000)
    expect(ok(await source.get()).incursions).toHaveLength(1)
  })

  it('data not loaded yet → DATA_NOT_READY without asking ESI', async () => {
    const env = await makeEnv()
    const source = createIncursions({ esi: env.api, data: { current: () => { throw new DataNotReadyError() } }, clock: env.clock })
    expect(await source.get()).toMatchObject({ ok: false, code: 'DATA_NOT_READY' })
    expect(env.fake.count(INCURSIONS)).toBe(0)
  })
})

describe('UniverseService wiring', () => {
  it('without sources incursions and server status answer NOT_CONFIGURED', async () => {
    const u = universe()
    expect(await u.incursions()).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
    expect(await u.serverStatus()).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
  })

  it('with sources they go to ESI', async () => {
    const env = await makeEnv({}, (fake) => {
      fake.incursions = [rawIncursion()]
    })
    const data = staticDataService()
    const u = universe({
      data,
      incursions: createIncursions({ esi: env.api, data, clock: env.clock }),
      status: createServerStatus({ esi: env.api, clock: env.clock }),
    })
    expect(ok(await u.incursions()).incursions).toHaveLength(1)
    expect(await u.serverStatus()).toMatchObject({ players: 23456 })
  })
})
