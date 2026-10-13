// 集成测试的环境：真实的 Koishi + 整个插件（installPlugin），物品数据来自 tests/fixtures 的小数据集（临时的自带快照目录），
// ESI 和 SSO 指向本机的假 ESI（经 ctx.http 真实发请求），模块级存储每个环境一个，互不影响。所有 ID 和名字都是编造的。
// 插件和假 ESI 用同一个时钟：默认从 EVE 时间 06:20 开始、跟着真实时间走，结果不受跑测试的时刻（DT 11:00–11:30）影响。
// 需要 EVE 授权页面时再加载 Koishi 的 server 插件，监听 127.0.0.1 上的一个空闲端口。

import { createRequire } from 'node:module'
import net from 'node:net'
import type { Context, ForkScope } from 'koishi'
import { installPlugin } from '../../../src/bot/plugin'
import { Config } from '../../../src/config/schema'
import { PRESET_MARKETS } from '../../../src/config/presets'
import { createModuleStore } from '../../../src/core/ports'
import type { Clock, Logger, ModuleStore, Scheduler } from '../../../src/core/ports'
import { FakeEsi, rawOrder } from '../../fakes/fake-esi'
import type { RawOrder } from '../../fakes/fake-esi'
import { bundledDir, cleanupDirs, makeVersion } from '../../core/data/helpers'
import { startHarness, startRealQQ } from '../../harness'
import type { Harness, HarnessOptions, RealQQ, Sent } from '../../harness'

export const THE_FORGE = 10000002
export const DOMAIN = 10000043
export const JITA_4_4 = 60003760
export const AMARR_STATION = 60008494
export const RAVEN = 638
export const RAVEN_NAVY = 17636
export const TRITANIUM = 34
export const PYERITE = 35
export const PLEX = 44992

/** 编造的授权群；不在里面的群算「其他群」 */
export const ALLOWED_GROUP = 'C0FFEE00000000000000000000000001'

/** 授权群 + 一个只在授权群可见、不用授权的玩家建筑市场（从星域订单里读它的公开订单） */
export const STRUCTURE_ID = 1_000_000_000_101
export const ALLIANCE_MARKET = {
  name: '联盟市场A', aliases: '前线', type: 'structure', location: String(STRUCTURE_ID), system: 'Jita', enabled: true,
  inDefaultList: 'auto', sortOrder: 5, visibility: 'auto', authProfile: '', note: '',
}

/** 测试开始的 EVE 时间：离每天的 DT（11:00–11:30）很远 */
export const TEST_START = Date.UTC(2026, 9, 7, 6, 20)

/** 从 start 开始、跟着真实时间走的时钟 */
export function testClock(start = TEST_START): Clock {
  const real = Date.now()
  return { now: () => start + (Date.now() - real) }
}

// ------------------------------------------------------------------ 读发出去的消息

/** 列表项里的 <qqbot-cmd-input …show="名字" /> 还原成名字（断言只看文字） */
export const plainCmdInput = (md: string): string => md.replace(/<qqbot-cmd-input [^>]*?show="([^"]*)"[^>]*\/>/g, (_, show: string) =>
  show.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))

/** 发出去的几条消息（Markdown 或纯文字），用 ---- 隔开；列表项里的可点文字还原成名字 */
export const card = (sent: Sent[]) => sent.map((s) => plainCmdInput(s.markdown ?? s.text)).join('\n----\n')
/** 按钮按行：[['标签=>命令', …], …] */
export const buttonRows = (sent: Sent[]) => sent.flatMap((s) => s.rows.map((r) => r.map((b) => `${b.label}=>${b.text}`)))
/** 所有按钮排成一列 */
export const buttons = (sent: Sent[]) => buttonRows(sent).flat()

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; text: string }> = []
  debug() {}
  info(...a: unknown[]) { this.push('info', a) }
  warn(...a: unknown[]) { this.push('warn', a) }
  error(...a: unknown[]) { this.push('error', a) }
  at(level: string): string[] {
    return this.lines.filter((l) => l.level === level).map((l) => l.text)
  }

  private push(level: string, a: unknown[]) {
    this.lines.push({ level, text: a.map(String).join(' ') })
  }
}

