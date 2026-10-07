// core 的生命周期：ready 时建端口、组装 core 并启动（读缓存或自带快照），停用时停掉。
// 命令和中间件只经 CoreHandle 拿 core：数据还没准备好时命令最多等 READY_WAIT_MS。

import type { Logger } from '../../core/ports'
import type { EveCore } from '../../core/types'
import { describeError } from '../../core/util'
import { within } from './wait'

export interface CoreHandle {
  /** 等 core 和数据都准备好，最多 ms 毫秒；没准备好（或已停用）返回 null */
  ready(ms: number): Promise<EveCore | null>
  /** 已经准备好的 core（中间件里同步判断用）；还没准备好时 null */
  current(): EveCore | null
}

export class CoreRuntime implements CoreHandle {
  private core: EveCore | null = null
  private loaded: EveCore | null = null
  private stopped = false
  private resolveBooted!: (core: EveCore | null) => void
  private readonly booted = new Promise<EveCore | null>((resolve) => { this.resolveBooted = resolve })

  constructor(private readonly logger: Logger) {}

  /** 只调用一次；任何错误都只写日志，不让插件加载失败 */
  async start(build: () => Promise<EveCore>): Promise<void> {
    let core: EveCore
    try {
      core = await build()
    } catch (e) {
      this.logger.error(`启动失败，命令暂时不能用：${describeError(e)}`)
      this.resolveBooted(null)
      return
    }
    if (this.stopped) {
      await core.stop().catch(() => undefined)
      this.resolveBooted(null)
      return
    }
    this.core = core
    this.resolveBooted(core)
    void core.ready.then(() => {
      if (!this.stopped) this.loaded = core
    })
    try {
      await core.start()
    } catch (e) {
      this.logger.error(`启动失败：${describeError(e)}`)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.loaded = null
    this.resolveBooted(null)
    const core = this.core
    this.core = null
    if (core) await core.stop().catch((e) => this.logger.warn(`停止时出错：${describeError(e)}`))
  }

  current(): EveCore | null {
    return this.loaded
  }

  ready(ms: number): Promise<EveCore | null> {
    if (this.loaded) return Promise.resolve(this.loaded)
    const loaded = this.booted.then(async (core) => {
      if (!core) return null
      await core.ready
      return this.stopped ? null : core
    })
    return within(loaded, ms)
  }
}
