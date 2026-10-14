// 击杀：「击杀 <zKill 链接 | 欧服击杀链接 | 编号>」回一张击杀卡片，带「BR 战报」「Warbeacon 战报」两个按钮；
// @机器人 的消息里带击杀链接时由后置中间件改成这个命令（控制台「截图」里的开关）。
// - 战报网站在控制台关掉了、或者这个击杀没有对应的战报地址时，对应的按钮不放；两个都没有时写一句原因。
// - 按钮只写命令名、「击杀」、数字和 warbeacon；回复里不出现网址，人名、军团名先过 safeEcho。
// - 取击杀的失败说法、慢提示在 loadKill 里，「战报 击杀 …」共用。

import { MAX_BUTTON_COMMAND_CHARS, TIMEZONE } from '../../constants'
import { displaySec, zonedParts } from '../../core/format'
import type { ZonedParts } from '../../core/format'
import { parseKillArg } from '../../core/killmail'
import type { KillLink } from '../../core/killmail'
import { isFailure } from '../../core/types'
import type { CoreFailure, KillParty, KillSummary } from '../../core/types'
import type { Action, Card } from '../view/card'
import { escapeMarkdown, safeEcho } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { sitesOf } from './shot-send'
import { startSlowHint } from './slow'
import { KILL, SAY } from './text'

export function registerKill(commands: CommandContext): void {
  commands.registry.register('kill', { args: '[link:text]', needsArgs: true, description: '击杀：zKill 击杀链接或编号的击杀卡片（直接 @我 发击杀链接也行）' })
    ?.action(async ({ session }, link) => {
      if (!session) return
      await invoke(commands, 'kill', session, (inv) => runKill(inv, typeof link === 'string' ? link : ''))
    })
}

async function runKill(inv: Invocation, text: string): Promise<void> {
  if (!text.trim()) return void await sendCard(inv, usageCard(inv))
  const link = parseKillArg(text)
  if (!link) return void await inv.reply.text(KILL.badArg)
  const summary = await loadKill(inv, link, KILL.hint)
  if (summary) await sendCard(inv, killCard(inv, summary))
}

// ------------------------------------------------------------------ 取击杀

/** 取击杀摘要；失败时已经回复了原因，返回 null。慢提示（3 秒）占一条额度，后面至少还要发一条 */
export async function loadKill(inv: Invocation, link: KillLink, hintText: string): Promise<KillSummary | null> {
  const hint = startSlowHint(inv, 1, () => hintText)
  const result = await inv.core.kills.summary(link.killId, link.hash ? { hash: link.hash } : {}).finally(() => hint.stop())
  await hint.sent()
  if (!isFailure(result)) return result
  await inv.reply.text(failureText(result, inv.commands.clock.now(), link.hash !== null))
  return null
}

function failureText(f: CoreFailure, now: number, esi: boolean): string {
  switch (f.code) {
    case 'KILL_NOT_FOUND':
      return esi ? KILL.notFoundEsi : KILL.notFound
    case 'ZKILL_UNAVAILABLE':
      return KILL.zkillDown
    case 'ZKILL_THROTTLED':
      return KILL.throttled(f.retryAt === undefined ? 1 : Math.max(1, Math.ceil((f.retryAt - now) / 60_000)))
    case 'ESI_UNAVAILABLE':
      return KILL.esiDown
    case 'DEADLINE':
      return KILL.deadline
    default:
      return SAY.failed
  }
}

/** 自动识别时交给「击杀」的参数：zKill 链接只传编号；欧服链接传（去掉协议的）原地址，超过 100 字时退回只传编号 */
export function killCommandArg(commands: Pick<CommandContext, 'registry'>, link: KillLink): string {
  if (link.source === 'esi' && link.hash) {
    const arg = `esi.evetech.net/killmails/${link.killId}/${link.hash}`
    if (`${commands.registry.name('kill')} ${arg}`.length <= MAX_BUTTON_COMMAND_CHARS) return arg
  }
  return String(link.killId)
}

// ------------------------------------------------------------------ 卡片

const pad = (n: number) => String(n).padStart(2, '0')
const dateOf = (p: ZonedParts) => `${p.year}-${pad(p.month)}-${pad(p.day)}`
const clockOf = (p: ZonedParts) => `${pad(p.hour)}:${pad(p.minute)}`

