// 战报（§2.11）：「战报 <战报链接>」（BR 工具、Warbeacon），或者 @机器人 的消息里带战报链接（后置中间件改成这个命令再执行）。
// 击杀转战报：「战报 击杀 <编号> [warbeacon|wb|br]」「战报 <zKill 链接> [warbeacon|wb|br]」先取击杀摘要，再按所在星系和时间截相关战报（默认 BR 工具）。
// - 每条消息只处理第一个有效链接；只打开规范化后的地址；回复里不回显链接。
// - 排队、慢提示、发图、失败的说法见 shot-send.ts（BR 工具的链接沿用战报的文案）。
// - 别的网站的链接（Janice 等）提示用「截图」；没有 puppeteer 时回复「截图服务没有启动」并写日志。

import { parseKillArg } from '../../core/killmail'
import type { KillLink } from '../../core/killmail'
import { findBrLink, mentionsBrHost } from '../../core/universe'
import type { SiteInfo } from '../../core/sites'
import type { Card } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { loadKill } from './kill'
import { badLinkText, ensureBrowser, shootLink, sitesOf } from './shot-send'
import { BR, KILL, SHOT } from './text'

const isReport = (site: SiteInfo) => site.kind === 'battle-report'

export function registerBr(commands: CommandContext): void {
  commands.registry.register('br', { args: '[link:text]', needsArgs: true, description: '战报：战报网站（BR 工具、Warbeacon）的截图（直接 @我 发链接也行）' })
    ?.action(async ({ session }, link) => {
      if (!session) return
      await invoke(commands, 'br', session, (inv) => runBr(inv, typeof link === 'string' ? link : ''))
    })
}

async function runBr(inv: Invocation, text: string): Promise<void> {
  const kill = parseKillReport(text)
  if (kill === 'bad') return void await inv.reply.text(KILL.badArg)
  if (kill) return runKillReport(inv, kill)
  const sites = sitesOf(inv.commands)
  const link = sites.find(text, isReport)
  if (link) return shootLink(inv, link)
  // BR 工具在控制台里关掉了
  if (!sites.sites.some((s) => s.id === 'br') && findBrLink(text)) return void await inv.reply.text(SHOT.brOff)
  if (mentionsBrHost(text)) return void await inv.reply.text(BR.badLink)
  const mentioned = sites.mentioned(text)
  if (mentioned && isReport(mentioned)) return void await inv.reply.text(badLinkText(mentioned))
  // 别的网站的有效链接
  if (sites.find(text)) return void await inv.reply.text(SHOT.notBattleReport(inv.commands.registry.name('shot')))
  await sendCard(inv, usageCard(inv, sites.sites.filter(isReport)))
}

interface KillReport {
  link: KillLink
  site: 'br' | 'warbeacon'
}

/**
 * 「击杀 <编号或链接> [站点]」，或者整段就是 zKill / 欧服击杀链接加可选的站点（不分大小写，默认 BR）。
 * 写了「击杀」但后面不对 → 'bad'；不是击杀的写法 → null
 */
function parseKillReport(text: string): KillReport | 'bad' | null {
  const m = /^(?:(击杀)\s+)?(\S+)(?:\s+(warbeacon|wb|br))?$/i.exec(text.trim())
  if (!m) return /^击杀(?:\s|$)/.test(text.trim()) ? 'bad' : null
  const link = parseKillArg(m[2])
  const site = m[3] && m[3].toLowerCase() !== 'br' ? 'warbeacon' : 'br'
  if (m[1]) return link ? { link, site } : 'bad'
  return link && link.source !== 'id' ? { link, site } : null
}

/** 取击杀摘要 → 战报地址 → 和「战报 <链接>」一样的截图流程（排队、慢提示、发图、失败的说法） */
async function runKillReport(inv: Invocation, { link, site }: KillReport): Promise<void> {
  const sites = sitesOf(inv.commands)
  if (!sites.sites.some((s) => s.id === site)) return void await inv.reply.text(KILL.siteOff)
  if (!(await ensureBrowser(inv))) return
  const summary = await loadKill(inv, link, KILL.reportHint)
  if (!summary) return
  const url = inv.core.kills.relatedUrls(summary)[site]
  if (!url) return void await inv.reply.text(summary.abyssal ? KILL.abyssal : KILL.noReport)
  const target = sites.parse(url)
  if (!target) return void await inv.reply.text(KILL.noReport)
  await shootLink(inv, target)
}

function usageCard(inv: Invocation, reports: readonly SiteInfo[]): Card {
  const name = escapeMarkdown(inv.commands.registry.name('br'))
  const names = reports.map((s) => s.name).join('、') || 'BR 工具'
  const card = emptyCard(BR.usageTitle)
  card.sections.push({
    lines: [
      { text: `${name} 加上战报链接（${escapeMarkdown(names)}）：截图发到群里` },
      { text: '也可以直接 @我 发战报链接，不用写命令' },
      { text: `${name} 击杀 编号：按击杀的星系和时间截战报（后面可加 warbeacon）` },
      { text: '长战报会分成两张图；同一个链接 10 分钟内再发很快' },
    ],
  })
  return card
}
