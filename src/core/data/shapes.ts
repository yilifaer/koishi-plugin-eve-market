// 数据文件的通用读法：按列名取值、声明每张表需要的列和类型、manifest 的格式。
// 规则（§5.2）：加列、加表不算不兼容，所以只检查插件需要的列；缺了需要的列，整份数据都不用。
// 不认识的枚举值（以后新增的活动代码等）由各表自己跳过，类型不对的值一律拒绝。

import { createHash } from 'node:crypto'
import { DATA_FILES, DATA_SCHEMA } from '../../constants'
import type { DataManifest } from '../types'

export type DataFileName = typeof DATA_FILES[number]

/**
 * schema：格式版本和插件不一致；columns：缺插件需要的列；format：结构或类型不对；hash：sha256 对不上；
 * rows：行数和 manifest 不符；reference：引用的 id 不存在；shrink：比当前的少太多；download：所有网址都没下载到对的文件
 */
export type DataErrorKind = 'schema' | 'columns' | 'format' | 'hash' | 'rows' | 'reference' | 'shrink' | 'download'

export class DataError extends Error {
  readonly kind: DataErrorKind

  constructor(kind: DataErrorKind, message: string) {
    super(message)
    this.name = 'DataError'
    this.kind = kind
  }
}

export type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function sha256(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex')
}

export function parseJsonObject(where: string, body: Buffer | string): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  } catch (e) {
    throw new DataError('format', `${where} 不是有效的 JSON：${(e as Error).message}`)
  }
  if (!isObject(value)) throw new DataError('format', `${where} 不是 JSON 对象`)
  return value
}

// ------------------------------------------------------------------ 单元格类型

/** 末尾带 ? 的可以是 null */
export type Cell = 'int' | 'int?' | 'num' | 'num?' | 'str' | 'str?' | 'bool' | 'list' | 'obj'

function matches(value: unknown, cell: Cell): boolean {
  if (value === null) return cell.endsWith('?')
  switch (cell) {
    case 'int':
    case 'int?':
      return Number.isInteger(value)
    case 'num':
    case 'num?':
      return typeof value === 'number' && Number.isFinite(value)
    case 'str':
    case 'str?':
      return typeof value === 'string'
    case 'bool':
      return typeof value === 'boolean'
    case 'list':
      return Array.isArray(value)
    case 'obj':
      return isObject(value)
  }
}

const CELL_LABEL: Record<Cell, string> = {
  'int': '整数', 'int?': '整数或 null', 'num': '数字', 'num?': '数字或 null', 'str': '字符串', 'str?': '字符串或 null',
  'bool': 'true/false', 'list': '数组', 'obj': '对象',
}

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

// ------------------------------------------------------------------ 列表（列名数组 + 紧凑行）

export interface TableSpec<K extends string> {
  /** 列名数组的键，例如 columns、groupColumns */
  columns: string
  /** 行数组的键，例如 types、groups */
  rows: string
  /** 插件需要的列和类型 */
  need: Record<K, Cell>
}

export interface Table<K extends string> {
  readonly where: string
  readonly rows: readonly unknown[][]
  /** 列名 → 行里的下标 */
  readonly col: Readonly<Record<K, number>>
}

/** 打开一张按列名存放的表：检查需要的列都在、每行的长度和类型都对。之后按 col 取值不用再检查类型 */
export function openTable<K extends string>(file: string, raw: JsonObject, spec: TableSpec<K>): Table<K> {
  const where = `${file} 的 ${spec.rows}`
  const columns = raw[spec.columns]
  if (!Array.isArray(columns) || !columns.every((c) => typeof c === 'string')) {
    throw new DataError('columns', `${file} 没有列名数组 ${spec.columns}`)
  }
  const col = {} as Record<K, number>
  const missing: string[] = []
  for (const name of Object.keys(spec.need) as K[]) {
    const index = columns.indexOf(name)
    if (index < 0) missing.push(name)
    col[name] = index
  }
  if (missing.length) throw new DataError('columns', `${where} 缺少列：${missing.join('、')}`)

  const rows = raw[spec.rows]
  if (!Array.isArray(rows)) throw new DataError('format', `${file} 没有 ${spec.rows} 表`)
  const checks = (Object.keys(spec.need) as K[]).map((name) => [name, col[name], spec.need[name]] as const)
  for (let r = 0; r < rows.length; r++) {
    const row: unknown = rows[r]
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw new DataError('format', `${where} 第 ${r + 1} 行的列数和列名不一致`)
    }
    for (const [name, index, cell] of checks) {
      if (!matches(row[index], cell)) {
        throw new DataError('format', `${where} 第 ${r + 1} 行的 ${name} 应该是${CELL_LABEL[cell]}：${show(row[index])}`)
      }
    }
  }
  return { where, rows: rows as unknown[][], col }
}

