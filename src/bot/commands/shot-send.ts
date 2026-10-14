// 网站截图的公共部分（「截图」「战报」「截图测试」共用）：排队、慢提示、发图、失败文案。
// 规则同战报（§2.11）：只打开规范化后的地址；回复里只写网站名字，从不写链接；排队按「从收到消息算起」估算；
// 3 秒内没截完先发一次慢提示（前面有排队时写「前面还有 N 个」），然后发图；
// 提示占一条额度；页面过长截掉了、或者因为额度少发了一张时，在最后一张图下面注明。

import { createSiteRegistry } from '../../core/sites'
import type { SiteInfo, SiteLink, SiteRegistry } from '../../core/sites'
import type { ShotOutcome, ShotTarget, SiteShot } from '../../render'
import type { CommandContext, Invocation } from './context'
import { startSlowHint } from './slow'
import { BR, SHOT } from './text'

const NONE = createSiteRegistry({ sites: [] })

export const sitesOf = (commands: Pick<CommandContext, 'sites'>): SiteRegistry => commands.sites ?? NONE

export interface ShotRun {
  /** 不读缓存（截图测试） */
  fresh?: boolean
  /** 慢提示后面至少还要发几条（默认 1：一张图） */
  reserve?: number
  /** 结果出来以后、发图以前调用（截图测试在这里发检查卡片） */
  report?: (outcome: ShotOutcome) => Promise<void>
}

/** 链接格式不对的说法（BR 沿用战报的文案） */
export const badLinkText = (site: SiteInfo): string => (site.legacyText ? BR.badLink : SHOT.badLink(site.name, site.badLinkHint))

/** 失败的说法；null = 什么都不说（插件停用了） */
export function failureText(site: SiteInfo, outcome: Extract<ShotOutcome, { ok: false }>): string | null {
  const old = site.legacyText
  switch (outcome.reason) {
    case 'closed':
      return null
    case 'no-browser':
      return BR.noBrowser
    case 'blocked':
      return SHOT.blocked
    case 'redirect':
      return SHOT.redirect
    case 'timeout':
      return old ? BR.timeout : SHOT.timeout
    case 'http':
      if (!outcome.status) return old ? BR.failed : SHOT.failed
      return old ? BR.http(outcome.status) : SHOT.http(outcome.status)
    case 'unreachable':
      return old ? BR.unreachable : SHOT.unreachable
    default:
      return old ? BR.failed : SHOT.failed
  }
}

/** 没有 puppeteer：回复并写日志；有就返回 true */
export async function ensureBrowser(inv: Invocation): Promise<boolean> {
  if (inv.commands.media?.renderer.available()) return true
  inv.commands.logger.warn(BR.logNoBrowser)
  await inv.reply.text(BR.noBrowser)
  return false
}

/** 截一个已经识别出来的链接并发图 */
export async function shootLink(inv: Invocation, link: SiteLink, run: ShotRun = {}): Promise<void> {
  if (!(await ensureBrowser(inv))) return
  const { site } = link
  const sites = sitesOf(inv.commands)
  // 命令参数再复查一次：必须整个是名单里的规范化地址
  if (!sites.parse(link.url)) {
    await inv.reply.text(badLinkText(site))
    return
  }
  const target: ShotTarget = { url: link.url, siteId: site.id, siteName: site.name, profile: site.profile, allowHosts: sites.hosts }
  // 排队按「从收到消息算起」估算：用 QQ 事件的时间（和回复时限用的是同一个）
  const stamp = inv.session.timestamp
  const receivedAt = typeof stamp === 'number' && stamp > 0 ? stamp : undefined
  const ticket = inv.commands.media!.shots.request(target, { ...(receivedAt === undefined ? {} : { receivedAt }), fresh: run.fresh })
  switch (ticket.status) {
    case 'invalid':
      await inv.reply.text(badLinkText(site))
      return
    case 'busy':
      await inv.reply.text(BR.busy)
      return
    case 'cached':
      await finish(inv, site, { ok: true, shot: ticket.shot }, run)
      return
    case 'queued': {
      const base = site.legacyText ? BR.hint : SHOT.hint
      const hint = startSlowHint(inv, run.reserve ?? 1, () => {
        const ahead = ticket.ahead()
        return ahead > 0 ? `${base}${BR.ahead(ahead)}` : base
      })
      const outcome = await ticket.done.finally(() => hint.stop())
      await hint.sent()
      await finish(inv, site, outcome, run)
    }
  }
}

async function finish(inv: Invocation, site: SiteInfo, outcome: ShotOutcome, run: ShotRun): Promise<void> {
  await run.report?.(outcome)
  if (outcome.ok) return sendShot(inv, site, outcome.shot)
  if (outcome.reason === 'no-browser') inv.commands.logger.warn(BR.logNoBrowser)
  const text = failureText(site, outcome)
  if (text) await inv.reply.text(text)
}

/** 发图：张数不超过剩下的额度；截掉了（页面过长或者额度不够）在最后一张下面注明截到多少像素 */
async function sendShot(inv: Invocation, site: SiteInfo, shot: SiteShot): Promise<void> {
  const room = Math.max(1, inv.reply.remaining())
  const images = shot.images.slice(0, room)
  const shown = images.reduce((sum, img) => sum + img.height, 0)
  const cut = shot.truncated || images.length < shot.images.length
  for (let i = 0; i < images.length; i++) {
    const last = i === images.length - 1
    const caption = last && cut ? BR.truncated(shown) : undefined
    const image = images[i]
    if (!(await inv.reply.image(image.data, image.mime, caption))) {
      if (i === 0) await inv.reply.text(site.legacyText ? BR.sendFailed : SHOT.sendFailed)
      return
    }
  }
}
