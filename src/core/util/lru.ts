// 带容量上限的 LRU，可选过期时间。core 里不直接读系统时间，用到过期时间时必须传 now。

export interface LruOptions {
  /** 最多保留几条，超过时丢掉最久没用的 */
  max: number
  /** 默认的过期时间（毫秒）；不写 = 不过期 */
  ttlMs?: number
  now?: () => number
}

interface Entry<V> {
  value: V
  /** 0 = 不过期 */
  expiresAt: number
}

export class LruCache<K, V> {
  private readonly map = new Map<K, Entry<V>>()
  private readonly max: number
  private readonly ttlMs: number
  private readonly now?: () => number

  constructor(options: LruOptions) {
    if (!(options.max >= 1)) throw new RangeError('LruCache: max 至少是 1')
    if (options.ttlMs && !options.now) throw new Error('LruCache: 用过期时间时必须传 now')
    this.max = Math.floor(options.max)
    this.ttlMs = options.ttlMs ?? 0
    this.now = options.now
  }

  get size() {
    return this.map.size
  }

  /** 取值并标成最近用过；过期的当作不存在 */
  get(key: K): V | undefined {
    const entry = this.live(key)
    if (!entry) return undefined
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  /** 取值但不改变顺序 */
  peek(key: K): V | undefined {
    return this.live(key)?.value
  }

  has(key: K): boolean {
    return !!this.live(key)
  }

  /** ttlMs 覆盖默认的过期时间；0 = 这一条不过期 */
  set(key: K, value: V, ttlMs = this.ttlMs): this {
    if (ttlMs && !this.now) throw new Error('LruCache: 用过期时间时必须传 now')
    this.map.delete(key)
    this.map.set(key, { value, expiresAt: ttlMs ? this.now!() + ttlMs : 0 })
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K)
    return this
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear() {
    this.map.clear()
  }

  /** 从最久没用的到最近用过的；不含已过期的 */
  keys(): K[] {
    return [...this.map.keys()].filter((key) => this.has(key))
  }

  /** 清掉所有过期的条目，返回清掉了几条 */
  prune(): number {
    let removed = 0
    for (const key of [...this.map.keys()]) {
      if (!this.live(key)) removed++
    }
    return removed
  }

  private live(key: K): Entry<V> | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (entry.expiresAt && this.now!() >= entry.expiresAt) {
      this.map.delete(key)
      return undefined
    }
    return entry
  }
}
