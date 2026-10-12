// 官方机器人看门狗：adapter-qq 断网恢复后有时一直拿过期的令牌重连（日志每分钟报「AccessToken无效或过期」），自己不会好，
// 只有在控制台停用再启用 adapter-qq 才行。这里每分钟看一次 QQ 机器人的状态：连续不在线满 10 分钟，就重启它所在的插件
// （和停用再启用一样，会重新取令牌），两次重启至少隔 30 分钟。重启记在模块级存储里，「市场状态」里能看到。
// 只看 QQ 官方机器人，不碰 LLBot 等其他机器人。

import { Universal } from 'koishi'
import type { Context } from 'koishi'
import { QQ_WATCHDOG_CHECK_MS, QQ_WATCHDOG_COOLDOWN_MS, QQ_WATCHDOG_OFFLINE_MS } from '../constants'
import type { Clock, Logger, ModuleStore, Scheduler } from '../core/ports'

/** 看门狗用到的机器人信息；restart 重启它所在的插件 */
export interface WatchedBot {
  sid: string
  platform: string
  status: Universal.Status
  restart(): void
}

export interface WatchdogStatus {
  enabled: boolean
  /** 现在有几个 QQ 官方机器人 */
  bots: number
  /** 不在线的机器人从什么时候开始不在线（几个时取最早的）；都在线时 null */
  downSince: number | null
  /** 自动重启过几次（插件重载也不清零） */
  restarts: number
  lastRestartAt: number | null
  /** 最近一次重启前不在线了多少分钟 */
  lastDownMinutes: number | null
}

interface WatchdogState {
  downSince: Map<string, number>
  restarts: number
  lastRestartAt: number | null
  lastDownMinutes: number | null
}

const STATE_KEY = 'bot/watchdog'

function watchdogState(store: ModuleStore): WatchdogState {
  return store.get<WatchdogState>(STATE_KEY, () => ({ downSince: new Map(), restarts: 0, lastRestartAt: null, lastDownMinutes: null }))
}

export interface WatchdogOptions {
  enabled: boolean
  bots: () => WatchedBot[]
  store: ModuleStore
  clock: Clock
  logger: Logger
}

export class Watchdog {
  private readonly state: WatchdogState

  constructor(private readonly o: WatchdogOptions) {
    this.state = watchdogState(o.store)
  }

  private qqBots(): WatchedBot[] {
    return this.o.bots().filter((b) => b.platform === 'qq')
  }

  /** 看一遍：记下不在线的开始时间，满 10 分钟、离上次重启也够 30 分钟时重启 */
  check(): void {
    const now = this.o.clock.now()
    const { state } = this
    const bots = this.qqBots()
    for (const sid of state.downSince.keys()) {
      if (!bots.some((b) => b.sid === sid)) state.downSince.delete(sid)
    }
    for (const bot of bots) {
      if (bot.status === Universal.Status.ONLINE) {
        state.downSince.delete(bot.sid)
        continue
      }
      const since = state.downSince.get(bot.sid) ?? now
      state.downSince.set(bot.sid, since)
      if (!this.o.enabled || now - since < QQ_WATCHDOG_OFFLINE_MS) continue
      if (state.lastRestartAt !== null && now - state.lastRestartAt < QQ_WATCHDOG_COOLDOWN_MS) continue
      const minutes = Math.floor((now - since) / 60_000)
      state.restarts++
      state.lastRestartAt = now
      state.lastDownMinutes = minutes
      // 重启以后重新计时
      state.downSince.set(bot.sid, now)
      this.o.logger.warn('官方机器人 %s 已经 %d 分钟不在线，自动重启 adapter-qq（和在控制台停用再启用一样）', bot.sid, minutes)
      try {
        bot.restart()
      } catch (error) {
        this.o.logger.warn('自动重启 adapter-qq 失败：%s', error instanceof Error ? error.message : String(error))
      }
    }
  }

  status(): WatchdogStatus {
    const bots = this.qqBots()
    // 按机器人现在的状态算：已经回来的不算；刚掉线、还没轮到检查的从现在算起
    const now = this.o.clock.now()
    const down = bots.filter((b) => b.status !== Universal.Status.ONLINE).map((b) => this.state.downSince.get(b.sid) ?? now)
    return {
      enabled: this.o.enabled,
      bots: bots.length,
      downSince: down.length ? Math.min(...down) : null,
      restarts: this.state.restarts,
      lastRestartAt: this.state.lastRestartAt,
      lastDownMinutes: this.state.lastDownMinutes,
    }
  }
}

/**
 * Koishi 里的机器人：重启它所在的插件（adapter-qq），新建的机器人会重新取令牌。
 * 经 ctx.bots 拿到的机器人，bot.ctx 指向的是读它的插件（也就是本插件），所以要用 bot.context（机器人自己的插件）；
 * 拿不到、或者是根作用域、本插件时不动
 */
function koishiBots(ctx: Context): WatchedBot[] {
  return ctx.bots.map((bot) => ({
    sid: bot.sid,
    platform: bot.platform ?? '',
    status: bot.status,
    restart: () => {
      const scope = (bot as unknown as { context?: Context }).context?.scope
      if (!scope || scope === ctx.root.scope || scope === ctx.scope) throw new Error('找不到 adapter-qq 所在的插件')
      scope.restart()
    },
  }))
}

/** 每分钟看一次；关掉时照样记录不在线的时间（「市场状态」里显示），只是不重启 */
export function installWatchdog(ctx: Context, o: Omit<WatchdogOptions, 'bots'> & { scheduler: Scheduler }): Watchdog {
  const watchdog = new Watchdog({ ...o, bots: () => koishiBots(ctx) })
  let cancel: (() => void) | undefined
  let stopped = false
  const loop = () => {
    if (stopped) return
    watchdog.check()
    cancel = o.scheduler.timeout(loop, QQ_WATCHDOG_CHECK_MS)
  }
  ctx.on('ready', () => {
    cancel = o.scheduler.timeout(loop, QQ_WATCHDOG_CHECK_MS)
  })
  ctx.on('dispose', () => {
    stopped = true
    cancel?.()
  })
  return watchdog
}
