// 走势图出图：SVG 包成一个完全自包含的 HTML 页面（不引用任何外部资源，内容安全策略也禁止加载），
// 交给 Renderer 截成 PNG（800×450 CSS 像素、2 倍分辨率 → 1600×900）。
// 出好的图放进内存 LRU（CHART_LRU_SIZE 张，用到一次就算最近用过），键是 SVG 本身的摘要：
// 图上的标题、地点、窗口、每一个点都一样才算同一张图（换了市场、过了 UTC 零点、历史更新了都会重新出图）。
// 同一张图正在出的时候，后来的请求共用这一次。

import { createHash } from 'node:crypto'
import { CHART_HEIGHT, CHART_LRU_SIZE, CHART_RENDER_TIMEOUT_MS, CHART_SCALE, CHART_WIDTH } from '../constants'
import { LruCache, SingleFlight } from '../core/util'
import { DEFAULT_PALETTE } from './chart-svg'
import type { RenderedImage, Renderer } from './renderer'

export interface ChartPageOptions {
  width?: number
  height?: number
  /** 页面底色，和图的背景一样，边缘不留白线 */
  background?: string
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/** SVG → 自包含 HTML。页面大小正好是图的大小，不滚动 */
export function chartPage(svg: string, options: ChartPageOptions = {}): string {
  const width = options.width ?? CHART_WIDTH
  const height = options.height ?? CHART_HEIGHT
  const background = options.background ?? DEFAULT_PALETTE.background
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<style>html,body{margin:0;padding:0;background:${background};width:${width}px;height:${height}px;overflow:hidden}svg{display:block}</style>`,
    '</head>',
    `<body>${svg}</body>`,
    '</html>',
  ].join('\n')
}

export interface ChartShotOptions {
  timeoutMs?: number
  signal?: AbortSignal
  background?: string
}

/** 截一张走势图（PNG）。失败时抛 RenderError */
export function renderChart(renderer: Renderer, svg: string, options: ChartShotOptions = {}): Promise<RenderedImage> {
  return renderer.screenshotHtml(chartPage(svg, { background: options.background }), {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    scale: CHART_SCALE,
    type: 'png',
    timeoutMs: options.timeoutMs ?? CHART_RENDER_TIMEOUT_MS,
    signal: options.signal,
  })
}

/** 缓存键：SVG 的摘要（SVG 完全决定了截出来的图） */
export function chartKey(svg: string): string {
  return createHash('sha256').update(svg).digest('base64url')
}

export interface ChartImages {
  /** 缓存里有就直接给（记为最近用过），没有就出图 */
  get(svg: string, options?: ChartShotOptions): Promise<RenderedImage>
  /** 只看缓存：有就给（记为最近用过），没有时 undefined，不出图 */
  cached(svg: string): RenderedImage | undefined
  /** 这张图正在出 */
  rendering(svg: string): boolean
  clear(): void
}

export function createChartImages(renderer: Renderer, max = CHART_LRU_SIZE): ChartImages {
  const cache = new LruCache<string, RenderedImage>({ max })
  const flights = new SingleFlight<string, RenderedImage>()
  return {
    get(svg, options) {
      const key = chartKey(svg)
      const hit = cache.get(key)
      if (hit) return Promise.resolve(hit)
      return flights.run(key, async () => {
        const image = await renderChart(renderer, svg, options)
        cache.set(key, image)
        return image
      })
    },
    cached: (svg) => cache.get(chartKey(svg)),
    rendering: (svg) => flights.has(chartKey(svg)),
    clear: () => cache.clear(),
  }
}
