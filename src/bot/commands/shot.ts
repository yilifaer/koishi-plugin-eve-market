// 截图：「截图 <网址>」，或者 @机器人 的消息里带名单里网站的链接（后置中间件改成这个命令再执行，每个网站单独开关）。
// 名单、识别规则见 core/sites；每条消息只处理第一个能截的链接；回复里只写网站名字，不回显链接。
// 排队、慢提示、发图、失败的说法见 shot-send.ts。

import { JANICE_CODE_PATTERN } from '../../constants'
import { janicePageUrl } from '../../core/janice'
import type { SiteRegistry } from '../../core/sites'
import type { Card } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { badLinkText, shootLink, sitesOf } from './shot-send'
import { SHOT } from './text'

const HAS_LINK = /https?:\/\//i
// 「截图 janice <编号>」：「估价」卡片上的按钮用，按钮里不放网址；编号区分大小写
const JANICE_FORM = new RegExp(`^janice\\s+(${JANICE_CODE_PATTERN})$`, 'i')

export function registerShot(commands: CommandContext): void {
  commands.registry.register('shot', { args: '[link:text]', needsArgs: true, description: '截图：给网站链接截图（直接 @我 发链接也行）' })
    ?.action(async ({ session }, link) => {
      if (!session) return
      await invoke(commands, 'shot', session, (inv) => runShot(inv, typeof link === 'string' ? link : ''))
    })
}

async function runShot(inv: Invocation, text: string): Promise<void> {
  const sites = sitesOf(inv.commands)
  const janice = JANICE_FORM.exec(text.trim())
  // 重新拼出估价页的地址再走名单的识别；Janice 在控制台关掉了就和别的不在名单里的网站一样
  const link = janice ? sites.parse(janicePageUrl(janice[1])) : sites.find(text)
  if (janice && !link) return void await inv.reply.text(SHOT.notListed(siteNames(sites)))
  if (!link) {
    const site = sites.mentioned(text)
    if (site) await inv.reply.text(badLinkText(site))
    else if (HAS_LINK.test(text)) await inv.reply.text(SHOT.notListed(siteNames(sites)))
    else await sendCard(inv, usageCard(inv, sites))
    return
  }
  await shootLink(inv, link)
}

/** 能截的网站名字（纯文字，不含网址） */
export function siteNames(sites: SiteRegistry): string {
  return sites.sites.map((s) => s.name).join('、') || '暂时没有'
}

function usageCard(inv: Invocation, sites: SiteRegistry): Card {
  const name = escapeMarkdown(inv.commands.registry.name('shot'))
  const card = emptyCard(SHOT.usageTitle)
  card.sections.push({
    lines: [
      { text: `${name} 加上网址：把网页截图发到群里` },
      { text: `能截的网站：${escapeMarkdown(siteNames(sites))}` },
      ...(sites.sites.some((s) => s.auto) ? [{ text: '也可以直接 @我 发这些网站的链接，不用写命令' }] : []),
      { text: '长页面最多分成几张图；同一个链接 10 分钟内再发很快' },
    ],
  })
  return card
}
