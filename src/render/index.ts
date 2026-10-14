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
export { SiteScreenshotter } from './site-shot'
export type {
  ShotDiag, ShotFailureReason, ShotOutcome, ShotRequestOptions, ShotTarget, ShotTicket, SiteScreenshotterOptions, SiteShot,
} from './site-shot'
export { installNetGuard } from './net-guard'
export type { NetGuard, NetGuardOptions, NetGuardStats } from './net-guard'
export { BAND_COLORS, BAND_NAMES, bandsPng } from './bands'
export type { BandsOptions } from './bands'
export { createKbCards, headlineFontSize, kbCardHtml, kbCardKey } from './kb-card'
export type { KbCardShotOptions, KbCardView, KbCards, KbCardsOptions } from './kb-card'
export { beijingDate, countText, iskShort, kbCardText, utcDate } from './kb-text'
