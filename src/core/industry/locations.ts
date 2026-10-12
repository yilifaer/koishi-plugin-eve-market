// 工业地点和建筑（§4.10、§6.7.3）：控制台的两张表 + 数据（universe.json、industry.json）→ 运行时的地点。
// - 地点的星系按名字（中英文）或 ID 查出安全等级和分类；查不到的地点连同它的建筑都不生效，并报告；
// - 建筑类型按名字或 typeID 对上 industry.json；「无」= 没有建筑加成，「NPC」= NPC 空间站（设施税按 NPC 空间站算）；
// - 改装件按名字或 typeID 对上数据：找不到、尺寸和建筑不符的去掉；在这个安全等级不生效的留着（算加成时按 0），都报告；
// - 反应只能在精炼厂、不能在高安：不符合的建筑去掉「反应」用途；不能放在高安的建筑（索迪约等）放在高安时报告；
//   这些判断（尺寸、安全等级、精炼厂）和计算时用的是同一套（modifiers.ts）；
// - 可见范围按 Access：本群看不到的地点和不存在的一样。
// 每个数据版本建一次，数据更新后第一次用到时自动重建。

import { DataNotReadyError } from '../data'
import { displaySec } from '../format'
import { nameKey } from '../items'
import { compactMarketKey, marketKey } from '../market'
import { secClassOf } from '../universe'
import type {
  Access, ConfigIssue, DataService, DataSet, IndustryActivity, IndustryLocationSetting, IndustrySettings,
  IndustryStructureSetting, RigInfo, SecClass, StructureTypeInfo, SystemInfo, Visibility,
} from '../types'
import { ACTIVITY_CODE, SEC_LABEL, rigFits, rigSecMultiplier, structureProblems } from './modifiers'

/** 一座建筑最多装几个改装件（Upwell 建筑都是 3 个改装槽） */
export const MAX_RIGS = 3

const LOC_TABLE = '工业地点'
const ST_TABLE = '工业建筑'

/** 「建筑类型」写这些 = NPC 空间站（按 nameKey 比较） */
const NPC_WORDS = new Set(['npc', 'npc空间站', 'npc站', '空间站', 'station', 'npcstation'].map(nameKey))

const SIZE_LABELS: Record<number, string> = { 2: '中型（M）', 3: '大型（L）', 4: '超大型（XL）' }
const ACTIVITY_LABELS: Record<IndustryActivity, string> = { manufacturing: '制造', reaction: '反应' }

// ------------------------------------------------------------------ 对外的类型

export interface IndustrySystem {
  id: number
  en: string
  /** 代号星系是 '' */
  zh: string
  regionId: number
  /** 真实安全等级（显示时经 displaySec） */
  security: number
  secClass: SecClass
}

export interface IndustryStructure {
  row: number
  /** 所属地点的名称 */
  location: string
  name: string
  /** null = 没有建筑加成（「无」或 NPC 空间站） */
  type: StructureTypeInfo | null
  /** NPC 空间站：设施税按「NPC 空间站设施税」算 */
  npc: boolean
  structureId: string
  /** 已经去掉做不了的反应（高安、不是精炼厂、NPC 空间站） */
  activities: readonly IndustryActivity[]
  /** 装得上的改装件，按填写顺序；在这个安全等级不生效的也在里面（rigSecMultiplier 为 null） */
  rigs: readonly RigInfo[]
  /** 已经换算好：NPC 空间站是「NPC 空间站设施税」，其他是这一行写的 */
  facilityTaxPct: number
  extraFeePct: number
  extraFeeIsk: number
  extraFeeLabel: string
  isDefault: boolean
}

export interface IndustryLocation {
  row: number
  /** 名称的比较键，表内唯一 */
  key: string
  name: string
  /** 手写的别名，再加上星系的中英文名（和别的地点冲突时不加） */
  aliases: readonly string[]
  system: IndustrySystem
  visibility: Visibility
  isDefault: boolean
  defaultME: number
  defaultTE: number
  /** 星系对安装费的额外加成（%，例如 -50） */
  sysCostBonusPct: number
  /** 这个地点的有效建筑，按表格顺序 */
  structures: readonly IndustryStructure[]
}

