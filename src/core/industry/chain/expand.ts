// 拆到原料：把配方展开成图。只看结构（有没有蓝图、层的设置、哪里造得了），不看价格和数量。
// 每个材料要么是节点（自己造），要么是叶子（买）；遇到环、没有地方造的，这条边改成买并警告。

import type {
  Access, BlueprintActivity, ChainLayer, ChainLeaf, ChainNode, ChainOptions, DataSet, IndustryActivity, IndustrySettings,
  ItemInfo, ItemResolver, MarketRegistry, ReprocessInfo, TypeId,
} from '../../types'
import { canBuild, locationCanBuild } from '../capabilities'
import type { AdjustedPrices, SystemIndices } from '../indices'
import { locationSupports, structuresFor } from '../locations'
import type { IndustryLocation, IndustryLocations, IndustryStructure } from '../locations'
import { classifyMaterial } from './layers'
import type { ChainSide, PriceSideFn } from './prices'

/** 安装费用要的两份全量列表；null = 取不到 */
export interface CostInputs { indices: SystemIndices | null; adjusted: AdjustedPrices | null }

/** 拆解用到的服务（由 IndustryService 提供） */
export interface ChainHost {
  data: DataSet
  items: Pick<ItemResolver, 'byId'>
  locations: IndustryLocations
  markets: Pick<MarketRegistry, 'configured'>
  settings: IndustrySettings
  now(): number
  priceSide: PriceSideFn
  costInputs(): Promise<CostInputs>
  marketWarnings(label: string, prices: ChainSide, missing: string): string[]
}

export interface ChainEnv {
  host: ChainHost
  access: Access
  /** 命令里的地点；null = 没有地点（基础模式），整条链按没有建筑算 */
  location: IndustryLocation | null
  options: ChainOptions
}

/** 在哪里造：structures 是这个地点能造的建筑（空 = 没有建筑加成）；fallback = 不是命令里写的地点 */
export interface Place { location: IndustryLocation | null; structures: IndustryStructure[]; fallback: boolean }

/** node = false 是叶子，kind 说明为什么是叶子 */
export interface PlanEdge { typeId: TypeId; node: boolean; kind?: ChainLeaf['kind']; layer?: ChainLayer }

/** 低级反应的炼金配方：粗糙产物的反应配方，和它能用的建筑 */
export interface AlchemyPlan {
  info: ReprocessInfo
  unrefined: ItemInfo
  bp: BlueprintActivity
  edges: PlanEdge[]
  structures: IndustryStructure[]
}

export interface PlanNode {
  item: ItemInfo
  layer: ChainNode['layer']
  activity: IndustryActivity
  bp: BlueprintActivity
  perRun: number
  place: Place
  edges: PlanEdge[]
  alchemy?: AlchemyPlan
}

export interface Expansion {
  nodes: Map<TypeId, PlanNode>
  /** 消费者在前，生产者在后 */
  order: TypeId[]
  /** 要取价的全部物品 */
  closure: Set<TypeId>
  warnings: string[]
}

const nameOf = (x: { zh: string; en: string }) => x.zh || x.en

/** 没有蓝图的东西（数据里有、物品表里没有，不该发生）也要能当叶子 */
export function itemOf(host: Pick<ChainHost, 'items'>, typeId: TypeId): ItemInfo {
  return host.items.byId(typeId) ?? {
    typeId, en: `#${typeId}`, zh: '', groupId: 0, categoryId: 0, marketGroupId: null, metaGroupId: null, techLevel: null,
    volume: 0, packagedVolume: 0, portionSize: 1, capacity: null, variationParent: null,
  }
}

const activityOf = (layer: ChainLayer): IndustryActivity => (layer === 'reaction1' || layer === 'reaction2' ? 'reaction' : 'manufacturing')

/** 制造：命令里的地点；反应：命令里的地点 → 设置里的反应地点 → 本群第一个造得了的地点；都不行 null */
export function placeFor(env: ChainEnv, item: ItemInfo, activity: IndustryActivity): Place | null {
  const { host, location } = env
  const { industry } = host.data
  const able = (loc: IndustryLocation) => structuresFor(loc, activity).filter((s) => canBuild(s, loc, item, activity, industry).ok)
  if (activity === 'manufacturing') {
    if (!location) return { location: null, structures: [], fallback: false }
    if (!locationSupports(location, activity) || !locationCanBuild(location, item, activity, industry).ok) return null
    return { location, structures: able(location), fallback: false }
  }
  // 没有地点（基础模式）时反应也没有地方做
  if (!location) return null
  const tried = [location, host.locations.chainReactionLocation(env.access), ...host.locations.visible(env.access, 'reaction')]
  for (const loc of tried) {
    if (!loc || !locationSupports(loc, activity)) continue
    const structures = able(loc)
    if (structures.length) return { location: loc, structures, fallback: loc !== location }
  }
  return null
}

