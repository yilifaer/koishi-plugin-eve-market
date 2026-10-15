// 战报截图。前半部分用假页面测排队、缓存、超时、关闭页面（总是跑）；页面都经过真正的 Renderer（共用页面名额）。
// 后半部分用真实的 Chromium 截本机 HTTP 服务上的 HTML（tests/fixtures/br），没有 CHROME_PATH 时跳过。
// 战报网站在这里访问不了：页面接口外面包一层，把 https://br.evetools.org 换成本机服务的地址。

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'puppeteer-core'
import {
  BR_JPEG_QUALITY, BR_MAX_HEIGHT, BR_QUEUE_REJECT_SEC, BR_QUEUE_TASK_SEC, BR_RENDER_TIMEOUT_MS, BR_SEGMENT_HEIGHT, BR_VIEWPORT_WIDTH,
} from '../../src/constants'
import type { Logger } from '../../src/core/ports'
import { BrScreenshotter, splitHeight } from '../../src/render/br'
import type { BrOutcome, BrScreenshotterOptions, BrTicket } from '../../src/render/br'
import { createRenderer } from '../../src/render/renderer'
import type { PageFactory, PageRequest, RenderPage, ShotOptions } from '../../src/render/renderer'

// 编造的战报编号
const ID = (n: number) => n.toString(16).padStart(24, '0')
const link = (n: number) => `https://br.evetools.org/br/${ID(n)}`

/** 让排队的 Promise 回调先跑完 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function pending(ticket: BrTicket) {
  if (ticket.status !== 'queued') throw new Error(`期望排上队，实际是 ${ticket.status}`)
  return ticket
}

async function outcomeOf(ticket: BrTicket): Promise<BrOutcome> {
  return pending(ticket).done
}

function shotOf(outcome: BrOutcome) {
  if (!outcome.ok) throw new Error(`截图失败：${outcome.reason} ${outcome.message ?? ''}`)
  return outcome.shot
}

class QuietLogger implements Logger {
  readonly warnings: string[] = []
  debug() {}
  info() {}
  warn(...a: unknown[]) { this.warnings.push(a.map(String).join(' ')) }
  error() {}
}

// ------------------------------------------------------------------ 假页面

/** 只有文件头的假 JPEG（SOF0 段里写宽高），最后一个字节是编号，用来区分是哪一张 */
function fakeJpeg(width: number, height: number, tag: number): number[] {
  return [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9, tag]
}

interface FakeBehavior {
  status?: number | null
  /** 每次读高度依次返回（最后一个一直用） */
  heights?: number[]
  gotoError?: Error
  /** goto / screenshot / close 一直不返回 */
  hangGoto?: boolean
  hangScreenshot?: boolean
  hangClose?: boolean
  closeError?: Error
  /** goto 要多久 */
  gotoMs?: number
  /** 截图返回的不是图片 */
  notAnImage?: boolean
}

class FakePage implements RenderPage {
  readonly calls: string[] = []
  readonly shots: ShotOptions[] = []
  viewport?: { width: number; height: number; deviceScaleFactor?: number }
  gotoOptions?: { timeout?: number; waitUntil?: string }
  url?: string
  closed = false
  private reads = 0

  constructor(private readonly b: FakeBehavior = {}) {}

  async setViewport(v: { width: number; height: number; deviceScaleFactor?: number }) {
    this.calls.push('setViewport')
    this.viewport = v
  }

  // 截战报用不到的几个方法
  async setJavaScriptEnabled() {}
  async setRequestInterception() {}
  on(_event: 'request', _handler: (request: PageRequest) => void) {
    return this
  }

  async setContent() {}

  async goto(url: string, options?: { timeout?: number; waitUntil?: string }) {
    this.calls.push('goto')
    this.url = url
    this.gotoOptions = options
    if (this.b.hangGoto) await new Promise(() => {})
    if (this.b.gotoMs) await new Promise((resolve) => setTimeout(resolve, this.b.gotoMs))
    if (this.closed) throw new Error('Navigating frame was detached')
    if (this.b.gotoError) throw this.b.gotoError
    const status = this.b.status === undefined ? 200 : this.b.status
    return status === null ? null : { status: () => status }
  }

