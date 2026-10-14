// 网站截图（DECISIONS 的截图一条）：从原来的战报截图器参数化而来，BR 只是名单里的一个网站（br.ts 是兼容层）。
// 只打开 ShotTarget.url（识别规则从各部分重新拼出来的 https 地址），页面参数（视口、等待方式、稳定时间、张数）来自网站的 profile。
// 排队：所有网站共用一个队列和 Renderer 的外部页面名额（PageKind 'br'）；按「从收到消息算起」估算完成时间
// （已过去的时间 +（前面的任务数 + 1）× 60 秒），超过 240 秒直接回答繁忙。同一地址 10 分钟内用缓存；正在截的同一地址共用一次结果。
// 截图：视口 → goto → 状态码 → 隐藏元素 → 等元素 → 等高度稳定 → 按页面高度用 clip 分段截 JPEG，
// 每段不超过 4000 像素，最多 maxImages 段，再长的部分截掉并标出。
// 安全：截图前装网络守卫（net-guard.ts），主框架跳出名单的跳转和打内网的请求都拦下；页面像验证页（Cloudflare 一类）就放弃。
// 页面的事都交给 Renderer.withPage：单次渲染最多 60 秒（拿到名额才开始算）、无论成败都关闭页面。不 import puppeteer。

import {
  BR_CACHE_MAX, BR_CACHE_MIN, BR_JPEG_QUALITY, BR_QUEUE_REJECT_SEC, BR_QUEUE_TASK_SEC, BR_RENDER_TIMEOUT_MS, BR_PAGES,
  SHOT_NET_GUARD, SHOT_SEGMENT_HEIGHT,
} from '../constants'
import type { Logger, Scheduler } from '../core/ports'
import { hostMatches } from '../core/sites'
import type { ShotProfile } from '../core/sites'
import { LruCache, imageSize, sleep } from '../core/util'
import { installNetGuard } from './net-guard'
import type { NetGuard } from './net-guard'
import { isRenderError, realScheduler, toImageBuffer } from './renderer'
import type { RenderPage, RenderedImage, Renderer } from './renderer'

// ------------------------------------------------------------------ 结果

/** 要截的一个地址；url 必须是识别规则规范化后的 https 地址 */
export interface ShotTarget {
  url: string
  siteId: string
  /** 日志里用的网站名 */
  siteName: string
  profile: ShotProfile
  /** 主框架允许去的域名（所有启用网站的域名） */
  allowHosts: readonly string[]
}

/** 只给「截图测试」看的检查结果 */
export interface ShotDiag {
  /** 网站返回的状态码（没有响应时 0） */
  status: number
  /** 页面标题前 80 个字 */
  title: string
  /** 页面像验证页 */
  challenge: boolean
  elapsedMs: number
  blockedRedirects: number
  blockedPrivate: number
}

export interface SiteShot {
  /** 规范化后的链接 */
  url: string
  /** JPEG，按从上到下的顺序，最多 maxImages 段；尺寸从图片头里读 */
  images: RenderedImage[]
  /** 页面实际高度 */
  pageHeight: number
  /** 截到的高度；页面超过 maxImages × 每段高度时只截前面这一段，truncated = true */
  keptHeight: number
  truncated: boolean
  capturedAt: number
  diag: ShotDiag
}

export type ShotFailureReason =
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
  /** 网站弹出了验证页，不让自动截图 */
  | 'blocked'
  /** 页面跳到了名单以外的地方 */
  | 'redirect'

export type ShotOutcome =
  | { ok: true; shot: SiteShot }
  | { ok: false; reason: ShotFailureReason; status?: number; message?: string; diag?: Partial<ShotDiag> }

export type ShotTicket =
  /** 地址不合格（不是 https、主机不在名单里），什么都没做 */
  | { status: 'invalid' }
  /** 10 分钟内截过 */
  | { status: 'cached'; shot: SiteShot }
  /** 排上也来不及在回复时限内完成，没有排队；queued = 队列里已有的任务数 */
  | { status: 'busy'; queued: number }
  /** 排上了（joined = 同一地址已经在截，共用结果）；ahead() = 现在前面还有几个任务 */
  | { status: 'queued'; joined: boolean; ahead: () => number; done: Promise<ShotOutcome> }

