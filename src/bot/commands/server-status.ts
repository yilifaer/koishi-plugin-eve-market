// 服务器状态（§2.12）：在线人数、本次开服、下次例行维护、服务器版本，同时写 EVE 时间和北京时间。
// VIP 模式写在标题上；请求失败或服务器不在线时回一句「连不上欧服」，并说明每天的例行维护时间。没有按钮。

import { DT_START_UTC, TIMEZONE } from '../../constants'
import { formatAgo, formatDateTime, formatDuration, formatTime } from '../../core/format'
import { isFailure } from '../../core/types'
import type { ServerStatus } from '../../core/types'
import type { Card } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { SERVER } from './text'

export function registerServerStatus(commands: CommandContext): void {
  commands.registry.register('serverStatus', { description: '服务器状态：欧服在线人数、开服时间、下次维护' })
    ?.action(async ({ session }) => {
      if (!session) return
      await invoke(commands, 'serverStatus', session, runServerStatus)
    })
}

async function runServerStatus(inv: Invocation): Promise<void> {
  const status = await inv.core.universe.serverStatus()
  if (isFailure(status)) {
    if (status.code !== 'UPSTREAM_UNAVAILABLE') inv.commands.logger.warn(`服务器状态失败：${status.code} ${status.message ?? ''}`)
    await inv.reply.text(downText())
    return
  }
  await sendCard(inv, serverStatusCard(inv, status))
}

/** 每天例行维护开始的时间：EVE 时间 11:00 和北京时间 19:00（按常量算；哪一天都一样，取 1970-01-01） */
function downtimeClock(): { eve: string; local: string } {
  const at = (DT_START_UTC.hour * 60 + DT_START_UTC.minute) * 60_000
  return { eve: formatTime(at, 'UTC'), local: formatTime(at, TIMEZONE) }
}

export function downText(): string {
  const dt = downtimeClock()
  return SERVER.down(dt.eve, dt.local)
}

export function serverStatusCard(inv: Pick<Invocation, 'core' | 'commands'>, status: ServerStatus): Card {
  const now = inv.commands.clock.now()
  const card = emptyCard(status.vip ? SERVER.vip : SERVER.online)
  card.sections.push({
    lines: [
      { label: SERVER.players, price: { na: false, full: inv.core.format.quantity(status.players) } },
      { text: SERVER.started(formatDateTime(status.startTime, TIMEZONE), formatDuration(status.uptimeSec)) },
      { text: SERVER.nextDowntime(formatDateTime(status.nextDowntime, TIMEZONE), formatTime(status.nextDowntime, 'UTC')) },
      { text: SERVER.version(escapeMarkdown(status.serverVersion)) },
    ],
  })
  card.sections.push({ style: 'plain', lines: [{ text: SERVER.clocks(formatTime(now, 'UTC'), formatTime(now, TIMEZONE)) }] })
  if (status.stale && status.dataTime !== null) card.warnings.push(SERVER.stale(formatAgo((now - status.dataTime) / 1000)))
  return card
}
