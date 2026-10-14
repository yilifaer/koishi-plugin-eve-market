// 网站截图器（假页面）：各网站的页面参数、张数、等元素、隐藏元素、验证页、缓存和排队跨网站共用、fresh。
// 页面都经过真正的 Renderer（共用页面名额）；BR 自己的用例在 br.test.ts。

import { describe, expect, it } from 'vitest'
import { SHOT_SEGMENT_HEIGHT } from '../../src/constants'
import type { Logger } from '../../src/core/ports'
import type { ShotProfile } from '../../src/core/sites'
import { SiteScreenshotter } from '../../src/render/site-shot'
import type { ShotOutcome, ShotTarget, ShotTicket, SiteScreenshotterOptions } from '../../src/render/site-shot'
import { createRenderer } from '../../src/render/renderer'
import type { PageFactory, PageRequest, RenderPage, ShotOptions } from '../../src/render/renderer'

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
}

class FakePage implements RenderPage {
  readonly calls: string[] = []
  readonly expressions: string[] = []
  readonly shots: ShotOptions[] = []
  viewport?: { width: number; height: number; deviceScaleFactor?: number }
  gotoOptions?: { timeout?: number; waitUntil?: string }
  url?: string
  closed = false
  private reads = 0
  private polls = 0

  constructor(private readonly b: Behavior = {}) {}

  async setViewport(v: { width: number; height: number; deviceScaleFactor?: number }) { this.viewport = v }
  async setJavaScriptEnabled() {}
  async setRequestInterception() {}
  on(_event: 'request', _handler: (request: PageRequest) => void) { return this }
  async setContent() {}

  async goto(url: string, options?: { timeout?: number; waitUntil?: string }) {
    this.calls.push('goto')
    this.url = url
    this.gotoOptions = options
    if (this.b.gotoMs) await new Promise((resolve) => setTimeout(resolve, this.b.gotoMs))
    return { status: () => this.b.status ?? 200 }
  }

  async evaluate(expression: string) {
    this.expressions.push(expression)
    if (expression.includes('scrollHeight')) {
      this.calls.push('probe')
      const heights = this.b.heights ?? [1000]
      const h = heights[Math.min(this.reads, heights.length - 1)]
      const flags = this.b.challenge ?? [false]
      const c = flags[Math.min(this.reads, flags.length - 1)]
      this.reads++
      return [h, true, c, this.b.title ?? '']
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

const PROFILE: ShotProfile = { viewportWidth: 1440, viewportHeight: 900, waitUntil: 'networkidle2', settleMs: 20, maxImages: 2 }
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
  it('uses the viewport and waitUntil of the site profile', async () => {
    const { source, pages } = fakeSource()
    const { shots } = shooter(source)
    shotOf(await outcomeOf(shots.request(target('dotlan', { viewportWidth: 1000, viewportHeight: 600, waitUntil: 'load' }))))
    expect(pages[0].url).toBe('https://dotlan.example.com/p')
    expect(pages[0].viewport).toEqual({ width: 1000, height: 600, deviceScaleFactor: 1 })
    expect(pages[0].gotoOptions?.waitUntil).toBe('load')
    expect(pages[0].shots[0].clip!.width).toBe(1000)
  })

  it('settles for at most the profile settleMs', async () => {
    const heights = Array.from({ length: 50 }, (_, i) => 1000 + i)
    const { source, pages } = fakeSource(() => new FakePage({ heights }))
    const { shots } = shooter(source)
    await outcomeOf(shots.request(target('janice', { settleMs: 50 })))
    // 第一次读 + 最多 ceil(50 / 5) 次
    expect(pages[0].calls.filter((c) => c === 'probe').length).toBe(11)
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
    expect(shot.diag).toMatchObject({ status: 200, title: '估价结果', challenge: false, blockedRedirects: 0, blockedPrivate: 0 })
    expect(shot.diag.elapsedMs).toBeGreaterThanOrEqual(0)
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