export interface ShotRequestOptions {
  /** 收到用户消息的时间（毫秒，和 now 同一个时钟）；不写 = 刚收到 */
  receivedAt?: number
  /** 不读缓存（截图测试用）；结果照样写进缓存 */
  fresh?: boolean
}

export interface SiteScreenshotterOptions {
  /** 页面来源和页面队列（和走势图共用；没有 puppeteer 时 withPage 抛 unavailable） */
  renderer: Pick<Renderer, 'withPage'>
  logger?: Logger
  /** 默认 Date.now */
  now?: () => number
  /** 等页面稳定时用；默认真实的定时器 */
  scheduler?: Scheduler
  /** false = 不装网络守卫（只给测试用）；默认看 SHOT_NET_GUARD */
  guard?: false
  // 下面几项默认取 constants 或网站的 profile，测试里调小
  renderTimeoutMs?: number
  /** 给了就覆盖 profile.settleMs */
  settleMs?: number
  settlePollMs?: number
  segmentHeight?: number
  /** 给了就覆盖 maxImages × segmentHeight */
  maxHeight?: number
  cacheMs?: number
  cacheMax?: number
}

/** 页面稳定：每隔这么久读一次高度，连续 STABLE_READS 次不变（且已加载完）就开始截图 */
const SETTLE_POLL_MS = 250
const STABLE_READS = 2
/** 状态码是这几个时先看看是不是验证页 */
const CHALLENGE_STATUS = new Set([403, 429, 503])

