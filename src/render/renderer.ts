// 出图和截图的公共部分：最小的页面接口（Koishi puppeteer 服务 ctx.puppeteer.page() 返回的页面满足它）、
// 页面队列（最多同时 BROWSER_PAGES 个页面，其中战报最多 BR_PAGES 个）、单次渲染的时限、无论成败都关闭页面。
// 这里不 import puppeteer：生产环境的页面来自 Koishi 的 puppeteer 服务（调用时再取，插件启动后才启用也能用），
// 测试里用假页面或 puppeteer-core。

import { BR_PAGES, BROWSER_PAGES } from '../constants'
import type { Logger, Scheduler } from '../core/ports'
import type { ImageMime } from '../core/types'
import { imageSize } from '../core/util'

// ------------------------------------------------------------------ 页面接口

export type LoadEvent = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'

/** 开了请求拦截以后收到的网络请求 */
export interface PageRequest {
  url(): string
  abort(errorCode?: string): Promise<void>
  continue(): Promise<void>
  isInterceptResolutionHandled?(): boolean
  /** 下面几个只有网络守卫用到，puppeteer 的请求都有；假请求可以不写 */
  isNavigationRequest?(): boolean
  frame?(): unknown
  redirectChain?(): unknown[]
  resourceType?(): string
}

export interface ShotClip {
  x: number
  y: number
  width: number
  height: number
}

export interface ShotOptions {
  type?: 'png' | 'jpeg'
  /** 只有 jpeg 能写 */
  quality?: number
  clip?: ShotClip
  fullPage?: boolean
  captureBeyondViewport?: boolean
}

/** 用到的页面方法；puppeteer 的 Page 满足它 */
export interface RenderPage {
  setViewport(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<void>
  setJavaScriptEnabled(enabled: boolean): Promise<void>
  setRequestInterception(enabled: boolean): Promise<void>
  on(event: 'request', handler: (request: PageRequest) => void): unknown
  setContent(html: string, options?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' }): Promise<void>
  /** 返回主文档的响应；同文档跳转时是 null */
  goto(url: string, options?: { timeout?: number; waitUntil?: LoadEvent }): Promise<{ status(): number } | null>
  /** 在页面里求一个表达式的值 */
  evaluate(expression: string): Promise<unknown>
  /** 新版 puppeteer 返回 Uint8Array，旧版返回 Buffer；指定 base64 时是字符串 */
  screenshot(options?: ShotOptions): Promise<Uint8Array | string>
  close(): Promise<void>
  /** 页面弹出的新窗口（网络守卫用来关掉它；假页面可以不写） */
  onPopup?(handler: (popup: { close(): Promise<void> } | null) => void): unknown
  /** 主框架（网络守卫用来区分主页面跳转和子框架；假页面可以不写） */
  mainFrame?(): unknown
}

/** 开一个新页面 */
export type PageFactory = () => Promise<RenderPage>

/**
 * Koishi 的 puppeteer 服务 → 页面来源。每次调用 get() 现取服务（插件启动后才启用 puppeteer 也能用），
 * 服务不在时返回 undefined。用法：puppeteerPages(() => ctx.get('puppeteer'))
 */
export function puppeteerPages(get: () => unknown): () => PageFactory | undefined {
  return () => {
    const service = get() as { page?: unknown; browser?: unknown } | null | undefined
    if (!service || typeof service.page !== 'function') return undefined
    const open = service.page as (this: unknown) => Promise<RenderPage>
    return async () => {
      // 每个页面一个独立上下文：关页面时整个上下文一起关，弹窗、Cookie、Service Worker 都不会留下
      const browser = service.browser as { createBrowserContext?: () => Promise<{ newPage(): Promise<RenderPage>; close(): Promise<void> }> } | undefined
      if (typeof browser?.createBrowserContext !== 'function') return open.call(service)
      const context = await browser.createBrowserContext()
      try {
        const page = await context.newPage()
        const close = page.close.bind(page)
        page.close = async () => {
          try {
            await close()
          } finally {
            await context.close()
          }
        }
        return page
      } catch (error) {
        await context.close().catch(() => undefined)
        throw error
      }
    }
  }
}

// ------------------------------------------------------------------ 结果和错误

export type { ImageMime }

export interface RenderedImage {
  /**
   * 正好是这张图的字节。可能是更大内存块上的视图（toImageBuffer 不复制）：Buffer 交给机器人时
   * 只按 byteOffset、byteLength 编码，不会把整块内存带出去
   */
  data: Buffer
  mime: ImageMime
  /** 像素尺寸，从图片头里读出来 */
  width: number
  height: number
}

export type RenderErrorKind =
  /** puppeteer 服务没有启用 */
  | 'unavailable'
  /** 单次渲染超时（不算排队） */
  | 'timeout'
  /** 调用方取消、插件停用 */
  | 'aborted'
  /** 浏览器出错 */
  | 'failed'

const ERROR_TEXT: Record<RenderErrorKind, string> = {
  unavailable: '截图服务没有启动',
  timeout: '渲染超时',
  aborted: '渲染已取消',
  failed: '渲染失败',
}

export class RenderError extends Error {
  readonly kind: RenderErrorKind

  constructor(kind: RenderErrorKind, message?: string, options?: { cause?: unknown }) {
    super(message ?? ERROR_TEXT[kind], options)
    this.name = 'RenderError'
    this.kind = kind
  }
}

export function isRenderError(error: unknown, kind?: RenderErrorKind): error is RenderError {
  return error instanceof RenderError && (kind === undefined || error.kind === kind)
}

/**
 * 截图结果 → 只覆盖这段数据的 Buffer（不复制）。Uint8Array 可能是一大块内存上的视图：直接交给机器人时
 * 会按 .buffer 把整块内存编码进去，转成 Buffer 以后只编码这一段
 */
export function toImageBuffer(data: Uint8Array | string): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'base64')
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

// ------------------------------------------------------------------ 页面队列

/** local：本地自包含 HTML（走势图、自检用图）；br：打开外部网站（战报和其他截图网站，名字沿用） */
export type PageKind = 'local' | 'br'

interface Waiter {
  kind: PageKind
  start(): void
  fail(reason: unknown): void
}

/** 排队时被取消：一律给 RenderError，原因放在 cause 里 */
function abortReason(signal: AbortSignal): RenderError {
  return isRenderError(signal.reason) ? signal.reason : new RenderError('aborted', undefined, { cause: signal.reason })
}

/**
 * 页面名额。总数 total 个，其中 br 类最多 br 个；先来先得，但排在前面、因为 br 名额满了而等着的战报
 * 不挡后面的走势图。
 */
export class PageQueue {
  readonly total: number
  readonly br: number
  private readonly running: Record<PageKind, number> = { local: 0, br: 0 }
  private waiters: Waiter[] = []

