// 完整快照上的批量估价耗时：认不出的行要线性扫描找「是不是：X」，200 行垃圾也不能把事件循环卡住（§9.3）。

import { performance } from 'node:perf_hooks'
import { beforeAll, describe, expect, it } from 'vitest'
import { readList } from '../../../src/core/appraisal/lines'
import { parsePaste } from '../../../src/core/parse'
import { isFailure } from '../../../src/core/types'
import type { PasteParse } from '../../../src/core/types'
import { snapshotResolver } from '../items/helpers'

function parse(text: string): PasteParse {
  const parsed = parsePaste(text, { matchMarket: () => null })
  if (isFailure(parsed)) throw new Error(parsed.code)
  return parsed
}

beforeAll(() => snapshotResolver().warm())

describe('readList on the full snapshot', () => {
  it('200 unrecognised lines (English and Chinese) take well under 100 ms', () => {
    const items = snapshotResolver()
    for (const text of [
      Array.from({ length: 200 }, (_, i) => `zzqx${i} wvut kjhg`).join('\n'),
      Array.from({ length: 200 }, (_, i) => `完全对不上的东西${i}号`).join('\n'),
    ]) {
      const start = performance.now()
      const { list } = readList(parse(text), items)
      const ms = performance.now() - start
      expect(list.entries).toHaveLength(200)
      expect(ms).toBeLessThan(100)
    }
  })
})
