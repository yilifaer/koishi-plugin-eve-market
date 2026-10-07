// 并发上限。交互请求和后台任务各用一个独立的 Pool，后台再忙也占不到交互请求的名额。

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Aborted')
}

export class Pool {
  private running = 0
  private readonly queue: Array<() => void> = []
  readonly limit: number

  constructor(limit: number) {
    if (!(limit >= 1)) throw new RangeError('Pool: limit 至少是 1')
    this.limit = Math.floor(limit)
  }

  get active() {
    return this.running
  }

  get waiting() {
    return this.queue.length
  }

  /** 等到有空位再执行；排队时 signal 中止就不再执行，直接 reject */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortReason(signal)
    if (this.running >= this.limit) await this.wait(signal)
    else this.running++
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private wait(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        const index = this.queue.indexOf(start)
        if (index >= 0) this.queue.splice(index, 1)
        reject(abortReason(signal!))
      }
      this.queue.push(start)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 名额直接交给排在最前面的任务，running 不变 */
  private release() {
    const next = this.queue.shift()
    if (next) next()
    else this.running--
  }
}

/** 按顺序返回结果，同时最多跑 limit 个；任何一个失败就整体失败（已经开始的照样跑完） */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const pool = new Pool(limit)
  return Promise.all(items.map((item, index) => pool.run(() => fn(item, index))))
}
