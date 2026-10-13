// industry.json → 蓝图、建筑加成、改装件、目标过滤器（§5.4，改装件按「实现后的更新」第 2 条：每条 effect 自带百分比）。

import type {
  ActivityCode, BlueprintActivity, BonusSet, IndustryData, ReprocessInfo, RigInfo, ServiceInfo, StructureTypeInfo, TargetFilter, TypeId,
} from '../types'
import { badValue, checkFileSchema, DataError, isObject, openObjects, openTable, readOptionalObjects } from './shapes'
import type { JsonObject, TableSpec } from './shapes'

const FILE = 'industry.json'

type BlueprintColumn = 'blueprint' | 'activity' | 'time' | 'maxRuns' | 'products' | 'materials'

export const BLUEPRINTS_SPEC: TableSpec<BlueprintColumn> = {
  columns: 'blueprintColumns',
  rows: 'blueprints',
  need: { blueprint: 'int', activity: 'str', time: 'int', maxRuns: 'int', products: 'list', materials: 'list' },
}

const STRUCTURE_FIELDS = { id: 'int', en: 'str', zh: 'str', group: 'int', rigSize: 'int', highsec: 'bool', bonus: 'obj' } as const
const RIG_FIELDS = { id: 'int', en: 'str', zh: 'str', group: 'int', size: 'int', sec: 'obj', effects: 'list' } as const
const FILTER_FIELDS = { id: 'int', name: 'str', categories: 'list', groups: 'list' } as const

const SERVICE_FIELDS = {
  id: 'int', key: 'str?', en: 'str', zh: 'str', activity: 'str', groups: 'list', categories: 'list',
  fitGroups: 'list', fitTypes: 'list', sec: 'obj',
} as const
const REPROCESS_FIELDS = { id: 'int', portion: 'int', skill: 'int?', materials: 'list' } as const

const SERVICE_ACTIVITIES: ReadonlySet<string> = new Set(['m', 'r', 'rp'])
const ACTIVITIES: ReadonlySet<string> = new Set<ActivityCode>(['m', 'r', 'i', 'c', 'rm', 'rt'])
const BLUEPRINT_ACTIVITIES: ReadonlySet<string> = new Set(['m', 'r', 'i'])
const KINDS: ReadonlySet<string> = new Set(['me', 'te', 'cost'])