  constructor(limits: { total: number; br: number } = { total: BROWSER_PAGES, br: BR_PAGES }) {
    this.total = Math.max(1, Math.floor(limits.total) || 1)
    this.br = Math.min(this.total, Math.max(1, Math.floor(limits.br) || 1))
  }

  /** 正在用的名额 */
  active(kind?: PageKind): number {
    return kind ? this.running[kind] : this.running.local + this.running.br
  }

  /** 排队的任务 */
  waiting(kind?: PageKind): number {
    return kind ? this.waiters.filter((w) => w.kind === kind).length : this.waiters.length
  }

  /** 等到有名额；返回归还名额的函数（只算一次）。排队时 signal 中止就不再等，直接 reject */
  async acquire(kind: PageKind, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortReason(signal)
    if (this.canStart(kind) && !this.waiters.some((w) => w.kind === kind)) this.running[kind]++
    else await this.wait(kind, signal)
    let released = false
    return () => {
      if (released) return
      released = true
      this.running[kind]--
      this.pump()
    }
  }

  /** 排队的任务全部 reject（插件停用）；正在用的名额不受影响 */
  clear(reason: unknown) {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w.fail(reason)
  }

  private canStart(kind: PageKind): boolean {
    if (this.running.local + this.running.br >= this.total) return false
    return kind !== 'br' || this.running.br < this.br
  }