  async evaluate(expression: string) {
    this.calls.push('evaluate')
    expect(expression).toContain('scrollHeight')
    const heights = this.b.heights ?? [1000]
    const h = heights[Math.min(this.reads++, heights.length - 1)]
    return [h, true]
  }

  async screenshot(options: ShotOptions = {}) {
    this.calls.push('screenshot')
    this.shots.push(options)
    if (this.b.hangScreenshot) await new Promise(() => {})
    if (this.closed) throw new Error('Target closed')
    if (this.b.notAnImage) return new Uint8Array([1, 2, 3])
    // 返回一大块内存上的视图（和 puppeteer 一样），检查转换时只取这一段
    const bytes = fakeJpeg(options.clip!.width, options.clip!.height, this.shots.length)
    const whole = new Uint8Array(256).fill(0xee)
    whole.set(bytes, 16)
    return whole.subarray(16, 16 + bytes.length)
  }

  async close() {
    this.calls.push('close')
    if (this.b.hangClose) await new Promise(() => {})
    this.closed = true
    if (this.b.closeError) throw this.b.closeError
  }
}

/** 按顺序开假页面，记下开过的页面和同时开着的最多几个 */
function fakeSource(make: (n: number) => FakePage = () => new FakePage()) {
  const pages: FakePage[] = []
  let open = 0
  let peak = 0
  const source: PageFactory = async () => {
    const page = make(pages.length)
    pages.push(page)
    open++
    peak = Math.max(peak, open)
    const close = page.close.bind(page)
    page.close = async () => {
      open--
      return close()
    }
    return page
  }
  return { source, pages, peak: () => peak }
}

const FAST: Partial<BrScreenshotterOptions> = { settleMs: 20, settlePollMs: 5 }

/** 截图器 + 它用的渲染器（关闭页面最多等 50 毫秒）；source 是 undefined 时就是没有 puppeteer */
function shooter(source: PageFactory | undefined, extra: Partial<BrScreenshotterOptions> = {}) {
  const logger = new QuietLogger()
  const renderer = createRenderer({ pages: () => source, closeWaitMs: 50 })
  return { logger, renderer, br: new BrScreenshotter({ renderer, logger, ...FAST, ...extra }) }
}

describe('splitHeight', () => {
  it('splits into near-equal parts no taller than the segment height', () => {
    expect(splitHeight(900, 4000)).toEqual([{ y: 0, height: 900 }])
    expect(splitHeight(4000, 4000)).toEqual([{ y: 0, height: 4000 }])
    expect(splitHeight(4010, 4000)).toEqual([{ y: 0, height: 2005 }, { y: 2005, height: 2005 }])
    expect(splitHeight(6001, 4000)).toEqual([{ y: 0, height: 3001 }, { y: 3001, height: 3000 }])
    expect(splitHeight(8000, 4000)).toEqual([{ y: 0, height: 4000 }, { y: 4000, height: 4000 }])
    expect(splitHeight(0, 4000)).toEqual([])
  })
})