const isInt = (v: unknown): v is number => Number.isInteger(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// ------------------------------------------------------------------ 蓝图

function readProducts(where: string, value: unknown[], hasType: (id: TypeId) => boolean): BlueprintActivity['products'] {
  return value.map((p) => {
    if (!Array.isArray(p) || !isInt(p[0]) || !isInt(p[1]) || (p.length > 2 && !isNum(p[2]))) throw badValue(where, '产品', p)
    if (!hasType(p[0])) throw new DataError('reference', `${where}：产品 ${p[0]} 不在 types.json 里`)
    return p.length > 2 ? { typeId: p[0], quantity: p[1], probability: p[2] as number } : { typeId: p[0], quantity: p[1] }
  })
}

function readMaterials(where: string, value: unknown[], hasType: (id: TypeId) => boolean): BlueprintActivity['materials'] {
  return value.map((m) => {
    if (!Array.isArray(m) || !isInt(m[0]) || !isInt(m[1])) throw badValue(where, '材料', m)
    if (!hasType(m[0])) throw new DataError('reference', `${where}：材料 ${m[0]} 不在 types.json 里`)
    return { typeId: m[0], quantity: m[1] }
  })
}

/** 产品 → 蓝图：只收已发布的蓝图时是唯一的；以后真有重复，取蓝图 ID 小的 */
function indexByProduct(map: Map<TypeId, BlueprintActivity>, activity: BlueprintActivity) {
  for (const product of activity.products) {
    const existing = map.get(product.typeId)
    if (!existing || activity.blueprintId < existing.blueprintId) map.set(product.typeId, activity)
  }
}

function readBlueprints(raw: JsonObject, hasType: (id: TypeId) => boolean) {
  const t = openTable(FILE, raw, BLUEPRINTS_SPEC)
  const c = t.col
  const blueprints: BlueprintActivity[] = []
  const byBlueprint: IndustryData['byBlueprint'] = new Map()
  const manufacturing = new Map<TypeId, BlueprintActivity>()
  const reactions = new Map<TypeId, BlueprintActivity>()
  t.rows.forEach((row, r) => {
    const activity = row[c.activity] as string
    // 以后加的活动（拷贝、研究）先不用
    if (!BLUEPRINT_ACTIVITIES.has(activity)) return
    const blueprintId = row[c.blueprint] as number
    const where = `${t.where} 第 ${r + 1} 行（蓝图 ${blueprintId}）`
    if (!hasType(blueprintId)) throw new DataError('reference', `${where}：蓝图不在 types.json 里`)
    const entry: BlueprintActivity = {
      blueprintId,
      activity: activity as BlueprintActivity['activity'],
      time: row[c.time] as number,
      maxRuns: row[c.maxRuns] as number,
      products: readProducts(where, row[c.products] as unknown[], hasType),
      materials: readMaterials(where, row[c.materials] as unknown[], hasType),
    }
    const activities = byBlueprint.get(blueprintId) ?? {}
    if (activities[entry.activity]) throw new DataError('format', `${where}：活动 ${activity} 重复`)
    activities[entry.activity] = entry
    byBlueprint.set(blueprintId, activities)
    blueprints.push(entry)
    if (entry.activity === 'm') indexByProduct(manufacturing, entry)
    else if (entry.activity === 'r') indexByProduct(reactions, entry)
  })
  return { blueprints, byBlueprint, manufacturing, reactions }
}

// ------------------------------------------------------------------ 建筑、改装件、过滤器

function readBonusSet(where: string, value: unknown): BonusSet {
  if (!isObject(value)) throw badValue(where, '加成', value)
  const out: BonusSet = {}
  for (const kind of ['me', 'te', 'cost'] as const) {
    if (value[kind] === undefined) continue
    if (!isNum(value[kind])) throw badValue(where, `加成 ${kind}`, value[kind])
    out[kind] = value[kind]
  }
  return out
}

function readStructures(raw: JsonObject): Map<TypeId, StructureTypeInfo> {
  const map = new Map<TypeId, StructureTypeInfo>()
  for (const s of openObjects(FILE, raw, 'structures', STRUCTURE_FIELDS)) {
    const id = s.id as number
    const where = `${FILE} 的建筑 ${id}`
    const bonus: StructureTypeInfo['bonus'] = {}
    for (const [activity, set] of Object.entries(s.bonus as JsonObject)) {
      if (ACTIVITIES.has(activity)) bonus[activity as ActivityCode] = readBonusSet(`${where} 的 ${activity}`, set)
    }
    if (map.has(id)) throw new DataError('format', `${where} 重复`)
    map.set(id, {
      id, en: s.en as string, zh: s.zh as string, group: s.group as number, rigSize: s.rigSize as number,
      highsec: s.highsec as boolean, bonus,
    })
  }
  return map
}

function readFilters(raw: JsonObject): Map<number, TargetFilter> {
  const map = new Map<number, TargetFilter>()
  for (const f of openObjects(FILE, raw, 'filters', FILTER_FIELDS)) {
    const id = f.id as number
    const where = `${FILE} 的过滤器 ${id}`
    const categories = f.categories as unknown[]
    const groups = f.groups as unknown[]
    if (!categories.every(isInt)) throw badValue(where, 'categories', categories)
    if (!groups.every(isInt)) throw badValue(where, 'groups', groups)
    if (map.has(id)) throw new DataError('format', `${where} 重复`)
    map.set(id, { id, name: f.name as string, categories, groups })
  }
  return map
}

function readSec(where: string, value: JsonObject): RigInfo['sec'] {
  const sec = { h: value.h ?? null, l: value.l ?? null, n: value.n ?? null }
  for (const [key, v] of Object.entries(sec)) {
    if (v !== null && !isNum(v)) throw badValue(where, `sec.${key}`, v)
  }
  return sec as RigInfo['sec']
}

function readEffects(where: string, value: unknown[], filters: Map<number, TargetFilter>): RigInfo['effects'] {
  const effects: RigInfo['effects'] = []
  for (const e of value) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'string'
      || (e[2] !== null && !isInt(e[2])) || !isNum(e[3])) {
      throw badValue(where, 'effects', e)
    }
    if (!ACTIVITIES.has(e[0]) || !KINDS.has(e[1])) continue
    if (e[2] !== null && !filters.has(e[2])) throw new DataError('reference', `${where}：过滤器 ${e[2]} 不存在`)
    effects.push({ activity: e[0] as ActivityCode, kind: e[1] as 'me' | 'te' | 'cost', filter: e[2] as number | null, pct: e[3] })
  }
  return effects
}

/** 数据里没有 bonus：每种取第一条 effect 的百分比，作为卡片上「材料 -2%」这类概括 */
function summarize(effects: RigInfo['effects']): BonusSet {
  const bonus: BonusSet = {}
  for (const e of effects) {
    if (bonus[e.kind] === undefined) bonus[e.kind] = e.pct
  }
  return bonus
}

