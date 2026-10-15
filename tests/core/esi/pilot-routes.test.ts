import { afterEach, describe, expect, it } from 'vitest'
import { parseAlliance, parseCharacter, parseCharacterSearch, parseCorpHistory, parseCorporation, parseStation } from '../../../src/core/esi'
import { EsiError } from '../../../src/core/esi'
import { rawCharacter } from '../../fakes/fake-esi'
import { authFrom, closeAll, makeEnv } from './helpers'

afterEach(closeAll)

const HANAKO = 2119876543

describe('EsiApi: characters, corporations, alliances, stations', () => {
  it('character: camelCase fields, birthday in ms, optional title and alliance', async () => {
    const env = await makeEnv({}, (f) => {
      f.characters.set(HANAKO, rawCharacter({ corporation_title: '<b>Quartermaster</b>', description: 'long blurb' }))
      f.characters.set(2119876544, rawCharacter({ name: 'Mika Tsukishiro', alliance_id: undefined, security_status: undefined }))
    })
    expect((await env.api.character(HANAKO)).value).toEqual({
      name: 'Hanako Kisaragi', corporationId: 98000501, allianceId: 99000501, birthday: Date.UTC(2019, 2, 14, 8, 30), securityStatus: 1.5,
      title: '<b>Quartermaster</b>',
    })
    expect((await env.api.character(2119876544)).value).toMatchObject({ name: 'Mika Tsukishiro', allianceId: null, securityStatus: null, title: null })
  })

  it('character: legacy title field still works, corporation_title wins', () => {
    const base = { name: 'A', corporation_id: 1, birthday: '2019-03-14T08:30:00Z' }
    expect(parseCharacter({ ...base, title: 'Old Title' }).title).toBe('Old Title')
    expect(parseCharacter({ ...base, corporation_title: '#New-Title', title: 'Old Title' }).title).toBe('#New-Title')
  })

  it('character: 404 is an http error and results are cached for an hour', async () => {
    const env = await makeEnv({}, (f) => f.characters.set(HANAKO, rawCharacter()))
    await expect(env.api.character(2119000999)).rejects.toMatchObject({ kind: 'http', status: 404 })
    await env.api.character(HANAKO)
    await env.api.character(HANAKO)
    expect(env.fake.count(new RegExp(`/characters/${HANAKO}$`))).toBe(1)
    env.clock.advance(61 * 60_000)
    await env.api.character(HANAKO)
    expect(env.fake.count(new RegExp(`/characters/${HANAKO}$`))).toBeGreaterThanOrEqual(2)
  })

  it('corporationHistory, corporation (ticker, home station) and alliance (ticker)', async () => {
    const env = await makeEnv({}, (f) => {
      f.corpHistory.set(HANAKO, [
        { corporation_id: 98000501, record_id: 40, start_date: '2023-01-01T00:00:00Z' },
        { corporation_id: 1000115, record_id: 3, start_date: '2019-03-14T08:30:00Z', is_deleted: false },
      ])
      f.corporations.set(98000501, { name: 'Moonlit Harbor Logistics', ticker: 'MHL', home_station_id: 60009999, alliance_id: 99000501 })
      f.corporations.set(1000115, { name: 'Fictional Academy', ticker: 'FACAD' })
      f.alliances.set(99000501, { name: 'Fictional Federation', ticker: 'FICT' })
    })
    expect((await env.api.corporationHistory(HANAKO)).value).toEqual([
      { corporationId: 98000501, recordId: 40, startDate: Date.UTC(2023, 0, 1), isDeleted: false },
      { corporationId: 1000115, recordId: 3, startDate: Date.UTC(2019, 2, 14, 8, 30), isDeleted: false },
    ])
    expect((await env.api.corporation(98000501)).value).toEqual({ name: 'Moonlit Harbor Logistics', ticker: 'MHL', homeStationId: 60009999, allianceId: 99000501 })
    expect((await env.api.corporation(1000115)).value).toMatchObject({ homeStationId: null, allianceId: null })
    expect((await env.api.alliance(99000501)).value).toEqual({ name: 'Fictional Federation', ticker: 'FICT' })
    await expect(env.api.alliance(99999999)).rejects.toBeInstanceOf(EsiError)
  })

  it('station: English by default, localized name when a language is asked for', async () => {
    const env = await makeEnv({}, (f) => f.stations.set(60009999, { name: 'Fictional IV - Moon 2 - Test Assembly Plant', system_id: 30009999, zhName: '虚构 IV - 卫星 2 - 测试组装厂' }))
    expect((await env.api.station(60009999)).value).toEqual({ name: 'Fictional IV - Moon 2 - Test Assembly Plant', systemId: 30009999 })
    expect((await env.api.station(60009999, { language: 'zh' })).value.name).toBe('虚构 IV - 卫星 2 - 测试组装厂')
    const sent = env.fake.requests.filter((r) => r.path.includes('/universe/stations/'))
    expect(sent.map((r) => r.headers['accept-language'])).toEqual([undefined, 'zh'])
  })

  it('searchCharacters needs a token, asks for categories=character, strict=false', async () => {
    const env = await makeEnv({}, (f) => f.characterSearch.set('Hanako', [HANAKO, 2119876544]))
    await expect(env.api.searchCharacters(2112000001, 'Hanako', { auth: authFrom(() => 'bad-token') })).rejects.toBeInstanceOf(EsiError)
    const { access } = env.fake.issueTokens()
    const auth = authFrom(() => access)
    expect((await env.api.searchCharacters(2112000001, 'Hanako', { auth })).value).toEqual([HANAKO, 2119876544])
    expect((await env.api.searchCharacters(2112000001, 'Nobody', { auth })).value).toEqual([])
    const search = env.fake.requests.filter((r) => r.path.endsWith('/search')).at(-1)!
    expect(Object.fromEntries(search.query)).toEqual({ categories: 'character', search: 'Nobody', strict: 'false' })
  })

  it('refuses impossible ids before sending anything', async () => {
    const env = await makeEnv()
    expect(() => env.api.character(0)).toThrow(RangeError)
    expect(() => env.api.corporationHistory(-1)).toThrow(RangeError)
    expect(() => env.api.corporation(1.5)).toThrow(RangeError)
    expect(() => env.api.alliance(0)).toThrow(RangeError)
    expect(() => env.api.station(0)).toThrow(RangeError)
    expect(() => env.api.searchCharacters(0, 'abc', { auth: authFrom(() => 'x') })).toThrow(RangeError)
    expect(env.fake.requests).toHaveLength(0)
  })
})

describe('parsers reject malformed rows', () => {
  it('names the missing or mistyped field', () => {
    expect(() => parseCharacter({ name: 'A', corporation_id: 1 })).toThrow(/birthday/)
    expect(() => parseCharacter({ name: 'A', corporation_id: 1, birthday: 'never' })).toThrow(/birthday/)
    expect(() => parseCharacter({ name: 'A', corporation_id: 1, birthday: '2019-03-14T08:30:00Z', title: 5 })).toThrow(/title/)
    expect(() => parseCorpHistory([{ corporation_id: 1 }])).toThrow(/record_id/)
    expect(() => parseCorporation({ name: 'A' })).toThrow(/ticker/)
    expect(() => parseAlliance({ ticker: 'A' })).toThrow(/name/)
    expect(() => parseStation({ name: 'A' })).toThrow(/system_id/)
    expect(() => parseCharacterSearch({ character: ['x'] })).toThrow(/character/)
    expect(parseCharacterSearch({})).toEqual([])
  })
})
