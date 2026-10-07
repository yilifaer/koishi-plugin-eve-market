// 同一类发送问题（同一个错误码、预算用完、超过时限）每小时只写一次日志。

const HOUR_MS = 3_600_000
/** 键很少（错误码），超过这个数就整个清空 */
const MAX_KEYS = 200

export class LogGate {
  private last = new Map<string, number>()

  constructor(private readonly intervalMs = HOUR_MS) {}

  allow(key: string, now: number): boolean {
    const previous = this.last.get(key)
    if (previous !== undefined && now - previous < this.intervalMs) return false
    if (this.last.size >= MAX_KEYS) this.last.clear()
    this.last.set(key, now)
    return true
  }
}
