// 截图测试（管理员）：「截图测试 <网址>」。识别同「截图」，但不用缓存；先发一张检查卡片，再发图。
// 卡片：网站、自动截图开关、HTTP 状态、用时、页面标题、页面高度、截了几张、验证页、拦下的跳转和内网请求个数；
// 失败时写原因代码和对应的说法。用来在生产机上核对 Warbeacon、Janice、DOTLAN 的页面参数。
// 只对管理员存在（在哪个群都行，和样式自检一样）；页面标题用 safeEcho，不会回显网址。

import type { Session } from 'koishi'
import type { SiteInfo } from '../../core/sites'
import type { ShotDiag, ShotOutcome } from '../../render'
import { buildAccess } from '../scope'
import type { Card, Line } from '../view/card'
import { safeEcho } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { badLinkText, failureText, shootLink, sitesOf } from './shot-send'
import { siteNames } from './shot'
import { SHOT } from './text'

const HAS_LINK = /https?:\/\//i
const yesNo = (v: boolean) => (v ? '是' : '否')

export function registerShotProbe(commands: CommandContext): void {
  const only = (session: Session) => buildAccess(session, commands.settings.access).isAdmin
  commands.registry.register('shotProbe', { args: '[link:text]', description: '截图测试：不用缓存截一次，并发检查结果（管理员）', hidden: true, only })
    ?.action(async ({ session }, link) => {
      if (!session || !only(session)) return
      await invoke(commands, 'shotProbe', session, (inv) => runProbe(inv, typeof link === 'string' ? link : ''))
    })
}

async function runProbe(inv: Invocation, text: string): Promise<void> {
  const sites = sitesOf(inv.commands)
  const link = sites.find(text)
  if (!link) {
    const site = sites.mentioned(text)
    if (site) await inv.reply.text(badLinkText(site))
    else if (HAS_LINK.test(text)) await inv.reply.text(SHOT.notListed(siteNames(sites)))
    else await inv.reply.text(`${inv.commands.registry.name('shotProbe')} 加上网址：不用缓存截一次，并发检查结果`)
    return
  }
  await shootLink(inv, link, {
    fresh: true,
    // 提示后面至少还要发卡片和 1 张图
    reserve: 2,
    report: async (outcome) => {
      await sendCard(inv, probeCard(link.site, outcome))
    },
  })
}

function probeCard(site: SiteInfo, outcome: ShotOutcome): Card {
  const diag: Partial<ShotDiag> = outcome.ok ? outcome.shot.diag : outcome.diag ?? {}
  const lines: Line[] = [
    { text: `网站：${site.name}（自动截图${site.auto ? '开' : '关'}）` },
    { text: `HTTP 状态：${diag.status ? diag.status : '没有'}` },
    { text: `打开用时：${diag.elapsedMs === undefined ? '未知' : `${(diag.elapsedMs / 1000).toFixed(1)} 秒`}` },
    { text: `页面标题：${diag.title ? safeEcho(diag.title) : '（没有）'}` },
  ]
  if (outcome.ok) {
    const { shot } = outcome
    lines.push({ text: `页面高度：${shot.pageHeight} 像素` })
    lines.push({ text: `截图：${shot.images.length} 张（最多 ${site.profile.maxImages} 张）${shot.truncated ? '，页面过长，后面截掉了' : ''}` })
  }
  lines.push({ text: `验证页：${yesNo(diag.challenge === true)}` })
  lines.push({ text: `拦下的跳转：${diag.blockedRedirects ?? 0} 个，拦下的内网请求：${diag.blockedPrivate ?? 0} 个` })
  if (!outcome.ok) {
    const reply = failureText(site, outcome)
    lines.push({ text: `失败原因：${outcome.reason}${reply ? `（${reply}）` : ''}` })
  }
  const card = emptyCard(`**截图测试**${outcome.ok ? '' : ' · 失败'}`)
  card.sections.push({ lines })
  return card
}
