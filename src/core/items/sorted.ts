// 排好序的字符串数组上的二分查找（前缀档、拼音全拼）。

/** 第一个 >= value 的位置 */
export function lowerBound(sorted: readonly string[], value: string): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** 以 prefix 开头的那一段：[start, end) */
export function prefixRange(sorted: readonly string[], prefix: string): [number, number] {
  const start = lowerBound(sorted, prefix)
  let end = start
  while (end < sorted.length && sorted[end].startsWith(prefix)) end++
  return [start, end]
}

/** 按 key 排好的 (key, row) 两列；key 相同时按 row */
export function sortPairs(keys: readonly string[], rows: readonly number[]): { keys: string[]; rows: Int32Array } {
  const order = Array.from(keys.keys())
  order.sort((a, b) => {
    const ka = keys[a]
    const kb = keys[b]
    if (ka === kb) return rows[a] - rows[b]
    return ka < kb ? -1 : 1
  })
  return { keys: order.map((i) => keys[i]), rows: Int32Array.from(order, (i) => rows[i]) }
}