  private wait(kind: PageKind, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        reject(abortReason(signal!))
      }
      const waiter: Waiter = {
        kind,
        start: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        fail: (reason) => {
          signal?.removeEventListener('abort', onAbort)
          reject(reason)
        },
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 名额按排队顺序交给能开始的任务（名额在这里就记上，run 里不再加） */
  private pump() {
    for (let i = 0; i < this.waiters.length;) {
      const waiter = this.waiters[i]
      if (!this.canStart(waiter.kind)) {
        i++
        continue
      }
      this.waiters.splice(i, 1)
      this.running[waiter.kind]++
      waiter.start()
    }
  }
}

// ------------------------------------------------------------------ Renderer

export interface PageTaskOptions {
  /** 默认 local */
  kind?: PageKind
  /** 单次渲染的时限（从拿到名额开始算，不算排队） */
  timeoutMs: number
  /** 排队或渲染时取消 */
  signal?: AbortSignal
}

export interface HtmlShotOptions {
  /** CSS 像素 */
  width: number
  height: number
  /** 设备像素比，默认 1 */
  scale?: number
  /** 默认 png */
  type?: 'png' | 'jpeg'
  /** jpeg 的质量 */
  quality?: number
  timeoutMs: number
  signal?: AbortSignal
}

export interface Renderer {
  /** puppeteer 服务现在在不在 */
  available(): boolean
  /** 正在渲染的 + 排队的任务数；写了 kind 时只算这一类 */
  queued(kind?: PageKind): number
  /**
   * 借一个新页面执行 fn：排队、时限、无论成败都关闭页面。超时或取消时 signal 中止、页面被关掉，
   * fn 里还没完成的页面操作会失败（结果不再用）。
   * 抛出 RenderError：unavailable / timeout / aborted / failed
   */
  withPage<T>(fn: (page: RenderPage, signal: AbortSignal) => Promise<T>, options: PageTaskOptions): Promise<T>
  /** 自包含的 HTML → 图片：关闭 JavaScript，拦截所有网络请求（data: 除外） */
  screenshotHtml(html: string, options: HtmlShotOptions): Promise<RenderedImage>
  /** 插件停用：排队的任务取消，正在渲染的页面关掉 */
  dispose(): Promise<void>
}

export interface RendererOptions {
  /** 每次渲染时现取；没有 puppeteer 时返回 undefined（见 puppeteerPages） */
  pages: () => PageFactory | undefined
  scheduler?: Scheduler
  logger?: Pick<Logger, 'debug' | 'warn'>
  /** 默认 BROWSER_PAGES / BR_PAGES */
  limits?: { total: number; br: number }
  /** 关闭页面最多等多久，卡住就不管它（名额照样归还） */
  closeWaitMs?: number
}

const CLOSE_WAIT_MS = 5000
const MAX_LOG_CHARS = 200

/** 真实的定时器（测试里换成假时钟） */
export const realScheduler: Scheduler = {
  timeout(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, MAX_LOG_CHARS)
}

/** 等 work 完成；signal 先中止就立刻 reject（work 照样在后台结束，结果丢掉） */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined)
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** 拦截到的请求：data: 放行，其余一律中止（页面本来就不该引用外部资源） */
function blockRequest(request: PageRequest, logger?: Pick<Logger, 'debug'>) {
  try {
    if (request.isInterceptResolutionHandled?.()) return
    const url = request.url()
    if (url.startsWith('data:')) {
      request.continue().catch(() => undefined)
      return
    }
    logger?.debug(`出图页面请求了外部资源，已拦截：${url.slice(0, MAX_LOG_CHARS)}`)
    request.abort().catch(() => undefined)
  } catch {
    // 页面已经关了
  }
}

class PageRenderer implements Renderer {
  private readonly queue: PageQueue
  private readonly scheduler: Scheduler
  private readonly closeWaitMs: number
  /** 正在渲染的任务（停用时中止，并等它们关完页面） */
  private readonly running = new Set<AbortController>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly closed = new WeakSet<RenderPage>()
  private disposed = false

  constructor(private readonly options: RendererOptions) {
    this.queue = new PageQueue(options.limits)
    this.scheduler = options.scheduler ?? realScheduler
    this.closeWaitMs = options.closeWaitMs ?? CLOSE_WAIT_MS
  }

  available(): boolean {
    return !this.disposed && !!this.options.pages()
  }

  queued(kind?: PageKind): number {
    return this.queue.active(kind) + this.queue.waiting(kind)
  }

  async withPage<T>(fn: (page: RenderPage, signal: AbortSignal) => Promise<T>, options: PageTaskOptions): Promise<T> {
    if (this.disposed) throw new RenderError('aborted', '插件已停用')
    if (!this.options.pages()) throw new RenderError('unavailable')
    const release = await this.queue.acquire(options.kind ?? 'local', options.signal)
    const task = this.runOnPage(fn, options, release)
    this.tasks.add(task)
    task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }

