// 假 ESI 自己的行为（其他测试依赖它）：兼容日期、版本前缀、SSO 的最小流程。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMPATIBILITY_DATE, SSO_SCOPES } from '../../../src/constants'
import { FakeEsi } from '../../fakes/fake-esi'
import { NodeHttpClient } from '../../fakes/node-http-client'

let fake: FakeEsi
const http = new NodeHttpClient()

beforeEach(async () => {
  fake = await new FakeEsi().start()
})

afterEach(() => fake.stop())

const json = (body: Buffer) => JSON.parse(body.toString('utf8'))
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`

function decodeJwt(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

describe('FakeEsi: request rules', () => {
  it('requires a compatibility date that is not in the future', async () => {
    const missing = await http.request({ method: 'GET', url: `${fake.base}/status` })
    expect(missing.status).toBe(400)
    const future = await http.request({ method: 'GET', url: `${fake.base}/status`, headers: { 'X-Compatibility-Date': '2099-01-01' } })
    expect(future.status).toBe(400)
    const ok = await http.request({ method: 'GET', url: `${fake.base}/status`, headers: { 'X-Compatibility-Date': COMPATIBILITY_DATE } })
    expect(ok.status).toBe(200)
    expect(ok.header('x-ratelimit-group')).toBe('status')
    expect(ok.header('X-Ratelimit-Limit')).toBe('600/15m')
  })

  it('does not serve versioned paths', async () => {
    const res = await http.request({ method: 'GET', url: `${fake.base}/latest/status/`, headers: { 'X-Compatibility-Date': COMPATIBILITY_DATE } })
    expect(res.status).toBe(404)
  })

  it('runs its own token buckets and answers 429 with Retry-After when one is empty', async () => {
    fake.buckets.status.limit = 4
    const get = () => http.request({ method: 'GET', url: `${fake.base}/status`, headers: { 'X-Compatibility-Date': COMPATIBILITY_DATE } })
    expect((await get()).header('x-ratelimit-remaining')).toBe('2')
    expect((await get()).header('x-ratelimit-remaining')).toBe('0')
    const limited = await get()
    expect(limited.status).toBe(429)
    expect(Number(limited.header('retry-after'))).toBeGreaterThan(0)
  })
})

describe('FakeEsi: SSO', () => {
  it('authorization code → tokens → refresh with rotation → old refresh token is invalid_grant', async () => {
    const authorize = new URL('/v2/oauth/authorize', fake.base)
    authorize.search = new URLSearchParams({
      response_type: 'code', redirect_uri: 'http://127.0.0.1:5140/eve-market/sso/callback', client_id: fake.sso.clientId,
      scope: SSO_SCOPES.join(' '), state: 'state-123',
    }).toString()
    const redirect = await http.request({ method: 'GET', url: authorize.toString() })
    expect(redirect.status).toBe(302)
    const back = new URL(redirect.header('location')!)
    expect(back.pathname).toBe('/eve-market/sso/callback')
    expect(back.searchParams.get('state')).toBe('state-123')
    const code = back.searchParams.get('code')!

    const token = (form: Record<string, string>, auth = basic(fake.sso.clientId, fake.sso.clientSecret)) => http.request({
      method: 'POST',
      url: `${fake.base}/v2/oauth/token`,
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })

    expect((await token({ grant_type: 'authorization_code', code }, basic('x', 'y'))).status).toBe(401)
    const first = await token({ grant_type: 'authorization_code', code })
    expect(first.status).toBe(200)
    const tokens = json(first.body)
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: fake.sso.accessTtlSec })
    const claims = decodeJwt(tokens.access_token)
    expect(claims).toMatchObject({ sub: `CHARACTER:EVE:${fake.sso.characterId}`, name: fake.sso.characterName, owner: fake.sso.ownerHash, scp: [...SSO_SCOPES] })
    // 授权码只能用一次
    expect(json((await token({ grant_type: 'authorization_code', code })).body).error).toBe('invalid_grant')

    const refreshed = json((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).body)
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)
    const reused = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    expect(reused.status).toBe(400)
    expect(json(reused.body)).toEqual({ error: 'invalid_grant', error_description: 'Invalid refresh token' })

    const revoke = await http.request({
      method: 'POST',
      url: `${fake.base}/v2/oauth/revoke`,
      headers: { Authorization: basic(fake.sso.clientId, fake.sso.clientSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token_type_hint: 'refresh_token', token: refreshed.refresh_token }).toString(),
    })
    expect(revoke.status).toBe(200)
    expect((await token({ grant_type: 'refresh_token', refresh_token: refreshed.refresh_token })).status).toBe(400)
  })

  it('can put a single scope into scp as a string and keep the refresh token', async () => {
    fake.sso.scopes = ['esi-markets.structure_markets.v1']
    fake.sso.scpAsString = true
    fake.sso.rotateRefresh = false
    const { refresh } = fake.issueTokens()
    const res = await http.request({
      method: 'POST',
      url: `${fake.base}/v2/oauth/token`,
      headers: { Authorization: basic(fake.sso.clientId, fake.sso.clientSecret) },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
    })
    const body = json(res.body)
    expect(body.refresh_token).toBe(refresh)
    expect(decodeJwt(body.access_token).scp).toBe('esi-markets.structure_markets.v1')
  })
})
