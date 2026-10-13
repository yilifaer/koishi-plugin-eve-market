// 拆到原料的测试共用：用小数据集里的真实物品当角色，地点、建筑名都是编造的，星系用公共星系（NIH-02 是 00，Tama 低安）。

import { expect } from 'vitest'
import type { ChainRequest, ChainResult, CoreFailure, DataSet, IndustryStep, ReprocessInfo, TypeId } from '../../../../src/core/types'
import { isFailure } from '../../../../src/core/types'
import { loadFixtureData } from '../../../fixtures/data/load'
import { ALLOWED, FakeIndices, FakePrices, JITA_KEY, makeService } from '../service-fakes'

export const NIH_02 = 30000900
export const TAMA = 30002813

export const LOCATIONS = [
  { name: '星点甲', system: 'NIH-02', visibility: 'public', isDefault: true },
  { name: '星点乙', system: 'Tama', visibility: 'public' },
]
export const STRUCTURES = [
  { location: '星点甲', name: '甲莱塔卢', structureType: 'Raitaru', facilityTaxPct: 1 },
  { location: '星点甲', name: '甲反应堆', structureType: 'Athanor', activities: 'reaction', facilityTaxPct: 1, reactionTaxPct: 2 },
  { location: '星点乙', name: '乙塔塔拉', structureType: 'Tatara', activities: 'reaction', reactionTaxPct: 3 },
]

/** 没单独定价的物品按这个价（每种略有不同，免得合计恰好相等） */
export const flat = (id: TypeId) => 100 + (id % 17)

/** 按物品给价；没写的用 flat；omit 里的没有挂单 */
export class ChainPrices extends FakePrices {
  omit = new Set<TypeId>()
  opts: Array<{ deadlineMs?: number } | undefined> = []
  constructor(private readonly table: Record<number, number> = {}) { super() }

  override async getQuotes(marketKey: string, items: Array<{ typeId: TypeId; qty: number }>, opts?: { deadlineMs?: number }) {
    this.opts.push(opts)
    this.set(marketKey, Object.fromEntries(items.filter((i) => !this.omit.has(i.typeId)).map((i) => [i.typeId, this.table[i.typeId] ?? flat(i.typeId)])))
    return super.getQuotes(marketKey, items)
  }
}

/** 数据里所有配方的材料都给一个调整价，安装费才算得出 */
export function adjustedFor(data: DataSet): Record<number, number> {
  const out: Record<number, number> = {}
  for (const bp of [...data.industry.manufacturing.values(), ...data.industry.reactions.values()]) {
    for (const m of bp.materials) out[m.typeId] = 50 + (m.typeId % 13)
  }
  return out
}

/** 给小数据集换（或加）几个配方：材料写成 [物品, 数量]；制造蓝图没有时按每流程出 1 个补一张 */
export function withRecipes(
  base: DataSet, edits: { manufacturing?: Record<number, Array<[number, number]>>; reactions?: Record<number, Array<[number, number]>> },
): DataSet {
  const manufacturing = new Map(base.industry.manufacturing)
  const reactions = new Map(base.industry.reactions)
  const apply = (map: typeof manufacturing, activity: 'm' | 'r', list: Record<number, Array<[number, number]>> = {}) => {
    for (const [id, materials] of Object.entries(list)) {
      const typeId = Number(id)
      const old = map.get(typeId)
      map.set(typeId, {
        blueprintId: 91000 + typeId, activity, time: 3600, maxRuns: 100, products: [{ typeId, quantity: 1 }], ...old,
        materials: materials.map(([t, quantity]) => ({ typeId: t, quantity })),
      })
    }
  }
  apply(manufacturing, 'm', edits.manufacturing)
  apply(reactions, 'r', edits.reactions)
  return { ...base, industry: { ...base.industry, manufacturing, reactions } }
}

/** 改提炼表里的一行 */
export function withReprocessing(base: DataSet, id: number, edit: (row: ReprocessInfo) => ReprocessInfo): DataSet {
  const reprocessing = new Map(base.industry.reprocessing)
  reprocessing.set(id, edit(reprocessing.get(id)!))
  return { ...base, industry: { ...base.industry, reprocessing } }
}

export interface SetupOptions {
  industry?: Record<string, unknown>
  data?: DataSet
  prices?: ChainPrices
}

export function setup(opts: SetupOptions = {}) {
  const data = opts.data ?? loadFixtureData()
  const prices = opts.prices ?? new ChainPrices()
  const indices = new FakeIndices({
    systems: { [NIH_02]: { manufacturing: 0.02, reaction: 0.03 }, [TAMA]: { manufacturing: 0.01, reaction: 0.01 } },
    adjusted: adjustedFor(data),
  })
  const env = makeService({ industry: { locations: LOCATIONS, structures: STRUCTURES, ...opts.industry } }, { prices, indices, data })
  expect(env.issues.filter((i) => i.section === 'industry')).toEqual([])
  const req = (typeId: number, chain: ChainRequest['chain'] = { on: true }, extra: Partial<ChainRequest> = {}): ChainRequest => ({
    typeId, activity: 'manufacturing', mode: 'advanced', materials: false, access: ALLOWED, location: '星点甲', me: 2, te: 4, chain, ...extra,
  })
  return { ...env, prices, indices, data, req, run: (typeId: number, chain?: ChainRequest['chain'], extra?: Partial<ChainRequest>) => env.service.chain(req(typeId, chain, extra)) }
}

export function chainResult(r: ChainResult | IndustryStep | CoreFailure): ChainResult {
  if (isFailure(r)) throw new Error(`应该出结果，实际是 ${r.code}（${r.message ?? r.reason ?? ''}）`)
  if ('step' in r) throw new Error(`应该出结果，实际是第「${r.step}」步`)
  return r
}
