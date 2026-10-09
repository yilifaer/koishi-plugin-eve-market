// 失败的结果记一小段时间：这段时间里直接返回记下的结果，不再请求（上游出问题时不让每个人都再打一次）。

import type { Clock } from '../ports'

export class FailureMemo<F> {
  private memo: { until: number; failure: F } | null = null

  constructor(private readonly clock: Clock, private readonly ttlMs: number) {}

  /** 还在有效期里的失败；没有时 null */
  get(): F | null {
    if (this.memo && this.clock.now() < this.memo.until) return this.memo.failure
    this.memo = null
    return null
  }

  /** 记下这次失败并原样返回；keep = false 时只返回不记（例如只是调用方自己的时限到了，请求还在后台继续） */
  remember(failure: F, keep = true): F {
    if (keep) this.memo = { until: this.clock.now() + this.ttlMs, failure }
    return failure
  }

  clear() {
    this.memo = null
  }
}
