// EVE 授权页面的处理函数（§7.4、§8.4、§10.1 web）：只接受本机、可选口令、一次性操作令牌、
// state 只能用一次、页面里没有 token、回调地址按 Host 算出并在不一致时标红、按名字搜建筑。

import { describe, expect, it } from 'vitest'
import {
  ADMIN_DELETE_PATH, ADMIN_PAGE_PATH, ADMIN_SEARCH_PATH, SSO_CALLBACK_PATH, SSO_START_PATH,
} from '../../src/constants'
import { AUTH_TEXT } from '../../src/core/sso'
import { SESSION_COOKIE, checkCallback, isLocalHost, isLoopback } from '../../src/web'
import { CoreRuntime } from '../../src/bot/commands'
import type { AuthCompletion } from '../../src/core/types'
import type { WebCoreHandle, WebResponse } from '../../src/web'

type AuthCompletionFailure = Extract<AuthCompletion, { ok: false }>
import { CALLBACK, MemoryLogger, SSO_URL, STRUCTURE_A, STRUCTURE_B, SYSTEM_ID, SYSTEM_NAME, profile, structureSource } from './fake-core'
import { formToken, linkTo, queryOf, setup } from './helpers'

/** 本机浏览器直接打开 */
const LOCAL = { remoteAddress: '127.0.0.1', host: '127.0.0.1:5140' } as const

const okProfile = () => profile({
  profile: 'default', status: 'OK', characterId: '2112000001', characterName: 'Test Pilot', scopesGranted: 3, tokenValid: true,
  lastRefreshAt: Date.UTC(2026, 9, 7, 6, 1), markets: ['联盟市场A'],
})

/** 走一遍「授权页面 → 开始授权」，返回跳到 EVE 登录页的地址 */
async function begin(env: ReturnType<typeof setup>, name = 'default'): Promise<URL> {
  const page = await env.get(ADMIN_PAGE_PATH)
  const start = linkTo(page, SSO_START_PATH, { profile: name })
  const res = start ? await env.get(SSO_START_PATH, { query: queryOf(start) }) : await env.get(SSO_START_PATH, { query: { profile: name, t: formToken(page, SSO_START_PATH)! } })
  expect(res.status).toBe(302)
  return new URL(res.headers.Location)
}

/** EVE 登录页跳回来 → 结果页（跟一次 303） */
async function callback(env: ReturnType<typeof setup>, query: Record<string, string>, remote = '127.0.0.1'): Promise<WebResponse> {
  const res = await env.get(SSO_CALLBACK_PATH, { query, remote })
  if (res.status !== 303) return res
  const next = new URL(res.headers.Location, 'http://127.0.0.1:5140')
  expect(next.pathname).toBe(SSO_CALLBACK_PATH)
  return env.get(SSO_CALLBACK_PATH, { query: queryOf(next), remote })
}

describe('wiring', () => {
  it('the plugin\'s CoreRuntime can be passed as the core handle', () => {
    const handle: WebCoreHandle = new CoreRuntime(new MemoryLogger())
    expect(typeof handle.ready).toBe('function')
  })
})