export interface EnvOptions extends Pick<HarnessOptions, 'help' | 'onebot'> {
  /** 插件配置（控制台的原始值）；manifestUrl、glossaryUrl 默认留空 = 只用自带数据 */
  config?: Record<string, unknown>
  /** 启动之前往假 ESI 里放订单 */
  esi?: (fake: FakeEsi) => void
  /** 在本插件之后再装一个测试用的插件（例如 onebot 上的中间件） */
  setup?: (app: Context) => void
  /** 在本插件之前装（例如抢先注册同名命令的旧插件） */
  before?: (app: Context) => void
  /** 插件和假 ESI 的时钟；默认 testClock() */
  clock?: Clock
  /** 插件的定时器（core 的时限、慢提示）；默认 ctx.setTimeout */
  scheduler?: Scheduler
  /** 看门狗的定时器；默认 ctx.setTimeout（测试里不会触发） */
  watchdogScheduler?: Scheduler
  /** 加载 Koishi 的 server 插件，监听 127.0.0.1 的这个端口（先用 freePort() 取一个） */
  serverPort?: number
  /** 提供一个 puppeteer 服务（假浏览器或真的 Chromium）；不写 = 没有 puppeteer */
  puppeteer?: PuppeteerLike
}

/** Koishi puppeteer 服务里用到的部分 */
export interface PuppeteerLike {
  page(): Promise<unknown>
}

/** 以插件的形式提供 puppeteer 服务（停用这个插件 = 控制台里停用 puppeteer） */
export function puppeteerPlugin(service: PuppeteerLike) {
  return { name: 'fake-puppeteer', apply: (ctx: Context) => { ctx.set('puppeteer', service) } }
}

export interface PluginEnv {
  h: Harness
  fake: FakeEsi
  store: ModuleStore
  logger: RecordingLogger
  /** 本插件（停用它 = 控制台里停用或保存配置时的重载） */
  plugin(): ForkScope
  stop(): Promise<void>
}

// koishi 走 CommonJS 入口，server 插件也用 CommonJS，保证是同一份 cordis
const requireCjs = createRequire(__filename)
const serverModule = requireCjs('@koishijs/plugin-server') as { default?: unknown; Server?: unknown }
const ServerPlugin = (serverModule.default ?? serverModule.Server ?? serverModule) as never

/** 127.0.0.1 上一个空闲端口 */
export async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

export function baseConfig(config: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...config,
    advanced: { manifestUrl: '', glossaryUrl: '', ...config.advanced as object },
    // 势力图地址默认留空：不联网，也不留下预取和定时更新的定时器
    render: { influenceMapUrl: '', coalitionMapUrl: '', ...config.render as object },
  }
}

/** 一种物品在 Jita 4-4 的卖单和买单（只挂在本站） */
export function jitaOrders(typeId: number, sell: number | null, buy: number | null, extra: Partial<RawOrder> = {}): RawOrder[] {
  const out: RawOrder[] = []
  if (sell !== null) out.push(rawOrder({ type_id: typeId, price: sell, volume_remain: 100, ...extra }))
  if (buy !== null) out.push(rawOrder({ type_id: typeId, price: buy, is_buy_order: true, range: 'station', volume_remain: 100, ...extra }))
  return out
}

/** 把订单放进某个星域（追加） */
export function addOrders(fake: FakeEsi, region: number, orders: RawOrder[]) {
  fake.regionOrders.set(region, [...fake.regionOrders.get(region) ?? [], ...orders])
}

interface InstallSetup {
  fake: FakeEsi
  store: ModuleStore
  logger: RecordingLogger
  clock: Clock
  scheduler?: Scheduler
  watchdogScheduler?: Scheduler
  /** 本插件每次停用（包括测试里重载）时拿到「停完了」的 Promise */
  onStop?: (done: Promise<void>) => void
  /** 装好以后记下本插件 */
  installed?: (fork: ForkScope) => void
}

