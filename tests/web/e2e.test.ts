// 整条授权流程：授权页面 → 假 EVE 登录页 → 回调 → 结果页，用真实的 core（createEveCore，SSO 和 ESI 指向本机的假服务）、
// 内存数据库上的 AuthStore 和真的 AES 密钥盒。数据库里只有密文；页面和日志里找不到任何 token、授权码和 Client Secret。

import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { Context } from 'koishi'
import Memory from '@koishijs/plugin-database-memory'
import { afterEach, describe, expect, it } from 'vitest'
import { AesSecretBox } from '../../src/bot/ports'
import { normalizeConfig } from '../../src/config/normalize'
import { ADMIN_DELETE_PATH, ADMIN_PAGE_PATH, ADMIN_SEARCH_PATH, SSO_CALLBACK_PATH, SSO_START_PATH } from '../../src/constants'
import { createEveCore } from '../../src/core'
import { createModuleStore } from '../../src/core/ports'
import type { AuthStore, Clock } from '../../src/core/ports'
import type { EveCore } from '../../src/core/types'
import { AUTH_TABLE, SEALED_PATTERN, createAuthStore } from '../../src/storage'
import { AdminGuard, createWebHandler } from '../../src/web'
import type { WebResponse } from '../../src/web'
import { bundledDir, cleanupDirs, makeVersion } from '../core/data/helpers'
import { MemoryBlobCache, realScheduler } from '../core/esi/helpers'
import { FakeEsi } from '../fakes/fake-esi'
import { NodeHttpClient } from '../fakes/node-http-client'
import { MemoryLogger } from './fake-core'
import { formToken, linkTo, queryOf } from './helpers'

const STRUCTURE = 1_000_000_000_301
const SYSTEM = 30_000_301

interface Env {
  app: Context
  fake: FakeEsi
  core: EveCore
  logger: MemoryLogger
  get(path: string, query?: Record<string, string>): Promise<WebResponse>
}

let env: Env | undefined

afterEach(async () => {
  if (!env) return
  await env.core.stop()
  await env.app.stop()
  await env.fake.stop()
  cleanupDirs()
  env = undefined
})

async function start(): Promise<Env> {
  const fake = new FakeEsi()
  fake.structureInfo.set(STRUCTURE, { name: 'XX-1 - 联盟市场A', owner_id: 98_000_001, solar_system_id: SYSTEM, type_id: 35833 })
  fake.searchResults.set('联盟市场', [STRUCTURE])
  await fake.start()

  const app = new Context()
  app.plugin(Memory as never)
  let auth!: AuthStore
  app.plugin({ name: 'eve-market-e2e-store', inject: ['database'], apply: (ctx: Context) => { auth = createAuthStore(ctx) } })
  await app.start()

  const { settings } = normalizeConfig({
    sso: { clientId: fake.sso.clientId, clientSecret: fake.sso.clientSecret },
    markets: [{ name: '联盟市场A', aliases: '', type: 'structure', location: String(STRUCTURE), system: '', enabled: true, inDefaultList: 'auto', sortOrder: 1, visibility: 'auto', authProfile: 'default', note: '' }],
    advanced: { manifestUrl: '', glossaryUrl: '', esiContact: '' },
  })
  const clock: Clock = { now: () => Date.now() }
  const logger = new MemoryLogger()
  const core = createEveCore({
    http: new NodeHttpClient(),
    clock,
    scheduler: realScheduler,
    logger,
    cache: new MemoryBlobCache(),
    auth,
    secrets: new AesSecretBox(randomBytes(32)),
    store: createModuleStore(),
    bundledDataDir: bundledDir(makeVersion()),
    version: '0.0.2',
  }, settings, { esiBase: fake.base, ssoBase: fake.base, random: () => 0.5 })
  await core.start()
  await core.ready

  const handle = createWebHandler({ ready: async () => core }, settings, { guard: new AdminGuard(), clock, logger, readyWaitMs: 1000 })
  const get = (path: string, query: Record<string, string> = {}) =>
    handle({ path, query: new URLSearchParams(query), remoteAddress: '127.0.0.1', host: '127.0.0.1:5140', fetchSite: 'same-origin' })
  env = { app, fake, core, logger, get }
  return env
}

/** 浏览器那一段：打开 EVE 登录页，假 SSO 直接跳回回调地址 */
function login(url: string): Promise<URL> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume()
      if (res.statusCode !== 302 || !res.headers.location) return reject(new Error(`login returned ${res.statusCode}`))
      resolve(new URL(res.headers.location))
    }).on('error', reject)
  })
}

describe('authorization from the admin page with the real core', () => {
  it('authorizes, stores only ciphertext, searches, deletes, and never shows a secret', async () => {
    const e = await start()
    const page = await e.get(ADMIN_PAGE_PATH)
    expect(page.body).toContain('需要授权')
    expect(page.body).toContain('联盟市场A')

    const go = await e.get(SSO_START_PATH, queryOf(linkTo(page, SSO_START_PATH, { profile: 'default' })!))
    expect(go.status).toBe(302)
    const back = await login(go.headers.Location)
    expect(back.pathname).toBe(SSO_CALLBACK_PATH)
    const code = back.searchParams.get('code')!
    const state = back.searchParams.get('state')!

    const redirected = await e.get(SSO_CALLBACK_PATH, queryOf(back))
    expect(redirected.status).toBe(303)
    const result = await e.get(SSO_CALLBACK_PATH, queryOf(new URL(redirected.headers.Location, 'http://127.0.0.1:5140')))
    expect(result.body).toContain('授权成功')
    expect(result.body).toContain(`已经授权给角色「${e.fake.sso.characterName}」`)
    expect(result.body).toContain('XX-1 - 联盟市场A')
    expect(result.body).toContain('可以访问')
    const issued = [...e.fake.accessTokens, ...e.fake.refreshTokens]
    expect(issued.length).toBeGreaterThan(1)

    // 同一个回调再来一次：不会再换 token
    const tokenCalls = () => e.fake.count(/^\/v2\/oauth\/token$/, 'POST')
    const calls = tokenCalls()
    expect((await e.get(SSO_CALLBACK_PATH, queryOf(back))).body).toContain('授权链接已失效')
    expect(tokenCalls()).toBe(calls)

    const rows = await e.app.database.get(AUTH_TABLE, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].refreshToken).toMatch(SEALED_PATTERN)

    const admin = await e.get(ADMIN_PAGE_PATH)
    expect(admin.body).toContain(e.fake.sso.characterName)
    expect(admin.body).toContain('3/3')

    const found = await e.get(ADMIN_SEARCH_PATH, { profile: 'default', q: '联盟市场', t: formToken(admin, ADMIN_SEARCH_PATH)! })
    expect(found.body).toContain('找到 1 个')
    expect(found.body).toContain(`<code>${STRUCTURE}</code>`)

    const confirm = await e.get(ADMIN_DELETE_PATH, { profile: 'default' })
    const removed = await e.get(ADMIN_DELETE_PATH, queryOf(linkTo(confirm, ADMIN_DELETE_PATH, { profile: 'default' })!))
    expect(removed.status).toBe(303)
    expect(await e.app.database.get(AUTH_TABLE, {})).toEqual([])

    const secrets = [e.fake.sso.clientSecret, code, state, ...issued, ...e.fake.accessTokens, ...e.fake.refreshTokens]
    const seen = [page, go, result, admin, found, confirm].map((r) => r.body).join('\n') + e.logger.lines.join('\n') + JSON.stringify(rows)
    for (const secret of secrets) expect(seen).not.toContain(secret)
  })
})
