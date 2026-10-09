// EVE 授权页面挂在真实的 Koishi server 服务上（@koishijs/plugin-server，koa 路由），经真实的 HTTP 访问：
// 对端地址取 socket（双栈监听时本机是 ::ffff:127.0.0.1）；带转发头（经反向代理、内网穿透）的、
// Host 不是本机写法的（DNS 重绑定）一律拒绝，转发头的值从不拿来放行；插件停用后路由撤掉。

import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import { Context } from 'koishi'
import { afterEach, describe, expect, it } from 'vitest'
import { ADMIN_DELETE_PATH, ADMIN_PAGE_PATH, ADMIN_SEARCH_PATH, SSO_CALLBACK_PATH, SSO_START_PATH } from '../../src/constants'
import { createModuleStore } from '../../src/core/ports'
import { installWebRoutes } from '../../src/web'
import { MemoryLogger, SSO_URL, fakeCore, profile, settingsWith } from './fake-core'
import type { FakeCore } from './fake-core'
import { ManualClock } from './helpers'

// koishi 走 CommonJS 入口，server 插件也用 CommonJS，保证是同一份 cordis
const require = createRequire(__filename)
const serverModule = require('@koishijs/plugin-server') as { default?: unknown; Server?: unknown }
const Server = (serverModule.default ?? serverModule.Server ?? serverModule) as never

async function canListen(host: string): Promise<boolean> {
  const probe = net.createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, host, resolve)
    })
    return true
  } catch {
    return false
  } finally {
    probe.close()
  }
}

async function freePort(host: string): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, host, resolve))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function waitListening(port: number) {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.end()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
    })
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('server did not start')
}

/** 这台机器的一个非本机 IPv4 地址（没有就跳过相关用例） */
function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return undefined
}

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function get(host: string, port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
  })
}

interface Env {
  app: Context
  port: number
  fc: FakeCore
  /** 测试用的附加路由记下的对端地址 */
  seen: string[]
  dispose(): void
  stop(): Promise<void>
}

let current: Env | undefined

afterEach(async () => {
  await current?.stop()
  current = undefined
})

async function start(listenHost: string, sso: Record<string, string> = {}): Promise<Env> {
  const port = await freePort(listenHost)
  const app = new Context()
  const server = app.plugin(Server, { host: listenHost, port })
  const fc = fakeCore()
  const seen: string[] = []
  const settings = settingsWith(sso)
  const fork = app.plugin({
    name: 'eve-market-web-test',
    inject: ['server'],
    apply(ctx: Context) {
      expect(installWebRoutes(ctx, fc.handle, settings, { store: createModuleStore(), logger: new MemoryLogger(), clock: new ManualClock(), readyWaitMs: 50 })).toBe(true)
      const router = (ctx as unknown as { server: { get(path: string, fn: (koa: { req: http.IncomingMessage; body: unknown }) => void): void } }).server
      router.get('/eve-market-test/remote', (koa) => {
        seen.push(String(koa.req.socket.remoteAddress))
        koa.body = 'ok'
      })
    },
  })
  await app.start()
  await waitListening(port)
  current = {
    app,
    port,
    fc,
    seen,
    dispose: () => fork.dispose(),
    // 先停 server（它停用时要写日志，日志服务比它先撤掉会报错）
    async stop() {
      server.dispose()
      await app.stop()
    },
  }
  return current
}

