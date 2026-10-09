// 慢提示（§2.0.14）：只用于重操作（走势图第一次渲染、势力图缓存未命中、战报截图）。开始处理后计时，
// 超过 SLOW_HINT_MS 还没好才发一行纯文字，每条用户消息最多一次（Replier.hint 保证）。
// 提示占一条回复额度：留不出后面要发的条数时不发（单聊的额度少 1 条，走势、势力图在单聊里就不发提示）。

import { SLOW_HINT_MS } from '../../constants'
import type { Invocation } from './context'

export interface SlowHint {
  /** 结果出来了：还没到时间就不再发 */
  stop(): void
  /** 等已经开始发的提示发完（结果要排在提示后面）；发出去了返回 true */
  sent(): Promise<boolean>
}

/**
 * 到时间时调用 text()：返回一行文字就发，返回 null 不发（例如这时已经知道有缓存）。
 * reserve：提示后面至少还要发几条（发了提示以后剩下的额度不够就不发）
 */
export function startSlowHint(inv: Pick<Invocation, 'commands' | 'reply'>, reserve: number, text: () => string | null): SlowHint {
  let sending: Promise<boolean> = Promise.resolve(false)
  let stopped = false
  const cancel = inv.commands.scheduler.timeout(() => {
    if (stopped || inv.reply.remaining() < reserve + 1) return
    const line = text()
    if (line) sending = inv.reply.hint(line)
  }, SLOW_HINT_MS)
  return {
    stop() {
      stopped = true
      cancel()
    },
    sent: () => sending,
  }
}
