import { afterEach, describe, expect, it } from 'vitest'
import { KB_CANDIDATES_MAX, KB_SEARCH_PER_MIN } from '../../../src/constants'
import { PilotResolver, findPilotLink, parsePilotArg, sortCandidates } from '../../../src/core/pilot'
import { isFailure } from '../../../src/core/types'
import type { AuthProfileStatus, AuthService, CoreFailure, PilotRef, PilotResolution } from '../../../src/core/types'
import { closeAll, makeEnv } from '../esi/helpers'
import type { Env } from '../esi/helpers'

afterEach(closeAll)

describe('parsePilotArg', () => {
  it.each([
    ['2119876543', 2119876543, 'id'],
    ['  2119876543  ', 2119876543, 'id'],
    ['https://zkillboard.com/character/2119876543/', 2119876543, 'link'],
    ['https://zkillboard.com/character/2119876543', 2119876543, 'link'],
    ['http://zkillboard.com/character/2119876543/', 2119876543, 'link'],
    ['https://www.zkillboard.com/character/2119876543/', 2119876543, 'link'],
    ['zkillboard.com/character/2119876543/', 2119876543, 'link'],
    ['HTTPS://ZKillboard.COM/Character/2119876543/?a=1#b', 2119876543, 'link'],
  ])('reads %s', (text, id, source) => {
    expect(parsePilotArg(text)).toEqual({ kind: 'id', id, source })
  })

  it.each([
    'https://zkillboard.com.evil.cn/character/2119876543/',
    'https://evilzkillboard.com/character/2119876543/',
    'https://user@zkillboard.com/character/2119876543/',
    'https://zkillboard.com:8080/character/2119876543/',
    'https://sub.zkillboard.com/character/2119876543/',
    'https://zkillboard.org/character/2119876543/',
    'https://zkillboard.com/corporation/98000501/',
    'https://zkillboard.com/character/abc/',
    'https://zkillboard.com/character/12345678901/',
  ])('does not treat %s as a link', (text) => {
    expect(parsePilotArg(text).kind).not.toBe('id')
    expect(findPilotLink(text)).toBeNull()
  })

  it('accepts English names, normalising whitespace', () => {
    expect(parsePilotArg('Hanako Kisaragi')).toEqual({ kind: 'name', name: 'Hanako Kisaragi' })
    expect(parsePilotArg("  Hanako   O'Neil-Smith Jr. ")).toEqual({ kind: 'name', name: "Hanako O'Neil-Smith Jr." })
    expect(parsePilotArg('abc')).toEqual({ kind: 'name', name: 'abc' })
    expect(parsePilotArg('a'.repeat(37)).kind).toBe('name')
  })

  it('returns specific errors', () => {
    expect(parsePilotArg('')).toEqual({ kind: 'error', error: 'empty' })
    expect(parsePilotArg('   ')).toEqual({ kind: 'error', error: 'empty' })
    for (const text of ['如月花子', 'Hanako 花子', 'ハナコ', '하나코']) expect(parsePilotArg(text), text).toEqual({ kind: 'error', error: 'cjk' })
    for (const text of ['ab', 'a'.repeat(38), 'Hanako<script>', 'Hanako_Kisaragi', 'Hanakoé', '0', 'https://example.com/x']) {
      expect(parsePilotArg(text), text).toEqual({ kind: 'error', error: 'bad' })
    }
  })

  it('finds a link inside a message', () => {
    expect(findPilotLink('看这个人 https://zkillboard.com/character/2119876543/ 怎么样')).toBe(2119876543)
    expect(findPilotLink('没有链接')).toBeNull()
    expect(findPilotLink('https://zkillboard.com/character/0/')).toBeNull()
  })
})

describe('sortCandidates', () => {
  const ref = (id: number, name: string): PilotRef => ({ id, name })
  it('puts names starting with the query first, then shorter names, then alphabetical', () => {
    const sorted = sortCandidates('hana', [ref(1, 'Ohana Kisaragi'), ref(2, 'Hanako Kisaragi'), ref(3, 'Hana'), ref(4, 'Hanabi'), ref(5, 'Hanako A')])
    expect(sorted.map((r) => r.name)).toEqual(['Hana', 'Hanabi', 'Hanako A', 'Hanako Kisaragi', 'Ohana Kisaragi'])
  })
})

// ------------------------------------------------------------------ resolver：假 ESI + 假授权

const HANAKO = 2119876543

class FakeAuth implements Pick<AuthService, 'profiles' | 'searchCharacters'> {
  status: AuthProfileStatus['status'] | null = 'OK'
  result: number[] | CoreFailure = []
  searches: Array<{ profile: string; text: string }> = []

  profiles(): AuthProfileStatus[] {
    return this.status
      ? [{
        profile: 'main', status: this.status, characterId: '2112000001', characterName: 'Test Pilot', scopesGranted: 3, scopesRequired: 3,
        tokenValid: true, lastRefreshAt: null, lastSuccessAt: null, lastError: '', lastErrorAt: null, markets: ['Fictional Hub'],
      }]
      : []
  }

  async searchCharacters(profile: string, text: string) {
    this.searches.push({ profile, text })
    return this.result
  }
}

