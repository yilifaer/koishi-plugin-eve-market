// 建筑能力（纯函数）：哪些服务能造这个产品，建筑实际装了哪些服务，能不能造。
// 规则全部来自 industry.json 的 services 表，这里只写判断，不写数据。

import type { IndustryActivity, IndustryData, SecClass, ServiceInfo, StructurePurpose, StructureTypeInfo } from '../types'
import type { IndustryLocation, IndustryStructure } from './locations'
import { SEC_KEY } from './modifiers'

/** 产品只看分组和大类（ItemInfo 可以直接传） */
export interface ProductClass { groupId: number; categoryId: number }

/** 建筑的情况；type 为 null = 「建筑:无」，npc = NPC 空间站，都只有制造厂 */
export interface StructureSpec {
  type: StructureTypeInfo | null
  npc: boolean
  purposes: readonly StructurePurpose[]
  /** 超级旗舰级船坞开关 */
  supercap: boolean
}

export type CapabilityVerdict =
  | { ok: true; known: boolean }
  | { ok: false; need: ServiceInfo[]; why: 'service' | 'sec' }

/** 活动 → services 表里的活动代码 */
const SERVICE_ACTIVITY: Readonly<Record<IndustryActivity, ServiceInfo['activity']>> = Object.freeze({ manufacturing: 'm', reaction: 'r' })

/** 能造这个产品的服务（活动对得上，分组或大类被覆盖） */
export function servicesFor(product: ProductClass, activity: IndustryActivity, services: readonly ServiceInfo[]): ServiceInfo[] {
  const code = SERVICE_ACTIVITY[activity]
  return services.filter((s) => s.activity === code && (s.groups.includes(product.groupId) || s.categories.includes(product.categoryId)))
}

/** 服务算不算装上了：用途对得上；超级旗舰级船坞要开关；不认识的服务不算 */
function installed(service: ServiceInfo, purposes: readonly StructurePurpose[], supercap: boolean): boolean {
  switch (service.key) {
    case 'manufacturing':
    case 'capital': return purposes.includes('manufacturing')
    case 'supercapital': return supercap
    case 'reaction': return purposes.includes('reaction')
    case 'reprocessing': return purposes.includes('reprocessing')
    default: return false
  }
}

/** 这种建筑能不能装这个服务（不看安全等级） */
export function canFit(type: StructureTypeInfo, service: ServiceInfo): boolean {
  return service.fitTypes.includes(type.id) || service.fitGroups.includes(type.group)
}

/** 建筑装的服务；sec 为 null 时不看安全等级（只用来找原因） */
function installedServices(spec: StructureSpec, sec: SecClass | null, services: readonly ServiceInfo[]): ServiceInfo[] {
  const secOk = (s: ServiceInfo) => sec === null || s.sec[SEC_KEY[sec]]
  if (spec.npc || !spec.type) return services.filter((s) => s.key === 'manufacturing' && secOk(s))
  const type = spec.type
  return services.filter((s) => canFit(type, s) && secOk(s) && installed(s, spec.purposes, spec.supercap))
}

/** 这座建筑在这个安全等级实际有的服务 */
export function structureServices(
  type: StructureTypeInfo | null, npc: boolean, sec: SecClass, supercap: boolean,
  purposes: readonly StructurePurpose[], services: readonly ServiceInfo[],
): ServiceInfo[] {
  return installedServices({ type, npc, purposes, supercap }, sec, services)
}

/** 能不能造：没有 services 表、或没有任何服务覆盖这个产品时放行（known=false） */
export function capabilityVerdict(
  product: ProductClass, activity: IndustryActivity, spec: StructureSpec, sec: SecClass, services: readonly ServiceInfo[] | null,
): CapabilityVerdict {
  const relevant = services ? servicesFor(product, activity, services) : []
  if (!services || !relevant.length) return { ok: true, known: false }
  const have = installedServices(spec, sec, services)
  if (relevant.some((s) => have.includes(s))) return { ok: true, known: true }
  const ignoringSec = installedServices(spec, null, services)
  return { ok: false, need: relevant, why: relevant.some((s) => ignoringSec.includes(s)) ? 'sec' : 'service' }
}

/** 「建筑:无」和没有建筑的地点：按 NPC 空间站的制造厂算 */
const NO_STRUCTURE: StructureSpec = { type: null, npc: false, purposes: ['manufacturing'], supercap: false }

/** 这座建筑（null = 没有建筑）在这个地点能不能造这个产品 */
export function canBuild(
  structure: IndustryStructure | null, location: IndustryLocation, product: ProductClass, activity: IndustryActivity, data: IndustryData,
): CapabilityVerdict {
  const spec = structure
    ? { type: structure.type, npc: structure.npc, purposes: structure.purposes, supercap: structure.supercapitalShipyard }
    : NO_STRUCTURE
  return capabilityVerdict(product, activity, spec, location.system.secClass, data.services)
}

/** 地点能不能造：任一座建筑能造就行；一座建筑都没配的地点按制造厂的能力算 */
export function locationCanBuild(
  location: IndustryLocation, product: ProductClass, activity: IndustryActivity, data: IndustryData,
): CapabilityVerdict {
  const list = location.structures.filter((s) => s.activities.includes(activity))
  if (!list.length) return canBuild(null, location, product, activity, data)
  const verdicts = list.map((s) => canBuild(s, location, product, activity, data))
  const known = verdicts.find((v) => v.ok && v.known) ?? verdicts.find((v) => v.ok)
  if (known) return known
  // 都造不了：原因优先写「安全等级」（建筑本身能装，只是这里用不了）
  return verdicts.find((v) => !v.ok && v.why === 'sec') ?? verdicts[0]
}

/** 「旗舰级船坞 / 超级旗舰级船坞」：中文去掉「屹立」前缀和「 I」后缀；没有中文名用英文（去掉 Standup 和 I） */
export function needLabel(need: readonly ServiceInfo[]): string {
  // 覆盖的分组少的在前（基础的服务先写，例如旗舰级船坞在超级旗舰级船坞前面）
  const size = (x: ServiceInfo) => x.groups.length + x.categories.length
  const names = [...need].sort((a, b) => size(a) - size(b)).map((s) => (s.zh
    ? s.zh.replace(/^屹立/, '').replace(/ I$/, '')
    : s.en.replace(/^Standup /, '').replace(/ I$/, '')))
  return [...new Set(names)].join(' / ')
}
