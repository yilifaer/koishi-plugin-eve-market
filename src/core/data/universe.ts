// universe.json → 星域、星座、星系、NPC 空间站、势力、星门连接（§5.5）。

import type { ConstellationInfo, FactionInfo, RegionInfo, StationInfo, SystemInfo, UniverseData } from '../types'
import { checkFileSchema, DataError, mapById, openTable } from './shapes'
import type { JsonObject, TableSpec } from './shapes'

const FILE = 'universe.json'

export const REGIONS_SPEC: TableSpec<'id' | 'en' | 'zh'> = {
  columns: 'regionColumns', rows: 'regions', need: { id: 'int', en: 'str', zh: 'str' },
}
export const CONSTELLATIONS_SPEC: TableSpec<'id' | 'region' | 'en' | 'zh'> = {
  columns: 'constellationColumns', rows: 'constellations', need: { id: 'int', region: 'int', en: 'str', zh: 'str' },
}
export const SYSTEMS_SPEC: TableSpec<'id' | 'constellation' | 'region' | 'security' | 'en' | 'zh'> = {
  columns: 'systemColumns',
  rows: 'systems',
  need: { id: 'int', constellation: 'int', region: 'int', security: 'num', en: 'str', zh: 'str' },
}
export const STATIONS_SPEC: TableSpec<'id' | 'system'> = {
  columns: 'stationColumns', rows: 'stations', need: { id: 'int', system: 'int' },
}
export const FACTIONS_SPEC: TableSpec<'id' | 'en' | 'zh'> = {
  columns: 'factionColumns', rows: 'factions', need: { id: 'int', en: 'str', zh: 'str' },
}
export const JUMPS_SPEC: TableSpec<'a' | 'b'> = {
  columns: 'jumpColumns', rows: 'jumps', need: { a: 'int', b: 'int' },
}

function missing(where: string, what: string, id: number, ref: number): DataError {
  return new DataError('reference', `${where} 的 ${id} 引用的${what} ${ref} 不存在`)
}

function readRegions(raw: JsonObject): Map<number, RegionInfo> {
  const t = openTable(FILE, raw, REGIONS_SPEC)
  const c = t.col
  return mapById(t, (row): RegionInfo => ({ id: row[c.id] as number, en: row[c.en] as string, zh: row[c.zh] as string }))
}

function readConstellations(raw: JsonObject, regions: Map<number, RegionInfo>): Map<number, ConstellationInfo> {
  const t = openTable(FILE, raw, CONSTELLATIONS_SPEC)
  const c = t.col
  const map = mapById(t, (row): ConstellationInfo => ({
    id: row[c.id] as number, regionId: row[c.region] as number, en: row[c.en] as string, zh: row[c.zh] as string,
  }))
  for (const k of map.values()) {
    if (!regions.has(k.regionId)) throw missing(t.where, '星域', k.id, k.regionId)
  }
  return map
}

function readSystems(raw: JsonObject, regions: Map<number, RegionInfo>, constellations: Map<number, ConstellationInfo>): Map<number, SystemInfo> {
  const t = openTable(FILE, raw, SYSTEMS_SPEC)
  const c = t.col
  const map = mapById(t, (row): SystemInfo => ({
    id: row[c.id] as number,
    constellationId: row[c.constellation] as number,
    regionId: row[c.region] as number,
    security: row[c.security] as number,
    en: row[c.en] as string,
    zh: row[c.zh] as string,
  }))
  for (const s of map.values()) {
    if (!regions.has(s.regionId)) throw missing(t.where, '星域', s.id, s.regionId)
    if (!constellations.has(s.constellationId)) throw missing(t.where, '星座', s.id, s.constellationId)
  }
  return map
}

function readStations(raw: JsonObject, systems: Map<number, SystemInfo>): Map<number, StationInfo> {
  const t = openTable(FILE, raw, STATIONS_SPEC)
  const c = t.col
  const map = mapById(t, (row): StationInfo => ({ id: row[c.id] as number, systemId: row[c.system] as number }))
  for (const s of map.values()) {
    if (!systems.has(s.systemId)) throw missing(t.where, '星系', s.id, s.systemId)
  }
  return map
}

function readFactions(raw: JsonObject): Map<number, FactionInfo> {
  const t = openTable(FILE, raw, FACTIONS_SPEC)
  const c = t.col
  return mapById(t, (row): FactionInfo => ({ id: row[c.id] as number, en: row[c.en] as string, zh: row[c.zh] as string }))
}

/** 无向图：两个方向都记 */
function readJumps(raw: JsonObject, systems: Map<number, SystemInfo>): Map<number, number[]> {
  const t = openTable(FILE, raw, JUMPS_SPEC)
  const c = t.col
  const graph = new Map<number, number[]>()
  const link = (from: number, to: number) => {
    const list = graph.get(from)
    if (!list) graph.set(from, [to])
    else if (!list.includes(to)) list.push(to)
  }
  for (const row of t.rows) {
    const a = row[c.a] as number
    const b = row[c.b] as number
    if (!systems.has(a)) throw missing(t.where, '星系', b, a)
    if (!systems.has(b)) throw missing(t.where, '星系', a, b)
    link(a, b)
    link(b, a)
  }
  return graph
}

export function buildUniverse(raw: JsonObject): UniverseData {
  checkFileSchema(FILE, raw)
  const regions = readRegions(raw)
  const constellations = readConstellations(raw, regions)
  const systems = readSystems(raw, regions, constellations)
  return {
    regions,
    constellations,
    systems,
    stations: readStations(raw, systems),
    factions: readFactions(raw),
    jumps: readJumps(raw, systems),
  }
}
