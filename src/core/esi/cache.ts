// ESI 响应缓存。过期的条目不删：留着做条件请求（If-None-Match）和出错时的旧数据，
// 只在占用超过上限时按最久没用的顺序丢掉。

export interface EsiCacheEntry<T = unknown> {
  value: T
  etag?: string
  /** Last-Modified；没有这个头时 null */
  lastModified: number | null
  /** 这个时间之前不再请求 */
  expiresAt: number
  /** 最近一次 200 或 304 的时间 */
  validatedAt: number
  /** 分页路由：X-Pages */
  pages?: number
  /** 响应体字节数，估算占用用 */
  bytes: number
}

/**
 * 缓存的存放处。默认是内存里的 MemoryResponseCache；建筑市场这种大的分页数据可以换成自己的实现
 * （例如写进 BlobCache），键的格式见 EsiClient.keyOf。
 */
export interface EsiCacheStore {
  get(key: string): EsiCacheEntry | undefined | Promise<EsiCacheEntry | undefined>
  set(key: string, entry: EsiCacheEntry): void | Promise<void>
}

/** 按响应体字节数限制总占用的 LRU */
export class MemoryResponseCache implements EsiCacheStore {
  private readonly map = new Map<string, EsiCacheEntry>()
  private total = 0

  constructor(private readonly maxBytes: number) {
    if (!(maxBytes > 0)) throw new RangeError('MemoryResponseCache: maxBytes 要大于 0')
  }

  get size() {
    return this.map.size
  }

  get bytes() {
    return this.total
  }

  get(key: string): EsiCacheEntry | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    this.map.delete(key)
    this.map.set(key, entry)
    return entry
  }

  set(key: string, entry: EsiCacheEntry) {
    this.delete(key)
    this.map.set(key, entry)
    this.total += entry.bytes
    // 至少留下刚放进去的这一条
    for (const [oldest, old] of this.map) {
      if (this.total <= this.maxBytes || oldest === key) break
      this.map.delete(oldest)
      this.total -= old.bytes
    }
  }

  delete(key: string): boolean {
    const entry = this.map.get(key)
    if (!entry) return false
    this.map.delete(key)
    this.total -= entry.bytes
    return true
  }

  clear() {
    this.map.clear()
    this.total = 0
  }
}
