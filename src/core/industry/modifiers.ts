// 工业修正（§6.7.3、§6.7.4、§6.7.8），全部来自 industry.json，这里不写任何加成数值：
//   建筑   S_k = structure.bonus[活动]?.[k] ?? 1        （无建筑、NPC 空间站 = 1）
//   改装件 R_k = 1 + Σ effect.pct / 100 × rig.sec[安等]  （只取 [活动, k, 过滤器] 命中产品的那条；多个改装件相加）
// 安全等级按真实值分类（secClassOf），显示一律用 core/format 的 displaySec，两者不会矛盾。
// 配置检查用的判断（尺寸、高安、精炼厂）也在这里，地点和建筑的配置检查直接调用。

import { secClassOf } from '../universe'
import type {
  ActivityCode, IndustryActivity, ItemInfo, RigInfo, SecClass, StructureTypeInfo, SystemInfo, TargetFilter, TypeId,
} from '../types'

export type ModifierKind = 'me' | 'te' | 'cost'

/** 三种修正的乘数（1 = 没有加成） */
export interface Multipliers { me: number; te: number; cost: number }

export const NO_BONUS: Readonly<Multipliers> = Object.freeze({ me: 1, te: 1, cost: 1 })

/** 插件的活动名 → 数据里的活动代码 */
export const ACTIVITY_CODE: Readonly<Record<IndustryActivity, ActivityCode>> = Object.freeze({ manufacturing: 'm', reaction: 'r' })

/** 安全等级分类 → 改装件 sec 里的键 */
export const SEC_KEY: Readonly<Record<SecClass, keyof RigInfo['sec']>> = Object.freeze({ high: 'h', low: 'l', null: 'n' })

export const SEC_LABEL: Readonly<Record<SecClass, string>> = Object.freeze({ high: '高安', low: '低安', null: '00' })

/** 精炼厂分组（Athanor、Tatara）：只有它能装反应堆服务 */
export const REFINERY_GROUP = 1406

/** 改装件尺寸（属性 1547）：2 = M、3 = L、4 = XL */
const RIG_SIZE_LABEL: Readonly<Record<number, string>> = { 2: '中型', 3: '大型', 4: '超大型' }

/** 产品的大类和分组（改装件过滤器按这两个匹配） */
export type ProductClass = Pick<ItemInfo, 'groupId' | 'categoryId'>

const nameOf = (x: { zh: string; en: string }) => x.zh || x.en
const sizeLabel = (size: number) => RIG_SIZE_LABEL[size] ?? `尺寸 ${size}`
/** 去掉浮点噪声（-2.4 × 2.1 = -5.039999…），只用于展示的百分比 */
const tidy = (x: number) => Math.round(x * 1e6) / 1e6 || 0

// ------------------------------------------------------------------ 安全等级

/** 地点星系的分类：≥ 0.45 高安，> 0 低安，其余（含虫洞、波赫文）00 */
export function systemSecClass(system: Pick<SystemInfo, 'security' | 'regionId'>): SecClass {
  return secClassOf(system.security, system.regionId)
}

// ------------------------------------------------------------------ 建筑

/** 建筑对这种活动的乘数；没有建筑或这种活动没有加成时都是 1 */
export function structureMultipliers(structure: StructureTypeInfo | null | undefined, activity: IndustryActivity): Multipliers {
  const set = structure?.bonus[ACTIVITY_CODE[activity]]
  return { me: set?.me ?? 1, te: set?.te ?? 1, cost: set?.cost ?? 1 }
}

/** 能不能做这种活动：反应只能在精炼厂；制造不限（待核实：精炼厂能否装制造服务） */
export function structureSupports(structure: StructureTypeInfo, activity: IndustryActivity): boolean {
  return activity !== 'reaction' || structure.group === REFINERY_GROUP
}

// ------------------------------------------------------------------ 改装件

/** 产品的大类在 categories 里、或分组在 groups 里就算命中 */
export function filterMatches(filter: TargetFilter, product: ProductClass): boolean {
  return filter.categories.includes(product.categoryId) || filter.groups.includes(product.groupId)
}

/**
 * 改装件对这个产品、这种活动、这种修正的百分比（还没乘安等倍率），没有命中的条目时 null。
 * 过滤器为 null 的条目对这个活动的所有产品生效。数据里同一个改装件的过滤器互不重叠，命中多条时取第一条
 */
export function rigEffectPct(
  rig: RigInfo, activity: IndustryActivity, kind: ModifierKind, product: ProductClass,
  filters: ReadonlyMap<number, TargetFilter>,
): number | null {
  const code = ACTIVITY_CODE[activity]
  for (const e of rig.effects) {
    if (e.activity !== code || e.kind !== kind) continue
    if (e.filter === null) return e.pct
    const filter = filters.get(e.filter)
    if (filter && filterMatches(filter, product)) return e.pct
  }
  return null
}

/** 安等倍率；null = 这个安全等级不生效 */
export function rigSecMultiplier(rig: RigInfo, secClass: SecClass): number | null {
  return rig.sec[SEC_KEY[secClass]]
}

/** 尺寸和建筑能装的一致 */
export function rigFits(rig: RigInfo, structure: StructureTypeInfo): boolean {
  return rig.size === structure.rigSize
}

export type ModifierIssueCode =
  /** 改装件尺寸和建筑不符（不计入） */
  | 'rig-size'
  /** 改装件在这个安全等级不生效 */
  | 'rig-sec'
  /** 不能放在高安的建筑（Sotiyo、Keepstar）放在高安 */
  | 'structure-highsec'
  /** 高安做反应 */
  | 'reaction-highsec'
  /** 不是精炼厂却做反应 */
  | 'reaction-structure'