/** 从顶层产品展开；seed.place 是顶层已经定好的地点和候选建筑 */
export function expand(
  env: ChainEnv, seed: { item: ItemInfo; activity: IndustryActivity; bp: BlueprintActivity; place: Place },
): Expansion {
  const { host, options } = env
  const { industry } = host.data
  const nodes = new Map<TypeId, PlanNode>()
  const closure = new Set<TypeId>([seed.item.typeId])
  const warnings = new Set<string>()
  const post: TypeId[] = []
  const stack = new Set<TypeId>()
  const places = new Map<string, Place | null>()

  const place = (item: ItemInfo, activity: IndustryActivity): Place | null => {
    const key = `${activity}:${item.groupId}:${item.categoryId}`
    if (!places.has(key)) places.set(key, placeFor(env, item, activity))
    return places.get(key)!
  }

  const alchemyPlan = (node: PlanNode): AlchemyPlan | undefined => {
    if (options.alchemy === 'normal' || !industry.reprocessing || !node.place.location) return undefined
    const id = node.item.typeId
    const infos = [...industry.reprocessing.values()]
    const info = infos.find((i) => i.main === id)
    if (!info) {
      if (infos.some((i) => i.main === null && i.materials.some((m) => m.typeId === id))) {
        warnings.add(`${nameOf(node.item)} 的提炼数据不完整（找不到主产物），炼金暂不计算`)
      }
      return undefined
    }
    if (info.skill !== null) {
      warnings.add(`${nameOf(node.item)} 在数据里有专用提炼技能，炼金暂不计算`)
      return undefined
    }
    const bp = industry.reactions.get(info.id)
    const unrefined = itemOf(host, info.id)
    const loc = node.place.location
    const structures = node.place.structures.filter((s) => canBuild(s, loc, unrefined, 'reaction', industry).ok)
    if (!bp || !structures.length) return undefined
    for (const m of info.materials) closure.add(m.typeId)
    return { info, unrefined, bp, structures, edges: bp.materials.map((m) => edge(unrefined, m.typeId)) }
  }

  const visit = (item: ItemInfo, layer: ChainNode['layer'], activity: IndustryActivity, bp: BlueprintActivity, found: Place) => {
    const node: PlanNode = { item, layer, activity, bp, perRun: bp.products.find((p) => p.typeId === item.typeId)?.quantity ?? 1, place: found, edges: [] }
    nodes.set(item.typeId, node)
    stack.add(item.typeId)
    node.edges = bp.materials.map((m) => edge(item, m.typeId))
    if (layer === 'reaction1') node.alchemy = alchemyPlan(node)
    stack.delete(item.typeId)
    post.push(item.typeId)
  }

  function edge(consumer: ItemInfo, typeId: TypeId): PlanEdge {
    closure.add(typeId)
    const item = itemOf(host, typeId)
    const layer = classifyMaterial(item, consumer, industry)
    if (layer === 'raw') return { typeId, node: false, kind: 'raw' }
    if (options.layers[layer] === 'buy') {
      // 这一层选了买；记下它能不能造，「继续拆」才知道要改哪几层
      const buildable = (activityOf(layer) === 'reaction' ? industry.reactions : industry.manufacturing).has(typeId) && !!place(item, activityOf(layer))
      return buildable ? { typeId, node: false, kind: 'bought', layer } : { typeId, node: false, kind: 'bought' }
    }
    if (stack.has(typeId)) {
      warnings.add(`${nameOf(item)} 的配方绕回了自己，这一项改成直接买`)
      return { typeId, node: false, kind: 'bought' }
    }
    if (nodes.has(typeId)) return { typeId, node: true }
    const activity = activityOf(layer)
    const found = place(item, activity)
    if (!found) {
      warnings.add(activity === 'reaction'
        ? `没有能做 ${nameOf(item)} 的反应建筑，改成直接买`
        : `${env.location ? `${env.location.name} ` : ''}造不了 ${nameOf(item)}，改成直接买`)
      return { typeId, node: false, kind: 'unbuildable' }
    }
    visit(item, layer, activity, (activity === 'reaction' ? industry.reactions : industry.manufacturing).get(typeId)!, found)
    return { typeId, node: true }
  }

  visit(seed.item, 'product', seed.activity, seed.bp, seed.place)
  return { nodes, order: post.reverse(), closure, warnings: [...warnings] }
}