export interface IndustryLocations {
  /** 全部有效的地点，不分可见范围，按表格顺序 */
  all(): IndustryLocation[]
  /** 本群能看到的地点，按表格顺序；给了 activity 时只留能做这种活动的 */
  visible(access: Access, activity?: IndustryActivity): IndustryLocation[]
  /** 按名称、别名、星系名找本群能看到的地点（不看能不能做哪种活动，高安做反应由调用方回答）；找不到返回 null */
  match(token: string, access: Access): IndustryLocation | null
  /** 名称和别名最多几个词（从命令里切出地点时用） */
  maxWords(): number
  /** 按名称取，不看可见范围 */
  get(name: string): IndustryLocation | undefined
  /** 「快速计算」的默认地点；本群看不到、或者不能做这种活动时 undefined */
  defaultLocation(access: Access, activity?: IndustryActivity): IndustryLocation | undefined
  /** 要有数据才能发现的配置问题：星系、建筑类型、改装件查不到或不合适 */
  issues(): ConfigIssue[]
}

// ------------------------------------------------------------------ 小工具（也给工业的其他模块用）

export function locationVisibleTo(location: IndustryLocation, access: Access): boolean {
  return location.visibility === 'public' || access.allowed
}

/** 这个地点能用来做这种活动的建筑，按表格顺序 */
export function structuresFor(location: IndustryLocation, activity: IndustryActivity): IndustryStructure[] {
  return location.structures.filter((s) => s.activities.includes(activity))
}

/**
 * 地点能不能做这种活动。反应：不在高安，并且有能做反应的建筑；
 * 制造：有能制造的建筑，或者这个地点一座建筑都没配（按没有建筑加成算）
 */
export function locationSupports(location: IndustryLocation, activity: IndustryActivity): boolean {
  if (activity === 'reaction') return location.system.secClass !== 'high' && structuresFor(location, activity).length > 0
  return location.structures.length === 0 || structuresFor(location, activity).length > 0
}

/** 默认建筑：勾了「默认」的那座能做这种活动就用它，否则第一座能做的；一座都没有时 null（没有建筑加成） */
export function defaultStructure(location: IndustryLocation, activity: IndustryActivity): IndustryStructure | null {
  const list = structuresFor(location, activity)
  return list.find((s) => s.isDefault) ?? list[0] ?? null
}

/** 命令里「建筑:名称」：先按建筑简称找，再按建筑类型（中英文名）找，类型对应多座时不算 */
export function findStructure(location: IndustryLocation, text: string, activity: IndustryActivity): IndustryStructure | undefined {
  const list = structuresFor(location, activity)
  const key = marketKey(text)
  const compact = compactMarketKey(text)
  const byName = list.find((s) => marketKey(s.name) === key) ?? list.find((s) => compactMarketKey(s.name) === compact)
  if (byName) return byName
  const typeKey = nameKey(text)
  if (!typeKey) return undefined
  const byType = list.filter((s) => s.type && (nameKey(s.type.en) === typeKey || (s.type.zh && nameKey(s.type.zh) === typeKey)))
  return byType.length === 1 ? byType[0] : undefined
}

// ------------------------------------------------------------------ 数据里的名字（每个数据版本建一次）

interface Lookups {
  /** marketKey → 星系；再一层去空白的 */
  systems: Map<string, SystemInfo>
  systemsCompact: Map<string, SystemInfo>
  /** nameKey（中英文）→ 建筑类型 */
  structures: Map<string, StructureTypeInfo>
  /** nameKey（中英文，也收去掉「Standup」「屹立」前缀的写法）→ 改装件；null = 对应多个 */
  rigs: Map<string, RigInfo | null>
}

const lookupsCache = new WeakMap<DataSet, Lookups>()

