// 命令：查价、批量查价、搜索、本群ID、帮助（隐藏的 eve-market.help）、管理员的市场状态和市场授权，以及后置的兜底中间件。

import { registerAdmin } from './admin'
import { registerBatch } from './batch'
import type { CommandContext } from './context'
import { registerGroupId } from './group-id'
import { registerHelp } from './help'
import { registerPrice } from './price'
import { registerSearch } from './search'

/** 安全注册：和别的插件重名的命令跳过（记进「命令冲突」），其余照常 */
export function registerCommands(commands: CommandContext): void {
  registerPrice(commands)
  registerBatch(commands)
  registerSearch(commands)
  registerGroupId(commands)
  registerAdmin(commands)
  registerHelp(commands)
}

export { installFallback } from './fallback'
export { listProbe } from './probe'
export { CoreRuntime } from './runtime'
export type { CoreHandle } from './runtime'
export type { CommandContext, Invocation } from './context'
