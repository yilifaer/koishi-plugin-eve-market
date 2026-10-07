// glossary.yaml（eve-cn-slang 黑话表）→ GlossaryEntry 列表。
// 别名怎么接入由 core/items 决定（§6.1.4）；这里只负责读、去掉写坏的词条、判断一份新表能不能用。

import yaml from 'js-yaml'
import { GLOSSARY_MIN_RATIO } from '../../constants'
import type { DataOrigin, GlossaryData, GlossaryEntry } from '../types'
import { DataError, isObject, sha256 } from './shapes'

export interface ParsedGlossary {
  data: GlossaryData
  /** 写坏、被跳过的词条数 */
  skipped: number
}

/** 字符串照用；数字、true/false 这类 YAML 会自动转换的值转回文字；其他（列表、对象、null）当作没写 */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(text).filter((s): s is string => !!s)
}

/** en、zh 都是非空文字才算一条可用的词条 */
export function toEntry(item: unknown): GlossaryEntry | null {
  if (!isObject(item)) return null
  const en = text(item.en)
  const zh = text(item.zh)
  if (!en || !zh) return null
  return Object.freeze({
    en,
    zh,
    mode: text(item.mode) ?? '',
    dir: text(item.dir) || 'both',
    enAliases: textList(item.en_aliases),
    zhAliases: textList(item.zh_aliases),
    category: text(item.category) ?? '',
    note: text(item.note) ?? '',
  })
}

export function glossaryKey(body: Buffer | string): string {
  return sha256(body).slice(0, 16)
}

/** 整个文件不是 YAML 列表时抛 DataError；单条写坏的跳过 */
export function parseGlossary(body: Buffer | string, origin: DataOrigin, loadedAt: number): ParsedGlossary {
  const source = typeof body === 'string' ? body : body.toString('utf8')
  let list: unknown
  try {
    list = yaml.load(source, { schema: yaml.CORE_SCHEMA })
  } catch (e) {
    throw new DataError('format', `glossary.yaml 不是有效的 YAML：${(e as Error).message.split('\n')[0]}`)
  }
  if (!Array.isArray(list)) throw new DataError('format', 'glossary.yaml 不是词条列表')
  const entries = list.map(toEntry).filter((e): e is GlossaryEntry => !!e)
  const data: GlossaryData = Object.freeze({ key: glossaryKey(body), origin, loadedAt, entries: Object.freeze(entries) })
  return { data, skipped: list.length - entries.length }
}

/** 一份新的黑话表至少要有 baseline（插件自带快照的可用词条数）的一半，防止上游文件坏了把别名清空 */
export function checkGlossarySize(entries: number, baseline: number, ratio = GLOSSARY_MIN_RATIO): void {
  const min = Math.max(1, Math.ceil(baseline * ratio))
  if (entries < min) throw new DataError('shrink', `黑话表只有 ${entries} 条可用词条，至少要 ${min} 条`)
}
