// 生成的写法（§6.1.3，算「别名」档）：中文船名去掉「级」、末尾罗马数字写成阿拉伯数字、查询里的 bp 当作 blueprint。

import { NO_ID } from '../types'
import type { TypeTable } from '../types'
import { romanToDigit } from './normalize'
import { CATEGORY_SHIP } from './rank'

const BP_WORD = /(?<![\p{L}\p{N}])(?:bpo|bpc|bp)(?![\p{L}\p{N}])/gu

/** 大类 6（舰船）里中文名以「级」结尾的船体名 */
export function hullNames(table: TypeTable): Set<string> {
  const out = new Set<string>()
  for (let row = 0; row < table.size; row++) {
    const zh = table.zh[row]
    if (table.category[row] === CATEGORY_SHIP && zh.length > 1 && zh.endsWith('级')) out.add(zh)
  }
  return out
}

/**
 * 以某个船体名开头的中文名去掉那个「级」：乌鸦级 → 乌鸦，乌鸦级海军型 → 乌鸦海军型，乌鸦级蓝图 → 乌鸦蓝图。
 * 只认船体名，所以「高级」「中级」「超级」不受影响。没有可去的返回 null
 */
export function withoutJi(zh: string, hulls: ReadonlySet<string>): string | null {
  let best = -1
  for (let i = zh.indexOf('级'); i > 0; i = zh.indexOf('级', i + 1)) {
    if (hulls.has(zh.slice(0, i + 1))) best = i
  }
  return best > 0 ? zh.slice(0, best) + zh.slice(best + 1) : null
}

/** 一个物品的全部生成写法（原样，调用方再算 key） */
export function generatedNames(table: TypeTable, row: number, hulls: ReadonlySet<string>): string[] {
  const out: string[] = []
  const en = table.en[row]
  const zh = table.zh[row]
  const enDigit = romanToDigit(en)
  if (enDigit) out.push(enDigit)
  if (zh) {
    const short = withoutJi(zh, hulls)
    for (const name of short ? [zh, short] : [zh]) {
      if (name !== zh) out.push(name)
      const digit = romanToDigit(name)
      if (digit) out.push(digit)
    }
  }
  return out
}

/** 拉丁查询里的 bp、bpo、bpc 换成 blueprint；没有可换的返回 null */
export function expandBlueprintWords(normalized: string): string | null {
  const out = normalized.replace(BP_WORD, 'blueprint')
  return out === normalized ? null : out
}

/** variationParent 为空时自己就是一族的根 */
export function familyRoot(table: TypeTable, row: number): number {
  const parent = table.variationParent[row]
  return parent === NO_ID ? table.id[row] : parent
}
