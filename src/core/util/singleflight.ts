// 同一个键的请求在进行中时共享结果：10 个人同时查同一个物品只发 1 个请求。
// 结束（成功或失败）后立即移除，下一次调用重新执行。

export class SingleFlight<K, V> {
  private readonly flights = new Map<K, Promise<V>>()

  get size() {
    return this.flights.size
  }

  has(key: K): boolean {
    return this.flights.has(key)
  }

  run(key: K, fn: () => Promise<V>): Promise<V> {
    const existing = this.flights.get(key)
    if (existing) return existing
    let promise: Promise<V>
    try {
      promise = Promise.resolve(fn())
    } catch (error) {
      promise = Promise.reject(error)
    }
    const tracked = promise.finally(() => {
      if (this.flights.get(key) === tracked) this.flights.delete(key)
    })
    this.flights.set(key, tracked)
    return tracked
  }
}