describe('admin routes on the Koishi server', () => {
  it('serves 127.0.0.1 with the security headers', async () => {
    const env = await start('127.0.0.1')
    const res = await get('127.0.0.1', env.port, ADMIN_PAGE_PATH, { Host: `127.0.0.1:${env.port}` })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['content-security-policy']).toContain('frame-ancestors \'none\'')
    expect(res.body).toContain(`<code>http://127.0.0.1:${env.port}/eve-market/sso/callback</code>`)
    // 控制台里填的是默认的 5140，浏览器用的是另一个端口：标红
    expect(res.body).toContain('box bad')
  })

  it('refuses a request from 127.0.0.1 that carries any forwarding header (a reverse proxy or tunnel on the same machine)', async () => {
    const env = await start('127.0.0.1')
    env.fc.auth.list = [profile({ profile: 'default', status: 'OK', characterName: 'Test Pilot' })]
    const proxied: Array<Record<string, string>> = [
      { 'X-Forwarded-For': '203.0.113.50' },
      { 'X-Forwarded-For': '127.0.0.1' },
      { Forwarded: 'for=203.0.113.50;proto=https' },
      { 'X-Real-IP': '127.0.0.1' },
      { 'X-Forwarded-Host': `127.0.0.1:${env.port}` },
      { 'X-Forwarded-Proto': 'https' },
      { Via: '1.1 proxy' },
      { 'CF-Connecting-IP': '203.0.113.50' },
      { 'True-Client-IP': '203.0.113.50' },
    ]
    for (const headers of proxied) {
      for (const path of [ADMIN_PAGE_PATH, `${SSO_START_PATH}?profile=default`, `${ADMIN_DELETE_PATH}?profile=default`, `${ADMIN_SEARCH_PATH}?q=abc`]) {
        const res = await get('127.0.0.1', env.port, path, headers)
        expect(res.status).toBe(403)
        expect(res.body).toContain('只接受本机访问')
        expect(res.body).not.toMatch(/name="t"|[?;]t=/)
        expect(res.body).not.toContain('Test Pilot')
      }
    }
    // 回调照常（EVE 经反向代理跳回来也行；state 保护它）
    const callback = await get('127.0.0.1', env.port, `${SSO_CALLBACK_PATH}?code=c&state=s`, { 'X-Forwarded-For': '203.0.113.50' })
    expect(callback.status).toBe(400)
    expect(callback.body).toContain('授权链接已失效')
    expect(env.fc.auth.begun).toEqual([])
    expect(env.fc.auth.removed).toEqual([])
    expect(env.fc.auth.searches).toEqual([])
  })

  it('refuses a foreign Host over real HTTP (DNS rebinding) but accepts the tunnel forms', async () => {
    const env = await start('127.0.0.1')
    for (const host of [`attacker.example:${env.port}`, 'bot.example.com']) {
      const res = await get('127.0.0.1', env.port, ADMIN_PAGE_PATH, { Host: host })
      expect(res.status).toBe(403)
      expect(res.body).not.toMatch(/name="t"/)
    }
    for (const host of [`127.0.0.1:${env.port}`, 'localhost:12345', '127.0.0.1:12345', '[::1]:12345']) {
      expect((await get('127.0.0.1', env.port, ADMIN_PAGE_PATH, { Host: host })).status).toBe(200)
    }
  })

  it.skipIf(!lanAddress())('refuses another address even when X-Forwarded-For claims 127.0.0.1', async () => {
    const env = await start('0.0.0.0')
    const res = await get(lanAddress()!, env.port, ADMIN_PAGE_PATH, { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' })
    expect(res.status).toBe(403)
    expect(res.body).toContain('只接受本机访问')
    // 回调不限制来源（state 保护它）
    const callback = await get(lanAddress()!, env.port, `${SSO_CALLBACK_PATH}?code=c&state=s`)
    expect(callback.status).toBe(400)
    expect(callback.body).toContain('授权链接已失效')
  })

  it('a dual-stack listener sees the local browser as ::ffff:127.0.0.1 and accepts it', async (t) => {
    if (!await canListen('::')) return t.skip()
    const env = await start('::')
    await get('127.0.0.1', env.port, '/eve-market-test/remote')
    expect(env.seen).toEqual(['::ffff:127.0.0.1'])
    expect((await get('127.0.0.1', env.port, ADMIN_PAGE_PATH)).status).toBe(200)
    expect((await get('::1', env.port, ADMIN_PAGE_PATH)).status).toBe(200)
  })

  it('passphrase cookie, authorize redirect and callback work over HTTP', async () => {
    const env = await start('127.0.0.1', { adminKey: 'pass-word-1' })
    env.fc.auth.list = []
    expect((await get('127.0.0.1', env.port, ADMIN_PAGE_PATH)).body).toContain('name="key"')
    const login = await get('127.0.0.1', env.port, `${ADMIN_PAGE_PATH}?key=pass-word-1`)
    expect(login.status).toBe(303)
    const cookie = String(login.headers['set-cookie']?.[0]).split(';')[0]
    const page = await get('127.0.0.1', env.port, ADMIN_PAGE_PATH, { Cookie: cookie })
    const token = /action="\/eve-market\/sso\/start"[\s\S]*?name="t" value="([^"]+)"/.exec(page.body)![1]

    // 别的网站发起的跳转：只给确认页，令牌不动
    const crossSite = await get('127.0.0.1', env.port, `${SSO_START_PATH}?profile=default&t=${token}`, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' })
    expect(crossSite.status).toBe(200)
    const go = await get('127.0.0.1', env.port, `${SSO_START_PATH}?profile=default&t=${token}`, { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' })
    expect(go.status).toBe(302)
    const location = new URL(String(go.headers.location))
    expect(`${location.origin}${location.pathname}`).toBe(SSO_URL)

    const back = await get('127.0.0.1', env.port, `${SSO_CALLBACK_PATH}?code=code-1&state=${location.searchParams.get('state')}`)
    expect(back.status).toBe(303)
    const result = await get('127.0.0.1', env.port, String(back.headers.location))
    expect(result.status).toBe(200)
    expect(result.body).toContain('授权成功')
  })

  it('a HEAD request through koa does not use the token', async () => {
    const env = await start('127.0.0.1')
    const page = await get('127.0.0.1', env.port, ADMIN_PAGE_PATH)
    const token = /action="\/eve-market\/sso\/start"[\s\S]*?name="t" value="([^"]+)"/.exec(page.body)![1]
    const head = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: env.port, method: 'HEAD', path: `${SSO_START_PATH}?profile=default&t=${token}` }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(head).toBe(200)
    expect(env.fc.auth.begun).toEqual([])
    expect((await get('127.0.0.1', env.port, `${SSO_START_PATH}?profile=default&t=${token}`)).status).toBe(302)
  })

  it('removes the routes when the plugin is disposed', async () => {
    const env = await start('127.0.0.1')
    expect((await get('127.0.0.1', env.port, ADMIN_PAGE_PATH)).status).toBe(200)
    env.dispose()
    expect((await get('127.0.0.1', env.port, ADMIN_PAGE_PATH)).status).toBe(404)
  })
})

describe('without the server service', () => {
  it('installWebRoutes does nothing', () => {
    const fc = fakeCore()
    expect(installWebRoutes(new Context(), fc.handle, settingsWith(), { store: createModuleStore(), logger: new MemoryLogger() })).toBe(false)
  })
})
