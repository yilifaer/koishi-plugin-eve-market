// 网站截图器（假页面）：各网站的页面参数、张数、等元素、隐藏元素、验证页、缓存和排队跨网站共用、fresh。
// 页面都经过真正的 Renderer（共用页面名额）；BR 自己的用例在 br.test.ts。

import { describe, expect, it } from 'vitest'
import { SHOT_SEGMENT_HEIGHT } from '../../src/constants'
import type { Logger, Scheduler } from '../../src/core/ports'
import type { ShotProfile } from '../../src/core/sites'
import { SiteScreenshotter } from '../../src/render/site-shot'
import type { ShotOutcome, ShotTarget, ShotTicket, SiteScreenshotterOptions } from '../../src/render/site-shot'
import { createRenderer } from '../../src/render/renderer'
import type { PageFactory, PageRequest, RenderPage, ShotOptions } from '../../src/render/renderer'

/** 睡觉不真睡：稳定窗口按轮询间隔累计，测试不用等真实的几秒 */
const instant: Scheduler = { timeout: (fn) => { const t = setImmediate(fn); return () => clearImmediate(t) } }

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

class QuietLogger implements Logger {
  readonly warnings: string[] = []
  debug() {}
  info() {}
  warn(...a: unknown[]) { this.warnings.push(a.map(String).join(' ')) }
  error() {}
}

function fakeJpeg(width: number, height: number, tag: number): number[] {
  return [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9, tag]
}

interface Behavior {
  status?: number
  heights?: number[]
  title?: string
  /** 每次读 PROBE 依次返回是否像验证页（最后一个一直用） */
  challenge?: boolean[]
  /** 第几次查元素才出现（1 = 第一次就有；不写 = 一直没有） */
  readyOnPoll?: number
  gotoMs?: number
  /** 网络一直不安静：waitForNetworkIdle 到 timeout 抛错 */
  neverIdle?: boolean
  /** 页面高度随视口变（100dvh 的应用壳）：给了就优先于 heights */
  heightOf?: (viewportHeight: number) => number
  /** 每次读内部滚动容器藏起来的高度依次返回（最后一个一直用） */
  hidden?: number[]
  /** 第几次找同意框按钮才找到（1 = 第一次就有；不写 = 一直没有） */
  dismissOnPoll?: number
  /** goto 一直不返回 */
  hangGoto?: boolean
  /** waitForNetworkIdle 一直不返回 */
  hangIdle?: boolean
}

class FakePage implements RenderPage {
  readonly calls: string[] = []
  readonly expressions: string[] = []
  readonly shots: ShotOptions[] = []
  viewport?: { width: number; height: number; deviceScaleFactor?: number }
  readonly viewports: Array<{ width: number; height: number; deviceScaleFactor?: number }> = []
  private hiddenReads = 0
  gotoOptions?: { timeout?: number; waitUntil?: string }
  url?: string
  idleOptions?: { idleTime?: number; concurrency?: number; timeout?: number }
  closed = false
  private dismissPolls = 0
  private reads = 0
  private polls = 0

  constructor(private readonly b: Behavior = {}) {}

  async setViewport(v: { width: number; height: number; deviceScaleFactor?: number }) {
    this.viewport = v
    this.viewports.push(v)
  }
  async setJavaScriptEnabled() {}
  async setRequestInterception() {}
  on(_event: 'request', _handler: (request: PageRequest) => void) { return this }
  async setContent() {}

  async goto(url: string, options?: { timeout?: number; waitUntil?: string }) {
    this.calls.push('goto')
    this.url = url
    this.gotoOptions = options
    if (this.b.hangGoto) await new Promise(() => {})
    if (this.b.gotoMs) await new Promise((resolve) => setTimeout(resolve, this.b.gotoMs))
    return { status: () => this.b.status ?? 200 }
  }

