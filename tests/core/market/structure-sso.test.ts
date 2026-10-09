// 建筑市场同步接真的授权档案服务：本机的假 ESI（含 SSO）+ 真的 HTTP 客户端。
// 授权成功后马上同步、401 时让档案刷新（refresh token 轮换后加密保存）、授权被撤销后不再显示、日志里没有任何秘密。

import { afterEach, describe, expect, it } from 'vitest'
import { createStructureMarkets } from '../../../src/core/market'
import type { ManagedStructureSource } from '../../../src/core/market'
import type { MarketDef } from '../../../src/core/types'
import { rawOrder } from '../../fakes/fake-esi'
import { MemoryBlobCache, realScheduler, until } from '../esi/helpers'
import { MINUTE, STRUCTURE_A, STRUCTURE_B, SYSTEM_XX1, closeSsoEnvs, makeSsoEnv } from '../sso/helpers'
import type { SsoEnv } from '../sso/helpers'

const RAVEN = 638
const sources: ManagedStructureSource[] = []

afterEach(async () => {
  for (const s of sources.splice(0)) s.stop()
  await closeSsoEnvs()
})

function def(name: string, id: number): MarketDef {
  return {
    key: name.toLowerCase(), name, aliases: [], shortAlias: name, type: 'structure', regionId: null, systemId: SYSTEM_XX1,
    locationId: id, inDefaultList: true, sortOrder: 0, visibility: 'allowed', authProfile: 'default',
  }
}

const MARKET_A = def('联盟市场A', STRUCTURE_A)
const MARKET_B = def('联盟市场B', STRUCTURE_B)

function build(env: SsoEnv, cache: MemoryBlobCache) {
  const source = createStructureMarkets({
    esi: env.esi, auth: env.auth, registry: { all: () => [MARKET_A, MARKET_B] }, cache, clock: env.clock, scheduler: realScheduler,
    logger: env.logger, random: () => 0,
  })
  sources.push(source)
  return source
}

describe('structure sync with the real auth profiles', () => {
  it('authorize, sync, refresh a rejected token, stop showing prices once the grant is revoked', async () => {
    const env = await makeSsoEnv({
      setup: (fake) => {
        fake.pageSize = 2
        fake.structureOrders.set(STRUCTURE_A, [
          rawOrder({ location_id: STRUCTURE_A, price: 270 }),
          rawOrder({ location_id: STRUCTURE_A, price: 260 }),
          rawOrder({ location_id: STRUCTURE_A, is_buy_order: true, price: 240, range: 'station' }),
        ])
      },
    })
    const cache = new MemoryBlobCache()
    const source = build(env, cache)
    await source.start()
    await until(() => source.status(MARKET_A).state === 'NEEDS_AUTH' && source.status(MARKET_B).state === 'NEEDS_AUTH')
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'not_ready', reason: 'needs_auth' })
    expect(env.fake.count(/^\/markets\/structures\//)).toBe(0)

    // 授权成功：马上同步；没有停靠权限的建筑只影响它自己
    expect(await env.authorize()).toMatchObject({ ok: true })
    await until(() => source.status(MARKET_A).state === 'OK' && source.status(MARKET_B).state === 'AUTH_ERROR')
    // 最近一次错误留着（「市场状态」按状态决定写不写）
    expect(source.status(MARKET_A)).toMatchObject({ pages: 2, orders: 3, lastSuccessAt: env.clock.now(), lastError: { code: 'NEEDS_AUTH' } })
    const read = source.read(MARKET_A, RAVEN)
    expect('orders' in read && read.orders.map((o) => o.price)).toEqual([260, 270, 240])
    expect(source.read(MARKET_B, RAVEN)).toEqual({
      status: 'auth_error', reason: 'auth', detail: 'GET /markets/structures/{structure_id} HTTP 403: Market access denied',
    })

    // access token 被拒：ESI 客户端让档案强制刷新一次，新的 refresh token 加密保存
    const sealed = env.db.rows.get('default')!.refreshToken
    const refreshes = env.tokenCalls()
    for (const token of [...env.fake.accessTokens]) env.fake.expire(token)
    env.clock.advance(6 * MINUTE)
    await source.resync([MARKET_A])
    expect(source.status(MARKET_A)).toMatchObject({ state: 'OK', lastSuccessAt: env.clock.now() })
    expect(env.tokenCalls()).toBe(refreshes + 1)
    expect(env.db.rows.get('default')!.refreshToken).not.toBe(sealed)

    // 授权被撤销：刷新失败，旧价格马上不再显示
    env.fake.refreshTokens.clear()
    for (const token of [...env.fake.accessTokens]) env.fake.expire(token)
    env.clock.advance(6 * MINUTE)
    await source.resync([MARKET_A])
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'auth_error', reason: 'auth' })
    expect(source.available(MARKET_A)).toEqual({ status: 'auth_error', reason: 'auth' })

    await source.flush()
    const logged = env.logger.text()
    const stored = JSON.stringify([...cache.entries.values()].map((e) => e.meta))
    for (const secret of env.secrets()) {
      expect(logged).not.toContain(secret)
      expect(stored).not.toContain(secret)
    }
  })

  it('deleting the profile while the ESI cache is still fresh: a query does not bring the prices back', async () => {
    const env = await makeSsoEnv({
      setup: (fake) => fake.structureOrders.set(STRUCTURE_A, [rawOrder({ location_id: STRUCTURE_A, price: 270 })]),
    })
    const source = build(env, new MemoryBlobCache())
    await source.start()
    expect(await env.authorize()).toMatchObject({ ok: true })
    await until(() => source.status(MARKET_A).state === 'OK')
    env.clock.advance(MINUTE)
    const requests = env.fake.count(/^\/markets\/structures\//)

    await env.auth.remove('default')
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'not_ready', reason: 'needs_auth' })
    await source.touch(MARKET_A, 3000)
    await source.resync([MARKET_A])
    expect(source.status(MARKET_A).state).toBe('NEEDS_AUTH')
    expect(source.read(MARKET_A, RAVEN)).toMatchObject({ status: 'not_ready', reason: 'needs_auth' })
    expect(env.fake.count(/^\/markets\/structures\//)).toBe(requests)
  })
})
