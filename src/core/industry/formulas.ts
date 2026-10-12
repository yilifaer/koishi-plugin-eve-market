// 工业公式（§6.7.1、§6.7.2、§6.7.5–§6.7.8），纯函数。写法和 eve-ref 经游戏截图验证的计算器一致，黄金向量见测试。
//   材料  mult = (1 − ME/100) × S_me × R_me                       反应：ME 项 = 1（配方不能研究）
//         qty  = max(runs, ceil(round2(runs × base × mult)))      每个工作分别取整再相加
//   时间  t    = round(runs × baseTime × (1 − TE/100) × S_te × R_te × skillMult)   反应：TE 项 = 1
//   费用  EIV      = round(runs × Σ 调整价 × ME0 数量)
//         grossSCI = round(EIV × SCI)
//         bonuses  = round(grossSCI × S_cost × R_cost × (1 + sysBonus) − grossSCI)
//         facility = round(EIV × 设施税%)   scc = round(EIV × SCC%)   extra = round(EIV × 其他%) + 其他 ISK
// 待核实的常量（SCC 附加费、NPC 设施税、取整方式、满技能系数）都在这个文件或 src/constants.ts，
// 改公式或常量时同时改 FORMULA_REVISION 和 docs/工业公式.md。

import { MAX_SKILL_MANUFACTURING_MULT, MAX_SKILL_REACTION_MULT } from '../../constants'
import { roundHalfAway } from '../format'
import type { BlueprintActivity, IndustryActivity, TypeId } from '../types'
import type { Multipliers } from './modifiers'

/** 公式版本：写进每个结果（IndustryResult.formulaRevision） */
export const FORMULA_REVISION = '1'

// ------------------------------------------------------------------ 常量

/** 控制台「工业」分组里能改的公式常量（§4.10） */
export interface FormulaConfig {
  /** SCC 附加费（%），乘以预估物品价值 */
  sccSurchargePct: number
  /** 无建筑（NPC 空间站）时的设施税（%） */
  npcFacilityTaxPct: number
}

/** 默认值：SCC 4%（eve-ref 的常量，和它的游戏内测试一致）、NPC 设施税 0.25%，两个都待核实 */
export const FORMULA_DEFAULTS: Readonly<FormulaConfig> = Object.freeze({ sccSurchargePct: 4, npcFacilityTaxPct: 0.25 })

/** 配置里给了（有限的数字）就用配置，否则用默认值 */
export function formulaConfig(settings: Partial<FormulaConfig> = {}): FormulaConfig {
  const pick = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    sccSurchargePct: pick(settings.sccSurchargePct, FORMULA_DEFAULTS.sccSurchargePct),
    npcFacilityTaxPct: pick(settings.npcFacilityTaxPct, FORMULA_DEFAULTS.npcFacilityTaxPct),
  }
}

/** 「满技能约 …」的时间系数：制造 Industry V × Advanced Industry V，反应 Reactions V（待核实，值在 src/constants.ts） */
export const MAX_SKILL_TIME_MULT: Readonly<Record<IndustryActivity, number>> = Object.freeze({
  manufacturing: MAX_SKILL_MANUFACTURING_MULT,
  reaction: MAX_SKILL_REACTION_MULT,
})

// ------------------------------------------------------------------ 取整

/** 材料数量先保留 2 位小数消掉浮点噪声，再向上取整（同 eve-ref） */
export function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/** ISK 取整到个位：.5 远离 0（同 eve-ref 的 HALF_UP；游戏里的取整方式待核实） */
export function roundIsk(x: number): number {
  return roundHalfAway(x, 0)
}

/** 时间取整到秒：四舍五入（游戏里是四舍五入、向上还是向下待核实） */
export function roundSeconds(x: number): number {
  return Math.round(x)
}

// ------------------------------------------------------------------ 流程和工作

/** *N 是产品数量：流程数 = ceil(N ÷ 每流程产出) */
export function runsForQuantity(quantity: number, perRun: number): number {
  return Math.max(1, Math.ceil(quantity / Math.max(1, perRun)))
}

