// AuthService：授权流程（state 只能用一次）、按需刷新和 single-flight、状态机（invalid_grant、owner 变了、权限不够、
// 网络问题的退避）、密钥对不上、重载和重启、删除和撤销、按名字搜建筑、给 ESI 客户端用的授权，以及日志里没有任何 token。

import { afterEach, describe, expect, it } from 'vitest'
import { SSO_SCOPES } from '../../../src/constants'
import { EsiError, MemoryResponseCache } from '../../../src/core/esi'
import { createModuleStore } from '../../../src/core/ports'
import type { SecretBox } from '../../../src/core/ports'
import { AUTH_TEXT } from '../../../src/core/sso'
import type { AuthProfileStatus } from '../../../src/core/types'
import { until } from '../esi/helpers'
import {
  MARKETS, MINUTE, STRUCTURE_A, STRUCTURE_B, STRUCTURE_C, SYSTEM_XX1, closeSsoEnvs, makeSsoEnv, newBox,
} from './helpers'
import type { SsoEnv } from './helpers'

const TTL_MS = 1199 * 1000
const [MARKETS_SCOPE, STRUCTURES_SCOPE, SEARCH_SCOPE] = SSO_SCOPES

afterEach(closeSsoEnvs)

async function authorized(): Promise<SsoEnv> {
  const env = await makeSsoEnv()
  expect(await env.authorize()).toMatchObject({ ok: true })
  return env
}

function token(env: SsoEnv, opts?: { force?: boolean }) {
  return env.auth.getAccessToken('default', opts)
}

const state = (env: SsoEnv, profile = 'default') => env.auth.profiles().find((p) => p.profile === profile)!

