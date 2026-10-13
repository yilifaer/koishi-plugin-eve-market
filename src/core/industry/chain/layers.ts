// 层的分类：一个材料在「拆到原料」里属于哪一层。按结构推导，不写物品清单。

import type { ChainLayer, IndustryData, ItemInfo } from '../../types'

/** 分类规则用到的 ID（已和快照核对） */
export const CATEGORY_SHIP = 6
export const GROUP_FUEL_BLOCK = 1136
export const GROUP_TOOL = 332

/** raw = 没有蓝图，永远直接买 */
export type MaterialClass = ChainLayer | 'raw'

/**
 * product 是正在造的产品（T2 物品的 T1 原型要归到 other）；null 时不做这条判断
 */
export function classifyMaterial(
  material: ItemInfo, product: ItemInfo | null, industry: Pick<IndustryData, 'reactions' | 'manufacturing'>,
): MaterialClass {
  const reaction = industry.reactions.get(material.typeId)
  if (reaction) {
    return reaction.materials.some((m) => industry.reactions.has(m.typeId)) ? 'reaction2' : 'reaction1'
  }
  if (!industry.manufacturing.has(material.typeId)) return 'raw'
  if (material.categoryId === CATEGORY_SHIP || material.groupId === GROUP_FUEL_BLOCK || material.groupId === GROUP_TOOL) return 'other'
  if (product && product.techLevel === 2 && product.variationParent === material.typeId) return 'other'
  return 'component'
}