  async waitForNetworkIdle(options: { idleTime?: number; concurrency?: number; timeout?: number }) {
    this.calls.push('idle')
    this.idleOptions = options
    if (this.b.hangIdle) await new Promise(() => {})
    if (this.b.neverIdle) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error('Timeout')
    }
  }

  async evaluate(expression: string) {
    this.expressions.push(expression)
    if (expression.includes("'fixed'")) {
      this.calls.push('hideFixed')
      return 0
    }
    if (expression.includes('el.click()')) {
      this.calls.push('dismiss')
      this.dismissPolls++
      return this.b.dismissOnPoll !== undefined && this.dismissPolls >= this.b.dismissOnPoll
    }
    if (expression.includes('overflowY')) {
      this.calls.push('hidden')
      const hidden = this.b.hidden ?? [0]
      return hidden[Math.min(this.hiddenReads++, hidden.length - 1)]
    }
    if (expression.includes('scrollHeight')) {
      this.calls.push('probe')
      const heights = this.b.heights ?? [1000]
      const h = this.b.heightOf ? this.b.heightOf(this.viewport?.height ?? 0) : heights[Math.min(this.reads, heights.length - 1)]
      const flags = this.b.challenge ?? [false]
      const c = flags[Math.min(this.reads, flags.length - 1)]
      this.reads++
      return [h, true, c, this.b.title ?? '', 100, 50]
    }
    if (expression.includes('display:none')) {
      this.calls.push('hide')
      return true
    }
    this.calls.push('ready')
    this.polls++
    return this.b.readyOnPoll !== undefined && this.polls >= this.b.readyOnPoll
  }

  async screenshot(options: ShotOptions = {}) {
    this.calls.push('screenshot')
    this.shots.push(options)
    return new Uint8Array(fakeJpeg(options.clip!.width, options.clip!.height, this.shots.length))
  }

  async close() {
    this.calls.push('close')
    this.closed = true
  }
}

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

const PROFILE: ShotProfile = { viewportWidth: 1440, viewportHeight: 900, idleMs: 3000, settleMs: 20, maxImages: 2, maxWaitSec: 60 }
const target = (name: string, profile: Partial<ShotProfile> = {}): ShotTarget => ({
  url: `https://${name}.example.com/p`,
  siteId: name,
  siteName: `${name} 站`,
  profile: { ...PROFILE, ...profile },
  allowHosts: ['janice.example.com', 'dotlan.example.com', 'br.example.com'],
})

function shooter(source: PageFactory | undefined, extra: Partial<SiteScreenshotterOptions> = {}) {
  const logger = new QuietLogger()
  const renderer = createRenderer({ pages: () => source, closeWaitMs: 50 })
  return { logger, renderer, shots: new SiteScreenshotter({ renderer, logger, settlePollMs: 5, ...extra }) }
}

function pending(ticket: ShotTicket) {
  if (ticket.status !== 'queued') throw new Error(`期望排上队，实际是 ${ticket.status}`)
  return ticket
}

const outcomeOf = (ticket: ShotTicket): Promise<ShotOutcome> => pending(ticket).done

function shotOf(outcome: ShotOutcome) {
  if (!outcome.ok) throw new Error(`截图失败：${outcome.reason} ${outcome.message ?? ''}`)
  return outcome.shot
}

