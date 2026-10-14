// 炼金术：低级反应产物走「粗糙配方 → 废料提炼」的另一条路线，和正常路线比成本、时间（§7.5）。
// 每份粗糙产物提炼出主产物 perUnit 个（整批取整时是精确的小数）和一些副产品；副产品先抵同种材料，抵不完的算「多出」。

import { REPROCESS_ROUNDING } from '../../../constants'
import { roundHalfAway } from '../../format'
import type { AlchemyMode, TypeId } from '../../types'
import { runsForQuantity } from '../formulas'
import { reprocessOut, scrapYield } from '../reprocess'
import type { ReprocessRounding } from '../reprocess'
import { evaluateAt } from './job'
import type { JobCtx, JobEval } from './job'
import type { IndustryLocation } from '../locations'
import type { AlchemyPlan, PlanNode } from './expand'
import { unitOf } from './prices'

export interface AlchemyRoute {
  /** 粗糙配方的建筑和安装费 */
  ev: JobEval
  runs: number
  /** 提炼的粗糙产物个数 */
  units: number
  /** 得到的主产物个数（可能多于需求） */
  output: number
  perUnit: number
  yieldPct: number
  byproducts: Array<{ typeId: TypeId; quantity: number }>
  /** 提炼税（ISK）；产出缺价格时 null */
  reprocessTax: number | null
  reprocessAt?: string
  /** 提炼建筑所在的地点和提炼税（%） */
  reprocessLocation?: string
  reprocessPct?: number
  /** 比较用的成本：材料（扣掉自己产的副产品）+ 安装费 + 提炼税；缺价格时 null */
  cost: number | null
  timeSeconds: number
}

/** 提炼税最低的提炼建筑：提炼地点设置 → 命令里的地点 → 低级反应实际做的地点 → 本群第一个有提炼建筑的地点；一座都没有按 0% */
function reprocessing(ctx: JobCtx, at: IndustryLocation | null): { pct: number; at?: string; location?: string } {
  const candidates = [ctx.host.locations.reprocessLocation(ctx.access), ctx.location, at, ...ctx.host.locations.visible(ctx.access)]
  for (const location of candidates) {
    const list = location?.structures.filter((s) => s.purposes.includes('reprocessing')) ?? []
    if (!list.length) continue
    const best = list.reduce((a, b) => (b.taxPct.reprocessing < a.taxPct.reprocessing ? b : a))
    return { pct: best.taxPct.reprocessing, at: best.name, location: location!.name }
  }
  ctx.warnings.add('未配置提炼建筑，提炼税按 0 算')
  return { pct: 0 }
}

/** 产出（数量 × 材料市场单价）的总价值；有缺价格的 null */
function worth(ctx: JobCtx, list: ReadonlyArray<{ typeId: TypeId; quantity: number }>): number | null {
  let sum = 0
  for (const { typeId, quantity } of list) {
    const unit = unitOf(ctx.prices, typeId)
    if (unit === null) return null
    sum += unit * quantity
  }
  return sum
}

/** 提炼 U 份刚好够 demand 个主产物的最小 U（按当前取整方式；一份都出不了时 null） */
export function portionsFor(qtyMain: number, y: number, demand: number, mode: ReprocessRounding): number | null {
  const each = qtyMain * y
  if (each <= 0 || (mode === 'per-unit' && reprocessOut(qtyMain, 1, y, mode) < 1)) return null
  // 先估个下限，再一份一份往上加到够为止（整批取整不能从向下取整后的单份推）
  let u = Math.max(1, Math.floor(demand / each) - 1)
  while (reprocessOut(qtyMain, u, y, mode) < demand) u++
  return u
}

/** 需求 demand 个主产物走炼金：要几个粗糙产物、几流程、副产品多少、花多少钱；这个产物提炼不出主产物时 null */
export function alchemyRoute(ctx: JobCtx, node: PlanNode, plan: AlchemyPlan, demand: number, rounding: ReprocessRounding = REPROCESS_ROUNDING): AlchemyRoute | null {
  const { info } = plan
  const main = info.materials.find((m) => m.typeId === node.item.typeId)
  const y = scrapYield(ctx.host.settings.chain.scrapmetalLevel)
  const need = main ? portionsFor(main.quantity, y, demand, rounding) : null
  if (!main || need === null) return null
  // 每份的产出：整批取整时给精确值（最多 2 位小数），逐个取整时给取整后的
  const perUnit = rounding === 'batch' ? roundHalfAway(main.quantity * y, 2) : reprocessOut(main.quantity, 1, y, rounding)
  // 每个配方流程出 perRun 个粗糙产物，全部拿去提炼；提炼一次要 portion 个
  const perRun = plan.bp.products.find((p) => p.typeId === info.id)?.quantity ?? 1
  const portion = Math.max(1, info.portion)
  const runs = runsForQuantity(need * portion, perRun)
  const units = runs * perRun
  const batches = Math.floor(units / portion)
  const output = reprocessOut(main.quantity, batches, y, rounding)
  const byproducts = info.materials
    .filter((m) => m.typeId !== main.typeId)
    .map((m) => ({ typeId: m.typeId, quantity: reprocessOut(m.quantity, batches, y, rounding) }))
    .filter((b) => b.quantity > 0)

  const ev = evaluateAt(ctx, {
    item: plan.unrefined, bp: plan.bp, activity: 'reaction', runs, me: 0, te: 0, techLevel: null, location: node.place.location, rigs: 'default',
  }, plan.structures)
  const station = reprocessing(ctx, node.place.location)
  const value = worth(ctx, [{ typeId: main.typeId, quantity: output }, ...byproducts])
  const reprocessTax = value === null ? null : roundHalfAway(value * station.pct / 100, 2)
  // 副产品先抵自己这条路线里同种材料
  let offset = 0
  for (const input of ev.inputs) {
    const got = byproducts.find((b) => b.typeId === input.typeId)
    if (got) offset += (unitOf(ctx.prices, input.typeId) ?? 0) * Math.min(got.quantity, input.quantity)
  }
  const cost = ev.cost === null || reprocessTax === null ? null : ev.cost - roundHalfAway(offset, 2) + reprocessTax
  const route: AlchemyRoute = {
    ev, runs, units, output, perUnit, yieldPct: Math.round(y * 1e8) / 1e6, byproducts, reprocessTax, cost, timeSeconds: ev.plan.timeSeconds,
  }
  if (station.at) {
    route.reprocessAt = station.at
    route.reprocessLocation = station.location
    route.reprocessPct = station.pct
  }
  return route
}

/** 选便宜的，一样便宜选快的；只有一条路线知道成本时用它；强制炼金就炼金 */
export function chooseRoute(
  mode: AlchemyMode, normal: { cost: number | null; time: number }, alchemy: { cost: number | null; time: number },
): 'normal' | 'alchemy' {
  if (mode === 'alchemy') return 'alchemy'
  if (alchemy.cost === null) return 'normal'
  if (normal.cost === null) return 'alchemy'
  if (Math.abs(alchemy.cost - normal.cost) >= 1) return alchemy.cost < normal.cost ? 'alchemy' : 'normal'
  return alchemy.time < normal.time ? 'alchemy' : 'normal'
}
