// 战报截图的兼容层（§2.11、§6.9）。真正的截图器是 site-shot.ts 的 SiteScreenshotter（所有网站共用）；
// 这里的 BrScreenshotter 只认 br.evetools.org 的规范化战报链接，页面参数取名单里 BR 工具的那一份
// （视口 1440×900、网络安静最多等 6 秒、稳定 1.5 秒、最多 2 张 × 4000 = 8000 像素）。
// 排队、缓存、同一链接共用、页面名额的规则见 site-shot.ts。

import { BR_MAX_HEIGHT, BR_SEGMENT_HEIGHT } from '../constants'
import { BUILTIN_SITES } from '../core/sites'
import type { ShotProfile } from '../core/sites'
import { BR_HOST, parseBrLink } from '../core/universe/br-link'
import { SiteScreenshotter, splitHeight } from './site-shot'
import type { ShotFailureReason, ShotOutcome, ShotRequestOptions, ShotTicket, SiteScreenshotterOptions, SiteShot } from './site-shot'

export { splitHeight }

export type BrShot = SiteShot
export type BrFailureReason = ShotFailureReason
export type BrOutcome = ShotOutcome
export type BrTicket = ShotTicket
export type BrRequestOptions = Pick<ShotRequestOptions, 'receivedAt'>
export type BrScreenshotterOptions = SiteScreenshotterOptions

const BR_SITE = BUILTIN_SITES.find((site) => site.id === 'br')!
const BR_PROFILE: ShotProfile = { ...BR_SITE.profile, maxImages: Math.round(BR_MAX_HEIGHT / BR_SEGMENT_HEIGHT) }

export class BrScreenshotter {
  private readonly inner: SiteScreenshotter

  constructor(options: BrScreenshotterOptions) {
    this.inner = new SiteScreenshotter(options)
  }

  /** 队列里的任务数（含正在截的） */
  get queued() {
    return this.inner.queued
  }

  /** 10 分钟内截过的结果；不排队 */
  cached(input: string): BrShot | undefined {
    const link = parseBrLink(input)
    return link ? this.inner.cached(link.url) : undefined
  }

  /** 截一个战报链接。input 必须整个是战报链接（先用 findBrLink 从消息里找出来） */
  request(input: string, options: BrRequestOptions = {}): BrTicket {
    const link = parseBrLink(input)
    if (!link) return { status: 'invalid' }
    return this.inner.request(
      { url: link.url, siteId: BR_SITE.id, siteName: BR_SITE.name, profile: BR_PROFILE, allowHosts: [BR_HOST] },
      { receivedAt: options.receivedAt },
    )
  }

  /** 插件停用：排队的任务不再执行，正在截的页面关掉（等它们关完），缓存清空 */
  dispose() {
    return this.inner.dispose()
  }
}
