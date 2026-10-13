// 拆到原料：算一个节点的工作（材料、时间、安装费），以及在几座候选建筑里挑最合适的。
// 公式、加成都复用 formulas.ts、modifiers.ts，这里只负责把它们接起来。

import type {
  Access, BlueprintActivity, IndustryActivity, ItemInfo, TypeId,
} from '../../types'
import { roundHalfAway } from '../../format'
import { facilityTaxPctFor, formulaConfig, jobsCost, planProduction } from '../formulas'
import type { JobCostBreakdown, ProductionPlan } from '../formulas'
import { costIndexOf } from '../indices'
import type { IndustryLocation, IndustryStructure } from '../locations'
import { NO_BONUS, jobModifiers } from '../modifiers'
import { rankStructures } from '../pick'
import type { ChainHost, CostInputs } from './expand'
import { unitOf } from './prices'
import type { ChainPriceBook } from './prices'

/** 取价之后的计算用到的东西，整个拆解共用一份 */
export interface JobCtx {
  host: ChainHost
  access: Access
  /** 命令里的地点 */
  location: IndustryLocation | null
  prices: ChainPriceBook
  costs: CostInputs
  /** 要写进结果的警告（去重） */
  warnings: Set<string>
  /** 提炼建筑的税，第一次用到时查 */
  reprocess?: { pct: number; at?: string }
}

export interface JobSpec {
  item: ItemInfo
  bp: BlueprintActivity
  activity: IndustryActivity
  runs: number
  me: number
  te: number
  techLevel: number | null
  location: IndustryLocation | null
  rigs: 'default' | 'none'
  /** 命令里的税（只有顶层用） */
  tax?: number
}

export interface JobEval {
  structure: IndustryStructure | null
  /** 在几座候选建筑里挑的 */
  among: number
  plan: ProductionPlan
  inputs: Array<{ typeId: TypeId; quantity: number }>
  jobCost: JobCostBreakdown | null
  /** 有对应材料缺调整价 */
  missingAdjusted: boolean
  /** 材料按市场价；有材料缺价格时 null */
  materialCost: number | null
  /** 材料 + 安装费；有材料缺价格时 null */
  cost: number | null
  /** 排序用：缺市场价的材料用调整价顶上 */
  rankCost: number
}

/** 一座建筑（null = 没有建筑加成）做这个工作 */
export function evaluateJob(ctx: JobCtx, spec: JobSpec, structure: IndustryStructure | null): JobEval {
  const { host, prices, costs } = ctx
  const { location } = spec
  const mods = location
    ? jobModifiers({
      activity: spec.activity,
      product: spec.item,
      secClass: location.system.secClass,
      structure: structure?.type ?? null,
      rigs: spec.rigs === 'none' ? [] : structure?.rigs ?? [],
      filters: host.data.industry.filters,
    })
    : { structure: NO_BONUS, rigs: NO_BONUS }
  const modifiers = { structure: mods.structure, rigs: mods.rigs }
  const plan = planProduction({
    activity: spec.activity, blueprint: spec.bp, runs: spec.runs, techLevel: spec.techLevel, me: spec.me, te: spec.te, mods: modifiers,
  })

  let jobCost: JobCostBreakdown | null = null
  let missingAdjusted = false
  if (location && costs.adjusted) {
    const config = formulaConfig(host.settings)
    const adjusted = costs.adjusted.byType
    const found = costs.indices ? costIndexOf(costs.indices, location.system.id, spec.activity) : undefined
    const cost = jobsCost(spec.bp.materials, plan.jobs, (id) => adjusted.get(id), {
      sci: found ?? 0,
      mods: modifiers,
      sysCostBonusPct: location.sysCostBonusPct,
      facilityTaxPct: facilityTaxPctFor({ override: spec.tax, activity: spec.activity, structure }, config),
      sccSurchargePct: config.sccSurchargePct,
      extraFeePct: structure?.extraFeePct ?? 0,
      extraFeeIsk: structure?.extraFeeIsk ?? 0,
    })
    jobCost = { eiv: cost.eiv, grossSci: cost.grossSci, bonuses: cost.bonuses, facility: cost.facility, scc: cost.scc, extra: cost.extra, total: cost.total }
    missingAdjusted = cost.missingAdjusted.length > 0
  }
  noteCostGaps(ctx, location)

  let materialCost: number | null = 0
  let rankCost = jobCost?.total ?? 0
  for (const m of plan.materials) {
    const unit = unitOf(prices, m.typeId)
    materialCost = materialCost === null || unit === null ? null : materialCost + roundHalfAway(unit * m.quantity, 2)
    rankCost += m.quantity * (unit ?? costs.adjusted?.byType.get(m.typeId) ?? 0)
  }
  return {
    structure, among: 1, plan, jobCost, missingAdjusted, materialCost, rankCost,
    inputs: plan.materials.map((m) => ({ typeId: m.typeId, quantity: m.quantity })),
    cost: materialCost === null ? null : materialCost + (jobCost?.total ?? 0),
  }
}

/** 没有地点、取不到指数或调整价时安装费不准，写一次 */
function noteCostGaps(ctx: JobCtx, location: IndustryLocation | null) {
  if (!location) {
    ctx.warnings.add('没有选工业地点，整条链按没有建筑加成算，安装费和税没有计入')
  } else if (!ctx.costs.adjusted) {
    ctx.warnings.add('调整价暂时取不到，安装费用、设施税和 SCC 附加费没有计入')
  } else if (!ctx.costs.indices) {
    ctx.warnings.add('星系成本指数暂时取不到，安装费用没有计入星系成本指数（偏低）')
  }
}

/** 候选建筑各算一遍，预计总成本 → 时间 → 默认勾 → 表格顺序排第一的；没有候选 = 没有建筑加成 */
export function evaluateAt(ctx: JobCtx, spec: JobSpec, candidates: readonly IndustryStructure[]): JobEval {
  if (candidates.length < 2) return evaluateJob(ctx, spec, candidates[0] ?? null)
  const ranked = rankStructures(candidates.map((structure) => {
    const ev = evaluateJob(ctx, spec, structure)
    return { item: ev, cost: ev.rankCost, time: ev.plan.timeSeconds, isDefault: structure.isDefault, row: structure.row }
  }))
  return { ...ranked[0].item, among: candidates.length }
}