describe('BrScreenshotter with fake pages', () => {
  it('opens only the normalized link and screenshots it as JPEG segments', async () => {
    const { source, pages } = fakeSource(() => new FakePage({ heights: [6000] }))
    const { br } = shooter(source)
    const ticket = br.request(`HTTP://BR.EVETOOLS.ORG/BR/${ID(1).toUpperCase()}?x=1#y`)
    const shot = shotOf(await outcomeOf(ticket))
    const page = pages[0]
    expect(page.url).toBe(link(1))
    expect(page.viewport).toEqual({ width: BR_VIEWPORT_WIDTH, height: expect.any(Number), deviceScaleFactor: 1 })
    expect(page.gotoOptions?.waitUntil).toBe('domcontentloaded')
    expect(page.gotoOptions?.timeout).toBeLessThanOrEqual(BR_RENDER_TIMEOUT_MS)
    expect(page.shots).toEqual([
      { type: 'jpeg', quality: BR_JPEG_QUALITY, captureBeyondViewport: true, clip: { x: 0, y: 0, width: BR_VIEWPORT_WIDTH, height: 3000 } },
      { type: 'jpeg', quality: BR_JPEG_QUALITY, captureBeyondViewport: true, clip: { x: 0, y: 3000, width: BR_VIEWPORT_WIDTH, height: 3000 } },
    ])
    expect(shot).toMatchObject({ url: link(1), pageHeight: 6000, keptHeight: 6000, truncated: false })
    // Uint8Array 视图转成 Buffer 后正好是这张图的字节，不带整块内存
    expect(shot.images.map((i) => [i.mime, i.width, i.height, [...i.data]])).toEqual([
      ['image/jpeg', BR_VIEWPORT_WIDTH, 3000, fakeJpeg(BR_VIEWPORT_WIDTH, 3000, 1)],
      ['image/jpeg', BR_VIEWPORT_WIDTH, 3000, fakeJpeg(BR_VIEWPORT_WIDTH, 3000, 2)],
    ])
    expect(shot.images.every((i) => Buffer.isBuffer(i.data))).toBe(true)
    expect(page.calls.at(-1)).toBe('close')
    expect(page.closed).toBe(true)
  })

  it('cuts pages taller than the limit and says so', async () => {
    const { source, pages } = fakeSource(() => new FakePage({ heights: [12345] }))
    const { br } = shooter(source)
    const shot = shotOf(await outcomeOf(br.request(link(1))))
    expect(shot).toMatchObject({ pageHeight: 12345, keptHeight: BR_MAX_HEIGHT, truncated: true })
    expect(shot.images.map((i) => i.height)).toEqual([BR_SEGMENT_HEIGHT, BR_SEGMENT_HEIGHT])
    expect(pages[0].shots.map((s) => s.clip!.y)).toEqual([0, BR_SEGMENT_HEIGHT])
  })

  it('waits for the height to settle before measuring', async () => {
    // 先是被视口撑在 900 的空壳（readyState 已 complete），数据到了才长高；睡觉不真睡
    const heights = [...Array(5).fill(900), 4500, 5200]
    const { source, pages } = fakeSource(() => new FakePage({ heights }))
    const instant = { timeout: (fn: () => void) => { const t = setImmediate(fn); return () => clearImmediate(t) } }
    const { br } = shooter(source, { settleMs: 8000, settlePollMs: 250, scheduler: instant })
    const shot = shotOf(await outcomeOf(br.request(link(1))))
    expect(shot.pageHeight).toBe(5200)
    // 900 平台期不算稳定；5200 稳定 1500 毫秒（6 次读取）就开始截，不把 8 秒用完：5 + 4500 + 5200 + 6
    expect(pages[0].calls.filter((c) => c === 'evaluate').length).toBe(5 + 1 + 1 + 6)
  })

  it('does not open anything for links outside the site', async () => {
    const { source, pages } = fakeSource()
    const { br } = shooter(source)
    for (const bad of ['https://example.com/br/' + ID(1), `看 ${link(1)}`, `https://example.com@br.evetools.org/br/${ID(1)}`, '']) {
      expect(br.request(bad), bad).toEqual({ status: 'invalid' })
    }
    expect(pages).toEqual([])
  })

  it('reports a missing browser', async () => {
    const { br, logger } = shooter(undefined)
    expect(await outcomeOf(br.request(link(1)))).toEqual({ ok: false, reason: 'no-browser' })
    expect(logger.warnings.join('\n')).toContain('no-browser')
  })

  it('maps failures: HTTP errors, network errors, navigation timeouts, a broken browser, an empty page', async () => {
    const timeoutError = Object.assign(new Error('Navigation timeout of 60000 ms exceeded'), { name: 'TimeoutError' })
    const cases: Array<[PageFactory, Partial<BrOutcome>]> = [
      [fakeSource(() => new FakePage({ status: 404 })).source, { ok: false, reason: 'http', status: 404 }],
      [fakeSource(() => new FakePage({ status: 502 })).source, { ok: false, reason: 'http', status: 502 }],
      [fakeSource(() => new FakePage({ gotoError: new Error(`net::ERR_NAME_NOT_RESOLVED at ${link(1)}`) })).source, { ok: false, reason: 'unreachable' }],
      [fakeSource(() => new FakePage({ gotoError: timeoutError })).source, { ok: false, reason: 'timeout' }],
      [fakeSource(() => new FakePage({ heights: [0] })).source, { ok: false, reason: 'failed' }],
      [fakeSource(() => new FakePage({ notAnImage: true })).source, { ok: false, reason: 'failed', message: '截图结果不是图片' }],
      [async () => { throw new Error('browser has disconnected') }, { ok: false, reason: 'failed', message: 'browser has disconnected' }],
    ]
    for (const [source, expected] of cases) {
      const { br } = shooter(source)
      expect(await outcomeOf(br.request(link(1)))).toMatchObject(expected)
    }
    // 同文档跳转时 goto 返回 null：照样截
    const { source } = fakeSource(() => new FakePage({ status: null }))
    expect((await outcomeOf(shooter(source).br.request(link(1)))).ok).toBe(true)
  })

  it('closes the page whatever happens, even when closing throws or hangs', async () => {
    for (const behavior of [{ status: 500 }, { gotoError: new Error('boom') }, { closeError: new Error('already closed') }, { hangClose: true }]) {
      const { source, pages } = fakeSource(() => new FakePage(behavior))
      const { br } = shooter(source)
      await outcomeOf(br.request(link(1)))
      expect(pages[0].calls.filter((c) => c === 'close')).toEqual(['close'])
      // 关闭卡住也不占着队列
      expect(br.queued).toBe(0)
      expect((await outcomeOf(br.request(link(2)))).ok).toBe(!('status' in behavior) && !('gotoError' in behavior))
    }
  })

  it('gives up after the render time limit and closes the page', async () => {
    for (const behavior of [{ hangGoto: true }, { hangScreenshot: true }]) {
      const { source, pages } = fakeSource(() => new FakePage(behavior))
      const { br } = shooter(source, { renderTimeoutMs: 100 })
      const started = Date.now()
      expect(await outcomeOf(br.request(link(1)))).toMatchObject({ ok: false, reason: 'timeout' })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(pages[0].calls).toContain('close')
    }
  })

  it('closes a page that only arrives after the time limit', async () => {
    const late = new FakePage()
    const source: PageFactory = () => new Promise((resolve) => setTimeout(() => resolve(late), 150))
    const { br } = shooter(source, { renderTimeoutMs: 50 })
    expect(await outcomeOf(br.request(link(1)))).toMatchObject({ ok: false, reason: 'timeout' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(late.calls).toEqual(['close'])
  })

  it('caches each link for 10 minutes and shares a capture in progress', async () => {
    let now = Date.UTC(2026, 9, 7, 6, 20)
    const { source, pages } = fakeSource()
    const { br } = shooter(source, { now: () => now })
    const first = pending(br.request(link(1)))
    const second = pending(br.request(`http://br.evetools.org/br/${ID(1)}/`))
    expect([first.joined, second.joined]).toEqual([false, true])
    expect(second.done).toBe(first.done)
    const shot = shotOf(await first.done)
    expect(pages.length).toBe(1)

    expect(br.request(link(1))).toEqual({ status: 'cached', shot })
    expect(br.cached(link(1))).toBe(shot)
    now += 9 * 60_000
    expect(br.request(link(1)).status).toBe('cached')
    now += 61_000
    expect(br.cached(link(1))).toBeUndefined()
    await outcomeOf(br.request(link(1)))
    expect(pages.length).toBe(2)
  })

  it('does not cache failures', async () => {
    const { source, pages } = fakeSource((n) => new FakePage(n === 0 ? { status: 503 } : {}))
    const { br } = shooter(source)
    expect((await outcomeOf(br.request(link(1)))).ok).toBe(false)
    expect((await outcomeOf(br.request(link(1)))).ok).toBe(true)
    expect(pages.length).toBe(2)
  })

  it('renders one battle report at a time, in order', async () => {
    const { source, pages, peak } = fakeSource(() => new FakePage({ gotoMs: 30 }))
    const { br } = shooter(source)
    const tickets = [1, 2, 3].map((n) => pending(br.request(link(n))))
    expect(tickets.map((t) => t.ahead())).toEqual([0, 1, 2])
    expect(br.queued).toBe(3)
    await tickets[0].done
    await flush()
    expect(tickets.map((t) => t.ahead())).toEqual([0, 0, 1])
    await Promise.all(tickets.map((t) => t.done))
    expect(peak()).toBe(1)
    expect(pages.map((p) => p.url)).toEqual([link(1), link(2), link(3)])
    expect(br.queued).toBe(0)
  })

  it('refuses work that could not finish before the reply cut-off (counted from the message)', async () => {
    expect([BR_QUEUE_TASK_SEC, BR_QUEUE_REJECT_SEC]).toEqual([60, 240])
    let now = Date.UTC(2026, 9, 7, 6, 20)
    const gates: Array<() => void> = []
    const source: PageFactory = async () => {
      await new Promise<void>((resolve) => gates.push(resolve))
      return new FakePage()
    }
    const { br } = shooter(source, { now: () => now })
    // 队列空：已经过去 170 秒还能排（170 + 60 ≤ 240），过去 190 秒就不行
    expect(br.request(link(1), { receivedAt: now - 190_000 })).toEqual({ status: 'busy', queued: 0 })
    const t1 = pending(br.request(link(1), { receivedAt: now - 170_000 }))
    // 刚收到的消息：前面 3 个任务时（3 + 1）× 60 = 240 还行，前面 4 个就拒绝
    pending(br.request(link(2), { receivedAt: now }))
    pending(br.request(link(3), { receivedAt: now }))
    const t4 = pending(br.request(link(4), { receivedAt: now }))
    expect(t4.ahead()).toBe(3)
    expect(br.request(link(5), { receivedAt: now })).toEqual({ status: 'busy', queued: 4 })
    // 和正在排的同一个链接：按那个任务的位置算
    expect(pending(br.request(link(2), { receivedAt: now - 100_000 })).joined).toBe(true)
    expect(br.request(link(4), { receivedAt: now - 30_000 }).status).toBe('busy')
    while (gates.length || br.queued) {
      gates.shift()?.()
      await flush()
    }
    await t1.done
    // 缓存命中不受排队和时间影响
    now += 1000
    expect(br.request(link(1), { receivedAt: now - 1_000_000 }).status).toBe('cached')
  })

  it('shares the page queue with charts: one battle report page at a time, puppeteer can go away', async () => {
    let service = true
    const { source, pages } = fakeSource(() => new FakePage({ gotoMs: 20 }))
    const renderer = createRenderer({ pages: () => (service ? source : undefined) })
    const br = new BrScreenshotter({ renderer, ...FAST })
    const tickets = [1, 2].map((n) => pending(br.request(link(n))))
    await flush()
    expect(renderer.queued('br')).toBe(2)
    for (const t of tickets) shotOf(await t.done)
    expect(pages.map((p) => p.closed)).toEqual([true, true])
    expect(renderer.queued()).toBe(0)
    // puppeteer 停用以后
    service = false
    expect(await outcomeOf(br.request(link(3)))).toEqual({ ok: false, reason: 'no-browser' })
    await renderer.dispose()
  })

  it('the time limit starts when the report gets a page, not while it waits behind charts', async () => {
    const { source, pages } = fakeSource(() => new FakePage({ gotoMs: 50 }))
    const { renderer, br } = shooter(source, { renderTimeoutMs: 300 })
    // 两个页面都被走势图占着，400 毫秒后才放出来
    const charts = [1, 2].map(() => renderer.withPage(() => new Promise((resolve) => setTimeout(resolve, 400)), { timeoutMs: 5000 }))
    const ticket = pending(br.request(link(1)))
    await flush()
    expect(ticket.ahead()).toBe(0)
    const shot = shotOf(await ticket.done)
    expect(shot.url).toBe(link(1))
    await Promise.all(charts)
    expect(pages.filter((p) => p.url === link(1))).toHaveLength(1)
  })

  it('dispose drops queued work and closes open pages', async () => {
    const pagesSeen: FakePage[] = []
    const source: PageFactory = async () => {
      const page = new FakePage({ hangGoto: true })
      pagesSeen.push(page)
      return page
    }
    const { br, logger } = shooter(source)
    const running = pending(br.request(link(1)))
    const waiting = pending(br.request(link(2)))
    await flush()
    await br.dispose()
    expect(await waiting.done).toEqual({ ok: false, reason: 'closed' })
    expect(await running.done).toMatchObject({ ok: false, reason: 'closed' })
    expect(pagesSeen.length).toBe(1)
    expect(pagesSeen[0].calls).toContain('close')
    expect(logger.warnings).toEqual([])
    expect(br.request(link(3)).status).toBe('busy')
  })
})

// ------------------------------------------------------------------ 真实的 Chromium

const CHROME = process.env.CHROME_PATH
const HAS_CHROME = !!CHROME && fs.existsSync(CHROME)
const FIXTURES = path.resolve(__dirname, '../fixtures/br')

const TALL = 0x7a11
const MEDIUM = 0x3ed1
const SHORT = 0x5407
const LATE = 0x1a7e
const SLOW = 0x5104
const MISSING = 0x404
const RELATED = 'https://br.evetools.org/related/30000142/202610071200'

const ROUTES: Record<string, string> = {
  [`/br/${ID(TALL)}`]: 'tall.html',
  [`/br/${ID(MEDIUM)}`]: 'medium.html',
  [`/br/${ID(SHORT)}`]: 'short.html',
  [`/br/${ID(LATE)}`]: 'late.html',
  '/related/30000142/202610071200': 'short.html',
}

/** JPEG 的宽高（读 SOF 段） */
function jpegSize(buf: Buffer): { width: number; height: number } {
  expect([buf[0], buf[1]]).toEqual([0xff, 0xd8])
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('JPEG 格式不对')
    const marker = buf[i + 1]
    const length = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + length
  }
  throw new Error('JPEG 里没有尺寸')
}

type Rgb = [number, number, number]

describe.skipIf(!HAS_CHROME)('BrScreenshotter with Chromium and local pages', () => {
  let browser: Browser
  let server: http.Server
  let origin = ''
  const opened: Page[] = []
  /** 每个页面打开的地址（没打开成功时 page.url() 还是 about:blank） */
  const requested = new Map<Page, string>()

  /** 页面接口外面包一层：战报网站的地址换成本机服务 */
  const source: PageFactory = async () => {
    const page = await browser.newPage()
    opened.push(page)
    // puppeteer 的 Page 本身就满足最小页面接口
    const typed: RenderPage = page
    return {
      setViewport: (v) => typed.setViewport(v),
      setJavaScriptEnabled: (enabled) => typed.setJavaScriptEnabled(enabled),
      setRequestInterception: (enabled) => typed.setRequestInterception(enabled),
      on: (event, handler) => typed.on(event, handler),
      setContent: (html, options) => typed.setContent(html, options),
      goto: (url, options) => {
        requested.set(page, url)
        return typed.goto(url.replace(/^https:\/\/br\.evetools\.org/, origin), options)
      },
      waitForNetworkIdle: (options) => typed.waitForNetworkIdle!(options),
      evaluate: (expression) => typed.evaluate(expression),
      screenshot: (options) => typed.screenshot(options),
      close: () => typed.close(),
    }
  }

  /** 和插件里一样：截图器用渲染器的页面队列 */
  const chromium = (extra: Partial<BrScreenshotterOptions> = {}) => new BrScreenshotter({ renderer: createRenderer({ pages: () => source }), ...extra })

  /** 在浏览器里解码 JPEG，取几个点的颜色 */
  async function sample(data: Buffer, points: Array<[number, number]>): Promise<Rgb[]> {
    const page = await browser.newPage()
    try {
      return await page.evaluate(async (b64: string, pts: Array<[number, number]>) => {
        const img = new Image()
        img.src = `data:image/jpeg;base64,${b64}`
        await img.decode()
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        return pts.map(([x, y]) => {
          const d = ctx.getImageData(x, y, 1, 1).data
          return [d[0], d[1], d[2]] as [number, number, number]
        })
      }, data.toString('base64'), points)
    } finally {
      await page.close()
    }
  }

  /** 颜色接近（JPEG 有损） */
  const near = (rgb: Rgb, want: Rgb) => rgb.every((v, i) => Math.abs(v - want[i]) <= 40)

  async function colorsOf(image: { data: Buffer; width: number; height: number }) {
    return sample(image.data, [[5, 2], [image.width >> 1, image.height >> 1], [image.width - 5, image.height - 3]])
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === `/br/${ID(SLOW)}`) return // 一直不回应
      if (url.pathname === `/br/${ID(MISSING)}`) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end('<!doctype html><title>404</title><p>没有这个战报</p>')
      }
      const file = ROUTES[url.pathname]
      if (!file) {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(path.join(FIXTURES, file)))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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

  it('a tall page: two 4000-pixel JPEG segments, the rest cut off', async () => {
    const br = chromium()
    const shot = shotOf(await outcomeOf(br.request(link(TALL))))
    expect(shot).toMatchObject({ pageHeight: 10000, keptHeight: BR_MAX_HEIGHT, truncated: true })
    expect(shot.images.length).toBe(2)
    for (const image of shot.images) {
      expect(image.mime).toBe('image/jpeg')
      expect(Buffer.isBuffer(image.data)).toBe(true)
      expect(jpegSize(image.data)).toEqual({ width: BR_VIEWPORT_WIDTH, height: BR_SEGMENT_HEIGHT })
      expect([image.width, image.height]).toEqual([BR_VIEWPORT_WIDTH, BR_SEGMENT_HEIGHT])
    }
    // 第一段全红、第二段全绿，没有截到第三段的蓝色
    const [red, green] = await Promise.all(shot.images.map(colorsOf))
    expect(red.every((c) => near(c, [255, 0, 0])), JSON.stringify(red)).toBe(true)
    expect(green.every((c) => near(c, [0, 255, 0])), JSON.stringify(green)).toBe(true)
    expect(opened.at(-1)!.isClosed()).toBe(true)
  })

  it('a medium page: two equal segments that line up with the page', async () => {
    const br = chromium()
    const shot = shotOf(await outcomeOf(br.request(link(MEDIUM))))
    expect(shot).toMatchObject({ pageHeight: 6000, keptHeight: 6000, truncated: false })
    expect(shot.images.map((i) => jpegSize(i.data))).toEqual([
      { width: BR_VIEWPORT_WIDTH, height: 3000 },
      { width: BR_VIEWPORT_WIDTH, height: 3000 },
    ])
    const [first, second] = await Promise.all(shot.images.map(colorsOf))
    expect(first.every((c) => near(c, [255, 0, 0])), JSON.stringify(first)).toBe(true)
    expect(second.every((c) => near(c, [0, 255, 0])), JSON.stringify(second)).toBe(true)
  })

  it('a short page and a related link: one image of the viewport height, then served from the cache', async () => {
    const pagesBefore = opened.length
    const br = chromium()
    const shot = shotOf(await outcomeOf(br.request(link(SHORT))))
    expect(shot.images.length).toBe(1)
    expect(shot.truncated).toBe(false)
    const size = jpegSize(shot.images[0].data)
    expect(size.width).toBe(BR_VIEWPORT_WIDTH)
    expect(size.height).toBe(shot.pageHeight)
    expect(shot.pageHeight).toBeLessThan(BR_SEGMENT_HEIGHT)
    const colors = await colorsOf(shot.images[0])
    expect(near(colors[2], [255, 255, 0]), JSON.stringify(colors)).toBe(true)

    const related = shotOf(await outcomeOf(br.request(`http://BR.evetools.org/related/30000142/202610071200`)))
    expect(related.url).toBe(RELATED)
    expect(related.images.length).toBe(1)
    expect(br.request(link(SHORT))).toEqual({ status: 'cached', shot })
    expect(opened.length - pagesBefore).toBe(2)
  })

  it('waits for content that shows up after the page has loaded', async () => {
    const br = chromium()
    const shot = shotOf(await outcomeOf(br.request(link(LATE))))
    expect(shot.pageHeight).toBe(5000)
    expect(shot.images.map((i) => i.height)).toEqual([2500, 2500])
    const colors = await colorsOf(shot.images[1])
    expect(colors.every((c) => near(c, [0, 255, 255])), JSON.stringify(colors)).toBe(true)
  })

  it('an HTTP error is reported and the page closed', async () => {
    const br = chromium({ logger: new QuietLogger() })
    expect(await outcomeOf(br.request(link(MISSING)))).toMatchObject({ ok: false, reason: 'http', status: 404 })
    expect(opened.at(-1)!.isClosed()).toBe(true)
  })

  it('a page that never answers times out, is closed, and the queue moves on', async () => {
    // 时限调小到 4 秒（正常的页面 1–2 秒就能截完）
    const br = chromium({ renderTimeoutMs: 4000, settleMs: 1500, logger: new QuietLogger() })
    const slow = pending(br.request(link(SLOW)))
    const next = pending(br.request(link(SHORT)))
    expect(next.ahead()).toBe(1)
    const started = Date.now()
    expect(await slow.done).toMatchObject({ ok: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(8000)
    const slowPage = opened.find((p) => requested.get(p) === link(SLOW))
    expect(slowPage?.isClosed()).toBe(true)
    expect(next.ahead()).toBe(0)
    shotOf(await next.done)
    expect(opened.every((p) => p.isClosed())).toBe(true)
  })
})