  screenshotHtml(html: string, options: HtmlShotOptions): Promise<RenderedImage> {
    const type = options.type ?? 'png'
    const mime: ImageMime = type === 'jpeg' ? 'image/jpeg' : 'image/png'
    return this.withPage(async (page, signal) => {
      await page.setJavaScriptEnabled(false)
      page.on('request', (request) => blockRequest(request, this.options.logger))
      await page.setRequestInterception(true)
      await page.setViewport({ width: options.width, height: options.height, deviceScaleFactor: options.scale ?? 1 })
      await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs })
      if (signal.aborted) throw signal.reason
      const shot: ShotOptions = { type }
      if (type === 'jpeg' && options.quality !== undefined) shot.quality = options.quality
      const data = toImageBuffer(await page.screenshot(shot))
      const size = imageSize(data)
      if (!size) throw new RenderError('failed', '截图结果不是图片')
      return { data, mime, ...size }
    }, { kind: 'local', timeoutMs: options.timeoutMs, signal: options.signal })
  }

  async dispose() {
    this.disposed = true
    const reason = new RenderError('aborted', '插件已停用')
    this.queue.clear(reason)
    for (const controller of this.running) controller.abort(reason)
    await Promise.allSettled([...this.tasks])
  }

  /**
   * 在新页面上执行 fn。release 是页面名额：页面关掉以后才还。超时或取消时页面还没打开的，结果照样马上返回，
   * 名额等页面打开、关掉以后再还（最多再等 closeWaitMs），免得卡住的浏览器被越开越多的页面压垮
   */
  private async runOnPage<T>(fn: (page: RenderPage, signal: AbortSignal) => Promise<T>, options: PageTaskOptions, release: () => void): Promise<T> {
    const factory = this.options.pages()
    if (this.disposed || !factory) {
      release()
      throw this.disposed ? new RenderError('aborted', '插件已停用') : new RenderError('unavailable')
    }

    const controller = new AbortController()
    const onCancel = () => controller.abort(new RenderError('aborted'))
    options.signal?.addEventListener('abort', onCancel, { once: true })
    const cancelTimer = this.scheduler.timeout(() => {
      controller.abort(new RenderError('timeout', `${options.timeoutMs} 毫秒内没有完成`))
    }, Math.max(0, options.timeoutMs))
    this.running.add(controller)

    const opening = Promise.resolve().then(factory)
    let page: RenderPage | undefined
    try {
      const work = opening.then((opened) => {
        page = opened
        if (controller.signal.aborted) throw controller.signal.reason
        return fn(opened, controller.signal)
      })
      return await untilAborted(work, controller.signal)
    } catch (error) {
      // 超时或取消以后，页面被关掉引起的错误不算数
      if (controller.signal.aborted) throw controller.signal.reason
      if (isRenderError(error)) throw error
      throw new RenderError('failed', messageOf(error), { cause: error })
    } finally {
      cancelTimer()
      options.signal?.removeEventListener('abort', onCancel)
      this.running.delete(controller)
      if (page) {
        await this.close(page)
        release()
      } else {
        void this.closeLate(opening).then(release)
      }
    }
  }

  /** 超时以后才打开的页面：等它出来就关掉。最多等 closeWaitMs，再不出来就写日志、不再等（出来以后照样关） */
  private closeLate(opening: Promise<RenderPage>): Promise<void> {
    return new Promise<void>((resolve) => {
      const cancel = this.scheduler.timeout(() => {
        this.options.logger?.warn(`打开页面超过 ${this.closeWaitMs} 毫秒还没好，不再等它（名额先还回去）`)
        resolve()
      }, this.closeWaitMs)
      opening.then((late) => this.close(late), () => undefined).finally(() => {
        cancel()
        resolve()
      })
    })
  }

  /** 关闭页面：只关一次；出错不管，卡住最多等 closeWaitMs */
  private close(page: RenderPage): Promise<void> {
    if (this.closed.has(page)) return Promise.resolve()
    this.closed.add(page)
    return new Promise<void>((resolve) => {
      const cancel = this.scheduler.timeout(() => {
        this.options.logger?.warn(`关闭页面超过 ${this.closeWaitMs} 毫秒，不再等待`)
        resolve()
      }, this.closeWaitMs)
      Promise.resolve()
        .then(() => page.close())
        .catch((error) => this.options.logger?.debug(`关闭页面出错：${messageOf(error)}`))
        .finally(() => {
          cancel()
          resolve()
        })
    })
  }
}

export function createRenderer(options: RendererOptions): Renderer {
  return new PageRenderer(options)
}