describe('SiteScreenshotter profiles', () => {
  it('uses the viewport of the site profile and only waits for domcontentloaded in goto', async () => {
    const { source, pages } = fakeSource()
    const { shots } = shooter(source)
    shotOf(await outcomeOf(shots.request(target('dotlan', { viewportWidth: 1000, viewportHeight: 600 }))))
    expect(pages[0].url).toBe('https://dotlan.example.com/p')
    expect(pages[0].viewport).toEqual({ width: 1000, height: 600, deviceScaleFactor: 1 })
    expect(pages[0].gotoOptions?.waitUntil).toBe('domcontentloaded')
    expect(pages[0].shots[0].clip!.width).toBe(1000)
  })

  it('still shoots a page that never gets network idle, with the HTTP status', async () => {
    const { source, pages } = fakeSource(() => new FakePage({ neverIdle: true, status: 200 }))
    const { shots } = shooter(source)
    const shot = shotOf(await outcomeOf(shots.request(target('janice', { idleMs: 3000 }))))
    expect(shot.diag.status).toBe(200)
    expect(pages[0].idleOptions).toMatchObject({ timeout: 3000 })
    // 软等待在 goto 之后、截图之前
    const calls = pages[0].calls
    expect(calls.indexOf('goto')).toBeLessThan(calls.indexOf('idle'))
    expect(calls.indexOf('idle')).toBeLessThan(calls.indexOf('screenshot'))
  })

  it('skips the idle wait when idleMs is 0', async () => {
    const { source, pages } = fakeSource()
    const { shots } = shooter(source)
    shotOf(await outcomeOf(shots.request(target('janice', { idleMs: 0 }))))
    expect(pages[0].calls).not.toContain('idle')
  })

  it('keeps the status of a failing page even when it never gets idle', async () => {
    const { source } = fakeSource(() => new FakePage({ neverIdle: true, status: 404 }))
    const { shots } = shooter(source)
    const outcome = await outcomeOf(shots.request(target('janice')))
    expect(outcome).toMatchObject({ ok: false, reason: 'http', status: 404 })
  })

  it('clicks the consent button of the profile, waiting for it to appear, and shoots anyway when it never does', async () => {
    const found = fakeSource(() => new FakePage({ dismissOnPoll: 3 }))
    const a = shooter(found.source)
    shotOf(await outcomeOf(a.shots.request(target('dotlan', { dismissTexts: ['I decline'] }))))
    expect(found.pages[0].calls.filter((c) => c === 'dismiss')).toHaveLength(3)
    expect(found.pages[0].expressions.some((e) => e.includes('"i decline"'))).toBe(true)

    const missing = fakeSource()
    const b = shooter(missing.source)
    shotOf(await outcomeOf(b.shots.request(target('dotlan', { dismissTexts: ['I decline'] }))))
    expect(missing.pages[0].calls).toContain('screenshot')

    const none = fakeSource()
    const c = shooter(none.source)
    shotOf(await outcomeOf(c.shots.request(target('dotlan'))))
    expect(none.pages[0].calls).not.toContain('dismiss')
  })

  it('readyScroll waits for the inner scroll box to fill, not just settleMs', async () => {
    // 内部滚动框前 6 次读都是空的（页头空壳），第 7 次才有内容
    const hidden = [...Array(6).fill(0), 1500, 0]
    const { source, pages } = fakeSource(() => new FakePage({ hidden }))
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
    shotOf(await outcomeOf(shots.request(target('janice', { settleMs: 100, readyScroll: true, readyTimeoutMs: 30000 }))))
    expect(pages[0].calls.filter((c) => c === 'hidden').length).toBe(7)
    expect(pages[0].calls.filter((c) => c === 'hidden').length).toBeLessThan(40)
  })

  it('readyScroll gives up at readyTimeoutMs and still shoots', async () => {
    const { source, pages } = fakeSource(() => new FakePage({ hidden: [0] }))
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
    shotOf(await outcomeOf(shots.request(target('janice', { settleMs: 100, readyScroll: true, readyTimeoutMs: 1000 }))))
    expect(pages[0].calls.filter((c) => c === 'hidden').length).toBe(5)
    expect(pages[0].calls).toContain('screenshot')
  })

  it('settles for at most the profile settleMs', async () => {
    const heights = Array.from({ length: 50 }, (_, i) => 1000 + i)
    const { source, pages } = fakeSource(() => new FakePage({ heights }))
    const { shots } = shooter(source)
    await outcomeOf(shots.request(target('janice', { settleMs: 50 })))
    // 第一次读 + 最多 ceil(50 / 5) 次
    expect(pages[0].calls.filter((c) => c === 'probe').length).toBe(11)
  })

  it('keeps waiting through a viewport-high plateau and shoots after the content arrives', async () => {
    // 先出只有页头的空壳：高度被视口撑在 900，几秒后数据才到（2101）
    const heights = [...Array(8).fill(900), 2101]
    const { source, pages } = fakeSource(() => new FakePage({ heights }))
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
    const shot = shotOf(await outcomeOf(shots.request(target('janice', { settleMs: 8000, maxImages: 2 }))))
    expect(shot.pageHeight).toBe(2101)
    expect(pages[0].shots[0].clip!.height).toBe(2101)
  })

  it('needs a longer stable window for a page not taller than the viewport', async () => {
    const probes = async (height: number, settleMs: number) => {
      const { source, pages } = fakeSource(() => new FakePage({ heights: [height] }))
      const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
      shotOf(await outcomeOf(shots.request(target('janice', { settleMs }))))
      return pages[0].calls.filter((c) => c === 'probe').length
    }
    // 第一次读 + 稳定窗口 / 250 毫秒：普通页 1500 → 6 次，不超过视口的页 3500 → 14 次
    expect(await probes(1000, 8000)).toBe(1 + 6)
    expect(await probes(900, 8000)).toBe(1 + 14)
    expect(await probes(500, 8000)).toBe(1 + 14)
    // 窗口再长也不超过 settleMs
    expect(await probes(900, 1000)).toBe(1 + 4)
  })

  it('a change in text length or node count restarts the stable window', async () => {
    let reads = 0
    class Growing extends FakePage {
      async evaluate(expression: string) {
        const value = await super.evaluate(expression)
        if (!Array.isArray(value)) return value
        // 高度一直不变，文字量前 4 次读取都在涨
        return [value[0], value[1], value[2], value[3], 100 + Math.min(reads++, 4), value[5]]
      }
    }
    const { source, pages } = fakeSource(() => new Growing({ heights: [1000] }))
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
    shotOf(await outcomeOf(shots.request(target('janice', { settleMs: 8000 }))))
    // 第 1–5 次读取的文字量各不相同（100…104），之后稳定 6 次
    expect(pages[0].calls.filter((c) => c === 'probe').length).toBe(5 + 6)
  })

  it('maxImages sets the highest page height that is kept', async () => {
    for (const [maxImages, count, kept] of [[1, 1, 4000], [3, 3, 12000], [2, 2, 8000]] as const) {
      const { source, pages } = fakeSource(() => new FakePage({ heights: [20000] }))
      const { shots } = shooter(source)
      const shot = shotOf(await outcomeOf(shots.request(target('janice', { maxImages }))))
      expect(shot).toMatchObject({ pageHeight: 20000, keptHeight: kept, truncated: true })
      expect(shot.images).toHaveLength(count)
      expect(pages[0].shots.map((s) => s.clip!.height)).toEqual(Array(count).fill(SHOT_SEGMENT_HEIGHT))
    }
  })

  it('splits a medium page evenly under maxImages 3', async () => {
    const { source } = fakeSource(() => new FakePage({ heights: [9000] }))
    const { shots } = shooter(source)
    const shot = shotOf(await outcomeOf(shots.request(target('janice', { maxImages: 3 }))))
    expect(shot.images.map((i) => i.height)).toEqual([3000, 3000, 3000])
    expect(shot.truncated).toBe(false)
  })

  it('waits for readySelector by polling, then goes on', async () => {
    const { source, pages } = fakeSource(() => new FakePage({ readyOnPoll: 3 }))
    const { shots } = shooter(source)
    shotOf(await outcomeOf(shots.request(target('janice', { readySelector: '#result', readyTimeoutMs: 1000 }))))
    expect(pages[0].calls.filter((c) => c === 'ready').length).toBe(3)
    expect(pages[0].expressions.find((e) => e.includes('#result'))).toBeDefined()
  })

  it('still takes the shot when readySelector never shows up', async () => {
    const { source, pages } = fakeSource()
    const { shots } = shooter(source)
    shotOf(await outcomeOf(shots.request(target('janice', { readySelector: '#result', readyTimeoutMs: 30 }))))
    expect(pages[0].calls.filter((c) => c === 'ready').length).toBeGreaterThan(1)
    expect(pages[0].shots.length).toBe(1)
  })

  it('hideSelectors cost exactly one extra evaluate', async () => {
    const plain = fakeSource()
    await outcomeOf(shooter(plain.source).shots.request(target('janice')))
    const hidden = fakeSource()
    await outcomeOf(shooter(hidden.source).shots.request(target('dotlan', { hideSelectors: ['.ad', '#banner'] })))
    expect(hidden.pages[0].expressions.length).toBe(plain.pages[0].expressions.length + 1)
    const css = hidden.pages[0].expressions.find((e) => e.includes('display:none'))!
    expect(css).toContain('.ad')
    expect(css).toContain('#banner')
  })

  it('returns diagnostics with the shot', async () => {
    const { source } = fakeSource(() => new FakePage({ title: '估价结果' }))
    const { shots } = shooter(source)
    const shot = shotOf(await outcomeOf(shots.request(target('janice'))))
    expect(shot.diag).toMatchObject({ status: 200, title: '估价结果', challenge: false, blockedRedirects: 0, blockedPrivate: 0, closedPopups: 0 })
    expect(shot.diag.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})

describe('SiteScreenshotter growViewport', () => {
  // 100dvh 的应用壳：页面高度就是视口高度，内容藏在内部滚动容器里
  const shell = (extra: Partial<Behavior>) => fakeSource(() => new FakePage({ heightOf: (vh) => vh, ...extra }))
  const grow = (profile: Partial<ShotProfile> = {}) => target('janice', { growViewport: true, settleMs: 3000, ...profile })

  it('grows the viewport by the hidden overflow and shoots the taller page', async () => {
    const { source, pages } = shell({ hidden: [1200, 0] })
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
    const shot = shotOf(await outcomeOf(shots.request(grow({ maxImages: 2 }))))
    expect(pages[0].viewports.map((v) => v.height)).toEqual([900, 2100])
    expect(pages[0].viewports[1]).toMatchObject({ width: 1440, deviceScaleFactor: 1 })
    expect(shot.pageHeight).toBe(2100)
    expect(pages[0].shots[0].clip!.height).toBe(2100)
    expect(pages[0].calls.filter((c) => c === 'hidden')).toHaveLength(2)
  })

  it('does not grow when nothing is hidden (1 px or less counts as nothing)', async () => {
    const { source, pages } = shell({ hidden: [1] })
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
    const shot = shotOf(await outcomeOf(shots.request(grow())))
    expect(pages[0].viewports.map((v) => v.height)).toEqual([900])
    expect(shot.pageHeight).toBe(900)
  })

  it('stops at the cap of maxImages times the segment height', async () => {
    const { source, pages } = shell({ hidden: [50000] })
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
    shotOf(await outcomeOf(shots.request(grow({ maxImages: 1 }))))
    expect(pages[0].viewports.map((v) => v.height)).toEqual([900, SHOT_SEGMENT_HEIGHT])
    // 到上限就不再读
    expect(pages[0].calls.filter((c) => c === 'hidden')).toHaveLength(1)
  })

  it('stops at the cap of the maxHeight option when it is set', async () => {
    const { source, pages } = shell({ hidden: [50000] })
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250, maxHeight: 2500 })
    shotOf(await outcomeOf(shots.request(grow({ maxImages: 3 }))))
    expect(pages[0].viewports.map((v) => v.height)).toEqual([900, 2500])
  })

  it('grows at most 3 rounds even when content keeps showing up', async () => {
    const { source, pages } = shell({ hidden: [500] })
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
    shotOf(await outcomeOf(shots.request(grow({ maxImages: 3 }))))
    expect(pages[0].viewports.map((v) => v.height)).toEqual([900, 1400, 1900, 2400])
    expect(pages[0].calls.filter((c) => c === 'hidden')).toHaveLength(3)
  })

  it('is skipped when the profile does not ask for it', async () => {
    const { source, pages } = shell({ hidden: [1200] })
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
    shotOf(await outcomeOf(shots.request(target('janice', { settleMs: 3000 }))))
    expect(pages[0].viewports.map((v) => v.height)).toEqual([900])
    expect(pages[0].calls).not.toContain('hidden')
  })

  it('is skipped on a verification page', async () => {
    const { source, pages } = shell({ hidden: [1200], challenge: [true], title: 'Just a moment...' })
    const { shots } = shooter(source, { scheduler: instant, settlePollMs: 250 })
    expect(await outcomeOf(shots.request(grow()))).toMatchObject({ ok: false, reason: 'blocked' })
    expect(pages[0].calls).not.toContain('hidden')
  })
})

describe('SiteScreenshotter challenge pages and errors', () => {
  it('403 with a challenge page is blocked, 403 without is http', async () => {
    const blocked = fakeSource(() => new FakePage({ status: 403, challenge: [true], title: 'Just a moment...' }))
    const a = shooter(blocked.source)
    expect(await outcomeOf(a.shots.request(target('janice')))).toMatchObject({ ok: false, reason: 'blocked', status: 403, diag: { challenge: true, title: 'Just a moment...' } })
    expect(blocked.pages[0].shots).toEqual([])
    expect(blocked.pages[0].closed).toBe(true)
    expect(a.logger.warnings.join('\n')).toContain('janice 站')

    const plain = fakeSource(() => new FakePage({ status: 403, challenge: [false] }))
    expect(await outcomeOf(shooter(plain.source).shots.request(target('janice')))).toMatchObject({ ok: false, reason: 'http', status: 403 })
  })

  it('404 is http without reading the page', async () => {
    const { source, pages } = fakeSource(() => new FakePage({ status: 404 }))
    expect(await outcomeOf(shooter(source).shots.request(target('janice')))).toMatchObject({ ok: false, reason: 'http', status: 404 })
    expect(pages[0].calls).not.toContain('probe')
  })

  it('a challenge page that shows up while settling is blocked', async () => {
    const { source, pages } = fakeSource(() => new FakePage({ challenge: [false, false, true], heights: [900], title: '请稍候…' }))
    const outcome = await outcomeOf(shooter(source, { settleMs: 100 }).shots.request(target('janice', { settleMs: 100 })))
    expect(outcome).toMatchObject({ ok: false, reason: 'blocked', diag: { challenge: true } })
    expect(pages[0].shots).toEqual([])
  })
})

describe('SiteScreenshotter queue and cache across sites', () => {
  it('shares one external page slot and one queue between sites', async () => {
    const { source, pages, peak } = fakeSource(() => new FakePage({ gotoMs: 30 }))
    const { shots } = shooter(source)
    const a = pending(shots.request(target('janice')))
    const b = pending(shots.request(target('dotlan')))
    await flush()
    expect([a.ahead(), b.ahead()]).toEqual([0, 1])
    expect(shots.queued).toBe(2)
    shotOf(await a.done)
    expect(b.ahead()).toBe(0)
    shotOf(await b.done)
    expect(peak()).toBe(1)
    expect(pages.map((p) => p.url)).toEqual(['https://janice.example.com/p', 'https://dotlan.example.com/p'])
  })

  it('joins the same address and serves the cache, but fresh skips the cache', async () => {
    const { source, pages } = fakeSource()
    const { shots } = shooter(source)
    const first = pending(shots.request(target('janice')))
    const joined = shots.request(target('janice'))
    expect(joined).toMatchObject({ status: 'queued', joined: true })
    const shot = shotOf(await first.done)
    expect(shots.request(target('janice'))).toEqual({ status: 'cached', shot })
    expect(shots.cached('https://janice.example.com/p')).toBe(shot)
    const again = pending(shots.request(target('janice'), { fresh: true }))
    expect(again.joined).toBe(false)
    shotOf(await again.done)
    expect(pages).toHaveLength(2)
  })

  it('answers busy from the elapsed time and the queue like before', async () => {
    const { source } = fakeSource(() => new FakePage({ gotoMs: 20 }))
    const { shots } = shooter(source, { now: () => 1_000_000 })
    expect(shots.request(target('janice'), { receivedAt: 1_000_000 - 200_000 })).toMatchObject({ status: 'busy' })
    expect(shots.request(target('janice'), { receivedAt: 1_000_000 - 100_000 }).status).toBe('queued')
  })

  it('keeps the legacy log wording for br only', async () => {
    const { source } = fakeSource(() => new FakePage({ status: 500 }))
    const { shots, logger } = shooter(source)
    await outcomeOf(shots.request({ ...target('br'), siteName: 'BR 工具战报' }))
    expect(logger.warnings[0]).toContain('战报截图失败（http 500）')
    await outcomeOf(shots.request(target('janice')))
    expect(logger.warnings[1]).toContain('截图失败（janice 站，http 500）')
  })
})

describe('SiteScreenshotter max wait per site', () => {
  it('uses profile.maxWaitSec as the goto and render limit', async () => {
    const { source, pages } = fakeSource()
    const { shots } = shooter(source)
    shotOf(await outcomeOf(shots.request(target('br', { maxWaitSec: 120 }))))
    const timeout = pages[0].gotoOptions!.timeout!
    expect(timeout).toBeLessThanOrEqual(120_000)
    expect(timeout).toBeGreaterThan(119_000)
    shotOf(await outcomeOf(shots.request(target('janice', { maxWaitSec: 45 }))))
    expect(pages[1].gotoOptions!.timeout!).toBeLessThanOrEqual(45_000)
  })

  it('times out at the limit of the site, not at a global one', async () => {
    const { source } = fakeSource(() => new FakePage({ hangGoto: true }))
    const { shots } = shooter(source)
    const started = Date.now()
    const outcome = await outcomeOf(shots.request(target('br', { maxWaitSec: 0.1 })))
    expect(outcome).toMatchObject({ ok: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('queue estimate: each task counts with its own limit, other sites stay at 60 seconds', async () => {
    const { source } = fakeSource(() => new FakePage({ gotoMs: 30 }))
    const { shots } = shooter(source, { now: () => 1_000_000 })
    const at = (sec: number) => ({ receivedAt: 1_000_000 - sec * 1000 })
    // 120 秒的网站：已过 130 秒就来不及（130 + 120 > 240）；60 秒的网站同样情况还来得及
    expect(shots.request(target('br', { maxWaitSec: 120 }), at(130))).toMatchObject({ status: 'busy' })
    expect(shots.request(target('janice', { maxWaitSec: 60 }), at(130)).status).toBe('queued')
  })

  it('queue estimate adds the limits of the tasks ahead', async () => {
    const { source } = fakeSource(() => new FakePage({ gotoMs: 50 }))
    const { shots } = shooter(source, { now: () => 1_000_000 })
    const first = shots.request(target('br', { maxWaitSec: 120 }))
    // 120 + 60 = 180 ≤ 240
    const second = shots.request(target('janice', { maxWaitSec: 60 }))
    expect(first.status).toBe('queued')
    expect(second.status).toBe('queued')
    // 120 + 60 + 120 > 240
    expect(shots.request(target('dotlan', { maxWaitSec: 120 })).status).toBe('busy')
    await Promise.all([outcomeOf(first), outcomeOf(second)])
  })
})

describe('SiteScreenshotter step diagnostics', () => {
  it('records status and open time as soon as goto returns, and says it was stuck waiting for the network', async () => {
    const { source } = fakeSource(() => new FakePage({ gotoMs: 30, hangIdle: true }))
    const { shots } = shooter(source)
    const outcome = await outcomeOf(shots.request(target('br', { maxWaitSec: 0.3 })))
    if (outcome.ok) throw new Error('应该超时')
    expect(outcome.reason).toBe('timeout')
    expect(outcome.diag).toMatchObject({ status: 200, stage: 'idle' })
    expect(outcome.diag!.openMs).toBeGreaterThanOrEqual(25)
    expect(outcome.diag!.steps).toEqual([{ stage: 'goto', ms: outcome.diag!.openMs }])
    expect(outcome.diag!.elapsedMs).toBeGreaterThanOrEqual(outcome.diag!.openMs!)
  })

  it('stuck in goto: no status, no open time, stage goto', async () => {
    const { source } = fakeSource(() => new FakePage({ hangGoto: true }))
    const { shots } = shooter(source)
    const outcome = await outcomeOf(shots.request(target('br', { maxWaitSec: 0.1 })))
    if (outcome.ok) throw new Error('应该超时')
    expect(outcome.diag).toMatchObject({ stage: 'goto' })
    expect(outcome.diag!.status).toBeUndefined()
    expect(outcome.diag!.openMs).toBeUndefined()
    expect(outcome.diag!.steps).toBeUndefined()
  })

  it('a successful shot lists every finished step in order and has no stage', async () => {
    const { source } = fakeSource(() => new FakePage({ gotoMs: 5 }))
    const { shots } = shooter(source)
    const shot = shotOf(await outcomeOf(shots.request(target('janice'))))
    expect(shot.diag.stage).toBeUndefined()
    expect(shot.diag.steps!.map((s) => s.stage)).toEqual(['goto', 'idle', 'settle', 'shoot'])
    expect(shot.diag.openMs).toBe(shot.diag.steps![0].ms)
  })

  it('a growing page gets a grow step between settle and shoot', async () => {
    const { source } = fakeSource(() => new FakePage({ heightOf: (vh) => vh, hidden: [600, 0] }))
    const { shots } = shooter(source)
    const shot = shotOf(await outcomeOf(shots.request(target('br', { growViewport: true, settleMs: 3000 }))))
    expect(shot.diag.steps!.map((s) => s.stage)).toEqual(['goto', 'idle', 'settle', 'grow', 'shoot'])
  })

  it('an HTTP error keeps the status and open time and is not stuck anywhere', async () => {
    const { source } = fakeSource(() => new FakePage({ status: 500 }))
    const { shots } = shooter(source)
    const outcome = await outcomeOf(shots.request(target('br')))
    if (outcome.ok) throw new Error('应该失败')
    expect(outcome.diag).toMatchObject({ status: 500 })
    expect(outcome.diag!.openMs).toBeGreaterThanOrEqual(0)
    expect(outcome.diag!.stage).toBeUndefined()
  })
})

describe('SiteScreenshotter hideFixedTexts', () => {
  it('looks for the floating bars after the page settled and before the shot', async () => {
    const { source, pages } = fakeSource()
    const { shots } = shooter(source)
    shotOf(await outcomeOf(shots.request(target('dotlan', { hideFixedTexts: ['EveMaps subscription'] }))))
    const calls = pages[0].calls
    expect(calls.filter((c) => c === 'hideFixed')).toHaveLength(1)
    expect(calls.indexOf('hideFixed')).toBeGreaterThan(calls.lastIndexOf('probe'))
    expect(calls.indexOf('hideFixed')).toBeLessThan(calls.indexOf('screenshot'))
    expect(pages[0].expressions.find((e) => e.includes("'fixed'"))).toContain('"evemaps subscription"')
  })

  it('costs nothing for profiles without it', async () => {
    const { source, pages } = fakeSource()
    const { shots } = shooter(source)
    shotOf(await outcomeOf(shots.request(target('janice'))))
    expect(pages[0].calls).not.toContain('hideFixed')
  })
})
