// 安全注册：和别的插件重名时跳过（主名重名跳过整个命令，别名重名只跳过别名）并记下来给「市场状态」，
// 任何异常都不让插件加载失败。每个命令名和别名都挂上和 cmdCtx 一样的过滤器，别的平台根本解析不到本插件的命令。

import { Command } from 'koishi'
import type { Context, Session } from 'koishi'
import { COMMAND_NAMES, HELP_COMMAND, HELP_WORDS } from '../constants'
import type { CommandId } from '../constants'
import type { Logger } from '../core/ports'
import { CONFLICT, LOG } from './text'
import type { CommandNamer } from './view/clickable'

export interface RegisterOptions {
  /** 参数声明，例如「[query:text]」；不写 = 不带参数（无空格拆分时必须完全相同才算这个命令） */
  args?: string
  /** plugin-help 列表里的说明 */
  description?: string
  /** 别名，例如「翻译」的「中英对照」 */
  aliases?: readonly string[]
  /** 管理命令：帮助列表里不显示 */
  hidden?: boolean
}

export interface CommandConflict {
  id: CommandId
  /** 命令的主名 */
  name: string
  /** name：主名重名，整个命令没注册；alias：只跳过了这个别名；error：注册时出错 */
  kind: 'name' | 'alias' | 'error'
  alias?: string
}

/** 本插件的一个命令名或别名（Koishi 规范化后的写法：小写，_ 换成 -） */
export interface CommandName {
  name: string
  /** 带参数（可以和后面的文字粘在一起写） */
  args: boolean
}

export interface RegistryOptions {
  /** createScopes() 给的过滤器 */
  filter: (session: Session) => boolean
  logger: Logger
}

type HelpConfig = Command.Config & { hidden?: boolean }

const keyOf = (name: string) => Command.normalize(name)

export function describeConflict(conflict: CommandConflict): string {
  if (conflict.kind === 'alias') return CONFLICT.alias(conflict.alias ?? '', conflict.name)
  return conflict.kind === 'name' ? CONFLICT.name(conflict.name) : CONFLICT.error(conflict.name)
}

export class CommandRegistry {
  private readonly commands = new Map<CommandId, Command>()
  /** 本插件建出来的 Command（含 eve-market.help 的上一级 eve-market） */
  private readonly own = new Set<Command>()
  private readonly found: CommandConflict[] = []

  /** ctx：命令所在的上下文（cmdCtx） */
  constructor(private readonly ctx: Context, private readonly options: RegistryOptions) {
    // 在「指令管理」里改名、加别名以后，新名字同样挂上过滤器
    ctx.on('command-updated', (command) => {
      if (this.own.has(command)) this.guard(command)
    })
  }

  /** 注册一个命令；重名或出错时返回 undefined（已经记下冲突、写了日志） */
  register(id: CommandId, options: RegisterOptions = {}): Command | undefined {
    const existing = this.commands.get(id)
    if (existing) return existing
    const name = id === 'help' ? HELP_COMMAND : COMMAND_NAMES[id]
    if (this.taken(name)) return this.conflict({ id, name, kind: 'name' })
    const before = new Set(this.ctx.$commander._commandList)
    let command: Command
    try {
      command = this.ctx.command(`${name} ${options.args ?? ''}`.trim(), options.description ?? '', this.configOf(id, options))
    } catch (error) {
      this.disposeNew(before)
      return this.conflict({ id, name, kind: 'error' }, error)
    }
    for (const created of this.ctx.$commander._commandList) {
      if (before.has(created)) continue
      this.own.add(created)
      this.guard(created)
      if (created !== command) Object.assign(created.config, { hidden: true })
    }
    for (const alias of options.aliases ?? []) this.addAlias(id, name, command, alias)
    this.commands.set(id, command)
    return command
  }

  get(id: CommandId): Command | undefined {
    return this.commands.get(id)
  }

  has(id: CommandId): boolean {
    return this.commands.has(id)
  }

  /**
   * 命令当前的名字（按钮、提示里用）：所有者在「指令管理」里改过名就用新名字。
   * help 注册的是隐藏命令，这里返回「帮助」，由前置中间件改写
   */
  name(id: CommandId): string {
    if (id === 'help') return HELP_WORDS[0]
    const display = this.commands.get(id)?.displayName
    if (!display || display === keyOf(COMMAND_NAMES[id])) return COMMAND_NAMES[id]
    return display
  }

  namer(): CommandNamer {
    return { commandName: (id) => this.name(id) }
  }

  /** 本插件已注册的命令名和别名（不含内部命令），无空格拆分、帮助改写用 */
  names(): CommandName[] {
    const out: CommandName[] = []
    for (const command of this.commands.values()) {
      const args = command._arguments.length > 0
      for (const name of Object.keys(command._aliases)) {
        if (!name.includes('.')) out.push({ name, args })
      }
    }
    return out
  }

  conflicts(): readonly CommandConflict[] {
    return this.found
  }

  private configOf(id: CommandId, options: RegisterOptions): HelpConfig {
    // captureQuote：不把引用的消息拼进参数；strictOptions：「批量查价 -5% Jita」里的 -5% 回到文本参数
    const config: HelpConfig = { captureQuote: false }
    if (options.args) config.strictOptions = true
    if (options.hidden || id === 'help') config.hidden = true
    return config
  }

  /** 名字已经被任何插件（含本插件）用作命令名或别名 */
  private taken(name: string): boolean {
    return !!this.ctx.$commander.get(keyOf(name))
  }

  /** 出错时建了一半的（例如上一级已经建好）也删掉 */
  private disposeNew(before: Set<Command>) {
    for (const created of this.ctx.$commander._commandList.slice()) {
      if (before.has(created)) continue
      try {
        created.dispose()
      } catch {
        // 删不掉就留着，不影响插件加载
      }
    }
  }

  /** 没有过滤器的名字都挂上 */
  private guard(command: Command) {
    for (const alias of Object.values(command._aliases)) alias.filter ??= this.options.filter
  }

  private addAlias(id: CommandId, name: string, command: Command, alias: string) {
    if (this.taken(alias)) {
      this.conflict({ id, name, kind: 'alias', alias })
      return
    }
    try {
      command.alias(alias, { filter: this.options.filter })
    } catch (error) {
      this.conflict({ id, name, kind: 'alias', alias }, error)
    }
  }

  private conflict(conflict: CommandConflict, error?: unknown): undefined {
    this.found.push(conflict)
    const detail = describeConflict(conflict)
    if (error === undefined) this.options.logger.warn(LOG.conflict(detail))
    else this.options.logger.warn(LOG.registerError(conflict.alias ?? conflict.name, error instanceof Error ? error.message : String(error)))
    return undefined
  }
}