/** 一张表 → Map（按 id 列）；id 重复时报错 */
export function mapById<K extends string, V>(table: Table<K | 'id'>, make: (row: unknown[]) => V): Map<number, V> {
  const map = new Map<number, V>()
  table.rows.forEach((row, r) => {
    const id = row[table.col.id] as number
    if (map.has(id)) throw new DataError('format', `${table.where} 第 ${r + 1} 行的 id ${id} 重复`)
    map.set(id, make(row))
  })
  return map
}

/** 打开一张对象数组的表（industry.json 的 structures、rigs、filters），检查需要的字段 */
export function openObjects<K extends string>(file: string, raw: JsonObject, key: string, need: Record<K, Cell>): Array<Record<K, unknown>> {
  const where = `${file} 的 ${key}`
  const list = raw[key]
  if (!Array.isArray(list)) throw new DataError('format', `${file} 没有 ${key} 表`)
  const fields = Object.keys(need) as K[]
  list.forEach((item: unknown, r) => {
    if (!isObject(item)) throw new DataError('format', `${where} 第 ${r + 1} 行不是对象`)
    const missing = fields.filter((f) => !(f in item))
    if (missing.length) throw new DataError('columns', `${where} 缺少字段：${missing.join('、')}`)
    for (const f of fields) {
      if (!matches(item[f], need[f])) {
        throw new DataError('format', `${where} 第 ${r + 1} 行的 ${f} 应该是${CELL_LABEL[need[f]]}：${show(item[f])}`)
      }
    }
  })
  return list as Array<Record<K, unknown>>
}

/** 一个嵌套值的格式问题（蓝图的材料、改装件的 effects 等） */
export function badValue(where: string, what: string, value: unknown): DataError {
  return new DataError('format', `${where}：${what} 不对：${show(value)}`)
}

/** 每个数据文件开头的 schema 必须和插件支持的一致 */
export function checkFileSchema(file: string, raw: JsonObject): void {
  if (raw.schema !== DATA_SCHEMA) throw schemaError(`${file} 的 schema`, raw.schema)
}

export function schemaError(what: string, found: unknown): DataError {
  const newer = typeof found === 'number' && found > DATA_SCHEMA
  return new DataError('schema', newer
    ? `${what} 是 ${show(found)}，比插件支持的 ${DATA_SCHEMA} 新，请升级插件`
    : `${what} 是 ${show(found)}，和插件支持的 ${DATA_SCHEMA} 不一致，请升级插件`)
}

// ------------------------------------------------------------------ manifest

const SHA_RE = /^[0-9a-f]{64}$/

/** 读 manifest；schema 和插件不一致时抛 kind = 'schema' 的 DataError */
export function parseManifest(body: Buffer | string, where = 'manifest.json'): DataManifest {
  const raw = parseJsonObject(where, body)
  if (raw.schema !== DATA_SCHEMA) throw schemaError(`${where} 的 schema`, raw.schema)
  const ints = ['dataRevision', 'buildNumber'] as const
  for (const key of ints) {
    if (!Number.isInteger(raw[key]) || (raw[key] as number) < 0) throw badValue(where, key, raw[key])
  }
  for (const key of ['sdeReleaseDate', 'generatedAt'] as const) {
    if (typeof raw[key] !== 'string') throw badValue(where, key, raw[key])
  }
  if (!isObject(raw.files)) throw badValue(where, 'files', raw.files)
  const files: DataManifest['files'] = {}
  for (const name of DATA_FILES) {
    const entry = raw.files[name]
    if (!isObject(entry) || typeof entry.sha256 !== 'string' || !SHA_RE.test(entry.sha256)
      || !Number.isInteger(entry.bytes) || (entry.bytes as number) < 0
      || !Number.isInteger(entry.rows) || (entry.rows as number) < 0) {
      throw badValue(where, `files.${name}`, entry)
    }
    files[name] = { sha256: entry.sha256, bytes: entry.bytes as number, rows: entry.rows as number }
  }
  const manifest: DataManifest = {
    schema: DATA_SCHEMA,
    dataRevision: raw.dataRevision as number,
    buildNumber: raw.buildNumber as number,
    sdeReleaseDate: raw.sdeReleaseDate as string,
    generatedAt: raw.generatedAt as string,
    files,
  }
  if (typeof raw.sourceCommit === 'string') manifest.sourceCommit = raw.sourceCommit
  return manifest
}

/** 按 (buildNumber, dataRevision) 比较：a 新返回正数 */
export function compareVersion(a: Pick<DataManifest, 'buildNumber' | 'dataRevision'>, b: Pick<DataManifest, 'buildNumber' | 'dataRevision'>): number {
  return a.buildNumber - b.buildNumber || a.dataRevision - b.dataRevision
}

/** 数据版本标识：三个文件的 sha256 各取前 12 位 */
export function dataKey(manifest: DataManifest): string {
  return DATA_FILES.map((name) => manifest.files[name].sha256.slice(0, 12)).join('.')
}

export function describeVersion(manifest: DataManifest): string {
  return `build ${manifest.buildNumber}（dataRevision ${manifest.dataRevision}）`
}
