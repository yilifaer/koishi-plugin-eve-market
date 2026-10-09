// 管理命令（§2.16）：市场状态（「市场状态 刷新」立即检查在线数据，只重新同步过期或出错的建筑市场）和市场授权。
// 只有管理员（access.admins 或 Koishi 权限等级 ≥ 4）能用，并且只在单聊或授权群里回应；其他情况一律不回复，
// 和命令不存在一样（不等数据、不写日志）：命令只对这些会话存在（注册时的 only），别人在 plugin-help 里
// 也看不到、问不到（help -H、help 市场状态、市场状态 -h）。对管理员也是隐藏命令，默认的帮助列表里不显示。

import type { Session } from 'koishi'
import type { CommandId } from '../../constants'
import type { RefreshResult } from '../../core/types'
import { describeError } from '../../core/util'
import { buildAccess } from '../scope'
import { sendState } from '../send/replier'
import type { Action } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { STATUS_TEXT, authCard, statusCard } from './status-card'
import type { StatusEnv } from './status-card'
import { within } from './wait'

/** 「市场状态 刷新」最多等多久；没做完的在后台接着做，结果下次「市场状态」里看 */
export const REFRESH_WAIT_MS = 10_000
const REFRESH_WORDS = ['刷新', 'refresh']

export function registerAdmin(commands: CommandContext): void {
  const only = (session: Session) => adminHere(commands, session)
  commands.registry.register('marketStatus', { args: '[action:text]', description: '市场状态：各市场、授权档案和数据版本（管理员）', hidden: true, only })
    ?.action(async ({ session }, action) => {
      if (!session || !adminHere(commands, session)) return
      const refresh = typeof action === 'string' && REFRESH_WORDS.includes(action.trim().toLowerCase())
      await invoke(commands, 'marketStatus', session, (inv) => runStatus(inv, refresh))
    })
  commands.registry.register('marketAuth', { description: '市场授权：EVE 授权档案的状态（管理员）', hidden: true, only })
    ?.action(async ({ session }) => {
      if (!session || !adminHere(commands, session)) return
      await invoke(commands, 'marketAuth', session, runAuth)
    })
}

/** 管理员，并且在单聊或授权群里 */
export function adminHere(commands: Pick<CommandContext, 'settings'>, session: Session): boolean {
  const access = buildAccess(session, commands.settings.access)
  return access.isAdmin && (access.isDirect || access.allowed)
}

function env(inv: Invocation): StatusEnv {
  const { sso } = inv.commands.settings
  return {
    now: inv.commands.clock.now(),
    ssoConfigured: !!sso.clientId && !!sso.clientSecret,
    web: inv.commands.webReady?.() ?? false,
  }
}

const has = (inv: Invocation, id: CommandId) => inv.commands.registry.has(id)

function statusActions(inv: Invocation): Action[][] {
  const row: Action[] = [{ label: STATUS_TEXT.refresh, command: { id: 'marketStatus', args: STATUS_TEXT.refreshArg }, primary: true }]
  if (has(inv, 'selfTest')) row.push({ label: inv.commands.registry.name('selfTest'), command: { id: 'selfTest' } })
  if (has(inv, 'marketAuth')) row.push({ label: inv.commands.registry.name('marketAuth'), command: { id: 'marketAuth' } })
  return [row]
}

function authActions(inv: Invocation): Action[][] {
  return has(inv, 'marketStatus') ? [[{ label: inv.commands.registry.name('marketStatus'), command: { id: 'marketStatus' } }]] : []
}

async function runStatus(inv: Invocation, refresh: boolean): Promise<void> {
  const refreshed = refresh ? await refreshNow(inv) : undefined
  const view = {
    ...env(inv),
    status: inv.core.status(),
    conflicts: inv.commands.registry.conflicts(),
    breaker: sendState(inv.commands.store).breaker.status(inv.commands.clock.now()),
    refreshed,
  }
  await sendCard(inv, statusCard(view, statusActions(inv)))
}

async function runAuth(inv: Invocation): Promise<void> {
  await sendCard(inv, authCard(inv.core.auth.profiles(), env(inv), authActions(inv)))
}

// ------------------------------------------------------------------ 立即刷新

function dataSummary(inv: Invocation, result: RefreshResult | null): string {
  if (!inv.commands.settings.advanced.manifestUrls.length) return '物品数据没有设置在线网址，只用插件自带的'
  if (!result) return '物品数据还在检查'
  const parts: string[] = []
  if (result.error) parts.push(`物品数据在线检查失败（${escapeMarkdown(result.error.replace(/\s+/g, ' ').slice(0, 80))}）`)
  else if (result.changed) parts.push(`物品数据已更新到 SDE build ${inv.core.data.status().buildNumber ?? '?'}`)
  else if (result.checked) parts.push('物品数据在线确认是最新')
  else parts.push('物品数据没有检查')
  if (result.glossaryChanged) parts.push('黑话表已更新')
  return parts.join('，')
}

function structureSummary(inv: Invocation, done: boolean): string | undefined {
  const synced = inv.core.prices.sources().filter((m) => m.source === 'structure')
  if (!synced.length) return undefined
  if (!done) return '建筑市场还在同步'
  const ok = synced.filter((m) => m.state === 'OK').length
  return `过期或出错的建筑市场已经重新同步（${ok}/${synced.length} 个正常）`
}

/** 立即检查在线数据，只重新同步过期或出错的建筑市场（不打破 ESI 的缓存规则）；最多等 REFRESH_WAIT_MS */
async function refreshNow(inv: Invocation): Promise<string[]> {
  const { core, commands } = inv
  const name = commands.registry.name('marketStatus')
  const onError = (what: string) => (e: unknown) => commands.logger.warn(`「${name} 刷新」${what}出错：${describeError(e)}`)
  const data = within(core.data.refresh(), REFRESH_WAIT_MS, onError('检查物品数据'))
  const sync = within(core.prices.resync().then(() => true), REFRESH_WAIT_MS, onError('同步建筑市场'))
  const [result, synced] = await Promise.all([data, sync])
  const parts = [dataSummary(inv, result), structureSummary(inv, synced === true)].filter((p): p is string => !!p)
  const pending = !result || synced !== true
  return [`刷新结果：${parts.join('；')}${pending ? `。没做完的在后台接着做，稍后再发「${escapeMarkdown(name)}」看结果` : ''}`]
}
