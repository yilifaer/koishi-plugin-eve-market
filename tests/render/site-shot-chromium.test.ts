// 网站截图器的网络守卫，用真实的 Chromium 和本机 HTTP 服务测（没有 CHROME_PATH 时跳过）。
// 网站在这里访问不了：页面接口外面包一层，把 https://kb.example.com 换成本机服务的地址。
// 守卫放行本次 goto 的第一个主框架请求（本机服务），所以用例里的页面本身能打开；页面里的子资源和之后的跳转照常检查。

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'puppeteer-core'
import type { Logger } from '../../src/core/ports'
import type { ShotProfile } from '../../src/core/sites'
import { createRenderer, puppeteerPages } from '../../src/render/renderer'
import type { PageFactory } from '../../src/render/renderer'
import { SiteScreenshotter } from '../../src/render/site-shot'
import type { ShotTarget } from '../../src/render/site-shot'

const CHROME = process.env.CHROME_PATH
const HAS_CHROME = !!CHROME && fs.existsSync(CHROME)

const PROFILE: ShotProfile = { viewportWidth: 800, viewportHeight: 600, idleMs: 3000, settleMs: 600, maxImages: 1 }
const target = (path: string, profile: Partial<ShotProfile> = {}): ShotTarget => ({
  url: `https://kb.example.com${path}`,
  siteId: 'custom-1',
  siteName: '测试站',
  profile: { ...PROFILE, ...profile },
  allowHosts: ['kb.example.com'],
})

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const BODY = '<div style="height:500px;background:#08f">内容</div>'