export interface ModifierIssue {
  code: ModifierIssueCode
  rigId?: TypeId
  structureId?: TypeId
  /** 给卡片和配置问题用的一句话 */
  message: string
}

function rigSizeIssue(rig: RigInfo, structure: StructureTypeInfo): ModifierIssue {
  return {
    code: 'rig-size',
    rigId: rig.id,
    structureId: structure.id,
    message: `改装件「${nameOf(rig)}」是${sizeLabel(rig.size)}改装件，${nameOf(structure)}只能装${sizeLabel(structure.rigSize)}改装件，没有计入`,
  }
}

function rigSecIssue(rig: RigInfo): ModifierIssue {
  return { code: 'rig-sec', rigId: rig.id, message: `改装件「${nameOf(rig)}」在此安全等级不生效` }
}

/** 配置检查：改装件装在这座建筑、这个安全等级上有什么问题（和产品无关） */
export function rigProblems(rig: RigInfo, structure: StructureTypeInfo, secClass: SecClass): ModifierIssue[] {
  const out: ModifierIssue[] = []
  if (!rigFits(rig, structure)) out.push(rigSizeIssue(rig, structure))
  if (rigSecMultiplier(rig, secClass) === null) out.push(rigSecIssue(rig))
  return out
}

/** 配置检查：建筑放在这个安全等级、做这些活动有什么问题 */
export function structureProblems(
  structure: StructureTypeInfo | null | undefined, secClass: SecClass, activities: readonly IndustryActivity[],
): ModifierIssue[] {
  const out: ModifierIssue[] = []
  if (structure && secClass === 'high' && !structure.highsec) {
    out.push({ code: 'structure-highsec', structureId: structure.id, message: `${nameOf(structure)}不能放在高安` })
  }
  if (activities.includes('reaction')) {
    if (secClass === 'high') out.push({ code: 'reaction-highsec', message: '高安不能进行反应' })
    if (structure && !structureSupports(structure, 'reaction')) {
      out.push({ code: 'reaction-structure', structureId: structure.id, message: `${nameOf(structure)}不是精炼厂，不能进行反应` })
    }
  }
  return out
}

// ------------------------------------------------------------------ 合起来

export interface AppliedRig {
  rigId: TypeId
  /** 已乘安等倍率的百分比，例如 00 的 T2 改装件 me -5.04、te -50.4；没有这种修正时 0 */
  me: number
  te: number
  cost: number
}

export interface ModifierInput {
  activity: IndustryActivity
  product: ProductClass
  secClass: SecClass
  /** null / 不给 = 无建筑（NPC 空间站或「建筑:无」），这时改装件也不算 */
  structure?: StructureTypeInfo | null
  /** 建筑上实际装的改装件（「改装:无」时传空数组） */
  rigs?: readonly RigInfo[]
  filters: ReadonlyMap<number, TargetFilter>
}

export interface JobModifiers {
  /** S × R：直接乘进材料、时间、费用公式 */
  me: number
  te: number
  cost: number
  structure: Multipliers
  /** R（多个改装件相加以后） */
  rigs: Multipliers
  /** 对这个产品生效的改装件，按配置顺序 */
  applied: AppliedRig[]
  issues: ModifierIssue[]
}

const KINDS: readonly ModifierKind[] = ['me', 'te', 'cost']

interface RigTotals { sum: Multipliers; applied: AppliedRig[]; issues: ModifierIssue[] }

/** 建筑上的改装件里对这个产品生效的那些，百分比乘上安等倍率后相加 */
function collectRigs(structure: StructureTypeInfo, input: ModifierInput): RigTotals {
  const { activity, product, secClass, filters } = input
  const out: RigTotals = { sum: { me: 0, te: 0, cost: 0 }, applied: [], issues: [] }
  for (const rig of input.rigs ?? []) {
    if (!rigFits(rig, structure)) {
      out.issues.push(rigSizeIssue(rig, structure))
      continue
    }
    const pct = KINDS.map((k) => rigEffectPct(rig, activity, k, product, filters))
    // 对这个产品没有任何效果的改装件不列出，安等也不用报
    if (pct.every((p) => p === null)) continue
    const mult = rigSecMultiplier(rig, secClass)
    if (mult === null) {
      out.issues.push(rigSecIssue(rig))
      continue
    }
    const row: AppliedRig = { rigId: rig.id, me: 0, te: 0, cost: 0 }
    KINDS.forEach((k, i) => {
      const p = pct[i]
      if (p === null) return
      out.sum[k] += p / 100 * mult
      row[k] = tidy(p * mult)
    })
    out.applied.push(row)
  }
  return out
}

/** 一个工作的全部修正：建筑 × 改装件，并列出对这个产品生效的改装件和发现的问题 */
export function jobModifiers(input: ModifierInput): JobModifiers {
  const structure = input.structure ?? null
  const S = structureMultipliers(structure, input.activity)
  const rigs = structure ? collectRigs(structure, input) : { sum: { me: 0, te: 0, cost: 0 }, applied: [], issues: [] }
  const R: Multipliers = { me: 1 + rigs.sum.me, te: 1 + rigs.sum.te, cost: 1 + rigs.sum.cost }
  return {
    me: S.me * R.me,
    te: S.te * R.te,
    cost: S.cost * R.cost,
    structure: S,
    rigs: R,
    applied: rigs.applied,
    issues: [...structureProblems(structure, input.secClass, [input.activity]), ...rigs.issues],
  }
}