function claim<T>(map: Map<string, T | null>, key: string, value: T) {
  if (!key) return
  const existing = map.get(key)
  if (existing === undefined) map.set(key, value)
  else if (existing !== value) map.set(key, null)
}

/** 去掉「Standup」「屹立」前缀的写法；没有前缀时 '' */
function shortRigKey(key: string): string {
  const short = key.replace(/^standup/, '').replace(/^屹立/, '')
  return short === key ? '' : short
}

function lookupsOf(data: DataSet): Lookups {
  let found = lookupsCache.get(data)
  if (found) return found
  const systems = new Map<string, SystemInfo>()
  const systemsCompact = new Map<string, SystemInfo>()
  for (const s of data.universe.systems.values()) {
    for (const name of [s.en, s.zh]) {
      if (!name) continue
      if (!systems.has(marketKey(name))) systems.set(marketKey(name), s)
      if (!systemsCompact.has(compactMarketKey(name))) systemsCompact.set(compactMarketKey(name), s)
    }
  }
  const structures = new Map<string, StructureTypeInfo>()
  for (const t of data.industry.structures.values()) {
    for (const name of [t.en, t.zh]) {
      const key = name ? nameKey(name) : ''
      if (key && !structures.has(key)) structures.set(key, t)
    }
  }
  // 全名优先；去掉前缀的简写只在不和任何全名相同时收
  const rigs = new Map<string, RigInfo | null>()
  const shorts = new Map<string, RigInfo | null>()
  for (const r of data.industry.rigs.values()) {
    for (const name of [r.en, r.zh]) if (name) claim(rigs, nameKey(name), r)
  }
  for (const r of data.industry.rigs.values()) {
    for (const name of [r.en, r.zh]) {
      const short = name ? shortRigKey(nameKey(name)) : ''
      if (short && !rigs.has(short)) claim(shorts, short, r)
    }
  }
  for (const [key, rig] of shorts) rigs.set(key, rig)
  found = { systems, systemsCompact, structures, rigs }
  lookupsCache.set(data, found)
  return found
}

function findSystem(text: string, data: DataSet, lookups: Lookups): SystemInfo | undefined {
  const value = text.trim()
  if (/^\d+$/.test(value)) return data.universe.systems.get(Number(value))
  return lookups.systems.get(marketKey(value)) ?? lookups.systemsCompact.get(compactMarketKey(value))
}

function typeName(t: StructureTypeInfo): string {
  return t.zh ? `${t.zh}（${t.en}）` : t.en
}

function rigName(r: RigInfo): string {
  return r.zh || r.en
}

// ------------------------------------------------------------------ 建表

interface Built {
  key: string
  list: IndustryLocation[]
  byKey: Map<string, IndustryLocation>
  /** 名称、手写别名、星系名，然后同样三层的去空白写法 */
  layers: Array<Map<string, IndustryLocation>>
  maxWords: number
  issues: ConfigIssue[]
}

const EMPTY: Built = { key: '', list: [], byKey: new Map(), layers: [], maxWords: 0, issues: [] }

/** 星系名当别名：碰上名称、手写别名，或者是纯数字、命令的参数时不加 */
const RESERVED_AUTO = new Set(['高级', '材料', '全部', 'all'].map(marketKey))

function usableAuto(key: string): boolean {
  return !!key && !RESERVED_AUTO.has(key) && !/^[\d\s.,]+$/.test(key)
}

interface Draft {
  setting: IndustryLocationSetting
  system: IndustrySystem
  hand: string[]
  auto: string[]
}

