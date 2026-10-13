// 拆到原料的顶层：成品用哪个地点、ME/TE、建筑，规则同 service.located()，但不取价。
// 建筑没写且有 2 座以上能造时 structure 是 undefined，由引擎取价后在这些建筑里挑。
// 缺参数、写错的建筑这类要问用户的情况返回 'ask'，由 service 交给 located() 出下一步。

import type {
  Access, BlueprintActivity, ChainRequest, CoreFailure, DataSet, IndustryActivity, ItemInfo, ServiceInfo,
} from '../../types'
import { canBuild, locationCanBuild } from '../capabilities'
import { findStructure } from '../locations'
import type { IndustryLocation, IndustryLocations, IndustryStructure } from '../locations'

/** 顶层产品（service 里的 Job 的一部分） */
export interface TopJob {
  data: Pick<DataSet, 'industry'>
  activity: IndustryActivity
  product: ItemInfo
  blueprint: ItemInfo
  bp: BlueprintActivity
  perRun: number
  runs: number
  t2: boolean
  access: Access
}

/** service 里有、这里要用的几个私有方法 */
export interface TopHelpers {
  locations: Pick<IndustryLocations, 'buildable' | 'defaultLocation'>
  findLocation(token: string): IndustryLocation | CoreFailure
  cannotBuildHere(location: IndustryLocation, need: readonly ServiceInfo[]): CoreFailure
  meTe(location: IndustryLocation): { me: number; te: number }
}

export interface ChainTop {
  item: ItemInfo
  activity: IndustryActivity
  bp: BlueprintActivity
  blueprint: ItemInfo
  perRun: number
  runs: number
  t2: boolean
  /** 成品要几个（写了数量就是数量，否则是流程 × 每流程产出） */
  demand: number
  /** null = 没有地点（基础模式） */
  location: IndustryLocation | null
  /** 固定用这座（null = 没有建筑加成）；undefined = 在能造的里挑 */
  structure?: IndustryStructure | null
  me: number
  te: number
  rigs: 'default' | 'none'
  /** 命令里的税，只用于成品这一步 */
  tax?: number
}

export function resolveTop(job: TopJob, req: ChainRequest, h: TopHelpers): ChainTop | CoreFailure | 'ask' {
  const { activity, product } = job
  const manufacturing = activity === 'manufacturing'
  const { industry } = job.data
  const top: Omit<ChainTop, 'location' | 'me' | 'te' | 'rigs'> = {
    item: product, activity, bp: job.bp, blueprint: job.blueprint, perRun: job.perRun, runs: job.runs, t2: job.t2,
    demand: req.runs === undefined && req.quantity !== undefined ? req.quantity : job.runs * job.perRun,
  }
  if (req.facilityTaxPct !== undefined) top.tax = req.facilityTaxPct

  // 基础模式：没有地点，整条链按没有建筑加成算（ME/TE 写了才算）
  if (req.mode === 'base') {
    return { ...top, location: null, structure: null, rigs: 'none', me: manufacturing ? req.me ?? 0 : 0, te: manufacturing ? req.te ?? 0 : 0 }
  }

  let location: IndustryLocation | undefined
  if (req.location !== undefined) {
    const found = h.findLocation(req.location)
    if ('ok' in found) return found
    const verdict = locationCanBuild(found, product, activity, industry)
    if (!verdict.ok) return h.cannotBuildHere(found, verdict.need)
    location = found
  } else {
    const list = h.locations.buildable(job.access, activity, product).usable
    const fallback = h.locations.defaultLocation(job.access, activity)
    location = list.length === 1 ? list[0] : fallback && list.includes(fallback) ? fallback : undefined
  }
  if (!location || (manufacturing && req.meteMissing) || req.structure === '?') return 'ask'

  const out: ChainTop = { ...top, location, ...h.meTe(location), rigs: req.rigs ?? 'default' }
  if (req.structure === 'none') {
    if (!manufacturing || !canBuild(null, location, product, activity, industry).ok) return 'ask'
    out.structure = null
  } else if (req.structure !== undefined) {
    const found = findStructure(location, req.structure, activity)
    if (!found || !canBuild(found, location, product, activity, industry).ok) return 'ask'
    out.structure = found
  }
  return out
}
