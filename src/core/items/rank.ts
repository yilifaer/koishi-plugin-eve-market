// 同一档里的排序（§6.1.7）：(大类惩罚, 元等级, 名字长度, typeID)，都是越小越靠前。

import type { Lang } from '../types'

export const CATEGORY_BLUEPRINT = 9
export const CATEGORY_SKIN = 91
export const CATEGORY_SHIP = 6
export const CATEGORY_SKILL = 16
export const CATEGORY_IMPLANT = 20

/** 服饰、特别版用品、个性化定制 */
const MINOR_CATEGORIES = new Set([30, 63, 2118])

/** 涂装 3、蓝图 2、服饰和特别版 1、其他 0；查询里提到涂装或蓝图时对应的惩罚取消 */
export function categoryPenalty(categoryId: number): number {
  if (categoryId === CATEGORY_SKIN) return 3
  if (categoryId === CATEGORY_BLUEPRINT) return 2
  return MINOR_CATEGORIES.has(categoryId) ? 1 : 0
}

/** 元分组 → 名次：T1 和没有 0，T2 1，势力 2，死亡空间和官员 3，其他 2 */
const META_RANK: ReadonlyMap<number, number> = new Map([
  [1, 0], [54, 0],
  [2, 1], [53, 1],
  [4, 2], [52, 2],
  [5, 3], [6, 3],
])

/** metaGroup 是 NO_ID（-1）时当作没有 */
export function metaRank(metaGroupId: number): number {
  if (metaGroupId < 0) return 0
  return META_RANK.get(metaGroupId) ?? 2
}

/** 查询里有没有提到蓝图、涂装；按哪种语言的名字比长度 */
export interface RankContext {
  blueprint: boolean
  skin: boolean
  lang: Lang
}

/** 排序要用的每行数据（建索引时算好） */
export interface RankColumns {
  readonly category: Int32Array
  readonly meta: Uint8Array
  readonly enLength: Uint16Array
  /** 没有中文名时等于英文名的长度 */
  readonly zhLength: Uint16Array
}

export function penaltyOf(cols: RankColumns, row: number, ctx: RankContext): number {
  const category = cols.category[row]
  if (category === CATEGORY_SKIN && ctx.skin) return 0
  if (category === CATEGORY_BLUEPRINT && ctx.blueprint) return 0
  return categoryPenalty(category)
}

/** 行号放在低 31 位（物品表按 typeID 升序，行号的顺序就是 typeID 的顺序） */
const ROW_SPAN = 2 ** 31

/** 按排序规则原地排好并返回。四项拼成一个不超过 2^53 的数，用 Float64Array 的数值排序，不用比较函数 */
export function rankRows(rows: number[], cols: RankColumns, ctx: RankContext): number[] {
  const lengths = ctx.lang === 'zh' ? cols.zhLength : cols.enLength
  const keys = new Float64Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    keys[i] = ((penaltyOf(cols, row, ctx) * 4 + cols.meta[row]) * 0x10000 + lengths[row]) * ROW_SPAN + row
  }
  keys.sort()
  for (let i = 0; i < keys.length; i++) rows[i] = keys[i] % ROW_SPAN
  return rows
}