function claimNames(drafts: Draft[]): Array<Map<string, Draft>> {
  const names = new Map<string, Draft>()
  const hand = new Map<string, Draft>()
  const auto = new Map<string, Draft>()
  const taken = (key: string) => names.has(key) || hand.has(key) || auto.has(key)
  for (const d of drafts) names.set(marketKey(d.setting.name), d)
  for (const d of drafts) {
    for (const alias of d.setting.aliases) {
      const key = marketKey(alias)
      if (!key || taken(key)) continue
      hand.set(key, d)
      d.hand.push(alias)
    }
  }
  for (const d of drafts) {
    for (const name of [d.system.en, d.system.zh]) {
      const key = name ? marketKey(name) : ''
      if (!usableAuto(key) || taken(key)) continue
      auto.set(key, d)
      d.auto.push(name)
    }
  }
  // 去空白的一层收全部写法：名字里有没有空格、输入里多没多空格都能认出
  const compact = (layer: Map<string, Draft>) => {
    const out = new Map<string, Draft>()
    for (const [key, d] of layer) {
      const short = key.replace(/ /g, '')
      if (!out.has(short)) out.set(short, d)
    }
    return out
  }
  return [names, hand, auto, compact(names), compact(hand), compact(auto)]
}

class StructureResolver {
  constructor(
    private readonly data: DataSet,
    private readonly lookups: Lookups,
    private readonly settings: IndustrySettings,
    private readonly issues: ConfigIssue[],
  ) {}

  private report(s: IndustryStructureSetting, field: string, message: string) {
    this.issues.push({ section: 'industry', table: ST_TABLE, row: s.row, field, message })
  }

  resolve(s: IndustryStructureSetting, system: IndustrySystem): IndustryStructure | null {
    const raw = s.structureType.trim()
    const npc = !!raw && NPC_WORDS.has(nameKey(raw))
    let type: StructureTypeInfo | null = null
    if (raw && !npc) {
      type = (/^\d+$/.test(raw) ? this.data.industry.structures.get(Number(raw)) : this.lookups.structures.get(nameKey(raw))) ?? null
      if (!type) {
        this.report(s, 'structureType', `「建筑类型」${raw} 在数据里找不到（填 Raitaru、阿兹贝尔、Sotiyo、塔塔拉这类名字或 typeID；没有建筑加成填「无」，NPC 空间站填「NPC」），已跳过`)
        return null
      }
    }

    const activities = this.activities(s, type, npc, system)
    if (!activities) return null

    let facilityTaxPct = s.facilityTaxPct
    if (npc) {
      facilityTaxPct = this.settings.npcFacilityTaxPct
      if (s.facilityTaxPct > 0 && s.facilityTaxPct !== facilityTaxPct) {
        this.report(s, 'facilityTaxPct', `NPC 空间站的设施税按「NPC 空间站设施税」（${facilityTaxPct}%）算，这一行写的 ${s.facilityTaxPct}% 不生效`)
      }
    }

    return Object.freeze({
      row: s.row,
      location: s.location,
      name: s.name,
      type,
      npc,
      structureId: s.structureId,
      activities: Object.freeze([...activities]),
      rigs: Object.freeze(this.rigs(s, type, npc, system, activities)),
      facilityTaxPct,
      extraFeePct: s.extraFeePct,
      extraFeeIsk: s.extraFeeIsk,
      extraFeeLabel: s.extraFeeLabel,
      isDefault: s.isDefault,
    })
  }

  /** 实际能做的用途：高安、不是精炼厂（NPC 空间站、「无」也算）的去掉反应；什么都不剩时 null（跳过这一行） */
  private activities(s: IndustryStructureSetting, type: StructureTypeInfo | null, npc: boolean, system: IndustrySystem): IndustryActivity[] | null {
    const where = `${s.location} 是高安（${displaySec(system.security)}）`
    const problems = structureProblems(type, system.secClass, ['reaction'])
    const highsec = problems.find((p) => p.code === 'structure-highsec')
    if (highsec) this.report(s, 'structureType', `${highsec.message}，而 ${where}，请检查`)
    if (!s.activities.includes('reaction')) return [...s.activities]
    const why = system.secClass === 'high' ? `${where}，高安不能进行反应`
      : npc ? 'NPC 空间站不能进行反应'
        : !type ? '建筑类型为「无」（没有建筑加成）时不能进行反应'
          : problems.find((p) => p.code === 'reaction-structure')?.message
    if (!why) return [...s.activities]
    const out = s.activities.filter((a) => a !== 'reaction')
    if (!out.length) {
      this.report(s, 'activities', `${why}，已跳过`)
      return null
    }
    this.report(s, 'activities', `${why}，「用途」里的反应不生效`)
    return out
  }