/**
 * 拆成几个工作（§6.7.2）。maxRuns 是蓝图拷贝的单次上限，是否也限制原图待核实：
 * 在核实之前只拆 T2 产品（发明出来的拷贝），T1 按原图算一个工作。核实后只改这里
 */
export function splitJobs(runs: number, maxRuns: number, techLevel: number | null): number[] {
  if (techLevel !== 2 || !(maxRuns > 0) || runs <= maxRuns) return [runs]
  const jobs: number[] = Array.from({ length: Math.floor(runs / maxRuns) }, () => maxRuns)
  if (runs % maxRuns) jobs.push(runs % maxRuns)
  return jobs
}

// ------------------------------------------------------------------ 材料

/** 1 − 等级 / 100 */
export function efficiency(level: number): number {
  return 1 - level / 100
}

/** 建筑和改装件的乘数（modifiers.ts 的 jobModifiers 给的 structure、rigs；基础模式传 NO_BONUS） */
export interface ModifierSet {
  structure: Multipliers
  rigs: Multipliers
}

/** 反应配方不能研究：ME / TE 一律按 0 */
export function researchable(activity: IndustryActivity): boolean {
  return activity !== 'reaction'
}

export function materialMultiplier(activity: IndustryActivity, me: number, mods: ModifierSet): number {
  return efficiency(researchable(activity) ? me : 0) * mods.structure.me * mods.rigs.me
}

/** 一个工作里一种材料的数量；mult = 1 时就是 runs × base */
export function materialQuantity(base: number, runs: number, mult: number): number {
  return Math.max(runs, Math.ceil(round2(runs * base * mult)))
}

export interface MaterialNeed {
  typeId: TypeId
  /** ME 0、无加成的数量（全部流程） */
  baseQuantity: number
  /** 实际数量：每个工作分别取整再相加 */
  quantity: number
}

export function jobMaterials(materials: BlueprintActivity['materials'], jobs: readonly number[], mult: number): MaterialNeed[] {
  const runs = jobs.reduce((a, b) => a + b, 0)
  return materials.map((m) => ({
    typeId: m.typeId,
    baseQuantity: m.quantity * runs,
    quantity: jobs.reduce((sum, r) => sum + materialQuantity(m.quantity, r, mult), 0),
  }))
}

// ------------------------------------------------------------------ 时间

export function timeMultiplier(activity: IndustryActivity, te: number, mods: ModifierSet): number {
  return efficiency(researchable(activity) ? te : 0) * mods.structure.te * mods.rigs.te
}

/** 一个工作的秒数；skillMult = 1 是「未计技能」 */
export function jobTime(baseTime: number, runs: number, mult: number, skillMult = 1): number {
  return roundSeconds(runs * baseTime * mult * skillMult)
}

/** 多个工作在一条生产线上连续做完的总秒数 */
export function productionTime(baseTime: number, jobs: readonly number[], mult: number, skillMult = 1): number {
  return jobs.reduce((sum, r) => sum + jobTime(baseTime, r, mult, skillMult), 0)
}

// ------------------------------------------------------------------ 安装费用

/** 调整价（/markets/prices 的 adjusted_price）；没有时 null 或 undefined */
export type AdjustedPrice = (typeId: TypeId) => number | null | undefined

export interface EivResult {
  eiv: number
  /** 没有调整价、EIV 里跳过的材料（卡片警告「安装费偏低」） */
  missing: TypeId[]
}

/** 预估物品价值：按 ME 0 的基础数量，和建筑、改装件无关 */
export function estimatedItemValue(materials: BlueprintActivity['materials'], runs: number, adjusted: AdjustedPrice): EivResult {
  let perRun = 0
  const missing: TypeId[] = []
  for (const m of materials) {
    const price = adjusted(m.typeId)
    if (typeof price === 'number' && Number.isFinite(price)) perRun += price * m.quantity
    else missing.push(m.typeId)
  }
  return { eiv: roundIsk(perRun * runs), missing }
}