function pluginInstaller(setup: InstallSetup, config: Record<string, unknown>) {
  const data = bundledDir(makeVersion())
  const { fake, store, logger, clock, scheduler, watchdogScheduler, onStop } = setup
  return (app: Context) => {
    const fork = app.plugin({
      name: 'eve-market',
      // 和 src/index.ts 一样：授权档案表要用数据库；puppeteer 可选，用的时候才取
      inject: { database: { required: true }, http: { required: true }, puppeteer: { required: false } },
      Config,
      apply: (ctx: Context, cfg: Config) => installPlugin(ctx, cfg, {
        store,
        bundledDataDir: data,
        overrides: { esiBase: fake.base, ssoBase: fake.base, random: () => 0.5 },
        logger,
        clock,
        ...scheduler ? { scheduler } : {},
        ...watchdogScheduler ? { watchdogScheduler } : {},
        ...onStop ? { onStop } : {},
      }),
    // 控制台的原始值，由 Schema 补默认值、normalize 逐行检查
    }, baseConfig(config) as unknown as Config)
    setup.installed?.(fork)
  }
}

async function fakeEsi(clock: Clock, setup?: (fake: FakeEsi) => void): Promise<FakeEsi> {
  const fake = new FakeEsi()
  fake.clock = () => clock.now()
  setup?.(fake)
  await fake.start()
  return fake
}

/** 整个插件 + FakeBot（大部分用例） */
export async function startPlugin(options: EnvOptions = {}): Promise<PluginEnv> {
  const clock = options.clock ?? testClock()
  const fake = await fakeEsi(clock, options.esi)
  const store = createModuleStore()
  const logger = new RecordingLogger()
  let plugin: ForkScope | undefined
  // 删临时目录以前等本插件停完（Koishi 不等异步的停用，建筑市场的缓存可能还在写）
  const stopping: Array<Promise<void>> = []
  const install = pluginInstaller({
    fake, store, logger, clock, scheduler: options.scheduler, watchdogScheduler: options.watchdogScheduler,
    onStop: (done) => stopping.push(done), installed: (fork) => { plugin = fork },
  }, options.config ?? {})
  let server: ForkScope | undefined
  const h = await startHarness({
    help: options.help,
    onebot: options.onebot,
    beforeCleanup: () => Promise.all(stopping),
    setup: (app) => {
      if (options.serverPort) server = app.plugin(ServerPlugin, { host: '127.0.0.1', port: options.serverPort })
      if (options.puppeteer) app.plugin(puppeteerPlugin(options.puppeteer))
      options.before?.(app)
      install(app)
      options.setup?.(app)
    },
  })
  return {
    h,
    fake,
    store,
    logger,
    plugin: () => plugin!,
    async stop() {
      // 先停 server（它停用时要写日志，日志服务比它先撤掉会报错）
      server?.dispose()
      await h.stop()
      await fake.stop()
      cleanupDirs()
    },
  }
}

export interface RealEnv {
  qq: RealQQ
  fake: FakeEsi
  logger: RecordingLogger
  stop(): Promise<void>
}

/** 整个插件 + 真实的 adapter-qq 接本机的假开放平台（少数高保真用例） */
export async function startRealPlugin(options: EnvOptions = {}): Promise<RealEnv> {
  const clock = options.clock ?? testClock()
  const fake = await fakeEsi(clock, options.esi)
  const logger = new RecordingLogger()
  const stopping: Array<Promise<void>> = []
  const install = pluginInstaller({ fake, store: createModuleStore(), logger, clock, scheduler: options.scheduler, onStop: (done) => stopping.push(done) }, options.config ?? {})
  const qq = await startRealQQ({ help: options.help, setup: (app) => { options.before?.(app); install(app); options.setup?.(app) }, beforeCleanup: () => Promise.all(stopping) })
  return {
    qq,
    fake,
    logger,
    async stop() {
      await qq.stop()
      await fake.stop()
      cleanupDirs()
    },
  }
}

export const MARKETS_WITH_ALLIANCE = [...PRESET_MARKETS, ALLIANCE_MARKET]
