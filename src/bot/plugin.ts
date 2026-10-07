// 插件组装（§3.7.3）：规范化配置 → 模块级存储 → 平台范围 → 安全注册 → 前置中间件 → 命令 → 后置中间件；
// ready 时建端口、组装 core 并启动（读缓存或自带快照 → 建索引），停用时停掉 core（取消请求、清定时器）。
// 数据还没准备好时收到的命令最多等 8 秒。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'koishi'
import { formatIssue, normalizeConfig } from '../config/normalize'
import type { Config } from '../config/schema'
import { createEveCore } from '../core'
import type { AuthStore, Clock, Logger, ModuleStore, Scheduler } from '../core/ports'
import type { CoreOverrides, EveCore, Settings } from '../core/types'
import { CoreRuntime, installFallback, listProbe, registerCommands } from './commands'
import type { CommandContext } from './commands'
import { pendingStore } from './pending'
import { koishiLogger, koishiScheduler, makePorts, moduleStore, systemClock } from './ports'
import { installPrefix, textReply } from './prefix'
import { CommandRegistry } from './register'
import { createScopes, messageDedupe } from './scope'
import { sendState } from './send/replier'

/** 包的根目录：编译后是 lib/bot/plugin.js，源码是 src/bot/plugin.ts，往上两级都是 */
const PACKAGE_ROOT = path.resolve(__dirname, '../..')

/** 随插件发布的数据快照 */
export const BUNDLED_DATA_DIR = path.join(PACKAGE_ROOT, 'data')

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 0.0.2 之前还没有授权档案表：一个档案都没有 */
const NO_PROFILES: AuthStore = {
  list: async () => [],
  get: async () => undefined,
  upsert: async () => undefined,
  remove: async () => undefined,
}

/** 测试和以后的其他入口用；正常加载时全部用默认值 */
export interface PluginOptions {
  /** 不写 = 模块级存储（跨插件重载保留）；测试里每次传一个新的 */
  store?: ModuleStore
  /** 不写 = 包里的 data/ */
  bundledDataDir?: string
  /** 把 ESI 指到假服务、固定随机数 */
  overrides?: CoreOverrides
  /** 授权档案表；不写 = 没有任何档案 */
  auth?: AuthStore
  logger?: Logger
  /** 不写 = 系统时钟、ctx.setTimeout（测试里固定时间，避开 DT） */
  clock?: Clock
  scheduler?: Scheduler
}

interface CoreSetup {
  settings: Settings
  store: ModuleStore
  logger: Logger
  clock: Clock
  scheduler: Scheduler
}

async function buildCore(ctx: Context, setup: CoreSetup, options: PluginOptions): Promise<EveCore> {
  const ports = await makePorts(ctx, {
    auth: options.auth ?? NO_PROFILES,
    bundledDataDir: options.bundledDataDir ?? BUNDLED_DATA_DIR,
    version: packageVersion(),
    store: setup.store,
    logger: setup.logger,
    clock: setup.clock,
    scheduler: setup.scheduler,
  })
  return createEveCore(ports, setup.settings, options.overrides)
}

export function installPlugin(ctx: Context, config: Config, options: PluginOptions = {}): void {
  const { settings, issues } = normalizeConfig(config)
  const logger = options.logger ?? koishiLogger(ctx)
  for (const issue of issues) logger.warn('配置问题：%s', formatIssue(issue))

  const store = options.store ?? moduleStore()
  const clock = options.clock ?? systemClock
  const scheduler = options.scheduler ?? koishiScheduler(ctx)
  const runtime = new CoreRuntime(logger)
  const scopes = createScopes(ctx, { general: settings.general, echo: sendState(store).echo })
  const registry = new CommandRegistry(scopes.cmdCtx, { filter: scopes.filter, logger })
  const commands: CommandContext = { settings, registry, pending: pendingStore(store), store, logger, core: runtime, clock, scheduler }

  installPrefix(scopes.cmdCtx, {
    registry,
    pending: commands.pending,
    dedupe: messageDedupe(store),
    probe: listProbe(commands),
    say: textReply(store, logger),
  })
  registerCommands(commands)
  installFallback(scopes.cmdCtx, commands)

  ctx.on('ready', () => runtime.start(() => buildCore(ctx, { settings, store, logger, clock, scheduler }, options)))
  ctx.on('dispose', () => runtime.stop())
}
