// Renderer：页面队列（总数、战报名额）、单次渲染时限、无论成败都关闭页面、HTML 截图的步骤、图片尺寸。
// 全部用假页面和假时钟，不需要浏览器。

import type { Page } from 'puppeteer-core'
import { describe, expect, it, vi } from 'vitest'
import type { BrScreenshotterOptions } from '../../src/render/br'
import {
  PageQueue, RenderError, createRenderer, imageSize, isRenderError, puppeteerPages, toImageBuffer,
} from '../../src/render'
import type { PageRequest, RenderPage, Renderer, ShotOptions } from '../../src/render'
import { FakeTime, flush } from '../fakes/fake-time'

/** 只有文件头的 PNG（imageSize 只读 IHDR） */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'latin1')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/** 只有 APP0 和 SOF0 的 JPEG 头 */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Behaviour {
  setContent?: () => Promise<void>
  shot?: (options?: ShotOptions) => Uint8Array | string
  close?: () => Promise<void>
}

class FakePage implements RenderPage {
  readonly calls: string[] = []
  readonly handlers: Array<(request: PageRequest) => void> = []
  shotOptions?: ShotOptions
  closed = 0

  constructor(private readonly behaviour: Behaviour = {}) {}

  async setViewport(v: { width: number; height: number; deviceScaleFactor?: number }) {
    this.calls.push(`viewport ${v.width}x${v.height}@${v.deviceScaleFactor}`)
  }

  async setJavaScriptEnabled(enabled: boolean) {
    this.calls.push(`javascript ${enabled}`)
  }

  async setRequestInterception(enabled: boolean) {
    this.calls.push(`intercept ${enabled}`)
  }

  on(event: 'request', handler: (request: PageRequest) => void) {
    this.calls.push(`on ${event}`)
    this.handlers.push(handler)
    return this
  }

  async setContent(html: string, options?: { waitUntil?: string; timeout?: number }) {
    this.calls.push(`content ${options?.waitUntil} ${options?.timeout}`)
    await this.behaviour.setContent?.()
  }

  async goto() {
    return null
  }

  async evaluate() {
    return undefined
  }

  async screenshot(options?: ShotOptions) {
    this.calls.push(`screenshot ${options?.type}`)
    this.shotOptions = options
    return this.behaviour.shot?.(options) ?? png(1600, 900)
  }

  async close() {
    this.calls.push('close')
    this.closed++
    await this.behaviour.close?.()
  }
}

function setup(behaviour: Behaviour = {}, extra: { limits?: { total: number; br: number } } = {}) {
  const time = new FakeTime()
  const pages: FakePage[] = []
  const logger = { debug: vi.fn(), warn: vi.fn() }
  let enabled = true
  const renderer = createRenderer({
    pages: () => (enabled ? async () => {
      const page = new FakePage(behaviour)
      pages.push(page)
      return page
    } : undefined),
    scheduler: time,
    logger,
    limits: extra.limits,
    closeWaitMs: 1000,
  })
  return { time, pages, logger, renderer, disable: () => (enabled = false) }
}

/** 一个一直占着页面、直到 release() 才结束的任务 */
function hold(renderer: Renderer, kind: 'local' | 'br' = 'local') {
  const gate = deferred()
  let started = false
  const done = renderer.withPage(async () => {
    started = true
    await gate.promise
    return kind
  }, { kind, timeoutMs: 60_000 })
  return { done, release: () => gate.resolve(), get started() { return started } }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('应该失败')
}

