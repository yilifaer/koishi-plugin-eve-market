// 熔断：10 分钟内 Markdown 失败 3 次 → 之后 30 分钟全部发纯文本（三个数都是常量）。
// 放在模块级存储里，控制台保存配置后还在；「市场状态」用 status() 显示。

import { BREAKER_COOLDOWN_MIN, BREAKER_FAILURES, BREAKER_WINDOW_MIN } from '../../constants'

export interface BreakerOptions {
  failures: number
  windowMs: number
  cooldownMs: number
}

export interface BreakerStatus {
  open: boolean
  /** 熔断到什么时候；没熔断时 null */
  until: number | null
  /** 窗口内的失败次数 */
  recentFailures: number
  /** 累计熔断次数 */
  trips: number
  lastTripAt: number | null
}

const DEFAULTS: BreakerOptions = {
  failures: BREAKER_FAILURES,
  windowMs: BREAKER_WINDOW_MIN * 60_000,
  cooldownMs: BREAKER_COOLDOWN_MIN * 60_000,
}

export class Breaker {
  private failures: number[] = []
  private until = 0
  private trips = 0
  private lastTripAt: number | null = null
  private readonly o: BreakerOptions

  constructor(options: Partial<BreakerOptions> = {}) {
    this.o = { ...DEFAULTS, ...options }
  }

  isOpen(now: number): boolean {
    return now < this.until
  }

  /** 记一次 Markdown 失败；这一次让它熔断时返回 true */
  fail(now: number): boolean {
    if (this.isOpen(now)) return false
    this.failures = this.recent(now)
    this.failures.push(now)
    if (this.failures.length < this.o.failures) return false
    this.failures = []
    this.until = now + this.o.cooldownMs
    this.trips++
    this.lastTripAt = now
    return true
  }

  status(now: number): BreakerStatus {
    const open = this.isOpen(now)
    return {
      open,
      until: open ? this.until : null,
      recentFailures: this.recent(now).length,
      trips: this.trips,
      lastTripAt: this.lastTripAt,
    }
  }

  private recent(now: number): number[] {
    return this.failures.filter((t) => now - t < this.o.windowMs)
  }
}
