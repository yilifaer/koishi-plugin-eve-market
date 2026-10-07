// 一次查询的各种形式：规范化文本、key、区分大小写的 key、tokens，以及排序用的上下文。

import type { Lang } from '../types'
import { hanMask, latinMask } from './masks'
import { caseKey, hanChars, hasHan, keyOf, normalizeName, tokensOf } from './normalize'
import type { RankContext } from './rank'
import { expandBlueprintWords } from './variants'

const BLUEPRINT_TOKENS = new Set(['blueprint', 'blueprints', 'bp', 'bpo', 'bpc'])
const SKIN_TOKENS = new Set(['skin', 'skins'])
const ID_QUERY = /^(?:#|id:)\s*(\d+)$/
const PINYIN_QUERY = /^[a-z]{2,}$/

export interface Query {
  /** 规范化文本 */
  norm: string
  key: string
  caseKey: string
  tokens: string[]
  han: boolean
  /** 不重复的汉字（中文容错档） */
  chars: string[]
  /** tokens 用到的拉丁字母和数字、汉字（包含档先按它筛） */
  latinMask: number
  hanMask: number
  lang: Lang
  rank: RankContext
  /** `#638`、`id:638` */
  id: number | null
  /** 拉丁查询里的 bp 换成 blueprint 以后的 key（生成的写法） */
  blueprintKey: string | null
  /** 纯拉丁字母、2 个以上：可以试拼音 */
  pinyin: boolean
}

export function parseQuery(text: string): Query {
  const norm = normalizeName(text)
  const tokens = tokensOf(norm)
  const han = hasHan(norm)
  const key = keyOf(norm)
  const lang: Lang = han ? 'zh' : 'en'
  const expanded = han ? null : expandBlueprintWords(norm)
  const id = ID_QUERY.exec(norm)
  const chars = hanChars(norm)
  return {
    norm,
    key,
    caseKey: caseKey(text),
    tokens,
    han,
    chars,
    latinMask: latinMask(tokens.filter((t) => !hasHan(t)).join('')),
    hanMask: hanMask(chars.join('')),
    lang,
    rank: {
      lang,
      blueprint: norm.includes('蓝图') || tokens.some((t) => BLUEPRINT_TOKENS.has(t)),
      skin: norm.includes('涂装') || tokens.some((t) => SKIN_TOKENS.has(t)),
    },
    id: id ? Number(id[1]) : null,
    blueprintKey: expanded ? keyOf(expanded) : null,
    pinyin: PINYIN_QUERY.test(key),
  }
}
