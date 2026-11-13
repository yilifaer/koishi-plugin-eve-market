// 生成的写法（§6.1.3，算「别名」档）：中文船名去掉「级」、末尾罗马数字写成阿拉伯数字、查询里的 bp 当作 blueprint、
// 蓝图中文名的旧写法（「灼烧蓝图 S」）。

import { NO_ID } from '../types'
import type { TypeTable } from '../types'
import { romanToDigit } from './normalize'
import { CATEGORY_BLUEPRINT, CATEGORY_SHIP } from './rank'

const BP_WORD = /(?<![\p{L}\p{N}])(?:bpo|bpc|bp)(?![\p{L}\p{N}])/gu
/**
 * 新写法的蓝图中文名：「灼烧 S 蓝图」「散热槽 II 蓝图」（2026-11 起），尺寸、科技等级在「蓝图」前面。
 * 后缀前面要么有空格，要么不是拉丁字母（「磁力ECM I 蓝图」可以，「XML蓝图」不算）
 */
const NEW_BLUEPRINT = /^(.*\S)(?:\s+|(?<=[^A-Za-z\s]))(XL|[SML]|IV|V|III|II|I)\s*蓝图$/

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

/**
 * 蓝图中文名的旧写法：2026-11 以前尺寸、科技等级写在「蓝图」后面（「灼烧蓝图 S」「散热槽蓝图 II」），
 * 很多人还会这样打。新写法以外的名字返回 null
 */
export function oldBlueprintName(zh: string): string | null {
  const m = NEW_BLUEPRINT.exec(zh)
  return m ? `${m[1]}蓝图 ${m[2]}` : null
}

/** 一个物品的全部生成写法（原样，调用方再算 key） */
export function generatedNames(table: TypeTable, row: number, hulls: ReadonlySet<string>): string[] {
  const out: string[] = []
  const en = table.en[row]
  const zh = table.zh[row]
  const enDigit = romanToDigit(en)
  if (enDigit) out.push(enDigit)
  if (zh && table.category[row] === CATEGORY_BLUEPRINT) {
    const old = oldBlueprintName(zh)
    if (old) {
      out.push(old)
      // 旧写法的数字写法（「散热槽蓝图2」），和改名前一样能认
      const digit = romanToDigit(old)
      if (digit) out.push(digit)
    }
  }
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
