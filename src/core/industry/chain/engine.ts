// 拆到原料的引擎（§7.4）：展开 → 一次取价 → 按「消费者先于生产者」的顺序聚合需求、整批取整、挑建筑、算成本 → 合计。
// 价格只在展开之后取一次；之后的计算全是纯函数。

import { CHAIN_COMPONENT_ME_TE, CHAIN_MAX_TYPES } from '../../../constants'
import { roundHalfAway } from '../../format'
import type {
  Access, ChainLayer, ChainLeaf, ChainNode, ChainOptions, ChainResult, CoreFailure, IndustryRequest, IndustryResult, IndustrySettings, TypeId,
} from '../../types'
import { FORMULA_REVISION, runsForQuantity } from '../formulas'
import { alchemyRoute, chooseRoute } from './alchemy'
import { expand, itemOf, placeFor } from './expand'
import type { ChainEnv, ChainHost, PlanEdge, PlanNode, Place } from './expand'
import { evaluateAt } from './job'
import type { JobCtx, JobEval, JobSpec } from './job'
import { fetchChainPrices } from './prices'
import { unitOf } from './prices'
import type { ChainTop } from './top'

/** 展示和合计的层顺序 */
const LAYER_ORDER: ChainNode['layer'][] = ['product', 'component', 'other', 'reaction2', 'reaction1']

const nameOf = (x: { zh: string; en: string }) => x.zh || x.en

/** 命令里写的层设置盖过控制台默认 */
export function mergeOptions(defaults: IndustrySettings['chain'], asked: NonNullable<IndustryRequest['chain']>): ChainOptions {
  return { layers: { ...defaults.layers, ...asked.layers }, alchemy: asked.alchemy ?? defaults.alchemy }
}

interface Built {
  node: ChainNode
  /** 这个节点的材料哪些是节点、哪些是叶子 */
  edges: PlanEdge[]
  byproducts: Array<{ typeId: TypeId; quantity: number }>
  /** 选了炼金时的提炼税 */
  tax: number | null
  alchemy: boolean
}

interface Variant {
  runs: number
  output: number
  me: number
  te: number
  ev: JobEval
  buildCost: number | null
}

function makeNode(ctx: JobCtx, pn: PlanNode, need: number, v: Variant): ChainNode {
  const unit = unitOf(ctx.prices, pn.item.typeId)
  const node: ChainNode = {
    item: pn.item, layer: pn.layer, activity: pn.activity,
    demand: need, runs: v.runs, output: v.output, surplus: v.output - need,
    location: pn.place.location?.name ?? '', structure: v.ev.structure?.name ?? null, autoPicked: v.ev.among > 1,
    me: v.me, te: v.te, inputs: v.ev.inputs, jobCost: v.ev.jobCost, buildCost: v.buildCost,
    buyCost: unit === null ? null : roundHalfAway(unit * need, 2),
    timeSeconds: v.ev.plan.timeSeconds, timeSecondsMaxSkill: v.ev.plan.timeSecondsMaxSkill,
  }
  if (pn.place.fallback) node.fallbackLocation = true
  return node
}

