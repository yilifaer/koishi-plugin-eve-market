// 出图和截图的接线：Koishi 的 puppeteer 服务（可选）→ 页面队列（走势图和战报共用 2 个页面，战报最多占 1 个）、
// 走势图的内存缓存、战报截图。puppeteer 每次用的时候才用 ctx.get('puppeteer') 取，插件启动后才启用也能用；
// 没有 puppeteer 时走势只发文字卡片，战报回复「截图服务没有启动」。插件停用时取消排队、关掉所有页面。

import type { Logger } from '../core/ports'
import { BrScreenshotter, createChartImages, createRenderer } from '../render'
import type { ChartImages, PageFactory, Renderer } from '../render'

export interface Media {
  renderer: Renderer
  charts: ChartImages
  br: BrScreenshotter
  dispose(): Promise<void>
}

export interface MediaOptions {
  /** 每次出图时现取页面来源；没有 puppeteer 时返回 undefined */
  pages: () => PageFactory | undefined
  logger: Logger
  /** 收到消息的时间用的时钟（和 session.timestamp 一样是本机时间）；默认 Date.now */
  now?: () => number
}

export function createMedia(options: MediaOptions): Media {
  const renderer = createRenderer({ pages: options.pages, logger: options.logger })
  const charts = createChartImages(renderer)
  const br = new BrScreenshotter({ renderer, logger: options.logger, now: options.now })
  let disposed: Promise<void> | undefined
  return {
    renderer,
    charts,
    br,
    dispose() {
      disposed ??= Promise.allSettled([br.dispose(), renderer.dispose()]).then(() => charts.clear())
      return disposed
    },
  }
}