export interface JobCostParams {
  /** 系统指数（小数，例如 0.0231）；星系不在 /industry/systems 里时由调用方传 0 并警告 */
  sci: number
  /** 建筑和改装件的费用乘数（S_cost、R_cost） */
  mods: ModifierSet
  /** 星系对安装费的额外加成（%，例如势力战争 -50） */
  sysCostBonusPct: number
  facilityTaxPct: number
  sccSurchargePct: number
  /** 联盟另收的其他费用：EIV 的百分比、每个工作固定 ISK */
  extraFeePct?: number
  extraFeeIsk?: number
}

export interface JobCostBreakdown {
  eiv: number
  grossSci: number
  /** 负数 = 折扣 */
  bonuses: number
  facility: number
  scc: number
  extra: number
  total: number
}

/** 一个工作的安装费用（Alpha 克隆的额外税不计） */
export function jobCost(eiv: number, p: JobCostParams): JobCostBreakdown {
  const grossSci = roundIsk(eiv * p.sci)
  const bonuses = roundIsk(grossSci * (p.mods.structure.cost * p.mods.rigs.cost * (1 + p.sysCostBonusPct / 100)) - grossSci)
  const facility = roundIsk(eiv * p.facilityTaxPct / 100)
  const scc = roundIsk(eiv * p.sccSurchargePct / 100)
  const extra = roundIsk(eiv * (p.extraFeePct ?? 0) / 100) + roundIsk(p.extraFeeIsk ?? 0)
  return { eiv, grossSci, bonuses, facility, scc, extra, total: grossSci + bonuses + facility + scc + extra }
}

/** 多个工作的安装费用：每个工作分别算（各自取整），再相加 */
export function jobsCost(
  materials: BlueprintActivity['materials'], jobs: readonly number[], adjusted: AdjustedPrice, p: JobCostParams,
): JobCostBreakdown & { missingAdjusted: TypeId[] } {
  const sum: JobCostBreakdown = { eiv: 0, grossSci: 0, bonuses: 0, facility: 0, scc: 0, extra: 0, total: 0 }
  const missing = new Set<TypeId>()
  for (const runs of jobs) {
    const value = estimatedItemValue(materials, runs, adjusted)
    for (const id of value.missing) missing.add(id)
    const one = jobCost(value.eiv, p)
    for (const key of Object.keys(sum) as Array<keyof JobCostBreakdown>) sum[key] += one[key]
  }
  return { ...sum, missingAdjusted: [...missing] }
}

/** 设施税：命令里写了「税:x%」用它；有建筑用建筑配置的；无建筑用 NPC 空间站的 */
export function facilityTaxPctFor(
  opts: { override?: number; structurePct?: number; hasStructure: boolean }, config: FormulaConfig,
): number {
  if (opts.override !== undefined) return opts.override
  return opts.hasStructure ? opts.structurePct ?? 0 : config.npcFacilityTaxPct
}

// ------------------------------------------------------------------ 一个计算

export interface ProductionInput {
  activity: IndustryActivity
  blueprint: Pick<BlueprintActivity, 'time' | 'maxRuns' | 'materials'>
  runs: number
  /** 产品的科技等级（决定是否按拷贝上限拆工作） */
  techLevel: number | null
  me: number
  te: number
  mods: ModifierSet
}

export interface ProductionPlan {
  /** 每个工作的流程数 */
  jobs: number[]
  materialMultiplier: number
  timeMultiplier: number
  materials: MaterialNeed[]
  /** 未计技能 */
  timeSeconds: number
  /** 满技能约 */
  timeSecondsMaxSkill: number
}

/** 材料和时间（不需要价格）；费用另用 jobsCost 算 */
export function planProduction(input: ProductionInput): ProductionPlan {
  const { activity, blueprint, mods } = input
  const jobs = splitJobs(input.runs, blueprint.maxRuns, input.techLevel)
  const mMult = materialMultiplier(activity, input.me, mods)
  const tMult = timeMultiplier(activity, input.te, mods)
  return {
    jobs,
    materialMultiplier: mMult,
    timeMultiplier: tMult,
    materials: jobMaterials(blueprint.materials, jobs, mMult),
    timeSeconds: productionTime(blueprint.time, jobs, tMult),
    timeSecondsMaxSkill: productionTime(blueprint.time, jobs, tMult, MAX_SKILL_TIME_MULT[activity]),
  }
}