/** 一个节点：正常路线；低级反应有炼金配方时再算炼金路线，选一条 */
function buildNode(ctx: JobCtx, options: ChainOptions, pn: PlanNode, need: number, top: ChainTop | null): Built {
  const reaction = pn.activity === 'reaction'
  const runs = top ? top.runs : runsForQuantity(need, pn.perRun)
  const me = top ? top.me : reaction ? 0 : CHAIN_COMPONENT_ME_TE.me
  const te = top ? top.te : reaction ? 0 : CHAIN_COMPONENT_ME_TE.te
  const spec: JobSpec = {
    item: pn.item, bp: pn.bp, activity: pn.activity, runs, me, te, techLevel: top ? pn.item.techLevel : null,
    location: pn.place.location, rigs: top ? top.rigs : 'default',
  }
  if (top?.tax !== undefined) spec.tax = top.tax
  const ev = evaluateAt(ctx, spec, pn.place.structures)
  const normal = makeNode(ctx, pn, need, { runs, output: runs * pn.perRun, me, te, ev, buildCost: ev.cost })
  const alt = pn.alchemy && options.alchemy !== 'normal' ? alchemyRoute(ctx, pn, pn.alchemy, need) : null
  if (!pn.alchemy || !alt) {
    if (ev.missingAdjusted) ctx.warnings.add('部分材料缺少调整价，安装费偏低')
    return { node: normal, edges: pn.edges, byproducts: [], tax: null, alchemy: false }
  }

  const pick = chooseRoute(options.alchemy, { cost: ev.cost, time: ev.plan.timeSeconds }, { cost: alt.cost, time: alt.timeSeconds })
  const alchemy: NonNullable<ChainNode['alchemy']> = {
    unrefined: pn.alchemy.unrefined, units: alt.units, runs: alt.runs, yieldPct: alt.yieldPct, perUnit: alt.perUnit,
    byproducts: alt.byproducts, reprocessTax: alt.reprocessTax,
    other: pick === 'alchemy'
      ? { route: 'normal', cost: ev.cost, timeSeconds: ev.plan.timeSeconds }
      : { route: 'alchemy', cost: alt.cost, timeSeconds: alt.timeSeconds },
  }
  if (alt.reprocessAt) {
    alchemy.reprocessAt = alt.reprocessAt
    alchemy.reprocessLocation = alt.reprocessLocation
    alchemy.reprocessPct = alt.reprocessPct
  }
  if (pick === 'normal') {
    if (ev.missingAdjusted) ctx.warnings.add('部分材料缺少调整价，安装费偏低')
    return { node: { ...normal, route: 'normal', alchemy }, edges: pn.edges, byproducts: [], tax: null, alchemy: false }
  }
  if (alt.ev.missingAdjusted) ctx.warnings.add('部分材料缺少调整价，安装费偏低')
  const node = makeNode(ctx, pn, need, { runs: alt.runs, output: alt.output, me: 0, te: 0, ev: alt.ev, buildCost: alt.cost })
  return { node: { ...node, route: 'alchemy', alchemy }, edges: pn.alchemy.edges, byproducts: alt.byproducts, tax: alt.reprocessTax, alchemy: true }
}

const failure = (message: string): CoreFailure => ({ ok: false, code: 'BAD_ARGUMENT', reason: 'chain-size', message })

