// 战报截图（§2.11、§6.9）。只打开 br.evetools.org 的规范化地址（防止被用来访问任意网址）。
// 排队：战报页面同一时间最多 1 个；按「从收到消息算起」估算完成时间（已过去的时间 +（前面的任务数 + 1）× 60 秒），
// 超过 240 秒直接回答繁忙，不排队。同一链接 10 分钟内用缓存；正在截的同一链接共用一次结果。
// 截图：视口 1440 宽、缩放 1；networkidle2，再最多等 1.5 秒让页面稳定；按页面高度用 clip 分段截 JPEG，
// 每段不超过 4000 像素，最多 8000 像素，再长的部分截掉并标出。
// 页面的事都交给 Renderer.withPage：和走势图共用页面名额（战报最多占 1 个）、单次渲染最多 60 秒（拿到名额才开始算，
// 不算排队）、无论成败都关闭页面。这里只管缓存、同一链接共用、排队估算和截图步骤，不 import puppeteer。

import {
  BR_CACHE_MAX, BR_CACHE_MIN, BR_JPEG_QUALITY, BR_MAX_HEIGHT, BR_PAGES, BR_QUEUE_REJECT_SEC, BR_QUEUE_TASK_SEC,
  BR_RENDER_TIMEOUT_MS, BR_SEGMENT_HEIGHT, BR_SETTLE_MS, BR_VIEWPORT_HEIGHT, BR_VIEWPORT_WIDTH,
} from '../constants'
import type { Logger, Scheduler } from '../core/ports'
import { parseBrLink } from '../core/universe/br-link'
import { LruCache, imageSize, sleep } from '../core/util'
import { isRenderError, realScheduler, toImageBuffer } from './renderer'
import type { RenderPage, RenderedImage, Renderer } from './renderer'

// ------------------------------------------------------------------ 结果

export interface BrShot {
  /** 规范化后的链接 */
  url: string
  /** JPEG，按从上到下的顺序，最多 BR_MAX_HEIGHT / BR_SEGMENT_HEIGHT 段；尺寸从图片头里读 */
  images: RenderedImage[]
  /** 页面实际高度 */
  pageHeight: number
  /** 截到的高度；页面超过 BR_MAX_HEIGHT 时只截前面这一段，truncated = true */
  keptHeight: number
  truncated: boolean
  capturedAt: number
}

export type BrFailureReason =
  /** puppeteer 没有启用 */
  | 'no-browser'
  /** 单次渲染时限内没有打开或没有截完 */
  | 'timeout'
  /** 网站返回 4xx / 5xx（见 status） */
  | 'http'
  /** 域名解析失败、连接被拒这类网络错误 */
  | 'unreachable'
  /** 其他：浏览器出错、页面是空的、截出来的不是图片 */
  | 'failed'
  /** 插件停用了 */
  | 'closed'

export type BrOutcome =
  | { ok: true; shot: BrShot }
  | { ok: false; reason: BrFailureReason; status?: number; message?: string }

export type BrTicket =
  /** 不是战报链接，什么都没做 */
  | { status: 'invalid' }
  /** 10 分钟内截过 */
  | { status: 'cached'; shot: BrShot }
  /** 排上也来不及在回复时限内完成，没有排队；queued = 队列里已有的任务数 */
  | { status: 'busy'; queued: number }
  /** 排上了（joined = 同一链接已经在截，共用结果）；ahead() = 现在前面还有几个任务 */
  | { status: 'queued'; joined: boolean; ahead: () => number; done: Promise<BrOutcome> }

export interface BrRequestOptions {
  /** 收到用户消息的时间（毫秒，和 now 同一个时钟）；不写 = 刚收到 */
  receivedAt?: number
}

export interface BrScreenshotterOptions {
  /** 页面来源和页面队列（和走势图共用；没有 puppeteer 时 withPage 抛 unavailable） */
  renderer: Pick<Renderer, 'withPage'>
  logger?: Logger
  /** 默认 Date.now */
  now?: () => number
  /** 等页面稳定时用；默认真实的定时器 */
  scheduler?: Scheduler
  // 下面几项默认取 constants，测试里调小
  renderTimeoutMs?: number
  settleMs?: number
  settlePollMs?: number
  segmentHeight?: number
  maxHeight?: number
  cacheMs?: number
  cacheMax?: number
}

/** 页面稳定：每隔这么久读一次高度，连续 STABLE_READS 次不变（且已加载完）就开始截图 */
const SETTLE_POLL_MS = 250
const STABLE_READS = 2

