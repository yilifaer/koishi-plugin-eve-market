// EVE SSO v2 的协议部分：授权网址、换 token（Basic 认证）、刷新、撤销、错误分类和脱敏、JWT 解码和检查。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SSO_SCOPES } from '../../../src/constants'
import { NetworkError } from '../../../src/core/ports'
import type { HttpClient } from '../../../src/core/ports'
import {
  SsoClient, SsoError, basicAuth, characterIdOf, checkAccessToken, decodeJwt, missingScopes, normalizeScopes,
} from '../../../src/core/sso'
import { FakeEsi } from '../../fakes/fake-esi'
import { NodeHttpClient } from '../../fakes/node-http-client'

const NOW = Date.UTC(2026, 9, 7, 6, 20)
const CLIENT = 'client-0001'

function jwt(payload: Record<string, unknown>, parts = 3): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const all = [enc({ alg: 'RS256', kid: 'JWT-Signature-Key', typ: 'JWT' }), enc(payload), Buffer.from('not-a-real-signature').toString('base64url')]
  return all.slice(0, parts).join('.')
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://login.eveonline.com',
    sub: 'CHARACTER:EVE:2112000001',
    azp: CLIENT,
    aud: [CLIENT, 'EVE Online'],
    name: 'Test Pilot',
    owner: 'owner-hash-1',
    scp: [...SSO_SCOPES],
    exp: NOW / 1000 + 1199,
    ...extra,
  }
}

const check = (token: string, now = NOW) => checkAccessToken(token, { clientId: CLIENT, now })

function rejection(fn: () => unknown): SsoError {
  try {
    fn()
  } catch (e) {
    if (e instanceof SsoError) return e
    throw e
  }
  throw new Error('expected an SsoError')
}

describe('JWT', () => {
  it('decodes the payload without verifying the signature', () => {
    expect(decodeJwt(jwt({ a: 1 }))).toEqual({ a: 1 })
    for (const bad of ['', 'abc', jwt({ a: 1 }, 2), 'a.b.c.d', 'x.!!!.y', `x.${Buffer.from('[1]').toString('base64url')}.y`, 'x.bm90IGpzb24.y']) {
      expect(rejection(() => decodeJwt(bad)).kind).toBe('bad-token')
    }
  })

  it('normalizes scp given as a string, an array or nothing', () => {
    expect(normalizeScopes('esi-markets.structure_markets.v1')).toEqual(['esi-markets.structure_markets.v1'])
    expect(normalizeScopes('a b  a')).toEqual(['a', 'b'])
    expect(normalizeScopes(['a', 'b', 'a', 3, ''])).toEqual(['a', 'b'])
    expect(normalizeScopes(undefined)).toEqual([])
    expect(missingScopes(['a'], ['a', 'b', 'c'])).toEqual(['b', 'c'])
  })

  it('takes the character ID from sub', () => {
    expect(characterIdOf('CHARACTER:EVE:2112000001')).toBe('2112000001')
    expect(characterIdOf('CORPORATION:EVE:98000001')).toBeNull()
    expect(characterIdOf('CHARACTER:EVE:')).toBeNull()
    expect(characterIdOf(2112000001)).toBeNull()
  })

  it('accepts a token from either issuer form, with aud as an array or the old single string', () => {
    expect(check(jwt(claims()))).toEqual({
      characterId: '2112000001', characterName: 'Test Pilot', ownerHash: 'owner-hash-1', scopes: [...SSO_SCOPES], expiresAt: NOW + 1_199_000,
    })
    expect(check(jwt(claims({ iss: 'login.eveonline.com', aud: 'EVE Online', azp: undefined }))).characterId).toBe('2112000001')
    expect(check(jwt(claims({ scp: 'esi-markets.structure_markets.v1' }))).scopes).toEqual(['esi-markets.structure_markets.v1'])
    expect(check(jwt(claims({ name: undefined, owner: undefined, scp: undefined })))).toMatchObject({ characterName: '', ownerHash: '', scopes: [] })
  })

  it('rejects the wrong issuer, client, audience, subject or an expired token', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ iss: 'https://login.example.test' }, /签发者/],
      [{ iss: undefined }, /签发者/],
      [{ azp: 'someone-else' }, /应用/],
      [{ azp: undefined, aud: ['someone-else'] }, /受众/],
      [{ sub: 'CORPORATION:EVE:98000001' }, /角色/],
      [{ exp: undefined }, /过期时间/],
      [{ exp: NOW / 1000 - 301 }, /过期/],
    ]
    for (const [extra, why] of cases) {
      const e = rejection(() => check(jwt(claims(extra))))
      expect(e.kind).toBe('bad-token')
      expect(e.message).toMatch(why)
      expect(e.transient).toBe(false)
    }
    // 本机时钟慢一点不算过期
    expect(check(jwt(claims({ exp: NOW / 1000 - 60 }))).characterId).toBe('2112000001')
  })
})