/** EVE 2026-10-14 12:34 · 北京 20:34；北京时间跨了午夜时北京时间前面加日期 */
function timeText(ms: number): string {
  const eve = zonedParts(ms, 'UTC')
  const cn = zonedParts(ms, TIMEZONE)
  const date = dateOf(eve) === dateOf(cn) ? '' : `${dateOf(cn)} `
  return `EVE ${dateOf(eve)} ${clockOf(eve)} · 北京 ${date}${clockOf(cn)}`
}

const nameOf = (name: string | null) => (name ? safeEcho(name) : KILL.unknown)

/** 驾驶员名；没有驾驶员（结构、无人机）写军团名 */
const partyName = (p: KillParty) => nameOf(p.character ?? p.corporation)

/** 受害者：名字（军团 / 联盟）；没有驾驶员时军团名当名字，联盟放括号里 */
function victimText(p: KillParty): string {
  const group = (p.character ? [p.corporation, p.alliance] : [p.alliance]).filter((n): n is string => !!n).map((n) => safeEcho(n))
  return group.length ? `${partyName(p)}（${group.join(' / ')}）` : partyName(p)
}

function shipText(p: KillParty): string {
  if (!p.ship) return KILL.unknown
  const { zh, en } = p.ship
  return !zh || zh === en ? escapeMarkdown(en) : `${escapeMarkdown(zh)} ${escapeMarkdown(en)}`
}

function placeText(s: KillSummary): string {
  const { system } = s
  if (!system) return KILL.unknown
  const name = !system.zh || system.zh === system.en ? system.en : `${system.zh} ${system.en}`
  const sec = displaySec(system.security)
  const region = system.region ? ` · ${escapeMarkdown(system.region.zh || system.region.en)}` : ''
  return `${escapeMarkdown(name)}${sec ? ` ${sec}` : ''}${region}`
}

function title(s: KillSummary): string {
  const flags = [s.flags.npc && KILL.flags.npc, s.flags.solo && KILL.flags.solo, s.flags.awox && KILL.flags.awox].filter(Boolean)
  return `**击杀 #${s.killId}**${flags.map((f) => ` · ${f}`).join('')}`
}

export function killCard(inv: Invocation, s: KillSummary): Card {
  const card = emptyCard(title(s))
  const lines = [
    { text: `损失：${shipText(s.victim)}` },
    { text: `受害者：${victimText(s.victim)}` },
    { text: `地点：${placeText(s)}` },
    { text: `时间：${timeText(s.time)}` },
    ...s.value === null ? [] : [{ label: '价值（zKill 估值）', price: inv.core.format.isk(s.value) }],
    { text: `参与：${s.attackers} 人${s.finalBlow ? `，最后一击 ${partyName(s.finalBlow)}（${shipText(s.finalBlow)}）` : ''}` },
  ]
  card.sections.push({ lines })
  addReportButtons(inv, card, s)
  return card
}

/** 两个战报按钮；网站在控制台关掉了、或者地址是 null 的不放，一个都没有时写原因 */
function addReportButtons(inv: Invocation, card: Card, s: KillSummary): void {
  const on = (id: string) => sitesOf(inv.commands).sites.some((site) => site.id === id)
  const urls = inv.core.kills.relatedUrls(s)
  const actions: Action[] = []
  if (on('br') && urls.br) actions.push({ label: KILL.brButton, command: { id: 'br', args: `击杀 ${s.killId}` }, primary: true })
  if (on('warbeacon') && urls.warbeacon) actions.push({ label: KILL.warbeaconButton, command: { id: 'br', args: `击杀 ${s.killId} warbeacon` } })
  if (actions.length) {
    card.actions.push(actions)
    return
  }
  const reason = s.abyssal ? KILL.abyssalNote : !on('br') && !on('warbeacon') ? KILL.bothOff : KILL.noReportNote
  card.sections.push({ style: 'plain', lines: [{ text: reason }] })
}

function usageCard(inv: Invocation): Card {
  const name = escapeMarkdown(inv.commands.registry.name('kill'))
  const br = escapeMarkdown(inv.commands.registry.name('br'))
  const card = emptyCard(KILL.usageTitle)
  card.sections.push({
    lines: [
      { text: `${name} 加上 zKill 击杀链接或击杀编号：回一张击杀卡片` },
      { text: '也可以直接 @我 发击杀链接，不用写命令' },
      { text: `${br} 击杀 编号：直接截这场击杀的战报（可以再加 warbeacon）` },
    ],
  })
  return card
}
