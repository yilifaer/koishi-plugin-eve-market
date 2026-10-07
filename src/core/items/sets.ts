// 植入体套装（§6.1.5）：从数据推出，不写死列表。
// 按英文名分组（分组 300，「High-grade Crystal Alpha」这种），中文套装名由每件的中文名去掉型号后缀得到；
// 中文名的分隔符五花八门（—、 - 、-、–，或者没有），所以不按分隔符切。同一组 6 件去完必须一样，否则不当套装。

import type { ImplantSet, TypeTable } from '../types'

export const IMPLANT_GROUP = 300

const SLOTS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Omega'] as const
const EN_PATTERN = /^(High|Mid|Low)-grade (.+) (Alpha|Beta|Gamma|Delta|Epsilon|Omega)$/
const ZH_SUFFIX = /[\s\-\u2010-\u2015\u2212]*(阿尔法|贝它|伽玛|德尔塔|伊普西隆|欧米伽)型$/
const GRADES = { High: 'high', Mid: 'mid', Low: 'low' } as const
const ZH_GRADE: Record<ImplantSet['grade'], string> = { high: '高级', mid: '中级', low: '低级' }

export interface ImplantSetEntry {
  set: ImplantSet
  /** 去掉等级的套装名（「Crystal」「水晶」）；中文名不以等级开头时 zh 是 '' */
  family: { en: string; zh: string }
}

export interface ImplantSets {
  sets: ImplantSetEntry[]
  /** 没当成套装的组合和原因（「市场状态」里报告） */
  skipped: string[]
}

interface Draft {
  grade: ImplantSet['grade']
  gradeEn: string
  family: string
  rows: Map<string, number[]>
}

function collect(table: TypeTable): Map<string, Draft> {
  const drafts = new Map<string, Draft>()
  for (let row = 0; row < table.size; row++) {
    if (table.group[row] !== IMPLANT_GROUP) continue
    const m = EN_PATTERN.exec(table.en[row])
    if (!m) continue
    const [, gradeEn, family, slot] = m
    const id = `${gradeEn}-grade ${family}`
    let draft = drafts.get(id)
    if (!draft) {
      draft = { grade: GRADES[gradeEn as keyof typeof GRADES], gradeEn, family, rows: new Map() }
      drafts.set(id, draft)
    }
    const list = draft.rows.get(slot) ?? []
    list.push(row)
    draft.rows.set(slot, list)
  }
  return drafts
}

function finish(name: string, draft: Draft, table: TypeTable): ImplantSetEntry | string {
  const rows: number[] = []
  for (const slot of SLOTS) {
    const list = draft.rows.get(slot)
    if (!list || list.length !== 1) return `${name}：${slot} ${list ? '有重复' : '缺少'}`
    rows.push(list[0])
  }
  const zhNames = new Set(rows.map((row) => table.zh[row].replace(ZH_SUFFIX, '').trim()))
  const [zh] = zhNames
  if (zhNames.size !== 1 || !zh) return `${name}：中文名去掉型号后不一致（${[...zhNames].join('、') || '没有中文名'}）`
  const prefix = ZH_GRADE[draft.grade]
  return {
    set: { name: { en: name, zh }, grade: draft.grade, items: rows.map((row) => table.item(row)) },
    family: { en: draft.family, zh: zh.startsWith(prefix) && zh.length > prefix.length ? zh.slice(prefix.length) : '' },
  }
}

export function findImplantSets(table: TypeTable): ImplantSets {
  const sets: ImplantSetEntry[] = []
  const skipped: string[] = []
  for (const [name, draft] of collect(table)) {
    const result = finish(name, draft, table)
    if (typeof result === 'string') skipped.push(result)
    else sets.push(result)
  }
  sets.sort((a, b) => a.set.items[0].typeId - b.set.items[0].typeId)
  return { sets, skipped }
}

/** 每个套装注册的写法：「高级水晶」「高级水晶套装」「high-grade crystal set」 */
export function setAliases(entry: ImplantSetEntry): string[] {
  const { en, zh } = entry.set.name
  return [zh, `${zh}套装`, `${en} set`]
}

/** 不带等级的写法：「水晶」「水晶套装」「crystal set」，把各等级列成候选 */
export function familyAliases(entry: ImplantSetEntry): string[] {
  const out = [`${entry.family.en} set`]
  if (entry.family.zh) out.push(entry.family.zh, `${entry.family.zh}套装`)
  return out
}