describe('SsoClient', () => {
  let fake: FakeEsi
  let http: NodeHttpClient
  let sso: SsoClient

  beforeEach(async () => {
    fake = await new FakeEsi().start()
    fake.clock = () => NOW
    http = new NodeHttpClient()
    sso = new SsoClient({ http, clientId: fake.sso.clientId, clientSecret: fake.sso.clientSecret, userAgent: 'koishi-plugin-eve-market/0.0.2', base: `${fake.base}/` })
  })

  afterEach(async () => {
    await fake.stop()
  })

  it('builds the authorize URL with %20 between scopes and an encoded redirect URI', () => {
    const url = sso.authorizeUrl('http://127.0.0.1:5140/eve-market/sso/callback', 'st-1')
    expect(url).toBe(`${fake.base}/v2/oauth/authorize?response_type=code`
      + '&redirect_uri=http%3A%2F%2F127.0.0.1%3A5140%2Feve-market%2Fsso%2Fcallback'
      + `&client_id=${fake.sso.clientId}`
      + '&scope=esi-markets.structure_markets.v1%20esi-universe.read_structures.v1%20esi-search.search_structures.v1'
      + '&state=st-1')
    expect(new URL(url).searchParams.get('scope')!.split(' ')).toEqual([...SSO_SCOPES])
  })

  it('exchanges a code with HTTP Basic client auth and a form body', async () => {
    const redirect = await http.request({ method: 'GET', url: sso.authorizeUrl('http://127.0.0.1:5140/eve-market/sso/callback', 'st-2') })
    const code = new URL(redirect.header('location')!).searchParams.get('code')!
    const exchanged = await sso.exchangeCode(code)
    expect(exchanged.refreshToken).toMatch(/^rt-/)
    expect(Object.fromEntries(new URLSearchParams(http.requests.at(-1)!.body))).toEqual({ grant_type: 'authorization_code', code })
    expect(await sso.exchangeCode(code).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_grant' })

    const { refresh } = fake.issueTokens()
    const tokens = await sso.refresh(refresh)
    expect(tokens.accessToken.split('.')).toHaveLength(3)
    expect(tokens.refreshToken).not.toBe(refresh)
    expect(tokens.expiresIn).toBe(fake.sso.accessTtlSec)
    const req = http.requests.at(-1)!
    expect(req).toMatchObject({ method: 'POST', url: `${fake.base}/v2/oauth/token` })
    expect(req.headers).toMatchObject({
      Authorization: basicAuth(fake.sso.clientId, fake.sso.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'koishi-plugin-eve-market/0.0.2',
    })
    expect(basicAuth('id', 'secret')).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`)
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({ grant_type: 'refresh_token', refresh_token: refresh })
    // 刷新请求不接中止信号：发出去以后就要等到结果（SSO 可能已经换了 refresh token）
    expect(req.signal).toBeUndefined()
  })

  it('classifies failures and keeps secrets out of the message', async () => {
    const { refresh } = fake.issueTokens()
    const fail = async (status: number, body: unknown) => {
      fake.fault('POST', /\/v2\/oauth\/token$/, { status, body })
      return sso.refresh(refresh).then(() => { throw new Error('expected failure') }, (e: unknown) => e as SsoError)
    }
    const grant = await fail(400, { error: 'invalid_grant', error_description: `Invalid refresh token ${refresh}` })
    expect(grant).toMatchObject({ kind: 'invalid_grant', status: 400, code: 'invalid_grant', transient: false })
    expect(grant.message).toBe('HTTP 400: invalid_grant: Invalid refresh token ***')
    expect(grant.info()).toEqual({ route: 'POST /v2/oauth/token', status: 400, code: 'invalid_grant', message: grant.message })
    expect(grant.brief).toBe('HTTP 400 invalid_grant')
    expect(await fail(401, { error: 'invalid_client' })).toMatchObject({ kind: 'invalid_client', transient: false })
    expect(await fail(403, {})).toMatchObject({ kind: 'rejected', transient: false })
    expect(await fail(400, { error: 'invalid_request' })).toMatchObject({ kind: 'rejected' })
    expect(await fail(429, {})).toMatchObject({ kind: 'unavailable', transient: true })
    const down = await fail(503, { error: 'server_error', error_description: `secret ${fake.sso.clientSecret} leaked` })
    expect(down).toMatchObject({ kind: 'unavailable', transient: true })
    expect(down.message).not.toContain(fake.sso.clientSecret)
  })

  it('treats odd 200 responses as bad responses and connection problems as unavailable', async () => {
    const { refresh } = fake.issueTokens()
    const odd = async (fault: Parameters<FakeEsi['fault']>[2]) => {
      fake.fault('POST', /\/v2\/oauth\/token$/, fault)
      return sso.refresh(refresh).catch((e: unknown) => e as SsoError)
    }
    expect(await odd({ status: 200, raw: '<html>' })).toMatchObject({ kind: 'bad-response', transient: true })
    expect(await odd({ status: 200, body: { token_type: 'Bearer' } })).toMatchObject({ kind: 'bad-response' })
    expect(await odd({ status: 200, body: { access_token: 'x.y.z', token_type: 'mac' } })).toMatchObject({ kind: 'bad-response' })
    expect(await odd({ destroy: true })).toMatchObject({ kind: 'unavailable', code: 'network' })

    const tooBig: HttpClient = { request: async () => { throw new NetworkError('too-large') } }
    const slow: HttpClient = { request: async () => { throw new NetworkError('timeout', '10000 毫秒没有响应') } }
    const weird: HttpClient = { request: async () => { throw Object.assign(new Error('boom'), { config: { headers: { Authorization: basicAuth('a', 'secret-value') } } }) } }
    const client = (h: HttpClient) => new SsoClient({ http: h, clientId: 'a', clientSecret: 'secret-value', userAgent: 'ua' })
    expect(await client(tooBig).refresh('rt-0000000').catch((e: unknown) => e)).toMatchObject({ kind: 'bad-response' })
    expect(await client(slow).refresh('rt-0000000').catch((e: unknown) => e)).toMatchObject({ kind: 'unavailable', code: 'timeout' })
    const e = await client(weird).refresh('rt-0000000').then(() => null, (x: unknown) => x as SsoError)
    expect(e).toMatchObject({ kind: 'unavailable' })
    expect(JSON.stringify(e?.info())).not.toContain('secret-value')
  })

  it('keeps the refresh token when SSO does not rotate it, and revokes with Basic auth', async () => {
    fake.sso.rotateRefresh = false
    const { refresh } = fake.issueTokens()
    expect((await sso.refresh(refresh)).refreshToken).toBe(refresh)
    await sso.revoke(refresh)
    const req = http.requests.at(-1)!
    expect(req.url).toBe(`${fake.base}/v2/oauth/revoke`)
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({ token_type_hint: 'refresh_token', token: refresh })
    expect(fake.refreshTokens.has(refresh)).toBe(false)
    expect(await sso.refresh(refresh).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid_grant' })
  })
})
