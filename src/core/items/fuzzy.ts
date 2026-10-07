// 容错档（§6.1.6 的 4b）用的距离。

/**
 * Damerau-Levenshtein（相邻换位算一步，即 OSA）。超过 max 时尽早返回 max + 1，
 * 容错档只关心「≤ 1」或「≤ 2」，名字又都很短，所以不建整张表，只留三行。
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  if (a === b) return 0
  let prev2 = new Array<number>(b.length + 1).fill(0)
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  let cur = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1)
      cur[j] = d
      if (d < rowMin) rowMin = d
    }
    if (rowMin > max) return max + 1
    const spare = prev2
    prev2 = prev
    prev = cur
    cur = spare
  }
  return prev[b.length]
}

/** 拉丁查询允许的距离：8 个字符以上 2，否则 1 */
export function maxDistance(key: string): number {
  return key.length >= 8 ? 2 : 1
}

/** 查询里的字有几个出现在名字里 */
export function sharedChars(chars: readonly string[], name: string): number {
  let n = 0
  for (const ch of chars) if (name.includes(ch)) n++
  return n
}