describe('screenshotHtml', () => {
  it('turns JavaScript off, blocks every request except data:, sets the viewport and closes the page', async () => {
    const { renderer, pages } = setup()
    const image = await renderer.screenshotHtml('<p>hi</p>', { width: 800, height: 450, scale: 2, timeoutMs: 5000 })
    expect(pages).toHaveLength(1)
    expect(pages[0].calls).toEqual([
      'javascript false', 'on request', 'intercept true', 'viewport 800x450@2', 'content load 5000', 'screenshot png', 'close',
    ])
    expect(pages[0].shotOptions).toEqual({ type: 'png' })
    expect(image).toMatchObject({ mime: 'image/png', width: 1600, height: 900 })
    expect(Buffer.isBuffer(image.data)).toBe(true)

    const request = (url: string, handled = false) => ({
      url: () => url,
      abort: vi.fn(async () => undefined),
      continue: vi.fn(async () => undefined),
      isInterceptResolutionHandled: () => handled,
    })
    const external = request('https://example.invalid/font.woff2')
    const inline = request('data:image/png;base64,AAAA')
    const done = request('https://example.invalid/x', true)
    for (const r of [external, inline, done]) pages[0].handlers[0](r)
    expect(external.abort).toHaveBeenCalledOnce()
    expect(external.continue).not.toHaveBeenCalled()
    expect(inline.continue).toHaveBeenCalledOnce()
    expect(inline.abort).not.toHaveBeenCalled()
    expect(done.abort).not.toHaveBeenCalled()
    expect(done.continue).not.toHaveBeenCalled()
  })

  it('jpeg with quality; the bytes come back as a Buffer covering only the image', async () => {
    const backing = new Uint8Array(4096)
    const shot = jpeg(1440, 4000)
    backing.set(shot, 100)
    const view = backing.subarray(100, 100 + shot.length)
    const { renderer, pages } = setup({ shot: () => view })
    const image = await renderer.screenshotHtml('<p>hi</p>', { width: 1440, height: 4000, type: 'jpeg', quality: 85, timeoutMs: 5000 })
    expect(pages[0].shotOptions).toEqual({ type: 'jpeg', quality: 85 })
    expect(image).toMatchObject({ mime: 'image/jpeg', width: 1440, height: 4000 })
    expect(Buffer.isBuffer(image.data)).toBe(true)
    expect(image.data.byteLength).toBe(shot.length)
    expect(image.data.equals(shot)).toBe(true)
  })

  it('accepts a base64 screenshot from older puppeteer and rejects bytes that are not an image', async () => {
    const ok = setup({ shot: () => png(10, 20).toString('base64') })
    expect(await ok.renderer.screenshotHtml('', { width: 10, height: 20, timeoutMs: 100 })).toMatchObject({ width: 10, height: 20 })
    const bad = setup({ shot: () => Buffer.from('not an image') })
    const error = await rejection(bad.renderer.screenshotHtml('', { width: 10, height: 20, timeoutMs: 100 }))
    expect(isRenderError(error, 'failed')).toBe(true)
    expect(bad.pages[0].closed).toBe(1)
  })
})

