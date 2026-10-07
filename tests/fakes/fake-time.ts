// 假时钟：同时实现 core 的 Clock 和 Scheduler 端口。advance() 按时间顺序触发到期的定时器，
// 每触发一个都先让出事件循环，定时器里排的 Promise 回调会在下一个定时器之前跑完。

import type { Clock, Scheduler } from '../../src/core/ports'

interface Timer {
  id: number
  at: number
  fn: () => void
}

export class FakeTime implements Clock, Scheduler {
  private timers: Timer[] = []
  private nextId = 1

  constructor(private current = Date.UTC(2026, 9, 7, 6, 20)) {}

  now() {
    return this.current
  }

  timeout(fn: () => void, ms: number): () => void {
    const timer = { id: this.nextId++, at: this.current + Math.max(0, ms), fn }
    this.timers.push(timer)
    return () => {
      this.timers = this.timers.filter((t) => t !== timer)
    }
  }

  /** 还没触发的定时器个数 */
  get pending() {
    return this.timers.length
  }

  async advance(ms: number) {
    const target = this.current + ms
    for (;;) {
      await flush()
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter((t) => t !== due)
      this.current = due.at
      due.fn()
    }
    this.current = target
    await flush()
  }
}

/** 让出几轮事件循环，排队的 Promise 回调都跑完 */
export async function flush() {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}