/** 页面高度和是否加载完 */
const PROBE = `(() => {
  const d = document.documentElement
  const b = document.body
  return [Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0), document.readyState === 'complete']
})()`

/** 把截到的高度分成几段：每段不超过 segment，尽量一样高（不留几像素的细条） */
export function splitHeight(height: number, segment: number): Array<{ y: number; height: number }> {
  if (!(height > 0)) return []
  const count = Math.ceil(height / segment)
  const each = Math.ceil(height / count)
  const out: Array<{ y: number; height: number }> = []
  for (let y = 0; y < height; y += each) out.push({ y, height: Math.min(each, height - y) })
  return out
}

/** Renderer 抛出的错误 → 失败的原因（浏览器自己的错误放在 cause 里） */
function failureOf(error: unknown): BrOutcome {
  if (isRenderError(error)) {
    if (error.kind === 'unavailable') return { ok: false, reason: 'no-browser' }
    if (error.kind === 'aborted') return { ok: false, reason: 'closed' }
    if (error.kind === 'timeout') return { ok: false, reason: 'timeout', message: error.message }
  }
  const cause = isRenderError(error) && error.cause !== undefined ? error.cause : error
  const message = error instanceof Error ? error.message : String(error)
  // goto 自己的导航超时（puppeteer 的 TimeoutError）
  if (cause instanceof Error && cause.name === 'TimeoutError') return { ok: false, reason: 'timeout', message }
  if (/\bnet::ERR_/.test(message)) return { ok: false, reason: 'unreachable', message }
  return { ok: false, reason: 'failed', message }
}

export class BrScreenshotter {
  private readonly renderer: Pick<Renderer, 'withPage'>
  private readonly logger?: Logger
  private readonly now: () => number
  private readonly scheduler: Scheduler
  private readonly renderTimeoutMs: number
  private readonly settleMs: number
  private readonly settlePollMs: number
  private readonly segmentHeight: number
  private readonly maxHeight: number
  private readonly cache: LruCache<string, BrShot>
  /** 排队和正在截的链接，按先后顺序（同一链接只有一个任务；真正的排队在 Renderer 的页面队列里，也是先来先得） */
  private readonly queue: string[] = []
  private readonly flights = new Map<string, Promise<BrOutcome>>()
  private readonly stop = new AbortController()

  constructor(options: BrScreenshotterOptions) {
    this.renderer = options.renderer
    this.logger = options.logger
    this.now = options.now ?? Date.now
    this.scheduler = options.scheduler ?? realScheduler
    this.renderTimeoutMs = options.renderTimeoutMs ?? BR_RENDER_TIMEOUT_MS
    this.settleMs = options.settleMs ?? BR_SETTLE_MS
    this.settlePollMs = options.settlePollMs ?? SETTLE_POLL_MS
    this.segmentHeight = options.segmentHeight ?? BR_SEGMENT_HEIGHT
    this.maxHeight = options.maxHeight ?? BR_MAX_HEIGHT
    this.cache = new LruCache({
      max: options.cacheMax ?? BR_CACHE_MAX,
      ttlMs: options.cacheMs ?? BR_CACHE_MIN * 60_000,
      now: this.now,
    })
  }

  /** 队列里的任务数（含正在截的） */
  get queued() {
    return this.queue.length
  }

  /** 10 分钟内截过的结果；不排队 */
  cached(input: string): BrShot | undefined {
    const link = parseBrLink(input)
    return link ? this.cache.get(link.url) : undefined
  }

  /** 截一个战报链接。input 必须整个是战报链接（先用 findBrLink 从消息里找出来） */
  request(input: string, options: BrRequestOptions = {}): BrTicket {
    const link = parseBrLink(input)
    if (!link) return { status: 'invalid' }
    if (this.stop.signal.aborted) return { status: 'busy', queued: 0 }
    const key = link.url
    const hit = this.cache.get(key)
    if (hit) return { status: 'cached', shot: hit }

    // 同一链接正在排或正在截：按那个任务的位置估算
    const flight = this.flights.get(key)
    const ahead = this.ahead(flight ? key : undefined)
    const elapsedSec = options.receivedAt === undefined ? 0 : Math.max(0, (this.now() - options.receivedAt) / 1000)
    if (elapsedSec + (ahead + 1) * BR_QUEUE_TASK_SEC > BR_QUEUE_REJECT_SEC) return { status: 'busy', queued: this.queue.length }
    if (flight) return { status: 'queued', joined: true, ahead: () => this.ahead(key), done: flight }

    this.queue.push(key)
    const done = this.capture(key)
      .then((outcome) => {
        if (outcome.ok) this.cache.set(key, outcome.shot)
        else if (outcome.reason !== 'closed') {
          const status = outcome.status ? ` ${outcome.status}` : ''
          this.logger?.warn(`战报截图失败（${outcome.reason}${status}）：${key}${outcome.message ? `：${outcome.message}` : ''}`)
        }
        return outcome
      })
      .finally(() => {
        const index = this.queue.indexOf(key)
        if (index >= 0) this.queue.splice(index, 1)
        this.flights.delete(key)
      })
    this.flights.set(key, done)
    return { status: 'queued', joined: false, ahead: () => this.ahead(key), done }
  }

