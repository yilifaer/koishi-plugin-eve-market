// 退避间隔和随机抖动。随机数可以注入，测试里固定。

export type Random = () => number

/** 按给定的间隔依次退避，用完以后一直用最后一个，例如 1 → 5 → 15 → 60 分钟 */
export class Backoff {
  private count = 0

  constructor(private readonly stepsMs: readonly number[]) {
    if (!stepsMs.length) throw new RangeError('Backoff: 至少要有一个间隔')
  }

  /** 已经退避了几次 */
  get attempts() {
    return this.count
  }

  /** 下一次的间隔，不计数 */
  peek(): number {
    return this.stepsMs[Math.min(this.count, this.stepsMs.length - 1)]
  }

  /** 取下一次的间隔并计数 */
  next(): number {
    const delay = this.peek()
    this.count++
    return delay
  }

  /** 成功以后从头开始 */
  reset() {
    this.count = 0
  }
}

/** [min, max) 之间的随机数 */
export function randomBetween(min: number, max: number, random: Random = Math.random): number {
  return min + (max - min) * random()
}

/** ms × (1 ± ratio) 之间随机 */
export function jitter(ms: number, ratio: number, random: Random = Math.random): number {
  return ms * (1 - ratio + 2 * ratio * random())
}