  /** effective：去掉不能做的反应以后的用途 */
  private rigs(
    s: IndustryStructureSetting, type: StructureTypeInfo | null, npc: boolean, system: IndustrySystem,
    effective: readonly IndustryActivity[],
  ): RigInfo[] {
    if (!s.rigs.length) return []
    if (!type) {
      this.report(s, 'rigs', `没有建筑加成（${npc ? 'NPC 空间站' : '建筑类型为「无」'}）时不能装改装件，「改装件」已忽略`)
      return []
    }
    const out: RigInfo[] = []
    for (const token of s.rigs) {
      const value = token.trim()
      const found = /^\d+$/.test(value) ? this.data.industry.rigs.get(Number(value)) : this.lookups.rigs.get(nameKey(value))
      if (found === null) {
        this.report(s, 'rigs', `改装件「${value}」对应多个改装件，请写完整的名字或 typeID，已忽略`)
        continue
      }
      if (!found) {
        this.report(s, 'rigs', `改装件「${value}」在数据里找不到，已忽略`)
        continue
      }
      if (out.includes(found)) {
        this.report(s, 'rigs', `改装件「${rigName(found)}」重复，已忽略`)
        continue
      }
      if (!rigFits(found, type)) {
        const has = SIZE_LABELS[found.size] ?? `尺寸 ${found.size} 的`
        const fits = SIZE_LABELS[type.rigSize] ?? `尺寸 ${type.rigSize}`
        this.report(s, 'rigs', `改装件「${rigName(found)}」是${has}改装件，${typeName(type)} 只能装${fits}的，已忽略`)
        continue
      }
      out.push(found)
      this.checkRig(s, found, system, effective)
    }
    if (out.length > MAX_RIGS) this.report(s, 'rigs', `填了 ${out.length} 个改装件，一座建筑最多装 ${MAX_RIGS} 个，请检查`)
    return out
  }

  /** 制造、反应用的改装件：「用途」没选那种活动（多半是选错了），或者在这个安全等级不生效。研究、发明用的不管 */
  private checkRig(s: IndustryStructureSetting, rig: RigInfo, system: IndustrySystem, effective: readonly IndustryActivity[]) {
    const usedFor = (['manufacturing', 'reaction'] as const).filter((a) => rig.effects.some((e) => e.activity === ACTIVITY_CODE[a]))
    if (!usedFor.length) return
    if (!usedFor.some((a) => s.activities.includes(a))) {
      const label = usedFor.map((a) => ACTIVITY_LABELS[a]).join('、')
      this.report(s, 'rigs', `改装件「${rigName(rig)}」是${label}用的，这座建筑的「用途」没有选${label}`)
      return
    }
    // 去掉的反应已经在「用途」那里报过
    if (usedFor.some((a) => effective.includes(a)) && rigSecMultiplier(rig, system.secClass) === null) {
      this.report(s, 'rigs', `改装件「${rigName(rig)}」在${SEC_LABEL[system.secClass]}（${displaySec(system.security)}）不生效`)
    }
  }
}