/** 页面高度、是否加载完、像不像验证页、标题前 80 个字 */
const PROBE = `(() => {
  const d = document.documentElement
  const b = document.body
  const title = document.title || ''
  const challenge = /^(?:just a moment|attention required|checking your browser|verify you are human|ddos-guard|请稍候)/i.test(title) ||
    !!document.querySelector('#challenge-form, #cf-challenge-running, .cf-browser-verification, iframe[src*="challenges.cloudflare.com"], #px-captcha')
  return [Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0), document.readyState === 'complete', challenge, title.slice(0, 80)]
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
function failureOf(error: unknown): ShotOutcome {
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

interface Probe {
  height: number
  complete: boolean
  challenge: boolean
  title: string
}

export class SiteScreenshotter {
  private readonly renderer: Pick<Renderer, 'withPage'>
  private readonly logger?: Logger
  private readonly now: () => number
  private readonly scheduler: Scheduler
  private readonly guardOn: boolean
  private readonly renderTimeoutMs: number
  private readonly settleMs?: number
  private readonly settlePollMs: number
  private readonly segmentHeight: number
  private readonly maxHeight?: number
  private readonly cache: LruCache<string, SiteShot>
  /** 排队和正在截的地址，按先后顺序（同一地址只有一个任务；真正的排队在 Renderer 的页面队列里，也是先来先得） */
  private readonly queue: string[] = []
  private readonly flights = new Map<string, Promise<ShotOutcome>>()
  private readonly stop = new AbortController()

  constructor(options: SiteScreenshotterOptions) {
    this.renderer = options.renderer
    this.logger = options.logger
    this.now = options.now ?? Date.now
    this.scheduler = options.scheduler ?? realScheduler
    this.guardOn = options.guard !== false && SHOT_NET_GUARD
    this.renderTimeoutMs = options.renderTimeoutMs ?? BR_RENDER_TIMEOUT_MS
    this.settleMs = options.settleMs
    this.settlePollMs = options.settlePollMs ?? SETTLE_POLL_MS
    this.segmentHeight = options.segmentHeight ?? SHOT_SEGMENT_HEIGHT
    this.maxHeight = options.maxHeight
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
  cached(url: string): SiteShot | undefined {
    return this.cache.get(url)
  }

  /** 截一个地址 */
  request(target: ShotTarget, options: ShotRequestOptions = {}): ShotTicket {
    if (!this.acceptable(target)) return { status: 'invalid' }
    if (this.stop.signal.aborted) return { status: 'busy', queued: 0 }
    const key = target.url
    const hit = options.fresh ? undefined : this.cache.get(key)
    if (hit) return { status: 'cached', shot: hit }

    // 同一地址正在排或正在截：按那个任务的位置估算
    const flight = this.flights.get(key)
    const ahead = this.ahead(flight ? key : undefined)
    const elapsedSec = options.receivedAt === undefined ? 0 : Math.max(0, (this.now() - options.receivedAt) / 1000)
    if (elapsedSec + (ahead + 1) * BR_QUEUE_TASK_SEC > BR_QUEUE_REJECT_SEC) return { status: 'busy', queued: this.queue.length }
    if (flight) return { status: 'queued', joined: true, ahead: () => this.ahead(key), done: flight }

    this.queue.push(key)
    const done = this.capture(target)
      .then((outcome) => {
        if (outcome.ok) this.cache.set(key, outcome.shot)
        else if (outcome.reason !== 'closed') this.logger?.warn(this.failureLine(target, outcome))
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

  /** 只打开 https 地址，并且主机在名单里（识别规则已经保证，这里再复查一次） */
  private acceptable(target: ShotTarget): boolean {
    try {
      const url = new URL(target.url)
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
      return target.allowHosts.some((domain) => hostMatches(url.hostname.toLowerCase(), domain.toLowerCase()))
    } catch {
      return false
    }
  }

  private failureLine(target: ShotTarget, outcome: Extract<ShotOutcome, { ok: false }>): string {
    const status = outcome.status ? ` ${outcome.status}` : ''
    const message = outcome.message ? `：${outcome.message}` : ''
    // BR 沿用原来的日志格式
    if (target.siteId === 'br') return `战报截图失败（${outcome.reason}${status}）：${target.url}${message}`
    return `截图失败（${target.siteName}，${outcome.reason}${status}）：${target.url}${message}`
  }

  /** 前面还有几个任务；不给 key = 新任务排在最后 */
  private ahead(key?: string): number {
    const index = key === undefined ? this.queue.length : this.queue.indexOf(key)
    if (index < 0) return 0
    return Math.max(0, index - (BR_PAGES - 1))
  }

  /** 单次渲染（Renderer 负责排队、时限和关闭页面）；失败也返回结果，不抛出 */
  private async capture(target: ShotTarget): Promise<ShotOutcome> {
    try {
      return await this.renderer.withPage((page, signal) => this.shoot(page, target, signal), {
        kind: 'br',
        timeoutMs: this.renderTimeoutMs,
        signal: this.stop.signal,
      })
    } catch (error) {
      return failureOf(error)
    }
  }

  private async shoot(page: RenderPage, target: ShotTarget, signal: AbortSignal): Promise<ShotOutcome> {
    const started = this.now()
    const { profile, url } = target
    const guard: NetGuard | undefined = this.guardOn ? await installNetGuard(page, { allowHosts: target.allowHosts }) : undefined
    const diagOf = (extra: Partial<ShotDiag> = {}): Partial<ShotDiag> => ({
      elapsedMs: this.now() - started,
      blockedRedirects: guard?.stats.blockedRedirects ?? 0,
      blockedPrivate: guard?.stats.blockedPrivate ?? 0,
      ...extra,
    })
    const redirected = (): ShotOutcome | undefined =>
      guard && guard.stats.blockedRedirects > 0 ? { ok: false, reason: 'redirect', diag: diagOf() } : undefined

    const width = profile.viewportWidth
    await page.setViewport({ width, height: profile.viewportHeight, deviceScaleFactor: 1 })
    const timeout = Math.max(1, this.renderTimeoutMs - (this.now() - started))
    let response: Awaited<ReturnType<RenderPage['goto']>>
    try {
      response = await page.goto(url, { waitUntil: profile.waitUntil, timeout })
    } catch (error) {
      // 重定向被守卫拦下时 goto 会报错：这不是网络故障
      const blocked = redirected()
      if (blocked) return blocked
      throw error
    }
    const status = response ? response.status() : 0
    if (status >= 400) {
      if (CHALLENGE_STATUS.has(status)) {
        const probe = await this.probe(page)
        if (probe.challenge) return { ok: false, reason: 'blocked', status, diag: diagOf({ status, title: probe.title, challenge: true }) }
      }
      return { ok: false, reason: 'http', status, diag: diagOf({ status }) }
    }

    if (profile.hideSelectors?.length) await page.evaluate(this.hideScript(profile.hideSelectors))
    if (profile.readySelector) await this.waitReady(page, profile.readySelector, profile.readyTimeoutMs ?? 0, signal)

    const last = await this.settle(page, signal, this.settleMs ?? profile.settleMs)
    if (last.challenge) return { ok: false, reason: 'blocked', status, diag: diagOf({ status, title: last.title, challenge: true }) }
    const blocked = redirected()
    if (blocked) return blocked
    const pageHeight = last.height
    if (!(pageHeight > 0)) return { ok: false, reason: 'failed', message: '页面是空的', diag: diagOf({ status, title: last.title }) }
    const keptHeight = Math.min(pageHeight, this.maxHeight ?? profile.maxImages * this.segmentHeight)
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
      if (!size) return { ok: false, reason: 'failed', message: '截图结果不是图片', diag: diagOf({ status, title: last.title }) }
      images.push({ data, mime: 'image/jpeg', ...size })
    }
    const diag = diagOf({ status, title: last.title, challenge: false }) as ShotDiag
    return { ok: true, shot: { url, images, pageHeight, keptHeight, truncated: pageHeight > keptHeight, capturedAt: this.now(), diag } }
  }

  /** 截图前隐藏广告、横幅一类的元素（选择器是代码里写死的） */
  private hideScript(selectors: readonly string[]): string {
    const css = `${selectors.join(',')}{display:none!important}`
    return `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).appendChild(s); return true })()`
  }

  /** 每隔一会儿查一次元素有没有出现，最多等 timeoutMs；到时候没出现也照样截 */
  private async waitReady(page: RenderPage, selector: string, timeoutMs: number, signal: AbortSignal) {
    const script = `!!document.querySelector(${JSON.stringify(selector)})`
    const rounds = Math.ceil(timeoutMs / this.settlePollMs)
    for (let i = 0; i <= rounds; i++) {
      if ((await page.evaluate(script)) === true) return
      if (i < rounds) await sleep(this.scheduler, this.settlePollMs, signal)
    }
  }

  /**
   * 最多等 settleMs：高度连续几次不变、并且已经加载完就算稳定，返回最后读到的结果。
   * 没等到稳定也照样截（内容通常在 networkidle 时已经出来了）；读到验证页立刻停。
   */
  private async settle(page: RenderPage, signal: AbortSignal, settleMs: number): Promise<Probe> {
    let last = await this.probe(page)
    let stable = 0
    const rounds = Math.ceil(settleMs / this.settlePollMs)
    for (let i = 0; i < rounds && stable < STABLE_READS && !last.challenge; i++) {
      await sleep(this.scheduler, this.settlePollMs, signal)
      const next = await this.probe(page)
      stable = next.height === last.height && next.complete && next.height > 0 ? stable + 1 : 0
      last = next
    }
    return last
  }

  private async probe(page: RenderPage): Promise<Probe> {
    const value = await page.evaluate(PROBE)
    if (!Array.isArray(value)) return { height: 0, complete: false, challenge: false, title: '' }
    const height = Number(value[0])
    return {
      height: Number.isFinite(height) ? Math.ceil(height) : 0,
      complete: value[1] === true,
      challenge: value[2] === true,
      title: typeof value[3] === 'string' ? value[3] : '',
    }
  }
}
