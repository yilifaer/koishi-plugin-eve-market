// 授权档案表（§8.1、§8.2）：真实的 Koishi + 内存数据库。数据库里只有 SecretBox 的密文，明文 refresh token 进不去。

import { Context } from 'koishi'
import Memory from '@koishijs/plugin-database-memory'
import { afterEach, describe, expect, it } from 'vitest'
import { AesSecretBox } from '../../src/bot/ports'
import { SSO_SCOPES } from '../../src/constants'
import type { AuthRecord, AuthStore } from '../../src/core/ports'
import { AUTH_TABLE, SEALED_PATTERN, createAuthStore, recordToRow, rowToRecord } from '../../src/storage'

const PLAIN = 'rt-plaintext-0123456789abcdef'
const box = new AesSecretBox(Buffer.alloc(32, 3))

function record(p: Partial<AuthRecord> = {}): AuthRecord {
  return {
    profile: 'default',
    characterId: '2112000001',
    characterName: 'Test Pilot',
    ownerHash: 'fake-owner-hash-1',
    scopes: [...SSO_SCOPES],
    refreshToken: box.seal(PLAIN),
    keyId: box.keyId,
    status: 'OK',
    lastError: '',
    lastErrorAt: null,
    lastRefreshAt: Date.UTC(2026, 9, 7, 6, 1),
    lastSuccessAt: Date.UTC(2026, 9, 7, 6, 1, 30),
    authorizedAt: Date.UTC(2026, 9, 7, 5, 59),
    ...p,
  }
}

let app: Context | undefined

afterEach(async () => {
  await app?.stop()
  app = undefined
})

async function start(now = Date.UTC(2026, 9, 7, 6, 20)): Promise<{ app: Context; store: AuthStore }> {
  app = new Context()
  app.plugin(Memory as never)
  let store!: AuthStore
  app.plugin({ name: 'eve-market-store-test', inject: ['database'], apply: (ctx: Context) => { store = createAuthStore(ctx, { now: () => now }) } })
  await app.start()
  return { app, store }
}

describe('DatabaseAuthStore', () => {
  it('declares the table with an auto id and a unique profile', async () => {
    const env = await start()
    const model = env.app.model.tables[AUTH_TABLE]
    expect(model.primary).toBe('id')
    expect(model.autoInc).toBe(true)
    expect(model.unique.flat()).toContain('profile')
  })

  it('round-trips a record; the stored row only holds the ciphertext', async () => {
    const { app: a, store } = await start()
    expect(await store.list()).toEqual([])
    expect(await store.get('default')).toBeUndefined()

    const rec = record()
    await store.upsert(rec)
    expect(await store.get('default')).toEqual(rec)
    const back = await store.get('default')
    expect(box.open(back!.refreshToken)).toBe(PLAIN)

    const rows = await a.database.get(AUTH_TABLE, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].refreshToken).toMatch(SEALED_PATTERN)
    expect(rows[0].scopes).toBe(SSO_SCOPES.join(' '))
    expect(rows[0].updatedAt?.getTime()).toBe(Date.UTC(2026, 9, 7, 6, 20))
    expect(JSON.stringify(rows)).not.toContain(PLAIN)
  })

  it('upsert overwrites by profile and keeps the id; list keeps creation order; remove deletes', async () => {
    const { app: a, store } = await start()
    await store.upsert(record({ profile: 'logistics', characterName: 'Hauler' }))
    await store.upsert(record())
    const [{ id }] = await a.database.get(AUTH_TABLE, { profile: 'default' })

    await store.upsert(record({ status: 'AUTH_ERROR', lastError: '刷新令牌失效', lastErrorAt: Date.UTC(2026, 9, 7, 6, 10), refreshToken: box.seal('rt-newer') }))
    const rows = await a.database.get(AUTH_TABLE, { profile: 'default' })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    const updated = await store.get('default')
    expect(updated?.status).toBe('AUTH_ERROR')
    expect(updated?.lastErrorAt).toBe(Date.UTC(2026, 9, 7, 6, 10))
    expect(box.open(updated!.refreshToken)).toBe('rt-newer')

    expect((await store.list()).map((r) => r.profile)).toEqual(['logistics', 'default'])
    await store.remove('logistics')
    await store.remove('missing')
    expect((await store.list()).map((r) => r.profile)).toEqual(['default'])
  })

  it('an empty refresh token (not authorized yet) is fine; a plaintext one is refused without echoing it', async () => {
    const { store } = await start()
    await store.upsert(record({ refreshToken: '', status: 'NEEDS_AUTH', characterId: '', characterName: '', scopes: [] }))
    expect((await store.get('default'))?.scopes).toEqual([])

    let error: unknown
    try {
      await store.upsert(record({ profile: 'other', refreshToken: PLAIN }))
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).not.toContain(PLAIN)
    expect(await store.get('other')).toBeUndefined()
  })

  it('refuses profile names outside the allowed characters', async () => {
    const { store } = await start()
    for (const profile of ['', 'a b', '../x', 'a.b', 'x'.repeat(33), '<p>']) {
      await expect(store.upsert(record({ profile }))).rejects.toThrow()
    }
    await store.upsert(record({ profile: '采矿-2' }))
    expect(await store.get('采矿-2')).toBeDefined()
  })
})

describe('row conversion', () => {
  it('reads unknown statuses as NEEDS_AUTH and tolerates missing fields', () => {
    const rec = rowToRecord({ profile: 'x', status: 'SOMETHING_NEW', scopes: '  a  b ', lastErrorAt: null })
    expect(rec.status).toBe('NEEDS_AUTH')
    expect(rec.scopes).toEqual(['a', 'b'])
    expect(rec.lastRefreshAt).toBeNull()
    expect(rec.refreshToken).toBe('')
  })

  it('writes timestamps as dates and stamps updatedAt', () => {
    const row = recordToRow(record({ lastErrorAt: null }), 1234)
    expect(row.lastErrorAt).toBeNull()
    expect(row.authorizedAt).toEqual(new Date(Date.UTC(2026, 9, 7, 5, 59)))
    expect(row.updatedAt).toEqual(new Date(1234))
  })
})