describe.skipIf(!HAS_CHROME)('SiteScreenshotter net guard with Chromium and local pages', () => {
  let browser: Browser
  let server: http.Server
  let origin = ''
  let port = 0
  const opened: Page[] = []
  /** 本机服务收到的路径 */
  const hits: string[] = []

  // 走生产的 puppeteerPages（含 onPopup 适配），只把 goto 的地址换成本机
  const source: PageFactory = async () => {
    const pages = puppeteerPages(() => ({
      browser: {
        createBrowserContext: async () => {
          const context = await browser.createBrowserContext()
          return {
            newPage: async () => {
              const page = await context.newPage()
              opened.push(page)
              return page
            },
            close: () => context.close(),
          }
        },
      },
      page: async () => browser.newPage(),
    }))
    const page = await pages()!()
    const goto = page.goto.bind(page)
    page.goto = (url, options) => goto(url.replace(/^https:\/\/kb\.example\.com/, origin), options)
    return page
  }

  const shooter = () => new SiteScreenshotter({ renderer: createRenderer({ pages: () => source }), logger: quiet, settlePollMs: 100 })

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      hits.push(path)
      const html = (body: string, title = '测试页') => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0">${body}</body></html>`)
      }
      if (path === '/redirect') {
        res.writeHead(302, { Location: 'https://example.invalid/' })
        return res.end()
      }
      if (path === '/challenge') return html(BODY, 'Just a moment...')
      if (path === '/private-image') return html(`${BODY}<img src="http://127.0.0.1:${port}/x.png" width="10" height="10">`)
      if (path === '/script-redirect') return html(`${BODY}<script>setTimeout(function () { location.href = 'https://example.invalid/' }, 50)</script>`)
      if (path === '/popup') return html(`${BODY}<script>window.open('http://127.0.0.1:${port}/popped')</script>`)
      if (path === '/ok') return html(BODY)
      // 100dvh 的应用壳：html/body 不滚动，内容在内部容器里滚（内联 !important 改不动高度，只能撑视口）
      if (path === '/shell') {
        return html(`<style>html, body { height: 100dvh !important; overflow: hidden }</style>
<div style="display:flex;flex-direction:column;height:100dvh !important"><div style="height:50px;background:#fa0">页头</div>
<div style="flex:1;min-height:0;overflow-y:auto"><div style="height:1500px;background:#08f">长内容</div></div></div>`)
      }
      // 同意框：点「I decline」后把标题改成 declined；点别的按钮标题不变
      if (path === '/consent') {
        return html(`${BODY}<div id="box"><button id="yes">That's ok</button><button id="no">I decline</button></div>
<script>document.getElementById('no').onclick = function () { document.title = 'declined'; document.getElementById('box').remove() }</script>`)
      }
      // 脚本跑完以后才出现的同意框
      if (path === '/consent-late') {
        return html(`${BODY}<script>setTimeout(function () {
  var b = document.createElement('button'); b.textContent = ' I Decline '; b.onclick = function () { document.title = 'declined' }; document.body.appendChild(b)
}, 400)</script>`)
      }
      // 提示框：被藏起来时（display:none）标题是 hidden
      if (path === '/tip') {
        return html(`${BODY}<div class="tip-layer"><p>tip</p></div>
<script>setTimeout(function () { document.title = getComputedStyle(document.querySelector('.tip-layer')).display === 'none' ? 'hidden' : 'shown' }, 600)</script>`)
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
    origin = `http://127.0.0.1:${port}`
    const puppeteer = await import('puppeteer-core')
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    })
  }, 30000)

  afterAll(async () => {
    await browser?.close()
    server?.closeAllConnections()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  })

  async function run(path: string, profile: Partial<ShotProfile> = {}) {
    // fresh：同一地址换参数再截，不吃缓存
    const ticket = shooter().request(target(path, profile), { fresh: true })
    if (ticket.status !== 'queued') throw new Error(`期望排上队，实际是 ${ticket.status}`)
    return ticket.done
  }

  // blockedPrivate 不断言：这里的主机是 127.0.0.1，浏览器自己请求的 favicon 也会被算进去
  it('a plain page works with the guard on', async () => {
    const outcome = await run('/ok')
    expect(outcome).toMatchObject({ ok: true })
    if (outcome.ok) expect(outcome.shot.diag).toMatchObject({ status: 200, blockedRedirects: 0 })
    expect(opened.at(-1)!.isClosed()).toBe(true)
  }, 30000)

  it('a server redirect to another host is blocked and the page is closed', async () => {
    const outcome = await run('/redirect')
    expect(outcome).toMatchObject({ ok: false, reason: 'redirect', diag: { blockedRedirects: 1 } })
    expect(opened.at(-1)!.isClosed()).toBe(true)
  }, 30000)

  it('growViewport makes an app shell with an inner scroller as tall as its content', async () => {
    const plain = await run('/shell')
    expect(plain).toMatchObject({ ok: true })
    if (plain.ok) expect(plain.shot.pageHeight).toBe(PROFILE.viewportHeight)
    const grown = await run('/shell', { growViewport: true })
    expect(grown).toMatchObject({ ok: true })
    // 页头 50 + 内部内容 1500
    if (grown.ok) expect(grown.shot.pageHeight).toBe(1550)
  }, 60000)

  it('a challenge page is reported as blocked', async () => {
    const outcome = await run('/challenge')
    expect(outcome).toMatchObject({ ok: false, reason: 'blocked', diag: { challenge: true, title: 'Just a moment...' } })
    expect(opened.at(-1)!.isClosed()).toBe(true)
  }, 30000)

  it('a sub-resource aimed at a local address never reaches the server', async () => {
    const outcome = await run('/private-image')
    expect(outcome).toMatchObject({ ok: true })
    if (outcome.ok) expect(outcome.shot.diag.blockedPrivate).toBeGreaterThanOrEqual(1)
    expect(hits).toContain('/private-image')
    expect(hits).not.toContain('/x.png')
  }, 30000)

  it('a script that navigates away is blocked', async () => {
    const outcome = await run('/script-redirect')
    expect(outcome).toMatchObject({ ok: false, reason: 'redirect', diag: { blockedRedirects: 1 } })
    expect(opened.at(-1)!.isClosed()).toBe(true)
  }, 30000)

  it('a popup is closed, counted, does not fail the shot, and leaves no extra page behind', async () => {
    const before = (await browser.pages()).length
    const outcome = await run('/popup')
    expect(outcome).toMatchObject({ ok: true })
    if (outcome.ok) expect(outcome.shot.diag).toMatchObject({ blockedRedirects: 0, closedPopups: 1 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await browser.pages()).length).toBe(before)
  }, 30000)

  it('clicks the decline button of the consent box, not the accept one, even when it shows up late', async () => {
    const now = await shooter().request(target('/consent', { dismissTexts: ['I decline'] }), { fresh: true })
    if (now.status !== 'queued') throw new Error('没排上队')
    const outcome = await now.done
    expect(outcome).toMatchObject({ ok: true })
    if (outcome.ok) expect(outcome.shot.diag.title).toBe('declined')

    const late = shooter().request(target('/consent-late', { dismissTexts: ['I decline'] }), { fresh: true })
    if (late.status !== 'queued') throw new Error('没排上队')
    const lateOutcome = await late.done
    if (lateOutcome.ok) expect(lateOutcome.shot.diag.title).toBe('declined')
    else throw new Error(`截图失败：${lateOutcome.reason}`)
  }, 30000)

  it('a profile without dismissTexts leaves the consent box alone', async () => {
    const outcome = await run('/consent')
    expect(outcome).toMatchObject({ ok: true })
    if (outcome.ok) expect(outcome.shot.diag.title).toBe('测试页')
  }, 30000)

  it('hides the tip layer named in hideSelectors', async () => {
    const ticket = shooter().request(target('/tip', { hideSelectors: ['.tip-layer'], settleMs: 1200 }), { fresh: true })
    if (ticket.status !== 'queued') throw new Error('没排上队')
    const outcome = await ticket.done
    if (!outcome.ok) throw new Error(`截图失败：${outcome.reason}`)
    expect(outcome.shot.diag.title).toBe('hidden')
  }, 30000)
})