function readRigs(raw: JsonObject, filters: Map<number, TargetFilter>): Map<TypeId, RigInfo> {
  const map = new Map<TypeId, RigInfo>()
  for (const g of openObjects(FILE, raw, 'rigs', RIG_FIELDS)) {
    const id = g.id as number
    const where = `${FILE} 的改装件 ${id}`
    const effects = readEffects(where, g.effects as unknown[], filters)
    if (map.has(id)) throw new DataError('format', `${where} 重复`)
    map.set(id, {
      id, en: g.en as string, zh: g.zh as string, group: g.group as number, size: g.size as number,
      bonus: summarize(effects), sec: readSec(where, g.sec as JsonObject), effects,
    })
  }
  return map
}

// ------------------------------------------------------------------ 建筑服务、提炼（可选表，旧数据没有）

function intList(where: string, what: string, value: unknown[]): number[] {
  if (!value.every(isInt)) throw badValue(where, what, value)
  return value as number[]
}

function readServiceSec(where: string, value: JsonObject): ServiceInfo['sec'] {
  for (const key of ['h', 'l', 'n']) {
    if (typeof value[key] !== 'boolean') throw badValue(where, `sec.${key}`, value[key])
  }
  return { h: value.h as boolean, l: value.l as boolean, n: value.n as boolean }
}

function readServices(raw: JsonObject): ServiceInfo[] | null {
  const rows = readOptionalObjects(FILE, raw, 'services', SERVICE_FIELDS)
  if (!rows) return null
  const seen = new Set<number>()
  const list: ServiceInfo[] = []
  for (const s of rows) {
    const id = s.id as number
    const where = `${FILE} 的服务 ${id}`
    // 以后加的活动先不用
    if (!SERVICE_ACTIVITIES.has(s.activity as string)) continue
    if (seen.has(id)) throw new DataError('format', `${where} 重复`)
    seen.add(id)
    list.push({
      id, key: s.key as string | null, en: s.en as string, zh: s.zh as string,
      activity: s.activity as ServiceInfo['activity'],
      groups: intList(where, 'groups', s.groups as unknown[]),
      categories: intList(where, 'categories', s.categories as unknown[]),
      fitGroups: intList(where, 'fitGroups', s.fitGroups as unknown[]),
      fitTypes: intList(where, 'fitTypes', s.fitTypes as unknown[]),
      sec: readServiceSec(where, s.sec as JsonObject),
    })
  }
  return list
}

/** 产出里恰好有一个反应产物时，它就是主产物，其余是副产品 */
function deriveMain(materials: ReprocessInfo['materials'], reactions: ReadonlyMap<TypeId, unknown>): TypeId | null {
  const products = materials.filter((m) => reactions.has(m.typeId))
  return products.length === 1 ? products[0]!.typeId : null
}

function readReprocessing(
  raw: JsonObject, hasType: (id: TypeId) => boolean, reactions: ReadonlyMap<TypeId, unknown>,
): Map<TypeId, ReprocessInfo> | null {
  const rows = readOptionalObjects(FILE, raw, 'reprocessing', REPROCESS_FIELDS)
  if (!rows) return null
  const map = new Map<TypeId, ReprocessInfo>()
  for (const r of rows) {
    const id = r.id as number
    const where = `${FILE} 的提炼 ${id}`
    if (map.has(id)) throw new DataError('format', `${where} 重复`)
    if (!hasType(id)) throw new DataError('reference', `${where}：物品不在 types.json 里`)
    const materials = readMaterials(where, r.materials as unknown[], hasType)
    map.set(id, { id, portion: r.portion as number, skill: r.skill as number | null, materials, main: deriveMain(materials, reactions) })
  }
  return map
}

export function buildIndustry(raw: JsonObject, hasType: (id: TypeId) => boolean): IndustryData {
  checkFileSchema(FILE, raw)
  const filters = readFilters(raw)
  const blueprints = readBlueprints(raw, hasType)
  return {
    ...blueprints,
    structures: readStructures(raw),
    rigs: readRigs(raw, filters),
    filters,
    services: readServices(raw),
    reprocessing: readReprocessing(raw, hasType, blueprints.reactions),
  }
}

/** manifest 的 rows：蓝图表的行数（含插件不用的活动） */
export function blueprintRows(raw: JsonObject): number {
  return Array.isArray(raw.blueprints) ? raw.blueprints.length : -1
}
