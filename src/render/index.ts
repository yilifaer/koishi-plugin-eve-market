// 出图和截图（§3.2 render/）。只依赖一个最小的页面接口，不 import koishi，也不调 ESI。

export { PageQueue, RenderError, createRenderer, isRenderError, puppeteerPages, toImageBuffer } from './renderer'
export { imageSize } from '../core/util'
export type {
  HtmlShotOptions, ImageMime, LoadEvent, PageFactory, PageKind, PageRequest, PageTaskOptions, RenderErrorKind,
  RenderPage, RenderedImage, Renderer, RendererOptions, ShotClip, ShotOptions,
} from './renderer'
export { DEFAULT_PALETTE, chartSvg, enoughData, escapeXml, roundVolume, sparkline, textWidth, trendStats } from './chart-svg'
export type { ChartInput, ChartOptions, ChartPalette, TrendSeries, TrendStats } from './chart-svg'
export { chartKey, chartPage, createChartImages, renderChart } from './chart-page'
export type { ChartImages, ChartPageOptions, ChartShotOptions } from './chart-page'
export * from './br'
export { BAND_COLORS, BAND_NAMES, bandsPng } from './bands'
export type { BandsOptions } from './bands'