describe('only local requests', () => {
  it('accepts exactly 127.0.0.1, ::1 and ::ffff:127.0.0.1', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true)
    for (const a of [undefined, '', '10.0.0.5', '::ffff:10.0.0.5', '192.168.1.2', '127.0.0.2', '0.0.0.0', '::', 'localhost']) expect(isLoopback(a)).toBe(false)
  })

  it('the page itself opens for each loopback form', async () => {
    const env = setup()
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect((await env.get(ADMIN_PAGE_PATH, { remote })).status).toBe(200)
    for (const remote of ['::ffff:192.0.2.2', '127.0.0.2']) expect((await env.get(ADMIN_PAGE_PATH, { remote })).status).toBe(403)
  })

  it('refuses every admin route from another computer, before asking for the passphrase', async () => {
    const env = setup({ adminKey: 'pass-word-1' })
    for (const path of [ADMIN_PAGE_PATH, ADMIN_SEARCH_PATH, ADMIN_DELETE_PATH, SSO_START_PATH]) {
      const res = await env.get(path, { remote: '192.168.1.20', query: { key: 'pass-word-1', profile: 'default' } })
      expect(res.status).toBe(403)
      expect(res.body).toContain('只接受本机访问')
      expect(res.headers['Set-Cookie']).toBeUndefined()
    }
    expect(env.fc.auth.begun).toEqual([])
  })

  it('refuses anything that came through a reverse proxy or tunnel, even from 127.0.0.1 and with the passphrase', async () => {
    const env = setup({ adminKey: 'pass-word-1' })
    for (const path of [ADMIN_PAGE_PATH, ADMIN_SEARCH_PATH, ADMIN_DELETE_PATH, SSO_START_PATH]) {
      const res = await env.get(path, { forwarded: true, query: { key: 'pass-word-1', profile: 'default' } })
      expect(res.status).toBe(403)
      expect(res.body).toContain('只接受本机访问')
      expect(res.body).toContain('反向代理')
      expect(res.headers['Set-Cookie']).toBeUndefined()
    }
    const open = setup()
    open.fc.auth.list = [okProfile()]
    const res = await open.get(ADMIN_PAGE_PATH, { forwarded: true })
    expect(res.status).toBe(403)
    expect(res.body).not.toMatch(/name="t"|[?;]t=/)
  })

  it('refuses a foreign Host (DNS rebinding): no page, no tokens, nothing searched, deleted or started', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile()]
    env.fc.auth.hits = [{ id: STRUCTURE_A, name: 'XX-1 - 联盟市场A', systemId: SYSTEM_ID }]
    const page = await env.get(ADMIN_PAGE_PATH)
    const searchToken = formToken(page, ADMIN_SEARCH_PATH)!
    const startQuery = queryOf(linkTo(page, SSO_START_PATH, { profile: 'default' })!)
    const confirm = await env.get(ADMIN_DELETE_PATH, { query: { profile: 'default' } })
    const deleteQuery = queryOf(linkTo(confirm, ADMIN_DELETE_PATH, { profile: 'default' })!)
    for (const host of ['attacker.example:12345', 'attacker.example', '127.0.0.1.attacker.example:5140', 'localhost.attacker.example', undefined, 'a b']) {
      const o = { host, fetchSite: 'same-origin' } as const
      const admin = await env.handle({ path: ADMIN_PAGE_PATH, query: new URLSearchParams(), remoteAddress: '127.0.0.1', ...o })
      expect(admin.status).toBe(403)
      expect(admin.body).not.toMatch(/name="t"|[?;]t=/)
      expect(admin.body).not.toContain('Test Pilot')
      for (const [path, query] of [[ADMIN_SEARCH_PATH, { profile: 'default', q: '联盟市场', t: searchToken }], [ADMIN_DELETE_PATH, deleteQuery], [SSO_START_PATH, startQuery]] as const) {
        const res = await env.handle({ path, query: new URLSearchParams(query), remoteAddress: '127.0.0.1', ...o })
        expect(res.status).toBe(403)
        expect(res.body).not.toContain(STRUCTURE_A)
      }
    }
    expect(env.fc.auth.searches).toEqual([])
    expect(env.fc.auth.removed).toEqual([])
    expect(env.fc.auth.begun).toEqual([])
    // 令牌没有被用掉：从本机地址照常
    expect((await env.get(SSO_START_PATH, { query: startQuery })).status).toBe(302)
  })

  it('accepts 127.0.0.1, localhost and [::1] on any port (SSH tunnels), and the host name of the callback address', async () => {
    const env = setup({ callbackUrl: 'http://koishi.lan:5140/eve-market/sso/callback' })
    for (const host of ['127.0.0.1:5140', '127.0.0.1:12345', 'localhost:12345', 'LOCALHOST:8080', '[::1]:5140', '127.0.0.1', 'koishi.lan:5140']) {
      expect((await env.get(ADMIN_PAGE_PATH, { host })).status).toBe(200)
    }
    expect(isLocalHost('koishi.lan:9', 'not a url')).toBe(false)
    expect(isLocalHost('[::2]:5140', CALLBACK)).toBe(false)
    expect(isLocalHost('127.0.0.2:5140', CALLBACK)).toBe(false)
  })

  it('serves the callback to any address (EVE redirects the browser there; the state protects it)', async () => {
    const env = setup()
    const res = await env.get(SSO_CALLBACK_PATH, { remote: '203.0.113.9', host: 'market.example.com', forwarded: true, query: { code: 'c', state: 's' } })
    // 不认识的 state：直接回答，不存结果页、不写日志
    expect(res.status).toBe(400)
    expect(res.body).toContain('授权链接已失效')
    expect(env.logger.lines).toEqual([])
    const login = await begin(env)
    const ok = await callback(env, { code: 'c', state: login.searchParams.get('state')! }, '203.0.113.9')
    expect(ok.body).toContain('授权成功')
  })

  it('answers unknown paths with 404 and every page with no-store, no-referrer and a strict CSP', async () => {
    const env = setup()
    expect((await env.get('/eve-market/other')).status).toBe(404)
    const res = await env.get(ADMIN_PAGE_PATH)
    expect(res.status).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.headers['Referrer-Policy']).toBe('no-referrer')
    expect(res.headers['X-Frame-Options']).toBe('DENY')
    const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers['Content-Security-Policy'])![1]
    expect(res.headers['Content-Security-Policy']).toContain('default-src \'none\'')
    expect(res.body).toContain(`<script nonce="${nonce}">`)
    // 不引用任何外部资源
    expect(res.body).not.toMatch(/<link|<img|<iframe|src="|href="https?:/)
  })
})