function buildLocations(settings: IndustrySettings, data: DataSet): Built {
  const issues: ConfigIssue[] = []
  const lookups = lookupsOf(data)
  const drafts: Draft[] = []
  for (const loc of settings.locations) {
    const info = findSystem(loc.system, data, lookups)
    if (!info) {
      issues.push({
        section: 'industry', table: LOC_TABLE, row: loc.row, field: 'system',
        message: `「星系」${loc.system} 在数据里找不到，这个地点和它的建筑都不生效`,
      })
      continue
    }
    const system: IndustrySystem = Object.freeze({
      id: info.id, en: info.en, zh: info.zh, regionId: info.regionId, security: info.security,
      secClass: secClassOf(info.security, info.regionId),
    })
    drafts.push({ setting: loc, system, hand: [], auto: [] })
  }

  const draftLayers = claimNames(drafts)
  // 按建筑表的顺序检查（问题也按行号报）；所属地点无效的建筑不再一行行报，地点那一行已经报过
  const resolver = new StructureResolver(data, lookups, settings, issues)
  const byName = new Map(drafts.map((d) => [d.setting.name, { draft: d, structures: [] as IndustryStructure[] }]))
  for (const s of settings.structures) {
    const owner = byName.get(s.location)
    const resolved = owner && resolver.resolve(s, owner.draft.system)
    if (resolved) owner.structures.push(resolved)
  }
  const built = new Map<Draft, IndustryLocation>()
  for (const { draft: d, structures } of byName.values()) {
    const loc = d.setting
    built.set(d, Object.freeze({
      row: loc.row,
      key: marketKey(loc.name),
      name: loc.name,
      aliases: Object.freeze([...d.hand, ...d.auto]),
      system: d.system,
      visibility: loc.visibility,
      isDefault: loc.isDefault,
      defaultME: loc.defaultME,
      defaultTE: loc.defaultTE,
      sysCostBonusPct: loc.sysCostBonusPct,
      structures: Object.freeze(structures),
    }))
  }
  const list = drafts.map((d) => built.get(d)!)
  const layers = draftLayers.map((layer) => new Map([...layer].map(([k, d]) => [k, built.get(d)!])))
  let maxWords = 0
  for (const layer of layers.slice(0, 3)) {
    for (const k of layer.keys()) maxWords = Math.max(maxWords, k.split(' ').length)
  }
  return { key: data.key, list, byKey: new Map(list.map((l) => [l.key, l])), layers, maxWords, issues }
}

function findIn(layers: Array<Map<string, IndustryLocation>>, text: string, accept: (l: IndustryLocation) => boolean): IndustryLocation | undefined {
  const key = marketKey(text)
  if (!key) return undefined
  const short = compactMarketKey(text)
  for (const [i, layer] of layers.entries()) {
    const found = layer.get(i < 3 ? key : short)
    if (found && accept(found)) return found
  }
  return undefined
}

// ------------------------------------------------------------------ 对外

class Locations implements IndustryLocations {
  private built: Built | undefined

  constructor(private readonly settings: IndustrySettings, private readonly data: Pick<DataService, 'current'>) {}

  all(): IndustryLocation[] {
    return [...this.state().list]
  }

  visible(access: Access, activity?: IndustryActivity): IndustryLocation[] {
    return this.state().list.filter((l) => locationVisibleTo(l, access) && (!activity || locationSupports(l, activity)))
  }

  match(token: string, access: Access): IndustryLocation | null {
    return findIn(this.state().layers, token, (l) => locationVisibleTo(l, access)) ?? null
  }

  maxWords(): number {
    return this.state().maxWords
  }

  get(name: string): IndustryLocation | undefined {
    return this.state().byKey.get(marketKey(name))
  }

  defaultLocation(access: Access, activity?: IndustryActivity): IndustryLocation | undefined {
    const loc = this.state().list.find((l) => l.isDefault)
    if (!loc || !locationVisibleTo(loc, access) || (activity && !locationSupports(loc, activity))) return undefined
    return loc
  }

  issues(): ConfigIssue[] {
    return [...this.state().issues]
  }

  private state(): Built {
    let data: DataSet
    try {
      data = this.data.current()
    } catch (e) {
      if (e instanceof DataNotReadyError) return EMPTY
      throw e
    }
    if (this.built?.key !== data.key) this.built = buildLocations(this.settings, data)
    return this.built
  }
}

export function createIndustryLocations(settings: IndustrySettings, data: Pick<DataService, 'current'>): IndustryLocations {
  return new Locations(settings, data)
}
