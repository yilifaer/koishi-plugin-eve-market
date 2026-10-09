// 命令共用的环境：每次调用先等 core 准备好，建好回复器和 Access，再交给命令；
// 所有输出都经过 Replier，处理函数一律不返回值（返回字符串会被 session.send 吞掉错误）。

import type { Session } from 'koishi'
import { CMD_INPUT_IN_LISTS, COMMAND_BUDGET, READY_WAIT_MS } from '../../constants'
import type { CommandId } from '../../constants'
import { DataNotReadyError } from '../../core/data'
import type { Clock, Logger, ModuleStore, Scheduler } from '../../core/ports'
import type { Access, EveCore, Settings } from '../../core/types'
import { describeError } from '../../core/util'
import { choicesOf, pendingKey } from '../pending'
import type { PendingStore } from '../pending'
import type { CommandRegistry } from '../register'
import { buildAccess } from '../scope'
import { createReplier, replyBudget, sendState } from '../send/replier'
import type { Replier } from '../send/replier'
import type { Card, CardRenderOptions } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import type { CoreHandle } from './runtime'
import { SAY } from './text'

/** 插件加载时建一次，所有命令共用（变量名用 commands，ctx 只指 Koishi 的 Context） */
export interface CommandContext {
  settings: Settings
  registry: CommandRegistry
  pending: PendingStore
  store: ModuleStore
  logger: Logger
  core: CoreHandle
  /** 和 core 用同一个时钟、定时器（卡片上的「N 分钟前」、慢提示） */
  clock: Clock
  scheduler: Scheduler
  /** EVE 授权页面挂上了没有（要有 Koishi 的 server 插件）；不写 = 没有 */
  webReady?: () => boolean
}

/** 一次命令调用 */
export interface Invocation {
  commands: CommandContext
  session: Session
  core: EveCore
  access: Access
  reply: Replier
  render: CardRenderOptions
}

export function renderOptions(commands: CommandContext): CardRenderOptions {
  return {
    numberStyle: commands.settings.display.numberStyle,
    clickable: commands.settings.display.clickable,
    cmdInputInLists: CMD_INPUT_IN_LISTS,
    commandName: (id) => commands.registry.name(id),
  }
}

export function replierFor(commands: CommandContext, id: CommandId, session: Session): Replier {
  return createReplier(session, {
    budget: replyBudget(COMMAND_BUDGET[id].max, session.isDirect),
    mode: commands.settings.display.output,
    render: renderOptions(commands),
    state: sendState(commands.store),
    logger: commands.logger,
  })
}

/** 等 core（最多 READY_WAIT_MS），再执行命令；出错时回一句话并写日志 */
export async function invoke(commands: CommandContext, id: CommandId, session: Session, run: (inv: Invocation) => Promise<void>): Promise<void> {
  const reply = replierFor(commands, id, session)
  const core = await commands.core.ready(READY_WAIT_MS)
  if (!core) {
    await reply.text(SAY.loading)
    return
  }
  const inv: Invocation = { commands, session, core, access: buildAccess(session, commands.settings.access), reply, render: renderOptions(commands) }
  try {
    await run(inv)
  } catch (e) {
    if (e instanceof DataNotReadyError) {
      await reply.text(SAY.loading)
      return
    }
    commands.logger.warn(`「${commands.registry.name(id)}」出错：${describeError(e)}`)
    await reply.text(SAY.failed)
  }
}

/** 发一张卡片；卡片上有编号选项时记下编号待办（quantity：编号后面可以带 *数量） */
export async function sendCard(inv: Invocation, card: Card, options: { quantity?: boolean } = {}): Promise<boolean> {
  const sent = await inv.reply.card(card)
  if (card.choices?.length) {
    inv.commands.pending.setChoices(pendingKey(inv.session), choicesOf(card, inv.commands.registry.namer()), { quantity: !!options.quantity })
  }
  return sent
}

/** 查价、批量查价卡片上的告示（启用、没过期、本群能看的前 2 条） */
export function notices(inv: Pick<Invocation, 'core' | 'access'>): string[] {
  return inv.core.notices(inv.access).map(escapeMarkdown)
}

/** 只有标题的小卡片（候选、提示、用法以外的一句话也可以直接 reply.text） */
export function emptyCard(title: string): Card {
  return { title, meta: [], sections: [], warnings: [], footer: '', notices: [], actions: [] }
}
