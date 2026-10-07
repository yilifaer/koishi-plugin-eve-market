// 等待和时限。都通过 Scheduler 端口，测试里可以用假时钟。

import type { Scheduler } from '../ports'

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Aborted')
}

export function sleep(scheduler: Scheduler, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    const onAbort = () => {
      cancel()
      reject(abortReason(signal!))
    }
    const cancel = scheduler.timeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type DeadlineResult<T> = { done: true; value: T } | { done: false }

/**
 * 最多等 ms 毫秒。到时间还没完成就返回 { done: false }，原来的任务照样在后台跑完（结果通常写进缓存）；
 * 时限之前失败就抛出原来的错误，时限之后才失败的错误被吞掉。
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, scheduler: Scheduler): Promise<DeadlineResult<T>> {
  return new Promise<DeadlineResult<T>>((resolve, reject) => {
    let settled = false
    const cancel = scheduler.timeout(() => {
      if (settled) return
      settled = true
      resolve({ done: false })
    }, Math.max(0, ms))
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        cancel()
        resolve({ done: true, value })
      },
      (error) => {
        if (settled) return
        settled = true
        cancel()
        reject(error)
      },
    )
  })
}
