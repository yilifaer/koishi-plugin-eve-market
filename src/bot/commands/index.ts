// 命令：查价、批量查价、走势、搜索、入侵、势力图、联盟势力图、战报、击杀、估价、KB 人物卡、截图、服务器状态、翻译（中英对照）、本群ID、
// 制造、制造比价、反应，帮助（隐藏的 eve-market.help）、管理员的市场状态、市场授权、样式自检和截图测试，
// 以及后置的中间件（截图和击杀链接自动识别、裸物品名、兜底）。

import { registerAdmin } from './admin'
import { registerBatch } from './batch'
import { registerBr } from './br'
import type { CommandContext } from './context'
import { registerGroupId } from './group-id'
import { registerHelp } from './help'
import { registerIncursion } from './incursion'
import { registerIndustry } from './industry'
import { registerJanice } from './janice'
import { registerKb } from './kb'
import { registerKill } from './kill'
import { registerMaps } from './map'
import { registerPrice } from './price'
import { registerSearch } from './search'
import { registerSelfTest } from './selftest'
import { registerServerStatus } from './server-status'
import { registerShot } from './shot'
import { registerShotProbe } from './shot-probe'
import { registerTranslate } from './translate'
import { registerTrend } from './trend'

/** 安全注册：和别的插件重名的命令跳过（记进「命令冲突」），其余照常 */
export function registerCommands(commands: CommandContext): void {
  registerPrice(commands)
  registerBatch(commands)
  registerTrend(commands)
  registerSearch(commands)
  registerIncursion(commands)
  registerMaps(commands)
  registerBr(commands)
  registerKill(commands)
  registerJanice(commands)
  registerKb(commands)
  registerShot(commands)
  registerShotProbe(commands)
  registerServerStatus(commands)
  registerTranslate(commands)
  registerIndustry(commands)
  registerGroupId(commands)
  registerAdmin(commands)
  registerSelfTest(commands)
  registerHelp(commands)
}

export { installFallback } from './fallback'
export { listProbe } from './probe'
export { CoreRuntime } from './runtime'
export type { CoreHandle } from './runtime'
export type { CommandContext, Invocation } from './context'
