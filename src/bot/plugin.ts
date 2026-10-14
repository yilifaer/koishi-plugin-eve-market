// 插件组装（§3.7.3）：规范化配置 → 授权档案表 → 模块级存储 → 平台范围 → 出图和截图（puppeteer 调用时再取）→ 官方机器人看门狗 → 安全注册
// → 前置中间件 → 命令 → 后置中间件 → 有 server 插件时挂上 EVE 授权页面；ready 时建端口（含 secret.key 的密钥盒）、组装 core 并启动
// （读缓存或自带快照 → 建索引 → 授权档案 → 建筑市场同步），停用时停掉 core（取消请求、清定时器）并关掉所有浏览器页面。
// 数据还没准备好时收到的命令最多等 8 秒。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from 'koishi'
import { formatIssue, normalizeConfig } from '../config/normalize'
import type { Config } from '../config/schema'
import { createEveCore } from '../core'
import { createSiteRegistry } from '../core/sites'
import type { AuthStore, Clock, Logger, ModuleStore, Scheduler } from '../core/ports'
import type { CoreOverrides, EveCore, Settings } from '../core/types'
import { puppeteerPages } from '../render'
import { createAuthStore } from '../storage'
import { installWebRoutes } from '../web'
import { CoreRuntime, installFallback, listProbe, registerCommands } from './commands'
import type { CommandContext } from './commands'
import { createMedia } from './media'
import { pendingStore } from './pending'
import { koishiLogger, koishiScheduler, makePorts, moduleStore, systemClock } from './ports'
import { installPrefix, textReply } from './prefix'
import { CommandRegistry } from './register'
import { createScopes, messageDedupe } from './scope'
import { sendState } from './send/replier'
import { installWatchdog } from './watchdog'

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

/** 测试和以后的其他入口用；正常加载时全部用默认值 */
export interface PluginOptions {
  /** 不写 = 模块级存储（跨插件重载保留）；测试里每次传一个新的 */
  store?: ModuleStore
  /** 不写 = 包里的 data/ */
  bundledDataDir?: string
  /** 把 ESI 指到假服务、固定随机数 */
  overrides?: CoreOverrides
  /** 授权档案表；不写 = 数据库里的 eve_market_auth 表 */
  auth?: AuthStore
  logger?: Logger
  /** 不写 = 系统时钟、ctx.setTimeout（测试里固定时间，避开 DT） */
  clock?: Clock
  scheduler?: Scheduler
  /** 看门狗每分钟检查用的定时器；不写 = ctx.setTimeout（不跟着上面测试用的 scheduler 走，免得测试里多出一个定时器） */
  watchdogScheduler?: Scheduler
  /** 停用时拿到「停完了」的 Promise：Koishi 不等异步的停用，测试要等缓存写完再删临时目录 */
  onStop?: (done: Promise<void>) => void
}

interface CoreSetup {
  settings: Settings
  auth: AuthStore
  store: ModuleStore
  logger: Logger
  clock: Clock
  scheduler: Scheduler
}

async function buildCore(ctx: Context, setup: CoreSetup, options: PluginOptions): Promise<EveCore> {
  const ports = await makePorts(ctx, {
    auth: setup.auth,
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
  const auth = options.auth ?? createAuthStore(ctx, clock)
  const runtime = new CoreRuntime(logger)
  const web = { ready: false }
  // puppeteer 是可选服务：每次出图时才取，插件启动后才启用 puppeteer 也能用
  const media = createMedia({ pages: puppeteerPages(() => ctx.get('puppeteer')), logger })
  // BR 工具的自动截图还要看旧开关（settings.render.brAuto 已经合并了两个开关）
  const sites = createSiteRegistry({ sites: settings.screenshot.sites.map((s) => (s.id === 'br' ? { ...s, auto: settings.render.brAuto } : s)) })
  const scopes = createScopes(ctx, { general: settings.general, echo: sendState(store).echo })
  const registry = new CommandRegistry(scopes.cmdCtx, { filter: scopes.filter, logger })
  const watchdog = installWatchdog(ctx, {
    enabled: settings.general.qqWatchdog, store, clock, logger, scheduler: options.watchdogScheduler ?? koishiScheduler(ctx),
  })
  const commands: CommandContext = {
    settings, registry, pending: pendingStore(store), store, logger, core: runtime, clock, scheduler, webReady: () => web.ready, media, sites,
    watchdog: () => watchdog.status(),
  }

  installPrefix(scopes.cmdCtx, {
    registry,
    pending: commands.pending,
    dedupe: messageDedupe(store),
    probe: listProbe(commands),
    say: textReply(store, logger),
  })
  registerCommands(commands)
  installFallback(scopes.cmdCtx, commands)

  // EVE 授权页面和 SSO 回调挂在 server 插件上；server 停用时路由跟着撤掉
  ctx.inject(['server'], (server) => {
    web.ready = installWebRoutes(server, runtime, settings, { store, logger, clock })
    server.on('dispose', () => {
      web.ready = false
    })
  })

  ctx.on('ready', () => runtime.start(() => buildCore(ctx, { settings, auth, store, logger, clock, scheduler }, options)))
  ctx.on('dispose', async () => {
    const done = Promise.all([runtime.stop(), media.dispose()]).then(() => undefined)
    options.onStop?.(done)
    await done
  })
}