describe('withPage', () => {
  it('says the screenshot service is unavailable without puppeteer', async () => {
    const { renderer, disable } = setup()
    expect(renderer.available()).toBe(true)
    disable()
    expect(renderer.available()).toBe(false)
    const error = await rejection(renderer.withPage(async () => 1, { timeoutMs: 100 }))
    expect(isRenderError(error, 'unavailable')).toBe(true)
    expect((error as Error).message).toBe('截图服务没有启动')
  })

  it('closes the page when the work fails and reports it as failed', async () => {
    const { renderer, pages } = setup()
    const error = await rejection(renderer.withPage(async () => {
      throw new Error('boom')
    }, { timeoutMs: 100 }))
    expect(error).toBeInstanceOf(RenderError)
    expect(error).toMatchObject({ kind: 'failed', message: 'boom' })
    expect(pages[0].closed).toBe(1)
    expect(renderer.queued()).toBe(0)
  })

  it('times out a hanging render, closes the page and frees the slot', async () => {
    const { renderer, pages, time } = setup({ setContent: () => new Promise(() => undefined) })
    const pending = rejection(renderer.screenshotHtml('', { width: 1, height: 1, timeoutMs: 20_000 }))
    await time.advance(19_999)
    expect(renderer.queued()).toBe(1)
    await time.advance(1)
    const error = await pending
    expect(isRenderError(error, 'timeout')).toBe(true)
    expect(pages[0].closed).toBe(1)
    expect(renderer.queued()).toBe(0)
    expect(time.pending).toBe(0)
  })

  it('closes a page that only opens after the time limit', async () => {
    const time = new FakeTime()
    const late = deferred<RenderPage>()
    const renderer = createRenderer({ pages: () => () => late.promise, scheduler: time })
    const pending = rejection(renderer.withPage(async () => 1, { timeoutMs: 100 }))
    await time.advance(100)
    expect(isRenderError(await pending, 'timeout')).toBe(true)
    const page = new FakePage()
    late.resolve(page)
    await flush()
    expect(page.closed).toBe(1)
  })

  it('a page that opens only after the time limit keeps its slot until it is closed: a slow browser never gets more than 2 pages', async () => {
    const time = new FakeTime()
    const logger = { debug: vi.fn(), warn: vi.fn() }
    let live = 0
    let peak = 0
    let opened = 0
    // 打开一个页面要 300 毫秒，比时限（50 毫秒）长得多
    const factory = () => new Promise<RenderPage>((resolve) => {
      live++
      peak = Math.max(peak, live)
      time.timeout(() => {
        opened++
        resolve(new FakePage({ close: async () => { live-- } }))
      }, 300)
    })
    const renderer = createRenderer({ pages: () => factory, scheduler: time, logger, closeWaitMs: 1000 })
    const runs = Array.from({ length: 10 }, () => rejection(renderer.withPage(async () => 1, { timeoutMs: 50 })))
    for (let i = 0; i < 40; i++) await time.advance(50)
    const errors = await Promise.all(runs)
    expect(errors.every((e) => isRenderError(e, 'timeout'))).toBe(true)
    expect(peak).toBe(2)
    expect(opened).toBe(10)
    expect(live).toBe(0)
    expect(renderer.queued()).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('a page that never opens gives its slot back after the close wait, with a log line', async () => {
    const time = new FakeTime()
    const logger = { debug: vi.fn(), warn: vi.fn() }
    const renderer = createRenderer({ pages: () => () => new Promise<RenderPage>(() => undefined), scheduler: time, logger, closeWaitMs: 1000, limits: { total: 1, br: 1 } })
    const first = rejection(renderer.withPage(async () => 1, { timeoutMs: 50 }))
    const second = rejection(renderer.withPage(async () => 2, { timeoutMs: 50 }))
    await time.advance(50)
    expect(isRenderError(await first, 'timeout')).toBe(true)
    expect(renderer.queued()).toBe(2)
    await time.advance(999)
    expect(renderer.queued()).toBe(2)
    await time.advance(1)
    expect(logger.warn).toHaveBeenCalledWith('打开页面超过 1000 毫秒还没好，不再等它（名额先还回去）')
    await time.advance(50)
    expect(isRenderError(await second, 'timeout')).toBe(true)
  })

  it('does not wait forever for a page that will not close', async () => {
    const { renderer, logger, time } = setup({ close: () => new Promise(() => undefined) })
    let done = false
    const run = renderer.withPage(async () => 'ok', { timeoutMs: 100 }).then((v) => {
      done = true
      return v
    })
    await time.advance(999)
    expect(done).toBe(false)
    await time.advance(1)
    expect(await run).toBe('ok')
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(renderer.queued()).toBe(0)
  })

  it('ignores errors from closing the page', async () => {
    const { renderer, logger } = setup({ close: async () => { throw new Error('target closed') } })
    expect(await renderer.withPage(async () => 'ok', { timeoutMs: 100 })).toBe('ok')
    expect(logger.debug).toHaveBeenCalledWith('关闭页面出错：target closed')
  })

  it('can be cancelled while rendering and while queued', async () => {
    const { renderer, pages } = setup({ setContent: () => new Promise(() => undefined) }, { limits: { total: 1, br: 1 } })
    const running = new AbortController()
    const first = rejection(renderer.screenshotHtml('', { width: 1, height: 1, timeoutMs: 60_000, signal: running.signal }))
    const queued = new AbortController()
    const second = rejection(renderer.withPage(async () => 1, { timeoutMs: 100, signal: queued.signal }))
    await flush()
    expect(renderer.queued()).toBe(2)
    queued.abort()
    expect(isRenderError(await second, 'aborted')).toBe(true)
    running.abort()
    expect(isRenderError(await first, 'aborted')).toBe(true)
    expect(pages).toHaveLength(1)
    expect(pages[0].closed).toBe(1)
    expect(renderer.queued()).toBe(0)
  })
})

describe('page queue', () => {
  it('at most 2 pages, at most 1 of them for battle reports; a waiting report does not block a chart', async () => {
    const { renderer } = setup()
    const br1 = hold(renderer, 'br')
    await flush()
    const br2 = hold(renderer, 'br')
    const chart1 = hold(renderer)
    await flush()
    expect([br1.started, br2.started, chart1.started]).toEqual([true, false, true])
    const chart2 = hold(renderer)
    await flush()
    expect(chart2.started).toBe(false)
    expect(renderer.queued()).toBe(4)
    expect(renderer.queued('br')).toBe(2)

    // 图先结束：名额给排在前面、但战报名额已满的 br2 不行，给 chart2
    chart1.release()
    await flush()
    expect([br2.started, chart2.started]).toEqual([false, true])
    br1.release()
    await flush()
    expect(br2.started).toBe(true)
    br2.release()
    chart2.release()
    expect(await Promise.all([br1.done, br2.done, chart1.done, chart2.done])).toEqual(['br', 'br', 'local', 'local'])
    expect(renderer.queued()).toBe(0)
  })

  it('PageQueue keeps the limits sane', () => {
    expect(new PageQueue({ total: 0, br: 5 })).toMatchObject({ total: 1, br: 1 })
    expect(new PageQueue({ total: 3, br: 9 })).toMatchObject({ total: 3, br: 3 })
    expect(new PageQueue()).toMatchObject({ total: 2, br: 1 })
  })
})

describe('dispose', () => {
  it('cancels queued work, aborts running work (closing its pages) and refuses new work', async () => {
    const { renderer, pages } = setup({ setContent: () => new Promise(() => undefined) }, { limits: { total: 2, br: 1 } })
    const report = rejection(renderer.withPage(() => new Promise(() => undefined), { kind: 'br', timeoutMs: 60_000 }))
    const running = rejection(renderer.screenshotHtml('', { width: 1, height: 1, timeoutMs: 60_000 }))
    const queued = rejection(renderer.withPage(async () => 1, { timeoutMs: 100 }))
    await flush()
    await renderer.dispose()
    // dispose 结束时页面都已经关了
    expect(pages.map((p) => p.closed)).toEqual([1, 1])
    expect(isRenderError(await report, 'aborted')).toBe(true)
    expect(isRenderError(await running, 'aborted')).toBe(true)
    expect(isRenderError(await queued, 'aborted')).toBe(true)
    expect(renderer.available()).toBe(false)
    expect(isRenderError(await rejection(renderer.withPage(async () => 1, { timeoutMs: 100 })), 'aborted')).toBe(true)
    expect(renderer.queued()).toBe(0)
  })
})

describe('puppeteerPages', () => {
  it('reads the service on every call and calls page() on it', async () => {
    let service: unknown
    const source = puppeteerPages(() => service)
    expect(source()).toBeUndefined()
    service = { notPage: 1 }
    expect(source()).toBeUndefined()
    const page = new FakePage()
    service = {
      opened: 0,
      async page(this: { opened: number }) {
        this.opened++
        return page
      },
    }
    expect(await source()!()).toBe(page)
    expect(service).toMatchObject({ opened: 1 })
  })
})

describe('imageSize', () => {
  it('reads PNG and JPEG headers', () => {
    expect(imageSize(png(1600, 900))).toEqual({ width: 1600, height: 900 })
    expect(imageSize(jpeg(1440, 4000))).toEqual({ width: 1440, height: 4000 })
    expect(imageSize(Buffer.from('GIF89a'))).toBeNull()
    expect(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull()
  })

  it('toImageBuffer copies nothing but never hands out a wider view', () => {
    const backing = new Uint8Array(64)
    const view = backing.subarray(8, 24)
    const buf = toImageBuffer(view)
    expect(buf.byteLength).toBe(16)
    expect(buf.byteOffset).toBe(8)
    const already = Buffer.from('abc')
    expect(toImageBuffer(already)).toBe(already)
    expect(toImageBuffer(Buffer.from('xyz').toString('base64')).toString()).toBe('xyz')
  })
})

describe('types', () => {
  it('a puppeteer Page is a RenderPage, and the renderer is all the battle report screenshotter needs', () => {
    // 只在类型检查时有意义：Koishi puppeteer 服务给的页面能直接用；渲染器能直接交给战报截图
    const asRenderPage = (page: Page): RenderPage => page
    const asBrRenderer = (renderer: Renderer): BrScreenshotterOptions['renderer'] => renderer
    expect(typeof asRenderPage).toBe('function')
    expect(typeof asBrRenderer).toBe('function')
  })
})