describe('AuthService: authorization', () => {
  it('builds the login URL with a fresh 32-byte state and all three scopes', async () => {
    const env = await makeSsoEnv()
    const a = env.auth.beginAuth('default')
    const b = env.auth.beginAuth(' default ')
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(b.state).not.toBe(a.state)
    const url = new URL(a.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${env.fake.base}/v2/oauth/authorize`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:5140/eve-market/sso/callback',
      client_id: env.fake.sso.clientId,
      scope: SSO_SCOPES.join(' '),
      state: a.state,
    })
    expect(() => env.auth.beginAuth('bad name!')).toThrow(AUTH_TEXT.badProfile)
    expect(() => env.another({ sso: { clientId: '' } }).beginAuth('default')).toThrow(AUTH_TEXT.notConfigured)
    expect(() => env.another({ sso: { clientSecret: '' } }).beginAuth('default')).toThrow(AUTH_TEXT.notConfigured)
  })

  it('completes: saves the sealed refresh token, keeps the access token in memory and probes the structures', async () => {
    const env = await makeSsoEnv({ setup: (fake) => fake.fault('GET', new RegExp(`/universe/structures/${STRUCTURE_C}$`), { status: 404, body: { error: 'Structure not found' } }) })
    const changes: AuthProfileStatus[] = []
    env.auth.onChange((s) => changes.push(s))
    const done = await env.authorize()
    expect(done).toEqual({
      ok: true,
      profile: 'default',
      characterId: String(env.fake.sso.characterId),
      characterName: 'Test Pilot',
      structures: [
        { marketKey: '联盟市场a', marketName: '联盟市场A', structureId: String(STRUCTURE_A), access: 'ok', structureName: 'XX-1 - 联盟市场A', systemId: SYSTEM_XX1 },
        { marketKey: '联盟市场b', marketName: '联盟市场B', structureId: String(STRUCTURE_B), access: 'forbidden' },
        { marketKey: '联盟市场c', marketName: '联盟市场C', structureId: String(STRUCTURE_C), access: 'not_found' },
      ],
    })
    const rec = env.db.rows.get('default')!
    expect(rec).toMatchObject({
      profile: 'default', characterId: '2112000001', characterName: 'Test Pilot', ownerHash: 'fake-owner-hash-1', scopes: [...SSO_SCOPES],
      keyId: env.box.keyId, status: 'OK', lastError: '', lastErrorAt: null,
      lastRefreshAt: env.clock.now(), lastSuccessAt: env.clock.now(), authorizedAt: env.clock.now(),
    })
    expect(rec.refreshToken).toMatch(new RegExp(`^v1:${env.box.keyId}:`))
    expect(env.fake.refreshTokens.has(env.box.open(rec.refreshToken))).toBe(true)
    expect(state(env)).toEqual({
      profile: 'default', status: 'OK', characterId: '2112000001', characterName: 'Test Pilot', scopesGranted: 3, scopesRequired: 3,
      tokenValid: true, lastRefreshAt: env.clock.now(), lastSuccessAt: env.clock.now(), lastError: '', lastErrorAt: null,
      markets: ['联盟市场A', '联盟市场B', '联盟市场C'],
    })
    expect(changes.map((c) => c.status)).toEqual(['OK'])
    // 刚拿到的 access token 直接用，不再请求
    const calls = env.tokenCalls()
    expect(await token(env)).toMatchObject({ ok: true, characterId: '2112000001' })
    expect(env.tokenCalls()).toBe(calls)
    expect(env.logger.at('info')).toContain('EVE 授权档案 default 已授权：角色「Test Pilot」')
  })

  it('accepts each state once, within 10 minutes, at most 5 at a time; a reloaded plugin can still finish', async () => {
    const env = await makeSsoEnv()
    expect(await env.auth.completeAuth('code', 'unknown')).toEqual({ ok: false, reason: 'bad_state', message: AUTH_TEXT.badState })

    const first = await env.login(env.auth.beginAuth('default').url)
    expect(await env.auth.completeAuth(first.code, first.state)).toMatchObject({ ok: true })
    expect(await env.auth.completeAuth(first.code, first.state)).toMatchObject({ ok: false, reason: 'bad_state' })

    const late = await env.login(env.auth.beginAuth('default').url)
    env.clock.advance(10 * MINUTE + 1000)
    const calls = env.tokenCalls()
    expect(await env.auth.completeAuth(late.code, late.state)).toMatchObject({ ok: false, reason: 'bad_state' })
    expect(env.tokenCalls()).toBe(calls)

    const urls = Array.from({ length: 6 }, () => env.auth.beginAuth('default').url)
    const oldest = await env.login(urls[0])
    const newest = await env.login(urls[5])
    expect(await env.auth.completeAuth(oldest.code, oldest.state)).toMatchObject({ ok: false, reason: 'bad_state' })
    // 登录期间控制台保存了配置：新的实例（同一个模块级存储）照样认这个 state
    expect(await env.another().completeAuth(newest.code, newest.state)).toMatchObject({ ok: true })
  })

  it('reports why an authorization did not complete', async () => {
    const env = await makeSsoEnv()
    const attempt = async (service = env.auth) => {
      const { code, state: s } = await env.login(service.beginAuth('default').url)
      return { code, state: s }
    }

    const bogus = await attempt()
    expect(await env.auth.completeAuth('code-bogus', bogus.state)).toEqual({ ok: false, reason: 'code_rejected', message: AUTH_TEXT.codeRejected })

    const empty = await attempt()
    expect(await env.auth.completeAuth('', empty.state)).toEqual({ ok: false, reason: 'code_rejected', message: AUTH_TEXT.badCode })

    env.fake.fault('POST', /\/v2\/oauth\/token$/, { status: 503, body: { error: 'temporarily_unavailable' } })
    const down = await attempt()
    expect(await env.auth.completeAuth(down.code, down.state)).toEqual({
      ok: false, reason: 'unavailable', message: AUTH_TEXT.exchangeUnavailable('HTTP 503 temporarily_unavailable'),
    })

    env.fake.sso.scopes = [SEARCH_SCOPE]
    const narrow = await attempt()
    expect(await env.auth.completeAuth(narrow.code, narrow.state)).toEqual({
      ok: false, reason: 'missing_scopes', message: AUTH_TEXT.missingScopes([MARKETS_SCOPE, STRUCTURES_SCOPE]),
    })
    env.fake.sso.scopes = [...SSO_SCOPES]

    const wrong = env.another({ sso: { clientSecret: 'wrong-secret-value' } })
    const w = await attempt(wrong)
    expect(await wrong.completeAuth(w.code, w.state)).toEqual({ ok: false, reason: 'exchange_failed', message: AUTH_TEXT.invalidClient })

    const begun = await attempt()
    expect(await env.another({ sso: { clientId: '' } }).completeAuth(begun.code, begun.state)).toMatchObject({ ok: false, reason: 'not_configured' })

    env.db.failNext.upsert = 1
    const lost = await attempt()
    expect(await env.auth.completeAuth(lost.code, lost.state)).toEqual({ ok: false, reason: 'save_failed', message: AUTH_TEXT.saveFailed })

    expect(env.db.rows.size).toBe(0)
    expect(state(env)).toMatchObject({ status: 'NEEDS_AUTH', lastError: '' })
    expect(env.logger.at('warn').filter((t) => t.includes('授权没有完成'))).toHaveLength(4)
  })

  it('keeps a profile that only lives in the database and lists it after the configured ones', async () => {
    const env = await makeSsoEnv()
    expect(await env.authorize('spare')).toMatchObject({ ok: true, structures: [] })
    expect(env.auth.profiles().map((p) => [p.profile, p.status, p.markets])).toEqual([
      ['default', 'NEEDS_AUTH', ['联盟市场A', '联盟市场B', '联盟市场C']],
      ['spare', 'OK', []],
    ])
    expect(env.auth.profile('spare')?.status).toBe('OK')
    expect(env.auth.profile('nobody')).toBeUndefined()
  })
})

describe('AuthService: access tokens', () => {
  it('refreshes 60 seconds before expiry, rotates and saves the new refresh token', async () => {
    const env = await authorized()
    const first = await token(env)
    const sealed = env.db.rows.get('default')!.refreshToken
    const calls = env.tokenCalls()

    env.clock.advance(TTL_MS - 61_000)
    expect(await token(env)).toEqual(first)
    expect(env.tokenCalls()).toBe(calls)

    env.clock.advance(2000)
    const second = await token(env)
    expect(second.ok && second.token).not.toBe(first.ok && first.token)
    expect(env.tokenCalls()).toBe(calls + 1)
    const rec = env.db.rows.get('default')!
    expect(rec.refreshToken).not.toBe(sealed)
    expect(env.fake.refreshTokens.has(env.box.open(sealed))).toBe(false)
    expect(env.fake.refreshTokens.has(env.box.open(rec.refreshToken))).toBe(true)
    expect(rec).toMatchObject({ status: 'OK', lastRefreshAt: env.clock.now(), lastSuccessAt: env.clock.now() })
  })

  it('keeps the same sealed refresh token when SSO does not rotate it', async () => {
    const env = await authorized()
    env.fake.sso.rotateRefresh = false
    const sealed = env.db.rows.get('default')!.refreshToken
    env.clock.advance(TTL_MS)
    expect(await token(env)).toMatchObject({ ok: true })
    expect(env.db.rows.get('default')!.refreshToken).toBe(sealed)
  })

  it('sends one refresh for many concurrent callers', async () => {
    const env = await authorized()
    env.clock.advance(TTL_MS)
    const calls = env.tokenCalls()
    const results = await Promise.all(Array.from({ length: 10 }, () => token(env)))
    expect(env.tokenCalls()).toBe(calls + 1)
    expect(new Set(results.map((r) => r.ok && r.token)).size).toBe(1)
  })

  it('feeds the ESI client: a 401 forces one refresh, a second force right after reuses the new token', async () => {
    const env = await authorized()
    const before = await token(env)
    env.clock.advance(20_000)
    env.fake.expire(before.ok ? before.token : '')
    const calls = env.tokenCalls()
    const auth = env.auth.esiAuth('default')
    const res = await env.esi.structure(STRUCTURE_A, { auth, store: new MemoryResponseCache(1 << 20) })
    expect(res.value.name).toBe('XX-1 - 联盟市场A')
    expect(env.tokenCalls()).toBe(calls + 1)
    expect(await token(env, { force: true })).toMatchObject({ ok: true })
    expect(env.tokenCalls()).toBe(calls + 1)

    const missing = await env.esi.structure(STRUCTURE_A, { auth: env.auth.esiAuth('nobody'), store: new MemoryResponseCache(1 << 20) }).catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(EsiError)
    expect(missing).toMatchObject({ kind: 'auth', code: 'NEEDS_AUTH' })
  })

  it('without a Client ID every profile needs authorization', async () => {
    const env = await authorized()
    const off = env.another({ sso: { clientId: '', clientSecret: '' } })
    await off.start()
    expect(await off.getAccessToken('default')).toEqual({ ok: false, status: 'NEEDS_AUTH', reason: AUTH_TEXT.notConfigured })
    expect(off.profiles()[0]).toMatchObject({ status: 'NEEDS_AUTH', characterName: 'Test Pilot', lastError: AUTH_TEXT.notConfigured, tokenValid: false })
    const fresh = await makeSsoEnv({ sso: { clientId: '' } })
    expect(await fresh.auth.getAccessToken('default')).toEqual({ ok: false, status: 'NEEDS_AUTH', reason: AUTH_TEXT.notConfigured })
    expect(fresh.auth.profiles()[0]).toMatchObject({ status: 'NEEDS_AUTH', lastError: '' })
    expect(await env.auth.getAccessToken('nobody')).toEqual({ ok: false, status: 'NEEDS_AUTH', reason: AUTH_TEXT.notAuthorized })
  })
})

describe('AuthService: status machine', () => {
  it('invalid_grant → AUTH_ERROR, saved, logged once, retried at most once an hour', async () => {
    const env = await authorized()
    const changes: string[] = []
    env.auth.onChange((s) => changes.push(s.status))
    env.fake.refreshTokens.clear()
    env.clock.advance(TTL_MS)
    const calls = env.tokenCalls()
    expect(await token(env)).toEqual({ ok: false, status: 'AUTH_ERROR', reason: AUTH_TEXT.invalidGrant })
    expect(state(env)).toMatchObject({ status: 'AUTH_ERROR', lastError: AUTH_TEXT.invalidGrant, lastErrorAt: env.clock.now(), tokenValid: false })
    expect(env.db.rows.get('default')).toMatchObject({ status: 'AUTH_ERROR', lastError: AUTH_TEXT.invalidGrant, lastErrorAt: env.clock.now() })

    expect(await token(env, { force: true })).toMatchObject({ ok: false, status: 'AUTH_ERROR' })
    env.clock.advance(59 * MINUTE)
    expect(await token(env)).toMatchObject({ ok: false, status: 'AUTH_ERROR' })
    expect(env.tokenCalls()).toBe(calls + 1)
    env.clock.advance(2 * MINUTE)
    expect(await token(env)).toMatchObject({ ok: false, status: 'AUTH_ERROR' })
    expect(env.tokenCalls()).toBe(calls + 2)
    expect(env.logger.at('warn').filter((t) => t.includes('需要重新授权'))).toEqual([
      `EVE 授权档案 default（角色「Test Pilot」）需要重新授权：${AUTH_TEXT.invalidGrant}`,
    ])
    expect(changes).toEqual(['AUTH_ERROR'])

    // 重新授权就好了，旧的错误清掉
    expect(await env.authorize()).toMatchObject({ ok: true })
    expect(state(env)).toMatchObject({ status: 'OK', lastError: '', lastErrorAt: null })
    expect(changes).toEqual(['AUTH_ERROR', 'OK'])
  })

  it('network trouble → DEGRADED with 1, 5, 15, 60 minute backoff; the old token is used while it lasts', async () => {
    const env = await authorized()
    const old = await token(env)
    env.fake.fault('POST', /\/v2\/oauth\/token$/, { status: 503, body: { error: 'server_error' } }, 6)
    env.clock.advance(TTL_MS - 30_000)
    const calls = env.tokenCalls()
    expect(await token(env)).toEqual(old)
    expect(state(env)).toMatchObject({ status: 'DEGRADED', lastError: AUTH_TEXT.unavailable('HTTP 503 server_error'), tokenValid: true })
    expect(env.db.rows.get('default')).toMatchObject({ status: 'DEGRADED' })
    expect(await token(env)).toEqual(old)
    expect(env.tokenCalls()).toBe(calls + 1)

    env.clock.advance(MINUTE)
    expect(await token(env)).toMatchObject({ ok: false, status: 'DEGRADED' })
    expect(env.tokenCalls()).toBe(calls + 2)
    for (const [i, step] of [5, 15, 60, 60].entries()) {
      env.clock.advance((step - 1) * MINUTE)
      await token(env)
      expect(env.tokenCalls()).toBe(calls + 2 + i)
      env.clock.advance(MINUTE)
      await token(env)
      expect(env.tokenCalls()).toBe(calls + 3 + i)
    }
    expect(env.logger.at('warn').filter((t) => t.includes('暂时刷新不了'))).toHaveLength(1)

    // 故障用完了：下一次重试就恢复
    env.clock.advance(60 * MINUTE)
    expect(await token(env)).toMatchObject({ ok: true })
    expect(state(env)).toMatchObject({ status: 'OK', tokenValid: true })
    expect(env.logger.at('info')).toContain('EVE 授权档案 default（角色「Test Pilot」）恢复正常')

    // 连接断开也算网络问题
    env.fake.fault('POST', /\/v2\/oauth\/token$/, { destroy: true })
    env.clock.advance(TTL_MS)
    expect(await token(env)).toMatchObject({ ok: false, status: 'DEGRADED' })
  })

  it('owner change → AUTH_ERROR, but the rotated refresh token is still saved', async () => {
    const env = await authorized()
    const sealed = env.db.rows.get('default')!.refreshToken
    env.fake.sso.ownerHash = 'fake-owner-hash-2'
    env.clock.advance(TTL_MS)
    expect(await token(env)).toEqual({ ok: false, status: 'AUTH_ERROR', reason: AUTH_TEXT.ownerChanged })
    const rec = env.db.rows.get('default')!
    expect(rec).toMatchObject({ status: 'AUTH_ERROR', ownerHash: 'fake-owner-hash-1' })
    expect(rec.refreshToken).not.toBe(sealed)
    expect(env.fake.refreshTokens.has(env.box.open(rec.refreshToken))).toBe(true)
  })

  it('losing a sync scope → AUTH_ERROR; losing only the search scope keeps the profile working', async () => {
    const env = await authorized()
    env.fake.sso.scopes = [MARKETS_SCOPE, STRUCTURES_SCOPE]
    env.clock.advance(TTL_MS)
    expect(await token(env)).toMatchObject({ ok: true })
    expect(state(env)).toMatchObject({ status: 'OK', scopesGranted: 2 })
    expect(await env.auth.searchStructures('default', '联盟市场')).toEqual({ ok: false, code: 'NOT_CONFIGURED', message: AUTH_TEXT.noSearchScope })

    env.fake.sso.scopes = [MARKETS_SCOPE]
    env.fake.sso.scpAsString = true
    env.clock.advance(TTL_MS)
    expect(await token(env)).toEqual({ ok: false, status: 'AUTH_ERROR', reason: AUTH_TEXT.missingScopes([STRUCTURES_SCOPE]) })
  })

  it('a token that is not for this character or not from EVE → AUTH_ERROR', async () => {
    const env = await authorized()
    env.fake.sso.characterId = 2112000099
    env.clock.advance(TTL_MS)
    expect(await token(env)).toEqual({ ok: false, status: 'AUTH_ERROR', reason: AUTH_TEXT.otherCharacter })

    const other = await authorized()
    other.fake.fault('POST', /\/v2\/oauth\/token$/, { status: 200, body: { access_token: 'a.b.c', token_type: 'Bearer', expires_in: 1199 } })
    other.clock.advance(TTL_MS)
    expect(await token(other)).toMatchObject({ ok: false, status: 'AUTH_ERROR', reason: AUTH_TEXT.badToken('access token 的内容不是 JSON') })
  })
})

describe('AuthService: keys, reloads and restarts', () => {
  it('a different secret.key → NEEDS_AUTH with the reason; nothing is sent, nothing is overwritten; the old key works again', async () => {
    const env = await authorized()
    const saved = { ...env.db.rows.get('default')! }
    const calls = env.tokenCalls()
    const moved = env.another({ box: newBox() })
    await moved.start()
    expect(moved.profiles()[0]).toMatchObject({
      status: 'NEEDS_AUTH', characterName: 'Test Pilot', lastError: AUTH_TEXT.keyChanged, lastErrorAt: env.clock.now(), tokenValid: false,
    })
    expect(await moved.getAccessToken('default')).toEqual({ ok: false, status: 'NEEDS_AUTH', reason: AUTH_TEXT.keyChanged })
    expect(env.tokenCalls()).toBe(calls)
    expect(env.db.rows.get('default')).toEqual(saved)
    expect(env.logger.at('warn')).toContain(`EVE 授权档案 default：${AUTH_TEXT.keyChanged}`)

    const back = env.another()
    env.clock.advance(TTL_MS)
    expect(await back.getAccessToken('default')).toMatchObject({ ok: true })
  })

  it('an unreadable key file → NEEDS_AUTH and no new authorizations', async () => {
    const env = await authorized()
    const fail = (): never => { throw new Error('secret.key unreadable') }
    const broken: SecretBox = { keyId: '', seal: fail, open: fail }
    const service = env.another({ box: broken })
    await service.start()
    expect(service.profiles()[0]).toMatchObject({ status: 'NEEDS_AUTH', lastError: AUTH_TEXT.secretUnavailable })
    expect(await service.getAccessToken('default')).toMatchObject({ ok: false, status: 'NEEDS_AUTH', reason: AUTH_TEXT.secretUnavailable })
    expect(() => service.beginAuth('default')).toThrow(AUTH_TEXT.secretUnavailable)
  })

  it('a damaged ciphertext → AUTH_ERROR', async () => {
    const env = await authorized()
    const rec = env.db.rows.get('default')!
    env.db.rows.set('default', { ...rec, refreshToken: `${rec.refreshToken.slice(0, -4)}AAAA` })
    const service = env.another()
    expect(await service.getAccessToken('default')).toEqual({ ok: false, status: 'AUTH_ERROR', reason: AUTH_TEXT.unreadable })
  })

  it('after a restart: an OK profile refreshes, a recent AUTH_ERROR waits for its hour', async () => {
    const env = await authorized()
    const calls = env.tokenCalls()
    const restarted = env.another()
    await restarted.start()
    expect(restarted.profiles()[0]).toMatchObject({ status: 'OK', tokenValid: false })
    expect(await restarted.getAccessToken('default')).toMatchObject({ ok: true })
    expect(env.tokenCalls()).toBe(calls + 1)

    env.db.rows.set('default', { ...env.db.rows.get('default')!, status: 'AUTH_ERROR', lastError: AUTH_TEXT.invalidGrant, lastErrorAt: env.clock.now() - 30 * MINUTE })
    const again = env.another()
    expect(await again.getAccessToken('default')).toEqual({ ok: false, status: 'AUTH_ERROR', reason: AUTH_TEXT.invalidGrant })
    expect(env.tokenCalls()).toBe(calls + 1)
    env.clock.advance(31 * MINUTE)
    expect(await again.getAccessToken('default')).toMatchObject({ ok: true })
    expect(again.profiles()[0]).toMatchObject({ status: 'OK' })
  })

  it('when the plugin reloaded mid-rotation, an invalid_grant retries once with the newer token from the database', async () => {
    const env = await authorized()
    const before = env.another()
    await before.start()
    env.clock.advance(TTL_MS)
    expect(await token(env)).toMatchObject({ ok: true })
    const calls = env.tokenCalls()
    expect(await before.getAccessToken('default')).toMatchObject({ ok: true })
    expect(env.tokenCalls()).toBe(calls + 2)
    expect(before.profiles()[0].status).toBe('OK')
    expect(env.logger.at('warn').filter((t) => t.includes('需要重新授权'))).toEqual([])
  })

  it('a database that cannot be read is retried a minute later', async () => {
    const env = await authorized()
    env.db.failNext.list = 2
    const service = env.another()
    await service.start()
    expect(service.profiles()[0]).toMatchObject({ status: 'NEEDS_AUTH', lastError: AUTH_TEXT.loadFailed })
    expect(await service.getAccessToken('default')).toMatchObject({ ok: false, status: 'NEEDS_AUTH', reason: AUTH_TEXT.loadFailed })
    env.clock.advance(MINUTE + 1000)
    expect(await service.getAccessToken('default')).toMatchObject({ ok: false, reason: AUTH_TEXT.loadFailed })
    env.clock.advance(MINUTE + 1000)
    expect(await service.getAccessToken('default')).toMatchObject({ ok: true })
    expect(env.logger.at('warn').filter((t) => t.startsWith('读不出保存的 EVE 授权档案'))).toHaveLength(1)
  })

  it('a failed save keeps the rotated token in memory and is retried on the next refresh', async () => {
    const env = await authorized()
    env.db.failNext.upsert = 1
    env.clock.advance(TTL_MS)
    expect(await token(env)).toMatchObject({ ok: true })
    expect(env.logger.at('warn').some((t) => t.startsWith('EVE 授权档案 default 没能写进数据库'))).toBe(true)
    env.clock.advance(TTL_MS)
    expect(await token(env)).toMatchObject({ ok: true })
    expect(env.fake.refreshTokens.has(env.box.open(env.db.rows.get('default')!.refreshToken))).toBe(true)
  })
})

describe('AuthService: remove', () => {
  it('deletes the profile and revokes its refresh token', async () => {
    const env = await authorized()
    const plain = env.box.open(env.db.rows.get('default')!.refreshToken)
    const changes: AuthProfileStatus[] = []
    env.auth.onChange((s) => changes.push(s))
    await env.auth.remove('default')
    expect(env.db.rows.size).toBe(0)
    expect(env.fake.refreshTokens.has(plain)).toBe(false)
    expect(state(env)).toMatchObject({ status: 'NEEDS_AUTH', characterName: '', lastError: '', tokenValid: false })
    expect(changes.map((c) => c.status)).toEqual(['NEEDS_AUTH'])
    expect(await token(env)).toMatchObject({ ok: false, status: 'NEEDS_AUTH' })
  })

  it('a failed revoke does not stop the deletion; an unknown profile is a no-op; a failed delete keeps everything', async () => {
    const env = await authorized()
    expect(await env.authorize('spare')).toMatchObject({ ok: true })
    env.fake.fault('POST', /\/v2\/oauth\/revoke$/, { status: 500 })
    await env.auth.remove('spare')
    expect(env.db.rows.has('spare')).toBe(false)
    expect(env.auth.profiles().map((p) => p.profile)).toEqual(['default'])
    expect(env.logger.at('info').some((t) => t.includes('手动撤销'))).toBe(true)

    env.db.failNext.remove = 1
    await expect(env.auth.remove('nobody')).resolves.toBeUndefined()
    await expect(env.auth.remove('default')).rejects.toThrow('database is locked')
    expect(state(env).status).toBe('OK')
    expect(env.db.rows.has('default')).toBe(true)
  })

  it('a refresh that was in flight while the profile was deleted does not bring it back', async () => {
    const env = await authorized()
    env.clock.advance(TTL_MS)
    const calls = env.tokenCalls()
    const release = env.fake.hold(/^\/v2\/oauth\/token$/)
    const pending = token(env)
    await until(() => env.tokenCalls() === calls + 1)
    await env.auth.remove('default')
    release()
    expect(await pending).toMatchObject({ ok: false, status: 'NEEDS_AUTH' })
    expect(env.db.rows.size).toBe(0)
    expect(state(env)).toMatchObject({ status: 'NEEDS_AUTH', characterName: '' })
  })
})

describe('AuthService: a refresh racing a slow database write', () => {
  const refreshGrant = (r: { body: string }) => new URLSearchParams(r.body).get('grant_type') === 'refresh_token'

  it('a refresh that returns while the delete is being written does not bring the profile back, and its new token is revoked', async () => {
    const env = await authorized()
    env.clock.advance(TTL_MS)
    const calls = env.tokenCalls()
    const releaseToken = env.fake.hold(/^\/v2\/oauth\/token$/)
    const pending = token(env, { force: true })
    await until(() => env.tokenCalls() === calls + 1)
    const releaseDb = env.db.hold('remove')
    const removing = env.auth.remove('default')
    await until(() => !env.db.rows.has('default'))
    // 数据库还没返回时，刷新先回来了（SSO 已经换了 refresh token）
    releaseToken()
    expect(await pending).toMatchObject({ ok: false, status: 'NEEDS_AUTH' })
    releaseDb()
    await removing
    expect(env.db.rows.has('default')).toBe(false)
    expect(state(env)).toMatchObject({ status: 'NEEDS_AUTH', characterName: '' })
    // 重启以后也没有
    const again = env.another({ store: createModuleStore() })
    await again.start()
    expect(await again.getAccessToken('default')).toMatchObject({ ok: false, status: 'NEEDS_AUTH' })
    // 刷新换出来的那个 refresh token 也撤销了
    await until(() => env.fake.refreshTokens.size === 0)
  })

  it('a refresh of the old authorization that returns during a re-authorization does not overwrite it, in memory or in the database', async () => {
    const env = await authorized()
    env.clock.advance(TTL_MS)
    const calls = env.tokenCalls()
    const releaseRefresh = env.fake.hold(/^\/v2\/oauth\/token$/, refreshGrant)
    const pending = token(env, { force: true })
    await until(() => env.tokenCalls() === calls + 1)

    // 换一个角色重新授权；写数据库的时候慢
    Object.assign(env.fake.sso, { characterId: 2112000002, characterName: 'Second Pilot', ownerHash: 'fake-owner-hash-2' })
    const { url } = env.auth.beginAuth('default')
    const { code, state: s } = await env.login(url)
    const releaseDb = env.db.hold('upsert')
    const completing = env.auth.completeAuth(code, s)
    await until(() => env.db.rows.get('default')?.characterName === 'Second Pilot')
    // 旧的刷新这时回来（拿到的还是原来的角色）
    Object.assign(env.fake.sso, { characterId: 2112000001, characterName: 'Test Pilot', ownerHash: 'fake-owner-hash-1' })
    releaseRefresh()
    await pending
    releaseDb()
    expect(await completing).toMatchObject({ ok: true, characterName: 'Second Pilot' })

    expect(env.db.writes.map((w) => w.characterName).slice(-1)).toEqual(['Second Pilot'])
    expect(env.db.rows.get('default')!.characterName).toBe('Second Pilot')
    expect(state(env).characterName).toBe('Second Pilot')
    const again = env.another({ store: createModuleStore() })
    await again.start()
    expect(again.profile('default')).toMatchObject({ status: 'OK', characterName: 'Second Pilot' })
  })

  it('a failed save of a new authorization puts the old one back', async () => {
    const env = await authorized()
    Object.assign(env.fake.sso, { characterId: 2112000002, characterName: 'Second Pilot', ownerHash: 'fake-owner-hash-2' })
    env.db.failNext.upsert = 1
    expect(await env.authorize()).toMatchObject({ ok: false, reason: 'save_failed' })
    expect(state(env)).toMatchObject({ status: 'OK', characterName: 'Test Pilot' })
    expect(env.db.rows.get('default')!.characterName).toBe('Test Pilot')
    expect(await token(env)).toMatchObject({ ok: true, characterId: '2112000001' })
  })
})

describe('AuthService: search structures by name', () => {
  it('lists the hits with name and system, unreachable ones last', async () => {
    const env = await authorized()
    env.fake.searchResults.set('联盟市场', [STRUCTURE_B, STRUCTURE_A, STRUCTURE_A])
    expect(await env.auth.searchStructures('default', '  联盟市场 ')).toEqual([
      { id: String(STRUCTURE_A), name: 'XX-1 - 联盟市场A', systemId: SYSTEM_XX1 },
      { id: String(STRUCTURE_B), name: '', systemId: null },
    ])
    const search = env.fake.requests.filter((r) => r.path.endsWith('/search')).at(-1)!
    expect(search.path).toBe(`/characters/${env.fake.sso.characterId}/search`)
    expect(Object.fromEntries(search.query)).toEqual({ categories: 'structure', search: '联盟市场' })
    expect(await env.auth.searchStructures('default', 'nothing here')).toEqual([])
  })

  it('checks the input, the profile and ESI failures', async () => {
    const env = await authorized()
    expect(await env.auth.searchStructures('default', 'ab')).toEqual({ ok: false, code: 'BAD_ARGUMENT', message: AUTH_TEXT.searchLength })
    expect(await env.auth.searchStructures('default', 'x'.repeat(101))).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(await env.auth.searchStructures('nobody', '联盟市场')).toEqual({ ok: false, code: 'NOT_CONFIGURED', message: AUTH_TEXT.notAuthorized })
    env.fake.fault('GET', /\/search$/, { status: 500 }, 2)
    expect(await env.auth.searchStructures('default', '联盟市场')).toEqual({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: AUTH_TEXT.searchFailed('HTTP 500') })
    // 4xx（路由或权限名不对）：不叫人一直重试，给别的找 ID 的办法
    env.fake.fault('GET', /\/search$/, { status: 404, body: { error: 'Not found' } })
    expect(await env.auth.searchStructures('default', '联盟市场')).toEqual({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: AUTH_TEXT.searchRejected('HTTP 404') })

    env.fake.refreshTokens.clear()
    env.clock.advance(TTL_MS)
    expect(await env.auth.searchStructures('default', '联盟市场')).toEqual({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: AUTH_TEXT.invalidGrant })
  })
})

describe('AuthService: search characters by name (KB 人物卡)', () => {
  it('returns the ids, asks ESI for categories=character and sends the profile token', async () => {
    const env = await authorized()
    env.fake.characterSearch.set('Hanako', [2119876543, 2119876544, 2119876543])
    expect(await env.auth.searchCharacters('default', '  Hanako ')).toEqual([2119876543, 2119876544])
    const search = env.fake.requests.filter((r) => r.path.endsWith('/search')).at(-1)!
    expect(search.path).toBe(`/characters/${env.fake.sso.characterId}/search`)
    expect(Object.fromEntries(search.query)).toEqual({ categories: 'character', search: 'Hanako', strict: 'false' })
    expect(search.headers.authorization).toMatch(/^Bearer /)
    expect(await env.auth.searchCharacters('default', 'Nobody')).toEqual([])
  })

  it('checks the input, the profile, the search permission and ESI failures', async () => {
    const env = await authorized()
    expect(await env.auth.searchCharacters('default', 'ab')).toEqual({ ok: false, code: 'BAD_ARGUMENT', message: AUTH_TEXT.searchLength })
    expect(await env.auth.searchCharacters('nobody', 'Hanako')).toEqual({ ok: false, code: 'NOT_CONFIGURED', message: AUTH_TEXT.notAuthorized })
    env.fake.fault('GET', /\/search$/, { status: 500 }, 2)
    expect(await env.auth.searchCharacters('default', 'Hanako')).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    env.fake.sso.scopes = [MARKETS_SCOPE, STRUCTURES_SCOPE]
    env.clock.advance(TTL_MS)
    expect(await token(env)).toMatchObject({ ok: true })
    expect(await env.auth.searchCharacters('default', 'Hanako')).toEqual({ ok: false, code: 'NOT_CONFIGURED', message: AUTH_TEXT.noSearchScope })
  })

  it('never writes the token or the client secret to the log', async () => {
    const env = await authorized()
    env.fake.fault('GET', /\/search$/, { status: 403, body: { error: `denied for ${env.fake.sso.clientSecret}` } })
    await env.auth.searchCharacters('default', 'Hanako')
    const log = env.logger.text()
    expect(env.secrets().filter((x) => log.includes(x))).toEqual([])
  })
})

describe('AuthService: no secrets anywhere', () => {
  it('logs, status and database never contain a token, a code or the client secret', async () => {
    const env = await makeSsoEnv()
    await env.authorize()
    await env.authorize('spare')
    // 各种失败，错误说明里故意带上 token
    const plain = env.box.open(env.db.rows.get('default')!.refreshToken)
    env.fake.fault('POST', /\/v2\/oauth\/token$/, { status: 503, body: { error: 'server_error', error_description: `refresh_token=${plain} secret=${env.fake.sso.clientSecret}` } })
    env.clock.advance(TTL_MS)
    await token(env)
    env.clock.advance(MINUTE)
    env.fake.fault('POST', /\/v2\/oauth\/token$/, { status: 400, body: { error: 'invalid_grant', error_description: `token ${plain} is gone` } })
    await token(env)
    const spare = env.box.open(env.db.rows.get('spare')!.refreshToken)
    env.fake.fault('POST', /\/v2\/oauth\/revoke$/, { status: 500, body: { error: 'server_error', error_description: spare } })
    await env.auth.remove('spare')
    env.db.failNext.upsert = 1
    const lost = await env.login(env.auth.beginAuth('default').url)
    await env.auth.completeAuth(lost.code, lost.state)
    await env.authorize()
    env.fake.fault('GET', /\/search$/, { status: 403, body: { error: `denied for ${env.fake.sso.clientSecret}` } })
    await env.auth.searchStructures('default', '联盟市场')

    const secrets = env.secrets()
    expect(secrets.length).toBeGreaterThan(8)
    const places = {
      logs: env.logger.text(),
      status: JSON.stringify(env.auth.profiles()),
      database: JSON.stringify([...env.db.rows.values(), ...env.db.writes]),
    }
    for (const [where, text] of Object.entries(places)) {
      expect(secrets.filter((s) => text.includes(s)), where).toEqual([])
    }
    expect(env.db.writes.every((w) => /^v1:[0-9a-f]{8}:/.test(w.refreshToken))).toBe(true)
  })
})

describe('AuthService: the market rows decide which profiles are listed', () => {
  it('lists every configured profile in table order, even before anything is loaded', async () => {
    const env = await makeSsoEnv({ markets: [MARKETS[1], { ...MARKETS[0], authProfile: 'logistics' }, MARKETS[2]] })
    expect(env.auth.profiles().map((p) => [p.profile, p.markets])).toEqual([
      ['default', ['联盟市场B', '联盟市场C']],
      ['logistics', ['联盟市场A']],
    ])
  })
})
