// 一个数据版本：manifest + 三个文件 → 校验 → 不可变的 DataSet。

import { DATA_FILES, DATA_MIN_ROW_RATIO } from '../../constants'
import type { DataManifest, DataOrigin, DataSet } from '../types'
import { blueprintRows, buildIndustry } from './industry'
import { DataError, dataKey, parseJsonObject, sha256 } from './shapes'
import type { DataFileName, JsonObject } from './shapes'
import { buildTypes } from './types-table'
import { buildUniverse } from './universe'

export type DataFiles = Record<DataFileName, Buffer | string>

/** manifest 的 rows 对应每个文件里的哪张表 */
const ROWS_OF: Record<DataFileName, (raw: JsonObject) => number> = {
  'types.json': (raw) => (Array.isArray(raw.types) ? raw.types.length : -1),
  'industry.json': blueprintRows,
  'universe.json': (raw) => (Array.isArray(raw.systems) ? raw.systems.length : -1),
}

/** 逐个核对 sha256 */
export function verifyFiles(manifest: DataManifest, files: DataFiles): void {
  for (const name of DATA_FILES) {
    const body = files[name]
    if (body === undefined) throw new DataError('hash', `缺少 ${name}`)
    if (sha256(body) !== manifest.files[name].sha256) throw new DataError('hash', `${name} 的 sha256 和 manifest 不一致`)
  }
}

function parseFiles(manifest: DataManifest, files: DataFiles): Record<DataFileName, JsonObject> {
  const out = {} as Record<DataFileName, JsonObject>
  for (const name of DATA_FILES) {
    const raw = parseJsonObject(name, files[name])
    const rows = ROWS_OF[name](raw)
    if (rows !== manifest.files[name].rows) {
      throw new DataError('rows', `${name} 有 ${rows} 行，manifest 写的是 ${manifest.files[name].rows}`)
    }
    out[name] = raw
  }
  return out
}

/**
 * 校验并建好一个版本：sha256、JSON、行数、需要的列、类型、引用。任何一项不过都抛 DataError，
 * 调用方继续用手上的版本。建好以后不再持有解析出的原始 JSON。
 */
export function loadDataSet(manifest: DataManifest, files: DataFiles, origin: DataOrigin, loadedAt: number): DataSet {
  verifyFiles(manifest, files)
  const raw = parseFiles(manifest, files)
  const types = buildTypes(raw['types.json'])
  const hasType = (id: number) => types.types.rowOf(id) >= 0
  const data: DataSet = {
    key: dataKey(manifest),
    manifest: Object.freeze({ ...manifest, files: { ...manifest.files } }),
    origin,
    loadedAt,
    ...types,
    industry: buildIndustry(raw['industry.json'], hasType),
    universe: buildUniverse(raw['universe.json']),
  }
  return Object.freeze(data)
}

/** 每张表的行数（新数据不能比当前的少太多） */
export function tableCounts(data: DataSet): Record<string, number> {
  let jumps = 0
  for (const list of data.universe.jumps.values()) jumps += list.length
  return {
    types: data.types.size,
    groups: data.groups.size,
    categories: data.categories.size,
    marketGroups: data.marketGroups.size,
    metaGroups: data.metaGroups.size,
    blueprints: data.industry.blueprints.length,
    structures: data.industry.structures.size,
    rigs: data.industry.rigs.size,
    filters: data.industry.filters.size,
    regions: data.universe.regions.size,
    constellations: data.universe.constellations.size,
    systems: data.universe.systems.size,
    stations: data.universe.stations.size,
    factions: data.universe.factions.size,
    jumps: jumps / 2,
  }
}

/** 任何一张表的行数少于当前的 ratio 倍就不用（防止上游数据坏了） */
export function checkShrink(current: DataSet, next: DataSet, ratio = DATA_MIN_ROW_RATIO): void {
  const before = tableCounts(current)
  const after = tableCounts(next)
  const shrunk = Object.keys(before)
    .filter((table) => after[table] < before[table] * ratio)
    .map((table) => `${table} ${before[table]} → ${after[table]}`)
  if (shrunk.length) throw new DataError('shrink', `新数据的行数比当前少太多：${shrunk.join('，')}`)
}