  /** 插件停用：排队的任务不再执行，正在截的页面关掉（等它们关完），缓存清空 */
  async dispose() {
    this.stop.abort()
    this.cache.clear()
    await Promise.allSettled([...this.flights.values()])
  }

  /** 前面还有几个任务；不给 key = 新任务排在最后 */
  private ahead(key?: string): number {
    const index = key === undefined ? this.queue.length : this.queue.indexOf(key)
    if (index < 0) return 0
    return Math.max(0, index - (BR_PAGES - 1))
  }

  /** 单次渲染（Renderer 负责排队、时限和关闭页面）；失败也返回结果，不抛出 */
  private async capture(url: string): Promise<BrOutcome> {
    try {
      return await this.renderer.withPage((page, signal) => this.shoot(page, url, signal), {
        kind: 'br',
        timeoutMs: this.renderTimeoutMs,
        signal: this.stop.signal,
      })
    } catch (error) {
      return failureOf(error)
    }
  }

  private async shoot(page: RenderPage, url: string, signal: AbortSignal): Promise<BrOutcome> {
    const started = this.now()
    const width = BR_VIEWPORT_WIDTH
    await page.setViewport({ width, height: BR_VIEWPORT_HEIGHT, deviceScaleFactor: 1 })
    const timeout = Math.max(1, this.renderTimeoutMs - (this.now() - started))
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout })
    const status = response ? response.status() : 0
    if (status >= 400) return { ok: false, reason: 'http', status }

    const pageHeight = await this.settle(page, signal)
    if (!(pageHeight > 0)) return { ok: false, reason: 'failed', message: '页面是空的' }
    const keptHeight = Math.min(pageHeight, this.maxHeight)
    const images: RenderedImage[] = []
    for (const part of splitHeight(keptHeight, this.segmentHeight)) {
      // clip 超出视口的部分也要截（不改视口高度，免得按视口高度排版的页面变形）
      const raw = await page.screenshot({
        type: 'jpeg',
        quality: BR_JPEG_QUALITY,
        clip: { x: 0, y: part.y, width, height: part.height },
        captureBeyondViewport: true,
      })
      // Uint8Array 可能是一大块内存上的视图：按 byteOffset、byteLength 转成 Buffer
      const data = toImageBuffer(raw)
      const size = imageSize(data)
      if (!size) return { ok: false, reason: 'failed', message: '截图结果不是图片' }
      images.push({ data, mime: 'image/jpeg', ...size })
    }
    return { ok: true, shot: { url, images, pageHeight, keptHeight, truncated: pageHeight > keptHeight, capturedAt: this.now() } }
  }

  /**
   * 最多等 settleMs：高度连续几次不变、并且已经加载完就算稳定，返回最后读到的高度。
   * 没等到稳定也照样截（BR 的内容通常在 networkidle2 时已经出来了）。
   */
  private async settle(page: RenderPage, signal: AbortSignal): Promise<number> {
    let [height] = await this.probe(page)
    let stable = 0
    const rounds = Math.ceil(this.settleMs / this.settlePollMs)
    for (let i = 0; i < rounds && stable < STABLE_READS; i++) {
      await sleep(this.scheduler, this.settlePollMs, signal)
      const [next, complete] = await this.probe(page)
      stable = next === height && complete && next > 0 ? stable + 1 : 0
      height = next
    }
    return height
  }

  private async probe(page: RenderPage): Promise<[number, boolean]> {
    const value = await page.evaluate(PROBE)
    if (!Array.isArray(value)) return [0, false]
    const height = Number(value[0])
    return [Number.isFinite(height) ? Math.ceil(height) : 0, value[1] === true]
  }
}