async function make(setup?: (env: Env, auth: FakeAuth) => void) {
  const auth = new FakeAuth()
  const env = await makeEnv({ contact: 'me@example.test' }, (fake) => {
    fake.cacheMode = 'none'
    fake.idNames.en.set('hanako kisaragi', { category: 'characters', id: HANAKO, name: 'Hanako Kisaragi' })
    for (const [id, name] of [[2119000001, 'Hanako Aoi'], [2119000002, 'Hanako'], [2119000003, 'Ohanako Mori'], [2119000004, 'Hanakoji Tachibana']] as const) {
      fake.names.set(id, { name, category: 'character' })
    }
    for (let i = 0; i < 12; i++) fake.names.set(2119100000 + i, { name: `Hanako Extra${'x'.repeat(i)}`, category: 'character' })
  })
  setup?.(env, auth)
  const resolver = new PilotResolver({ esi: env.api, auth, logger: env.logger, clock: env.clock })
  return { env, auth, resolver }
}

const ok = (r: PilotResolution | CoreFailure): PilotResolution => {
  if (isFailure(r)) throw new Error(`应该成功：${r.code}`)
  return r
}

describe('PilotResolver', () => {
  it('resolves an exact name (case-insensitive) with the canonical spelling', async () => {
    const { resolver, env, auth } = await make()
    expect(ok(await resolver.resolve('hanako KISARAGI'))).toEqual({ id: HANAKO, name: 'Hanako Kisaragi' })
    expect(env.fake.count(/universe\/ids/, 'POST')).toBe(1)
    expect(auth.searches).toEqual([])
  })

  it('rejects ids, Chinese names and malformed names without any request', async () => {
    const { resolver, env } = await make()
    expect(await resolver.resolve('如月花子')).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'cjk-name' })
    expect(await resolver.resolve('ab')).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', reason: 'bad-name' })
    expect(await resolver.resolve('2119876543')).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(env.fake.requests).toHaveLength(0)
  })

  it('does not search without a market authorisation: asks for the full name', async () => {
    const { resolver, auth } = await make((_, a) => { a.status = null })
    expect(await resolver.resolve('Hanako')).toMatchObject({ ok: false, code: 'PILOT_NOT_FOUND', reason: 'need-full-name' })
    expect(auth.searches).toEqual([])
  })

  it('does not search with a profile that is not OK', async () => {
    const { resolver, auth } = await make((_, a) => { a.status = 'AUTH_ERROR' })
    expect(await resolver.resolve('Hanako')).toMatchObject({ code: 'PILOT_NOT_FOUND', reason: 'need-full-name' })
    expect(auth.searches).toEqual([])
  })

  it('asks for the full name when the profile has no search permission', async () => {
    const { resolver } = await make((_, a) => { a.result = { ok: false, code: 'NOT_CONFIGURED', message: 'no scope' } })
    expect(await resolver.resolve('Hanako')).toMatchObject({ code: 'PILOT_NOT_FOUND', reason: 'need-full-name' })
  })

  it('caps token-backed searches across all callers per minute', async () => {
    const { resolver, auth, env } = await make((_e, a) => {
      a.result = [2119000001]
    })
    for (let i = 0; i < KB_SEARCH_PER_MIN; i++) ok(await resolver.resolve('Hanako'))
    expect(await resolver.resolve('Hanako')).toMatchObject({ code: 'PILOT_NOT_FOUND', reason: 'need-full-name' })
    expect(auth.searches).toHaveLength(KB_SEARCH_PER_MIN)
    env.clock.advance(61_000)
    ok(await resolver.resolve('Hanako'))
    expect(auth.searches).toHaveLength(KB_SEARCH_PER_MIN + 1)
  })

  it('lists candidates: prefix first, shorter first, at most 8', async () => {
    const { resolver, auth } = await make((_, a) => {
      a.result = [2119000001, 2119000002, 2119000003, 2119000004, ...Array.from({ length: 12 }, (_, i) => 2119100000 + i)]
    })
    const res = ok(await resolver.resolve('Hanako'))
    expect(auth.searches).toEqual([{ profile: 'main', text: 'Hanako' }])
    if (!('candidates' in res)) throw new Error('应该是候选')
    expect(res.candidates).toHaveLength(KB_CANDIDATES_MAX)
    expect(res.candidates[0]).toEqual({ id: 2119000002, name: 'Hanako' })
    expect(res.candidates.slice(0, 3).map((c) => c.name)).toEqual(['Hanako', 'Hanako Aoi', 'Hanako Extra'])
    expect(res.candidates.map((c) => c.name)).not.toContain('Ohanako Mori')
  })

  it('reports not found when the search finds nothing', async () => {
    const { resolver } = await make((_, a) => { a.result = [] })
    expect(await resolver.resolve('Zzzzz')).toMatchObject({ ok: false, code: 'PILOT_NOT_FOUND' })
    expect((await resolver.resolve('Zzzzz') as CoreFailure).reason).toBeUndefined()
  })

  it('passes search failures through', async () => {
    const { resolver } = await make((_, a) => { a.result = { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: 'down' } })
    expect(await resolver.resolve('Hanako')).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
  })

  it('maps ESI trouble on the exact lookup to UPSTREAM_UNAVAILABLE', async () => {
    const { resolver, env } = await make()
    env.fake.fault('POST', /universe\/ids/, { status: 500 }, 5)
    expect(await resolver.resolve('Hanako Kisaragi')).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
  })
})
