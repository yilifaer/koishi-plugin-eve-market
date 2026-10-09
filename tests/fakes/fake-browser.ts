// 假的 Koishi puppeteer 服务：page() 开一个假页面（满足 render 的最小页面接口），不启动浏览器。
// 截图返回只有文件头的假 PNG / JPEG（宽高按视口和缩放、或者 clip 算），最后一个字节是编号，用来区分是哪一张。
// 战报页面按 goto 的地址查表决定状态码和页面高度；可以卡住截图或打开页面（测慢提示），也可以让截图出错。

import type { PageRequest, RenderPage, ShotOptions } from '../../src/render'

/** 只有 IHDR 的假 PNG */
export function fakePng(width: number, height: number, tag: number): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const size = Buffer.alloc(8)
  size.writeUInt32BE(width, 0)
  size.writeUInt32BE(height, 4)
  return Buffer.concat([head, size, Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0, tag & 0xff])])
}

/** 只有 SOF0 段的假 JPEG */
export function fakeJpeg(width: number, height: number, tag: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9, tag & 0xff])
}

export interface FakeSite {
  status?: number
  height?: number
  /** goto 抛出的错误（例如 net::ERR_NAME_NOT_RESOLVED） */
  error?: string
}

/** 可以从外面放行的等待 */
export interface Gate {
  promise: Promise<void>
  open(): void
}

export function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

export class FakeBrowser {
  readonly pages: FakePage[] = []
  /** 地址 → 页面；没有的地址按 200、高度 2000 */
  readonly sites = new Map<string, FakeSite>()
  /** 截图前等它放行 */
  holdShot?: Gate
  /** 打开页面（goto）前等它放行 */
  holdGoto?: Gate
  /** 截图出错 */
  shotError?: string
  private tag = 0

  /** Koishi 的 puppeteer 服务只用到这个方法 */
  page = async (): Promise<RenderPage> => {
    const page = new FakePage(this)
    this.pages.push(page)
    return page
  }

  /** 还没关闭的页面 */
  get open(): number {
    return this.pages.filter((p) => !p.closed).length
  }

  nextTag(): number {
    return ++this.tag
  }
}

export class FakePage implements RenderPage {
  closed = false
  html?: string
  url?: string
  javaScript = true
  viewport?: { width: number; height: number; deviceScaleFactor?: number }
  readonly shots: ShotOptions[] = []

  constructor(private readonly browser: FakeBrowser) {}

  async setViewport(viewport: { width: number; height: number; deviceScaleFactor?: number }) {
    this.viewport = viewport
  }

  async setJavaScriptEnabled(enabled: boolean) {
    this.javaScript = enabled
  }

  async setRequestInterception() {}

  on(_event: 'request', _handler: (request: PageRequest) => void) {
    return this
  }

  async setContent(html: string) {
    this.html = html
  }

  async goto(url: string) {
    this.url = url
    await this.browser.holdGoto?.promise
    const site = this.browser.sites.get(url) ?? {}
    if (site.error) throw new Error(site.error)
    return { status: () => site.status ?? 200 }
  }

  async evaluate() {
    const site = this.url ? this.browser.sites.get(this.url) : undefined
    return [site?.height ?? 2000, true]
  }

  async screenshot(options: ShotOptions = {}) {
    this.shots.push(options)
    await this.browser.holdShot?.promise
    if (this.browser.shotError) throw new Error(this.browser.shotError)
    const tag = this.browser.nextTag()
    if (options.type === 'jpeg') {
      // 和新版 puppeteer 一样返回 Uint8Array，而且是一大块内存上的视图：交给机器人的必须只是这一段
      const bytes = fakeJpeg(options.clip?.width ?? this.viewport?.width ?? 0, options.clip?.height ?? this.viewport?.height ?? 0, tag)
      const pool = new Uint8Array(bytes.length + 64)
      pool.set(bytes, 32)
      return new Uint8Array(pool.buffer, 32, bytes.length)
    }
    const scale = this.viewport?.deviceScaleFactor ?? 1
    return fakePng((this.viewport?.width ?? 0) * scale, (this.viewport?.height ?? 0) * scale, tag)
  }

  async close() {
    this.closed = true
  }
}
