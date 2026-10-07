// 「相关物品」（§2.5）：同系列的其他型号、蓝图或产品、名字里包含它的其他物品；涂装只算个数。

import type { ItemIndex } from './item-index'
import { CATEGORY_SKIN, rankRows } from './rank'
import type { RankContext } from './rank'
import { familyRoot } from './variants'

export interface RelatedRows {
  variants: number[]
  blueprint?: number
  product?: number
  containing: number[]
  skins: number
}

const RANK: RankContext = { lang: 'zh', blueprint: false, skin: false }

function rowOf(index: ItemIndex, typeId: number | undefined): number | undefined {
  if (typeId === undefined) return undefined
  const row = index.table.rowOf(typeId)
  return row >= 0 ? row : undefined
}

function blueprintOf(index: ItemIndex, typeId: number): number | undefined {
  const { manufacturing, reactions } = index.data.industry
  return rowOf(index, (manufacturing.get(typeId) ?? reactions.get(typeId))?.blueprintId)
}

function productOf(index: ItemIndex, typeId: number): number | undefined {
  const activities = index.data.industry.byBlueprint.get(typeId)
  return rowOf(index, (activities?.m ?? activities?.r)?.products[0]?.typeId)
}

/** needle 在 text 里作为整词出现（前后是开头、结尾或空格） */
function hasWords(text: string, needle: string): boolean {
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    const end = i + needle.length
    if ((i === 0 || text[i - 1] === ' ') && (end === text.length || text[end] === ' ')) return true
  }
  return false
}

/** 名字里包含它：英文按整词，中文按字串 */
function containsName(index: ItemIndex, row: number, other: number): boolean {
  const en = index.enText[row]
  if (en && hasWords(index.enText[other], en)) return true
  const zh = index.zhText[row]
  return !!zh && index.zhText[other].includes(zh)
}

export function relatedRows(index: ItemIndex, row: number): RelatedRows {
  const market = index.scopeOf.market
  const typeId = index.table.id[row]
  const family = (index.families.get(familyRoot(index.table, row)) ?? []).filter((r) => r !== row && market[r] >= 0)
  const blueprint = blueprintOf(index, typeId)
  const product = productOf(index, typeId)
  const listed = new Set<number>([row, ...family, ...(blueprint === undefined ? [] : [blueprint]), ...(product === undefined ? [] : [product])])
  const containing: number[] = []
  let skins = 0
  for (const other of index.scopeRows.market) {
    if (listed.has(other) || !containsName(index, row, other)) continue
    if (index.table.category[other] === CATEGORY_SKIN) skins++
    else containing.push(other)
  }
  return {
    variants: rankRows(family, index.rank, RANK),
    blueprint,
    product,
    containing: rankRows(containing, index.rank, RANK),
    skins,
  }
}