describe('passphrase', () => {
  it('shows a form instead of the page, rejects a wrong one and remembers a right one in a cookie', async () => {
    const env = setup({ adminKey: 'pass-word-1' })
    const form = await env.get(ADMIN_PAGE_PATH)
    expect(form.status).toBe(200)
    expect(form.body).toContain('name="key"')
    expect(form.body).not.toContain('第 1 步')

    const wrong = await env.get(ADMIN_PAGE_PATH, { query: { key: 'pass-word-2' } })
    expect(wrong.status).toBe(403)
    expect(wrong.body).toContain('口令不对')

    const right = await env.get(ADMIN_PAGE_PATH, { query: { key: 'pass-word-1' } })
    expect(right.status).toBe(303)
    expect(right.headers.Location).toBe(ADMIN_PAGE_PATH)
    const cookie = right.headers['Set-Cookie']
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{40,}; Path=/eve-market; HttpOnly; SameSite=Strict; Max-Age=\\d+$`))
    expect(cookie).not.toContain('pass-word-1')

    const value = cookie.split(';')[0]
    const page = await env.get(ADMIN_PAGE_PATH, { cookie: `other=1; ${value}` })
    expect(page.body).toContain('第 1 步')
    expect(page.body).not.toContain('pass-word-1')
    expect((await env.get(ADMIN_PAGE_PATH, { cookie: `${SESSION_COOKIE}=forged` })).body).toContain('name="key"')
  })

  it('a session stops working when the passphrase is changed', async () => {
    const first = setup({ adminKey: 'pass-word-1' })
    const cookie = (await first.get(ADMIN_PAGE_PATH, { query: { key: 'pass-word-1' } })).headers['Set-Cookie'].split(';')[0]
    const changed = setup({ adminKey: 'pass-word-2' }, first.guard)
    expect((await changed.get(ADMIN_PAGE_PATH, { cookie })).body).toContain('name="key"')
    expect((await first.get(ADMIN_PAGE_PATH, { cookie })).body).toContain('第 1 步')
  })

  it('without a passphrase the page opens directly', async () => {
    const env = setup()
    const page = await env.get(ADMIN_PAGE_PATH)
    expect(page.body).toContain('第 1 步')
    expect(page.body).not.toContain('name="key"')
  })
})

describe('callback address', () => {
  it('is computed from the Host header; a different configured one is marked red', async () => {
    const env = setup({ callbackUrl: 'http://127.0.0.1:5140/eve-market/sso/callback' })
    const same = await env.get(ADMIN_PAGE_PATH, { host: '127.0.0.1:5140' })
    expect(same.body).toContain('<code>http://127.0.0.1:5140/eve-market/sso/callback</code>')
    expect(same.body).toContain('和控制台里填的回调地址一致')
    expect(same.body).not.toContain('box bad')

    // SSH 隧道：浏览器里是本地的另一个端口
    const tunnel = await env.get(ADMIN_PAGE_PATH, { host: '127.0.0.1:12345' })
    expect(tunnel.body).toContain('<code>http://127.0.0.1:12345/eve-market/sso/callback</code>')
    expect(tunnel.body).toMatch(/box bad">控制台里「EVE 授权 → 回调地址」现在写的是 <code>http:\/\/127\.0\.0\.1:5140\/eve-market\/sso\/callback<\/code>/)
    expect(tunnel.body).toContain('data-copy="http://127.0.0.1:12345/eve-market/sso/callback"')
  })

  it('an https callback on the same host and port is a warning, and the http line is the one to copy', async () => {
    const env = setup({ callbackUrl: 'https://127.0.0.1:12345/eve-market/sso/callback' })
    const page = await env.get(ADMIN_PAGE_PATH, { host: '127.0.0.1:12345' })
    expect(page.body).not.toContain('和控制台里填的回调地址一致')
    expect(page.body).toContain('box warn">控制台里「EVE 授权 → 回调地址」写的是 <code>https://127.0.0.1:12345/eve-market/sso/callback</code>，是 https 开头')
    expect(page.body).toContain('data-copy="http://127.0.0.1:12345/eve-market/sso/callback"')
    expect(page.body).not.toContain('data-copy="https://')
  })

  it('compares host and path, flags https, and copes with a missing or odd Host', () => {
    expect(checkCallback('localhost:5140', 'http://LOCALHOST:5140/eve-market/sso/callback').state).toBe('match')
    expect(checkCallback('127.0.0.1:5140', 'http://localhost:5140/eve-market/sso/callback').state).toBe('mismatch')
    expect(checkCallback('127.0.0.1:5140', 'http://127.0.0.1:5140/eve-market/sso/back').state).toBe('mismatch')
    expect(checkCallback('127.0.0.1:5140', 'not a url').state).toBe('mismatch')
    expect(checkCallback('market.example.com', 'https://market.example.com/eve-market/sso/callback'))
      .toEqual({ expected: 'http://market.example.com/eve-market/sso/callback', configured: 'https://market.example.com/eve-market/sso/callback', state: 'https' })
    expect(checkCallback('127.0.0.1:12345', 'https://127.0.0.1:12345/eve-market/sso/callback').state).toBe('https')
    expect(checkCallback('127.0.0.1:12345', 'https://127.0.0.1/eve-market/sso/callback').state).toBe('mismatch')
    expect(checkCallback('[::1]:5140', 'http://[::1]:5140/eve-market/sso/callback').state).toBe('match')
    for (const host of [undefined, '', 'a b', '<x>', 'h:99999', 'evil.com/x']) expect(checkCallback(host, CALLBACK).state).toBe('unknown')
  })

  it('tells the owner to fill in Client ID and Secret Key first, and hides the authorize buttons', async () => {
    const env = setup({ clientId: '', clientSecret: '' })
    env.fc.auth.list = [profile({ profile: 'default', markets: ['联盟市场A'] })]
    const page = await env.get(ADMIN_PAGE_PATH)
    expect(page.body).toContain('先把应用的 Client ID 和 Secret Key 填进 Koishi 控制台')
    expect(linkTo(page, SSO_START_PATH)).toBeUndefined()
    expect(formToken(page, SSO_START_PATH)).toBeUndefined()
    const res = await env.get(SSO_START_PATH, { query: { profile: 'default', t: 'x' } })
    expect(res.status).toBe(400)
    expect(env.fc.auth.begun).toEqual([])
    expect(page.body).not.toContain('test-client-secret')
  })
})

describe('admin page', () => {
  it('lists profiles, the markets using them and the structure markets with their sync state', async () => {
    const env = setup()
    env.fc.auth.list = [
      okProfile(),
      profile({ profile: 'logistics', status: 'AUTH_ERROR', characterName: 'Hauler', scopesGranted: 3, lastError: '刷新令牌失效', lastErrorAt: Date.UTC(2026, 9, 6, 13, 10) }),
    ]
    env.fc.sources = [
      structureSource({ marketKey: 'a', name: '联盟市场A', state: 'OK', lastSyncAt: Date.UTC(2026, 9, 7, 6, 16), pages: 3, orders: 2841 }),
      structureSource({ marketKey: 'b', name: '联盟市场B', state: 'AUTH_ERROR', authProfile: 'logistics', lastError: { status: 403, message: 'Market access denied' }, lastErrorAt: Date.UTC(2026, 9, 7, 5, 40) }),
      structureSource({ marketKey: 'c', name: '联盟市场C', state: 'FIRST_SYNC', paused: true }),
      structureSource({ marketKey: 'jita', name: 'Jita 4-4', type: 'npc-station', source: 'region' }),
    ]
    const page = await env.get(ADMIN_PAGE_PATH)
    const body = page.body
    expect(body).toContain('Test Pilot')
    expect(body).toContain('3/3')
    expect(body).toContain('联盟市场A')
    expect(body).toContain('需要重新授权')
    expect(body).toContain('最近的错误：刷新令牌失效')
    expect(body).toContain('3 页 2,841 单')
    expect(body).toContain('403 Market access denied')
    expect(body).toContain('正在第一次同步')
    expect(body).toContain('24 小时没人查')
    expect(body).not.toContain('Jita 4-4')
    // 每个档案一个「重新授权」（令牌绑定这个档案）、一个「删除」（先到确认页，不带令牌）
    expect(linkTo(page, SSO_START_PATH, { profile: 'default' })?.searchParams.get('t')).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(linkTo(page, SSO_START_PATH, { profile: 'logistics' })).toBeDefined()
    expect(linkTo(page, ADMIN_DELETE_PATH, { profile: 'logistics' })?.searchParams.has('t')).toBe(false)
    // 搜索只列状态正常的档案
    expect(body).toContain('<option value="default">default</option>')
    expect(body).not.toContain('<option value="logistics">')
  })

  it('escapes everything that comes from the game or the console', async () => {
    const env = setup({ callbackUrl: 'http://127.0.0.1:5140/eve-market/sso/callback?"><script>alert(1)</script>' })
    env.fc.auth.list = [profile({ profile: 'default', status: 'OK', characterName: '<script>alert(2)</script>', lastError: '<b>x</b>', markets: ['<i>A</i>'] })]
    env.fc.sources = [structureSource({ marketKey: 'x', name: '<img src=x onerror=alert(3)>', lastError: { message: '"><svg>' } })]
    const body = (await env.get(ADMIN_PAGE_PATH, { host: '127.0.0.1:5140' })).body
    expect(body).not.toMatch(/<script>alert|<img src=x|<svg>|<b>x<\/b>|<i>A<\/i>/)
    expect(body).toContain('&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(body).toContain('&lt;img src=x onerror=alert(3)&gt;')
    // 带查询参数的回调地址算不一致
    expect(body).toContain('box bad')
  })

  it('shows a short notice after a profile was deleted, but only for a sane profile name', async () => {
    const env = setup()
    expect((await env.get(ADMIN_PAGE_PATH, { query: { msg: 'deleted', profile: 'logistics' } })).body).toContain('已删除授权档案 logistics')
    expect((await env.get(ADMIN_PAGE_PATH, { query: { msg: 'deleted', profile: '<x>' } })).body).not.toContain('已删除')
  })

  it('says so when the plugin is still starting', async () => {
    const env = setup()
    env.fc.ready = false
    const res = await env.get(ADMIN_PAGE_PATH)
    expect(res.status).toBe(503)
    expect(res.body).toContain('插件还没准备好')
  })
})

describe('one-time action tokens', () => {
  it('authorize: a link without a valid token only shows a confirmation; a token works once, for its own profile', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile(), profile({ profile: 'logistics' })]
    const page = await env.get(ADMIN_PAGE_PATH)

    // 别的网页偷偷打开授权地址：只会看到确认页
    const forged = await env.get(SSO_START_PATH, { query: { profile: 'default' } })
    expect(forged.status).toBe(200)
    expect(forged.body).toContain('点下面的按钮跳到 EVE 登录页')
    expect(env.fc.auth.begun).toEqual([])

    // 绑定 logistics 的令牌不能拿来授权 default
    const logistics = linkTo(page, SSO_START_PATH, { profile: 'logistics' })!
    const swapped = await env.get(SSO_START_PATH, { query: { profile: 'default', t: logistics.searchParams.get('t')! } })
    expect(swapped.body).toContain('已经过期或用过了')
    expect(env.fc.auth.begun).toEqual([])

    const link = linkTo(page, SSO_START_PATH, { profile: 'default' })!
    const go = await env.get(SSO_START_PATH, { query: queryOf(link) })
    expect(go.status).toBe(302)
    expect(go.headers.Location.startsWith(SSO_URL)).toBe(true)
    expect(env.fc.auth.begun).toEqual(['default'])

    const again = await env.get(SSO_START_PATH, { query: queryOf(link) })
    expect(again.status).toBe(200)
    expect(again.body).toContain('已经过期或用过了')
    expect(env.fc.auth.begun).toEqual(['default'])

    // 确认页上的按钮能用
    const confirm = linkTo(again, SSO_START_PATH, { profile: 'default' })!
    expect((await env.get(SSO_START_PATH, { query: queryOf(confirm) })).status).toBe(302)
  })

  it('the new-profile form token works for any name and an empty name means default; bad names are refused', async () => {
    const env = setup()
    const page = await env.get(ADMIN_PAGE_PATH)
    expect(page.body).toContain('name="profile" value="default"')
    const token = formToken(page, SSO_START_PATH)!
    expect((await env.get(SSO_START_PATH, { query: { profile: '', t: token } })).status).toBe(302)
    expect(env.fc.auth.begun).toEqual(['default'])

    const page2 = await env.get(ADMIN_PAGE_PATH)
    const bad = await env.get(SSO_START_PATH, { query: { profile: '../x', t: formToken(page2, SSO_START_PATH)! } })
    expect(bad.status).toBe(400)
    // 和控制台的说法一样（汉字也可以）
    expect(bad.body).toContain('档案名只能用文字、数字、- 和 _（最多 32 个字）')
    expect((await env.get(SSO_START_PATH, { query: { profile: 'x'.repeat(33), t: formToken(page2, SSO_START_PATH)! } })).status).toBe(400)
    expect((await env.get(SSO_START_PATH, { query: { profile: '采矿', t: formToken(page2, SSO_START_PATH)! } })).status).toBe(302)
    expect(env.fc.auth.begun).toEqual(['default', '采矿'])
  })

  it('tokens expire after 30 minutes', async () => {
    const env = setup()
    const token = formToken(await env.get(ADMIN_PAGE_PATH), SSO_START_PATH)!
    env.clock.advance(31 * 60_000)
    expect((await env.get(SSO_START_PATH, { query: { profile: 'default', t: token } })).body).toContain('已经过期或用过了')
    expect(env.fc.auth.begun).toEqual([])
  })

  it('delete: asks first, deletes once with the token from the confirmation page, then returns to the admin page', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile()]
    const page = await env.get(ADMIN_PAGE_PATH)
    const confirm = await env.get(ADMIN_DELETE_PATH, { query: queryOf(linkTo(page, ADMIN_DELETE_PATH, { profile: 'default' })!) })
    expect(confirm.body).toContain('确定要删除授权档案')
    expect(env.fc.auth.removed).toEqual([])

    const yes = linkTo(confirm, ADMIN_DELETE_PATH, { profile: 'default' })!
    const done = await env.get(ADMIN_DELETE_PATH, { query: queryOf(yes) })
    expect(done.status).toBe(303)
    expect(done.headers.Location).toBe(`${ADMIN_PAGE_PATH}?msg=deleted&profile=default`)
    expect(env.fc.auth.removed).toEqual(['default'])
    // 删除的日志由 core 写，页面这一层不重复
    expect(env.logger.lines.join('\n')).not.toContain('已删除')

    const replay = await env.get(ADMIN_DELETE_PATH, { query: queryOf(yes) })
    expect(replay.status).toBe(200)
    expect(replay.body).toContain('已经过期或用过了')
    expect(env.fc.auth.removed).toEqual(['default'])

    // 删除令牌不能拿去删别的档案
    const other = linkTo(await env.get(ADMIN_DELETE_PATH, { query: { profile: 'default' } }), ADMIN_DELETE_PATH, { profile: 'default' })!
    await env.get(ADMIN_DELETE_PATH, { query: { profile: 'logistics', t: other.searchParams.get('t')! } })
    expect(env.fc.auth.removed).toEqual(['default'])
  })

  it('requests started by another site or by prefetching never act and leave the token unused', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile()]
    const page = await env.get(ADMIN_PAGE_PATH)
    const link = linkTo(page, SSO_START_PATH, { profile: 'default' })!
    const query = queryOf(link)
    const crossSite = await env.handle({ path: SSO_START_PATH, query: new URLSearchParams(query), ...LOCAL, fetchSite: 'cross-site' })
    expect(crossSite.status).toBe(200)
    expect(crossSite.body).toContain('点下面的按钮跳到 EVE 登录页')
    for (const purpose of ['prefetch', 'prefetch;prerender']) {
      const prefetch = await env.handle({ path: SSO_START_PATH, query: new URLSearchParams(query), ...LOCAL, fetchSite: 'same-origin', purpose })
      expect(prefetch.status).toBe(200)
    }
    expect(env.fc.auth.begun).toEqual([])
    // 令牌还在：从本站页面点击照常
    const click = await env.handle({ path: SSO_START_PATH, query: new URLSearchParams(query), ...LOCAL, fetchSite: 'same-origin' })
    expect(click.status).toBe(302)

    const confirm = await env.get(ADMIN_DELETE_PATH, { query: { profile: 'default' } })
    const yes = queryOf(linkTo(confirm, ADMIN_DELETE_PATH, { profile: 'default' })!)
    await env.handle({ path: ADMIN_DELETE_PATH, query: new URLSearchParams(yes), ...LOCAL, fetchSite: 'same-site' })
    await env.handle({ path: ADMIN_DELETE_PATH, query: new URLSearchParams(yes), ...LOCAL, purpose: 'prefetch' })
    expect(env.fc.auth.removed).toEqual([])
    await env.handle({ path: ADMIN_DELETE_PATH, query: new URLSearchParams(yes), ...LOCAL, fetchSite: 'none' })
    expect(env.fc.auth.removed).toEqual(['default'])
  })

  it('HEAD requests (koa routes GET handlers for HEAD too) never act', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile()]
    const query = queryOf(linkTo(await env.get(ADMIN_PAGE_PATH), SSO_START_PATH, { profile: 'default' })!)
    const head = await env.handle({ method: 'HEAD', path: SSO_START_PATH, query: new URLSearchParams(query), ...LOCAL })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(env.fc.auth.begun).toEqual([])
    const state = (await begin(env)).searchParams.get('state')!
    await env.handle({ method: 'HEAD', path: SSO_CALLBACK_PATH, query: new URLSearchParams({ code: 'c', state }), ...LOCAL })
    expect(env.fc.auth.completed).toEqual([])
    expect((await env.handle({ method: 'GET', path: SSO_START_PATH, query: new URLSearchParams(query), ...LOCAL })).status).toBe(302)
  })

  it('a start token cannot be used to delete or search', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile()]
    const t = linkTo(await env.get(ADMIN_PAGE_PATH), SSO_START_PATH, { profile: 'default' })!.searchParams.get('t')!
    await env.get(ADMIN_DELETE_PATH, { query: { profile: 'default', t } })
    expect(env.fc.auth.removed).toEqual([])
  })
})

describe('search structures by name', () => {
  it('needs the page token, at least 3 characters, and lists name, system and ID with the row for the markets table', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile()]
    env.fc.auth.hits = [
      { id: STRUCTURE_A, name: 'XX-1 - 联盟市场A', systemId: SYSTEM_ID },
      { id: STRUCTURE_B, name: 'XX-1 - <仓库>', systemId: null },
    ]
    const page = await env.get(ADMIN_PAGE_PATH)

    const forged = await env.get(ADMIN_SEARCH_PATH, { query: { profile: 'default', q: '联盟市场' } })
    expect(forged.body).toContain('刚才的页面已经过期')
    expect(env.fc.auth.searches).toEqual([])

    const short = await env.get(ADMIN_SEARCH_PATH, { query: { profile: 'default', q: '联盟', t: formToken(page, ADMIN_SEARCH_PATH)! } })
    expect(short.body).toContain('至少输入 3 个字')
    expect(env.fc.auth.searches).toEqual([])

    const res = await env.get(ADMIN_SEARCH_PATH, { query: { profile: 'default', q: '联盟市场', t: formToken(short, ADMIN_SEARCH_PATH)! } })
    expect(env.fc.auth.searches).toEqual([{ profile: 'default', text: '联盟市场' }])
    expect(res.body).toContain('找到 2 个')
    expect(res.body).toContain(`<code>${STRUCTURE_A}</code>`)
    expect(res.body).toContain(`data-copy="${STRUCTURE_A}"`)
    expect(res.body).toContain(`<td>${SYSTEM_NAME}</td>`)
    expect(res.body).toContain(`位置「<code>${STRUCTURE_A}</code>」· 建筑所在星系「${SYSTEM_NAME}」· 授权档案「default」`)
    expect(res.body).toContain('XX-1 - &lt;仓库&gt;')
    // 星系不知道时：照抄的那一行写「留空」，不写「—」
    expect(res.body).toContain(`位置「<code>${STRUCTURE_B}</code>」· 建筑所在星系留空（插件会自己查）`)
    expect(res.body).not.toContain('建筑所在星系「—」')

    // 结果页上的表单带着新的令牌，可以接着搜；旧令牌不能再用
    const again = await env.get(ADMIN_SEARCH_PATH, { query: { profile: 'default', q: '联盟市场', t: formToken(short, ADMIN_SEARCH_PATH)! } })
    expect(again.body).toContain('刚才的页面已经过期')
    await env.get(ADMIN_SEARCH_PATH, { query: { profile: 'default', q: '仓库仓库', t: formToken(res, ADMIN_SEARCH_PATH)! } })
    expect(env.fc.auth.searches).toHaveLength(2)
  })

  it('a structure the character can find but not read: no row to copy, a hint to use another character', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile()]
    env.fc.auth.hits = [{ id: '1000000000301', name: '', systemId: null }, { id: STRUCTURE_A, name: 'XX-1 - 联盟市场A', systemId: 30_009_999 }]
    const page = await env.get(ADMIN_PAGE_PATH)
    const res = await env.get(ADMIN_SEARCH_PATH, { query: { profile: 'default', q: '联盟市场', t: formToken(page, ADMIN_SEARCH_PATH)! } })
    expect(res.body).toContain('<code>1000000000301</code>')
    expect(res.body).toContain('看不到它的名字和星系：多半不能停靠')
    expect(res.body).toContain('换一个能停靠它的角色授权')
    expect(res.body).not.toContain('名称「」')
    expect(res.body).not.toContain('位置「<code>1000000000301</code>」')
    // 数据里没有的星系 ID 不拿来照抄
    expect(res.body).toContain(`位置「<code>${STRUCTURE_A}</code>」· 建筑所在星系留空（插件会自己查）`)
    expect(res.body).not.toContain('30009999')
  })

  it('shows the reason from the core as it is: a missing search permission, a refused search route, a token problem', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile()]
    let page = await env.get(ADMIN_PAGE_PATH)
    const search = async () => {
      const res = await env.get(ADMIN_SEARCH_PATH, { query: { profile: 'default', q: '联盟市场', t: formToken(page, ADMIN_SEARCH_PATH)! } })
      page = res
      return res.body
    }
    env.fc.auth.hits = { ok: false, code: 'NOT_CONFIGURED', message: AUTH_TEXT.noSearchScope }
    let body = await search()
    expect(body).toContain(`用档案 default 搜索没有成功：${AUTH_TEXT.noSearchScope}。`)
    expect(body).not.toContain('还没有授权')
    env.fc.auth.hits = { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: AUTH_TEXT.searchRejected('HTTP 404') }
    body = await search()
    expect(body).toContain('EVE 的搜索接口拒绝了请求（HTTP 404）')
    expect(body).toContain('游戏里的建筑链接')
    expect(body).not.toContain('暂时连不上')
    env.fc.auth.hits = { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: AUTH_TEXT.invalidGrant }
    body = await search()
    expect(body).toContain(AUTH_TEXT.invalidGrant)
    expect(body).not.toContain('暂时连不上')
  })

  it('reports nothing found and failures from the core without leaking secrets', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile()]
    env.fc.auth.hits = []
    let page = await env.get(ADMIN_SEARCH_PATH)
    const empty = await env.get(ADMIN_SEARCH_PATH, { query: { profile: 'default', q: '不存在的', t: formToken(page, ADMIN_SEARCH_PATH)! } })
    expect(empty.body).toContain('没有找到')

    env.fc.auth.hits = { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: `${AUTH_TEXT.searchFailed('HTTP 502')} Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl` }
    page = empty
    const failed = await env.get(ADMIN_SEARCH_PATH, { query: { profile: 'default', q: '联盟市场', t: formToken(page, ADMIN_SEARCH_PATH)! } })
    expect(failed.body).toContain('暂时连不上 EVE 的搜索接口（HTTP 502），请稍后再试')
    expect(failed.body).not.toContain('eyJhbGci')
  })

  it('without an authorized profile there is no search form', async () => {
    const env = setup()
    env.fc.auth.list = [profile({ profile: 'default' })]
    expect((await env.get(ADMIN_PAGE_PATH)).body).toContain('完成第 2 步的授权以后才能搜索')
  })
})

describe('SSO callback', () => {
  it('state works once: the result page lists the structures and never shows code, state or tokens', async () => {
    const env = setup()
    env.fc.auth.list = [okProfile()]
    const login = await begin(env)
    const state = login.searchParams.get('state')!
    const code = 'code-0123456789abcdef'

    const result = await callback(env, { code, state })
    expect(result.status).toBe(200)
    expect(result.body).toContain('授权成功')
    expect(result.body).toContain('已经授权给角色「Test Pilot」')
    expect(result.body).toContain('XX-1 - 联盟市场A')
    expect(result.body).toContain(SYSTEM_NAME)
    expect(result.body).toContain('可以访问')
    expect(result.body).toContain('没有权限（403）')
    expect(result.body).not.toContain(code)
    expect(result.body).not.toContain(state)
    expect(env.fc.auth.completed).toEqual([{ code, state }])
    // 授权成功的日志由 core 写，页面这一层不重复
    expect(env.logger.lines.join('\n')).not.toContain('已授权')
    expect(env.logger.lines.join('\n')).not.toContain(state)
    expect(env.logger.lines.join('\n')).not.toContain(code)

    // 同一个 state 再来一次：不会再去换 token
    const replay = await callback(env, { code, state })
    expect(replay.body).toContain('授权链接已失效')
    expect(env.fc.auth.completed).toHaveLength(1)
  })

  it('refreshing the result page shows the same result; it expires after 10 minutes', async () => {
    const env = setup()
    const login = await begin(env)
    const first = await env.get(SSO_CALLBACK_PATH, { query: { code: 'code-1', state: login.searchParams.get('state')! } })
    const resultUrl = new URL(first.headers.Location, 'http://127.0.0.1:5140')
    expect([...resultUrl.searchParams.keys()]).toEqual(['r'])
    for (let i = 0; i < 2; i++) expect((await env.get(SSO_CALLBACK_PATH, { query: queryOf(resultUrl) })).body).toContain('授权成功')
    env.clock.advance(11 * 60_000)
    expect((await env.get(SSO_CALLBACK_PATH, { query: queryOf(resultUrl) })).status).toBe(404)
    expect(env.fc.auth.completed).toHaveLength(1)
  })

  it('unknown and expired states never reach the token exchange', async () => {
    const env = setup()
    expect((await callback(env, { code: 'code-1', state: 'made-up-state' })).body).toContain('授权链接已失效')
    const login = await begin(env)
    env.clock.advance(11 * 60_000)
    expect((await callback(env, { code: 'code-1', state: login.searchParams.get('state')! })).body).toContain('授权链接已失效')
    expect(env.fc.auth.completed).toEqual([])
  })

  it('keeps at most 5 pending states', async () => {
    const env = setup()
    const states: string[] = []
    for (let i = 0; i < 6; i++) states.push((await begin(env)).searchParams.get('state')!)
    expect((await callback(env, { code: 'c', state: states[0] })).body).toContain('授权链接已失效')
    expect((await callback(env, { code: 'c', state: states[5] })).body).toContain('授权成功')
  })

  it('the login page being cancelled uses up the state', async () => {
    const env = setup()
    const state = (await begin(env)).searchParams.get('state')!
    const res = await env.get(SSO_CALLBACK_PATH, { query: { error: 'access_denied', state } })
    expect(res.status).toBe(400)
    expect(res.body).toContain('授权被取消')
    expect((await callback(env, { code: 'c', state })).body).toContain('授权链接已失效')
    expect(env.fc.auth.completed).toEqual([])
  })

  it('missing parameters are refused', async () => {
    const env = setup()
    expect((await env.get(SSO_CALLBACK_PATH, { query: { code: 'c' } })).status).toBe(400)
    expect((await env.get(SSO_CALLBACK_PATH)).status).toBe(400)
  })

  it('a failed exchange explains what to check; secrets in the message never reach the page or the log', async () => {
    const env = setup()
    const secret = 'rt-0123456789abcdef0123'
    env.fc.auth.completion = () => ({
      ok: false,
      reason: 'exchange_failed',
      message: `invalid_client refresh_token=${secret} Authorization: Basic dGVzdC1jbGllbnQtaWQ6dGVzdC1jbGllbnQtc2VjcmV0`,
    })
    const state = (await begin(env)).searchParams.get('state')!
    const page = await callback(env, { code: 'code-1', state })
    expect(page.body).toContain('授权没有完成')
    expect(page.body).toContain('Client ID、Secret Key 和回调地址')
    const everything = `${page.body}\n${env.logger.lines.join('\n')}`
    expect(everything).not.toContain(secret)
    expect(everything).not.toContain('dGVzdC1jbGllbnQtaWQ6dGVzdC1jbGllbnQtc2VjcmV0')
    expect(everything).not.toContain('test-client-secret')
    expect(env.logger.lines.some((l) => l.includes('exchange_failed'))).toBe(true)
  })

  it('missing scopes give one instruction: tick the missing permission on the developer website', async () => {
    const env = setup()
    const message = AUTH_TEXT.missingScopes(['esi-markets.structure_markets.v1'])
    env.fc.auth.completion = () => ({ ok: false, reason: 'missing_scopes', message })
    const page = await callback(env, { code: 'code-1', state: (await begin(env)).searchParams.get('state')! })
    expect(page.body).toContain(`${message}。`)
    expect(page.body).toContain('EVE 开发者网站编辑应用')
    expect(page.body).not.toContain('三项')
    expect(page.body).not.toContain('登录页')
  })

  it('an expired or reused code, a network problem and a failed save do not send the owner to check the app settings', async () => {
    const env = setup()
    const cases: Array<[AuthCompletionFailure, string]> = [
      [{ ok: false, reason: 'code_rejected', message: AUTH_TEXT.codeRejected }, '授权码已经失效（超过有效期或用过了）。'],
      [{ ok: false, reason: 'code_rejected', message: AUTH_TEXT.badCode }, '回调里没有有效的授权码。'],
      [{ ok: false, reason: 'unavailable', message: AUTH_TEXT.exchangeUnavailable('HTTP 503') }, '暂时连不上 EVE 登录服务器（HTTP 503）。'],
      [{ ok: false, reason: 'save_failed', message: AUTH_TEXT.saveFailed }, `${AUTH_TEXT.saveFailed}。`],
      [{ ok: false, reason: 'not_configured', message: AUTH_TEXT.secretUnavailable }, `${AUTH_TEXT.secretUnavailable}。`],
    ]
    for (const [failure, text] of cases) {
      env.fc.auth.completion = () => failure
      const page = await callback(env, { code: 'code-1', state: (await begin(env)).searchParams.get('state')! })
      expect(page.body).toContain(text)
      expect(page.body).toContain('回到授权页面，重新点「授权」再试一次')
      expect(page.body).not.toContain('Client ID、Secret Key 和回调地址')
      expect(page.body).not.toContain('还没有填 Client ID')
    }
  })

  it('a core error while starting is shown without crashing', async () => {
    const env = setup()
    env.fc.auth.beginError = new Error('client_secret=abcdef123456 不可用')
    const page = await env.get(ADMIN_PAGE_PATH)
    const res = await env.get(SSO_START_PATH, { query: { profile: '', t: formToken(page, SSO_START_PATH)! } })
    expect(res.status).toBe(500)
    expect(res.body).toContain('还不能授权')
    expect(res.body).not.toContain('abcdef123456')
  })
})