export async function runChain(
  host: ChainHost, access: Access, top: ChainTop, asked: NonNullable<IndustryRequest['chain']>,
): Promise<ChainResult | CoreFailure> {
  const options = mergeOptions(host.settings.chain, asked)
  const env: ChainEnv = { host, access, location: top.location, options }
  const place: Place = top.structure !== undefined
    ? { location: top.location, structures: top.structure ? [top.structure] : [], fallback: false }
    : placeFor(env, top.item, top.activity) ?? { location: top.location, structures: [], fallback: false }
  const exp = expand(env, { item: top.item, activity: top.activity, bp: top.bp, place })
  if (exp.closure.size > CHAIN_MAX_TYPES) {
    return failure(`${nameOf(top.item)} 要拆的物品有 ${exp.closure.size} 种，超过上限 ${CHAIN_MAX_TYPES} 种`)
  }

  const outputQuantity = top.runs * top.perRun
  const [prices, costs] = await Promise.all([
    fetchChainPrices(host, access, exp.closure, { typeId: top.item.typeId, qty: outputQuantity }),
    host.costInputs(),
  ])
  const ctx: JobCtx = { host, access, location: top.location, prices, costs, warnings: new Set(exp.warnings) }

  // 消费者先于生产者：轮到一个节点时，它的需求已经聚合完
  const demand = new Map<TypeId, number>([[top.item.typeId, top.demand]])
  const bought = new Map<TypeId, { quantity: number; kind: ChainLeaf['kind']; layer?: ChainLayer }>()
  const pool = new Map<TypeId, number>()
  const nodes: ChainNode[] = []
  let reprocessTax = 0
  // 缺价格的物品，每种只数一次
  const missing = new Set<TypeId>()
  for (const id of exp.order) {
    const need = demand.get(id) ?? 0
    if (need <= 0) continue
    const built = buildNode(ctx, options, exp.nodes.get(id)!, need, id === top.item.typeId ? top : null)
    nodes.push(built.node)
    for (const input of built.node.inputs) {
      const edge = built.edges.find((e) => e.typeId === input.typeId)
      if (edge?.node) {
        demand.set(input.typeId, (demand.get(input.typeId) ?? 0) + input.quantity)
        continue
      }
      const got = bought.get(input.typeId)
      if (got) got.quantity += input.quantity
      else bought.set(input.typeId, { quantity: input.quantity, kind: edge?.kind ?? 'bought', ...edge?.layer ? { layer: edge.layer } : {} })
    }
    for (const b of built.byproducts) pool.set(b.typeId, (pool.get(b.typeId) ?? 0) + b.quantity)
    if (built.alchemy) {
      if (built.tax === null) {
        for (const id of [built.node.item.typeId, ...built.byproducts.map((b) => b.typeId)]) if (unitOf(prices, id) === null) missing.add(id)
      }
      else reprocessTax += built.tax
    }
  }

  // 叶子：炼金副产品先抵同种要买的材料（原料和直接买的），抵不完的算「多出」
  const leaves: ChainLeaf[] = [...bought].map(([typeId, b]) => {
    const offset = Math.min(b.quantity, pool.get(typeId) ?? 0)
    if (offset) pool.set(typeId, pool.get(typeId)! - offset)
    const price = prices.material.units.get(typeId)
    const buy = b.quantity - offset
    const leaf: ChainLeaf = {
      item: itemOf(host, typeId), quantity: b.quantity, offset, unit: price?.unit ?? null,
      total: buy === 0 ? 0 : price ? roundHalfAway(price.unit * buy, 2) : null, kind: b.kind,
    }
    if (price?.fallback) leaf.fallback = true
    if (b.layer) leaf.layer = b.layer
    if (leaf.total === null) missing.add(typeId)
    return leaf
  })
  leaves.sort((a, b) => (b.total ?? -1) - (a.total ?? -1))
  const surplusByproducts = [...pool].filter(([, q]) => q > 0).map(([typeId, quantity]) => ({ item: itemOf(host, typeId), quantity }))

  const missingPrices = missing.size
  const leavesTotal = leaves.reduce((sum, l) => sum + (l.total ?? 0), 0)
  const jobsTotal = nodes.reduce((sum, n) => sum + (n.jobCost?.total ?? 0), 0)
  const total = leavesTotal + jobsTotal + reprocessTax
  const result: ChainResult = {
    product: top.item, runs: top.runs, outputQuantity, options, nodes, inventionExcluded: top.t2,
    layers: layerRows(nodes, options), leaves, surplusByproducts,
    totals: { leaves: leavesTotal, jobs: jobsTotal, reprocessTax, total, missingPrices, fastestSeconds: fastestSeconds(nodes) },
    warnings: [], indicesAt: costs.indices?.dataTime ?? null, formulaRevision: FORMULA_REVISION,
  }
  if (top.location) {
    result.location = top.location.name
    result.secClass = top.location.system.secClass
  }
  const material = prices.material
  if (material.market) {
    result.materialPrices = { marketKey: material.market.key, side: material.side }
    if (material.unavailable) result.materialPrices.unavailable = true
    if (material.fallback) result.materialPrices.fallbackKey = material.fallback.key
  }
  addProduct(host, prices.product, top, result)
  result.pricesAt = oldest([...leaves.map((l) => prices.material.units.get(l.item.typeId)), prices.product.units.get(top.item.typeId)])
  result.warnings = warningsOf(ctx, options, top, nodes, result)
  return result
}

