// 走势图页面：自包含 HTML、截图参数、PNG 缓存（同一张图只出一次，用到就算最近用过）、缓存键。

import { describe, expect, it } from 'vitest'
import { CHART_COLORS_LIGHT, CHART_RENDER_TIMEOUT_MS } from '../../src/constants'
import { RenderError, chartKey, chartPage, createChartImages, renderChart } from '../../src/render'
import type { HtmlShotOptions, RenderedImage, Renderer } from '../../src/render'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450"/></svg>'

function image(tag: string): RenderedImage {
  return { data: Buffer.from(tag), mime: 'image/png', width: 1600, height: 900 }
}

/** 只记录 screenshotHtml 的调用；每次返回一个新 deferred，由测试决定什么时候完成 */
function fakeRenderer() {
  const calls: Array<{ html: string; options: HtmlShotOptions; resolve: (img: RenderedImage) => void; reject: (e: unknown) => void }> = []
  const renderer: Renderer = {
    available: () => true,
    queued: () => calls.length,
    withPage: () => Promise.reject(new Error('不该调用')),
    screenshotHtml: (html, options) => new Promise((resolve, reject) => calls.push({ html, options, resolve, reject })),
    dispose: async () => undefined,
  }
  return { renderer, calls }
}

describe('chartPage', () => {
  it('wraps the SVG into a page with no external resources at exactly the chart size', () => {
    const html = chartPage(SVG)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`)
    expect(html).toContain(`background:${CHART_COLORS_LIGHT.background};width:800px;height:450px;overflow:hidden`)
    expect(html).toContain(`<body>${SVG}</body>`)
    // 除了 SVG 的命名空间，没有任何网址、外链、脚本
    expect(html.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:|<link|<script|src=|href=|@import/)
    expect(chartPage(SVG, { width: 10, height: 20, background: '#000' })).toContain('background:#000;width:10px;height:20px')
  })
})

describe('renderChart', () => {
  it('asks for an 800×450 PNG at 2× within the chart time limit', async () => {
    const { renderer, calls } = fakeRenderer()
    const pending = renderChart(renderer, SVG)
    expect(calls).toHaveLength(1)
    expect(calls[0].html).toBe(chartPage(SVG))
    expect(calls[0].options).toEqual({ width: 800, height: 450, scale: 2, type: 'png', timeoutMs: CHART_RENDER_TIMEOUT_MS, signal: undefined })
    calls[0].resolve(image('a'))
    expect(await pending).toEqual(image('a'))
  })
})

/** 不同的「图」：SVG 里写上标记 */
const svgOf = (tag: string) => SVG.replace('<rect', `<text>${tag}</text><rect`)

describe('createChartImages', () => {
  it('renders each SVG once: concurrent requests share it, later ones hit the cache', async () => {
    const { renderer, calls } = fakeRenderer()
    const charts = createChartImages(renderer)
    const first = charts.get(SVG)
    const second = charts.get(SVG)
    expect(charts.rendering(SVG)).toBe(true)
    expect(calls).toHaveLength(1)
    calls[0].resolve(image('k'))
    expect(await first).toBe(await second)
    expect(charts.rendering(SVG)).toBe(false)
    expect(await charts.get(SVG)).toEqual(image('k'))
    expect(calls).toHaveLength(1)
    expect(charts.cached(SVG)).toEqual(image('k'))
    expect(charts.cached(svgOf('other'))).toBeUndefined()
    charts.clear()
    expect(charts.cached(SVG)).toBeUndefined()
  })

  it('does not cache failures, and keeps at most max images', async () => {
    const { renderer, calls } = fakeRenderer()
    const charts = createChartImages(renderer, 2)
    const failed = charts.get(svgOf('x'))
    calls[0].reject(new RenderError('timeout'))
    await expect(failed).rejects.toMatchObject({ kind: 'timeout' })
    expect(charts.cached(svgOf('x'))).toBeUndefined()

    for (const key of ['a', 'b', 'c']) {
      const pending = charts.get(svgOf(key))
      calls.at(-1)!.resolve(image(key))
      await pending
    }
    expect(['a', 'b', 'c'].map((k) => charts.cached(svgOf(k))?.data.toString())).toEqual([undefined, 'b', 'c'])
  })

  it('a cache hit counts as recently used: a popular chart is not dropped first', async () => {
    const { renderer, calls } = fakeRenderer()
    const charts = createChartImages(renderer, 2)
    const render = async (key: string) => {
      const pending = charts.get(svgOf(key))
      calls.at(-1)!.resolve(image(key))
      await pending
    }
    await render('a')
    await render('b')
    expect(charts.cached(svgOf('a'))?.data.toString()).toBe('a')
    await render('c')
    expect(['a', 'b', 'c'].map((k) => charts.cached(svgOf(k))?.data.toString())).toEqual(['a', undefined, 'c'])
    // get 命中也一样
    await charts.get(svgOf('a'))
    await render('d')
    expect(['a', 'c', 'd'].map((k) => charts.cached(svgOf(k))?.data.toString())).toEqual(['a', undefined, 'd'])
    expect(calls).toHaveLength(4)
  })
})

describe('chartKey', () => {
  it('is a digest of the SVG: any difference on the picture is another key', () => {
    expect(chartKey(SVG)).toBe(chartKey(`${SVG}`))
    expect(chartKey(SVG)).toMatch(/^[\w-]{43}$/)
    expect(chartKey(svgOf('伏尔戈（Jita 4-4）'))).not.toBe(chartKey(svgOf('伏尔戈')))
  })
})
