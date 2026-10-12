// 官方机器人看门狗：连续不在线满 10 分钟重启 adapter-qq，两次至少隔 30 分钟；只看 QQ 官方机器人；关掉时只记录不重启。
// 后面一组用真的 Koishi 和假机器人：重启的是机器人所在的插件，换上一个新的机器人；「市场状态」里看得到。

import { format } from 'node:util'
import { Universal } from 'koishi'
import { describe, expect, it, vi } from 'vitest'
import { Watchdog } from '../../../src/bot/watchdog'
import type { WatchedBot } from '../../../src/bot/watchdog'
import { createModuleStore } from '../../../src/core/ports'
import { FakeTime } from '../../fakes/fake-time'
import { FakeBot, USER } from '../../harness'
import { card, startPlugin } from '../integration/plugin-env'

const MIN = 60_000

function setup(enabled = true) {
  const time = new FakeTime()
  const logs: string[] = []
  const logger = { debug() {}, info() {}, warn: (...a: unknown[]) => logs.push(format(...a)), error() {} }
  const restarts: string[] = []
  const bot = (sid: string, platform = 'qq'): WatchedBot & { status: Universal.Status } => ({
    sid, platform, status: Universal.Status.ONLINE, restart: () => restarts.push(sid),
  })
  const bots = [bot('qq:1'), bot('onebot:2', 'onebot')]
  const store = createModuleStore()
  const dog = new Watchdog({ enabled, bots: () => bots, store, clock: time, logger })
  /** 每分钟看一次，一共 n 分钟 */
  const minutes = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await time.advance(MIN)
      dog.check()
    }
  }
  return { time, logs, restarts, bots, dog, store, minutes }
}

describe('Watchdog', () => {
  it('restarts after 10 minutes offline, then waits at least 30 minutes before the next restart', async () => {
    const { bots, restarts, logs, dog, minutes } = setup()
    dog.check()
    bots[0].status = Universal.Status.RECONNECT
    dog.check()
    await minutes(9)
    expect(restarts).toEqual([])
    expect(dog.status().downSince).not.toBeNull()
    await minutes(1)
    expect(restarts).toEqual(['qq:1'])
    expect(logs[0]).toMatch(/官方机器人 qq:1 已经 10 分钟不在线，自动重启 adapter-qq/)
    // 重启以后还是不在线：重新计时，但离上次重启不到 30 分钟时不再重启
    await minutes(29)
    expect(restarts).toEqual(['qq:1'])
    await minutes(1)
    expect(restarts).toEqual(['qq:1', 'qq:1'])
    expect(dog.status()).toMatchObject({ enabled: true, bots: 1, restarts: 2, lastDownMinutes: 30 })
  })

  it('coming back online resets the count; only QQ bots are watched', async () => {
    const { bots, restarts, dog, minutes } = setup()
    bots[0].status = Universal.Status.OFFLINE
    bots[1].status = Universal.Status.OFFLINE
    dog.check()
    await minutes(8)
    bots[0].status = Universal.Status.ONLINE
    dog.check()
    expect(dog.status().downSince).toBeNull()
    bots[0].status = Universal.Status.OFFLINE
    dog.check()
    await minutes(9)
    expect(restarts).toEqual([])
    await minutes(1)
    expect(restarts).toEqual(['qq:1'])
  })

  it('switched off: never restarts, but still tells how long the bot has been offline', async () => {
    const { bots, restarts, dog, time, minutes } = setup(false)
    const start = time.now()
    bots[0].status = Universal.Status.OFFLINE
    dog.check()
    await minutes(60)
    expect(restarts).toEqual([])
    expect(dog.status()).toMatchObject({ enabled: false, downSince: start, restarts: 0 })
  })

  it('a failing restart is logged and the next one still waits for the cooldown', async () => {
    const { bots, logs, dog, minutes } = setup()
    bots[0].restart = () => { throw new Error('scope is disposed') }
    bots[0].status = Universal.Status.OFFLINE
    dog.check()
    await minutes(10)
    expect(logs.some((l) => l.includes('自动重启 adapter-qq 失败：scope is disposed'))).toBe(true)
    expect(dog.status().restarts).toBe(1)
  })

  it('the count survives a plugin reload (module store)', async () => {
    const { bots, dog, store, time, minutes } = setup()
    bots[0].status = Universal.Status.OFFLINE
    dog.check()
    await minutes(10)
    const again = new Watchdog({ enabled: true, bots: () => bots, store, clock: time, logger: { debug() {}, info() {}, warn() {}, error() {} } })
    expect(again.status().restarts).toBe(dog.status().restarts)
  })
})

describe('Watchdog in Koishi', () => {
  it('restarts the plugin the QQ bot lives in (a new bot, like disabling and enabling adapter-qq) and shows it in 市场状态', async () => {
    const time = new FakeTime()
    const e = await startPlugin({ clock: time, scheduler: time, watchdogScheduler: time, config: { access: { admins: [USER] } } })
    try {
      const old = e.h.app.bots.find((b) => b.platform === 'qq') as FakeBot
      old.offline()
      await time.advance(11 * MIN)
      const now = e.h.app.bots.find((b) => b.platform === 'qq') as FakeBot
      expect(now).toBeDefined()
      expect(now).not.toBe(old)
      await vi.waitFor(() => expect(now.status).toBe(Universal.Status.ONLINE))
      expect(e.logger.at('warn').some((l) => l.includes('自动重启 adapter-qq（和在控制台停用再启用一样）'))).toBe(true)
      const status = card(await e.h.send(now, '市场状态', { direct: true }))
      expect(status).toMatch(/官方机器人：在线 · 自动重启过 1 次（最近 \d\d:\d\d，之前不在线 \d+ 分钟）/)
    } finally {
      await e.stop()
    }
  })
})