/** 每种各开一条线、一层做完再做下一层的最快时间：每层最长的那个节点，各层相加 */
export function fastestSeconds(nodes: Array<Pick<ChainNode, 'layer' | 'timeSeconds'>>): number {
  const longest = new Map<ChainNode['layer'], number>()
  for (const n of nodes) longest.set(n.layer, Math.max(longest.get(n.layer) ?? 0, n.timeSeconds))
  return [...longest.values()].reduce((sum, t) => sum + t, 0)
}

/** 每层的合计；这一层一个节点都没有（没造、或者上面的层直接买了）used 是 false */
function layerRows(nodes: ChainNode[], options: ChainOptions): ChainResult['layers'] {
  return LAYER_ORDER.map((layer) => {
    const list = nodes.filter((n) => n.layer === layer)
    const sum = (pick: (n: ChainNode) => number | null) => {
      const values = list.map(pick)
      return list.length && values.every((v) => v !== null) ? (values as number[]).reduce((a, b) => a + b, 0) : null
    }
    const row: ChainResult['layers'][number] = {
      layer, mode: layer === 'product' ? 'build' : options.layers[layer], used: list.length > 0,
      build: sum((n) => n.buildCost), buy: sum((n) => n.buyCost), timeSeconds: list.reduce((s, n) => s + n.timeSeconds, 0),
    }
    const where = [...new Set(list.map((n) => n.structure ?? n.location).filter(Boolean))].join('、')
    if (where) row.where = where
    return row
  })
}

/** 成品价值和利润（同 service 的单个计算） */
function addProduct(host: ChainHost, side: JobCtx['prices']['product'], top: ChainTop, result: ChainResult) {
  const market = side.market ?? side.fallback
  if (!market) return
  const price = side.units.get(top.item.typeId)
  const value: NonNullable<IndustryResult['productValue']> = {
    marketKey: price?.fallback && side.fallback ? side.fallback.key : market.key,
    side: side.side,
    unit: price?.unit ?? null,
    total: price ? price.unit * result.outputQuantity : null,
  }
  if (price?.fallback) value.fallback = true
  result.productValue = value
  if (value.total === null || !(value.total > 0)) {
    result.profit = null
    return
  }
  const profit = value.total - (result.totals.total + value.total * host.settings.sellFeesPct / 100)
  result.profit = { value: profit, marginPct: profit / value.total * 100 }
}

function oldest(prices: Array<{ dataTime: number | null } | undefined>): number | null {
  let out: number | null = null
  for (const p of prices) if (p && p.dataTime !== null && (out === null || p.dataTime < out)) out = p.dataTime
  return out
}

function warningsOf(ctx: JobCtx, options: ChainOptions, top: ChainTop, nodes: ChainNode[], result: ChainResult): string[] {
  const { host, prices } = ctx
  const out = new Set<string>()
  const jobs = Math.ceil(top.runs / Math.max(1, top.bp.maxRuns))
  if (top.t2 && jobs > 1) out.add(`单张蓝图最多 ${top.bp.maxRuns} 流程，成品按 ${jobs} 个工作计算`)
  if (options.alchemy === 'alchemy') {
    const reactions = nodes.filter((n) => n.layer === 'reaction1')
    const done = reactions.filter((n) => n.route === 'alchemy').length
    if (done < reactions.length) out.add(`炼金只适用于 ${done} 种低级反应，其余 ${reactions.length - done} 种没有炼金配方，按正常路线算`)
  }
  for (const w of ctx.warnings) out.add(w)
  for (const w of host.marketWarnings('材料市场', prices.material, '材料成本不完整')) out.add(w)
  for (const w of host.marketWarnings('成品市场', prices.product, '没有算成品价值')) out.add(w)
  if (result.totals.missingPrices) out.add(`有 ${result.totals.missingPrices} 项没有价格，总成本不完整`)
  return [...out]
}
