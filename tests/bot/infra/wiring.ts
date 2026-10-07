// 测试用的接线：范围 + 安全注册 + 前置中间件，加几个只记录参数、回一句纯文字的命令。
// 回复经 textReply（Replier），所以自我回声的记录、预算和真实命令一样。

import type { Context, Session } from 'koishi'
import type { CommandId } from '../../../src/constants'
import { createModuleStore } from '../../../src/core/ports'
import type { ModuleStore } from '../../../src/core/ports'
import type { Access, AccessSettings, GeneralSettings } from '../../../src/core/types'
import { PendingStore } from '../../../src/bot/pending'
import { installPrefix, textReply } from '../../../src/bot/prefix'
import type { ListProbe } from '../../../src/bot/prefix'
import { CommandRegistry } from '../../../src/bot/register'
import type { RegisterOptions } from '../../../src/bot/register'
import { MessageDedupe, buildAccess, createScopes } from '../../../src/bot/scope'
import type { Scopes } from '../../../src/bot/scope'
import { sendState } from '../../../src/bot/send/replier'

export interface Call {
  id: CommandId
  /** 文本参数（不带参数的命令是 ''） */
  arg: string
  access: Access
  session: Session
}

export interface Wiring {
  store: ModuleStore
  scopes: Scopes
  registry: CommandRegistry
  pending: PendingStore
  calls: Call[]
  logs: string[]
  say(session: Session, text: string): Promise<boolean>
}

export interface WiringOptions {
  general?: Partial<GeneralSettings>
  access?: Partial<AccessSettings>
  probe?: ListProbe
  /** 不写 = DEFAULT_COMMANDS */
  commands?: Partial<Record<CommandId, RegisterOptions>>
  store?: ModuleStore
}

export const DEFAULT_COMMANDS: Partial<Record<CommandId, RegisterOptions>> = {
  price: { args: '[query:text]', description: '查价' },
  batch: { args: '[args:text]', description: '批量查价' },
  search: { args: '[query:text]' },
  incursion: {},
  influenceMap: {},
  coalitionMap: {},
  translate: { args: '[query:text]', aliases: ['中英对照'] },
  help: { args: '[topic:text]' },
  groupId: {},
  marketStatus: { args: '[arg:text]', hidden: true },
}

/** 在 ctx 上接好前置中间件和命令；每个命令把参数记进 calls，再回一句「<命令 id>:<参数>」 */
export function wire(ctx: Context, options: WiringOptions = {}): Wiring {
  const store = options.store ?? createModuleStore()
  const logs: string[] = []
  const logger = {
    debug() {},
    info: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
    warn: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
  }
  const general: GeneralSettings = { requireAt: true, allowSandbox: false, ...options.general }
  const access: AccessSettings = { admins: [], allowedGroups: [], allowedUsers: [], ...options.access }
  const scopes = createScopes(ctx, { general, echo: sendState(store).echo })
  const registry = new CommandRegistry(scopes.cmdCtx, { filter: scopes.filter, logger })
  const pending = new PendingStore()
  const say = textReply(store, logger)
  const calls: Call[] = []
  installPrefix(scopes.cmdCtx, { registry, pending, dedupe: new MessageDedupe(), probe: options.probe, say })
  for (const [id, opts] of Object.entries(options.commands ?? DEFAULT_COMMANDS) as Array<[CommandId, RegisterOptions]>) {
    registry.register(id, opts)?.action(async ({ session }, ...args: unknown[]) => {
      const arg = typeof args[0] === 'string' ? args[0] : ''
      calls.push({ id, arg, access: buildAccess(session!, access), session: session! })
      await say(session!, arg ? `${id}:${arg}` : `${id}:`)
    })
  }
  return { store, scopes, registry, pending, calls, logs, say }
}

/** 作为一个 Koishi 插件装上（随 app.stop() 一起清掉），返回接线结果 */
export function wirePlugin(app: Context, options: WiringOptions = {}): { current: Wiring | null } {
  const ref: { current: Wiring | null } = { current: null }
  app.plugin({ name: 'eve-market-wiring', apply: (ctx: Context) => { ref.current = wire(ctx, options) } })
  return ref
}
