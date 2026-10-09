// 真浏览器出图：用 puppeteer-core 启动本机的 Chromium（路径放在环境变量 CHROME_PATH 里，CI 在 Node 22 上装好），
// 没有浏览器时整组跳过。检查 PNG 的像素尺寸、页面一定关闭、脚本不执行、外部请求被拦截、超时。

import fs from 'node:fs'
import type { Browser } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPriceFormatter } from '../../src/core/format'
import type { HistoryPoint } from '../../src/core/types'
import { chartSvg, createRenderer, imageSize, isRenderError, renderChart } from '../../src/render'
import type { PageFactory, RenderPage } from '../../src/render'

const CHROME = process.env.CHROME_PATH
const hasChrome = !!CHROME && fs.existsSync(CHROME)

const formatter = createPriceFormatter(
  { priceDisplayMode: 'full_and_compact', compactDecimals: 2, thousandSeparator: true, showCurrency: true },
  { now: () => Date.UTC(2026, 9, 9) },
)

function points(): HistoryPoint[] {
  const out: HistoryPoint[] = []
  for (let i = 0; i < 29; i++) {
    if (i === 10 || i === 11) continue
    const average = 258_000_000 * (1 + Math.sin(i / 4) * 0.02)
    const date = new Date(Date.UTC(2026, 8, 10) + i * 86_400_000).toISOString().slice(0, 10)
    out.push({ date, average, highest: average * 1.04, lowest: average * 0.96, volume: 400 + i * 5, orderCount: 1000 })
  }
  return out
}

describe.skipIf(!hasChrome)('rendering in a real Chromium', () => {
  let browser: Browser
  let factory: PageFactory

  beforeAll(async () => {
    const puppeteer = (await import('puppeteer-core')).default
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    factory = () => browser.newPage()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  const openPages = async () => (await browser.pages()).length

  it('a 30-day chart becomes a 1600×900 PNG Buffer and the page is closed', async () => {
    const before = await openPages()
    const renderer = createRenderer({ pages: () => factory })
    const svg = chartSvg({ item: '乌鸦级 Raven', place: '伏尔戈（Jita）', days: 30, end: '2026-10-09', points: points() }, { formatter })
    const image = await renderChart(renderer, svg)
    expect(image.mime).toBe('image/png')
    expect(Buffer.isBuffer(image.data)).toBe(true)
    expect(image.data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
    expect(imageSize(image.data)).toEqual({ width: 1600, height: 900 })
    expect(image).toMatchObject({ width: 1600, height: 900 })
    // 约 100–200 KB；留宽一点，只防明显不对（空白图、整块内存）
    expect(image.data.length).toBeGreaterThan(20_000)
    expect(image.data.length).toBeLessThan(1_000_000)
    expect(await openPages()).toBe(before)
  })

  it('runs no page scripts and blocks every outside request', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() }
    let probe: unknown = 'unset'
    // 截图前在页面里看一眼脚本有没有跑过
    const watched: PageFactory = async () => {
      const page = await browser.newPage()
      const wrapped: RenderPage = {
        setViewport: (v) => page.setViewport(v),
        setJavaScriptEnabled: (e) => page.setJavaScriptEnabled(e),
        setRequestInterception: (e) => page.setRequestInterception(e),
        on: (event, handler) => page.on(event, handler),
        setContent: (html, o) => page.setContent(html, o),
        goto: (url, o) => page.goto(url, o),
        evaluate: (expression) => page.evaluate(expression),
        screenshot: async (o) => {
          probe = await page.evaluate('document.body.getAttribute("data-ran")')
          return page.screenshot(o)
        },
        close: () => page.close(),
      }
      return wrapped
    }
    const renderer = createRenderer({ pages: () => watched, logger })
    const html = '<!doctype html><html><body style="margin:0;background:#fff">'
      + '<img src="http://127.0.0.1:9/never.png" width="10" height="10">'
      + '<script>document.body.setAttribute("data-ran", "yes")</script></body></html>'
    const image = await renderer.screenshotHtml(html, { width: 200, height: 100, timeoutMs: 15_000 })
    expect(image).toMatchObject({ width: 200, height: 100, mime: 'image/png' })
    expect(probe).toBeNull()
    expect(logger.debug).toHaveBeenCalledWith('出图页面请求了外部资源，已拦截：http://127.0.0.1:9/never.png')
  })

  it('jpeg at scale 1 for long pages', async () => {
    const renderer = createRenderer({ pages: () => factory })
    const html = '<!doctype html><html><body style="margin:0;height:1200px;background:linear-gradient(#fff,#2a78d6)"></body></html>'
    const image = await renderer.screenshotHtml(html, { width: 300, height: 1200, type: 'jpeg', quality: 80, timeoutMs: 15_000 })
    expect(image).toMatchObject({ mime: 'image/jpeg', width: 300, height: 1200 })
    expect(image.data.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
  })

  it('a render that hangs times out and its page is still closed', async () => {
    const before = await openPages()
    const renderer = createRenderer({ pages: () => factory })
    const error = await renderer.withPage(() => new Promise(() => undefined), { timeoutMs: 300 }).catch((e: unknown) => e)
    expect(isRenderError(error, 'timeout')).toBe(true)
    expect(await openPages()).toBe(before)
  })
})
