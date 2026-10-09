// 「入侵」（§2.9、§6.9）：ESI /incursions + 数据里的中英文名。
// - 星座、星域、星系、势力的名字和安全等级只从数据（universe.json）取，不调用 /universe/names；数据里缺的 ID 显示 ID 本身；
// - 按集结星系的安全等级分类排序：高安 → 低安 → 00；同一类里安全等级高的在前；
// - 缓存时间以 ESI 的过期头为准（约 5 分钟），出错时最多用 60 分钟内的缓存（见 core/esi 的路由）；
//   请求失败的结果记 FAILURE_MEMO_SEC 秒，免得 ESI 出问题时每个人都再打一次。

import { FAILURE_MEMO_SEC, QUERY_DEADLINE_MS } from '../../constants'
import { DataNotReadyError } from '../data'
import { isEsiError } from '../esi'
import type { EsiApi, EsiIncursion } from '../esi'
import type { Clock, Logger } from '../ports'
import type { CoreFailure, DataService, DataSet, Incursion, IncursionsResult, NamePair, SecClass } from '../types'
import { FailureMemo, describeError } from '../util'
import { secClassOf } from './names'

export type IncursionsEsi = Pick<EsiApi, 'incursions'>

export interface IncursionsOptions {
  esi: IncursionsEsi
  data: Pick<DataService, 'current'>
  clock: Clock
  logger?: Logger
  /** 默认 QUERY_DEADLINE_MS */
  deadlineMs?: number
}

const CLASS_ORDER: Record<SecClass, number> = { high: 0, low: 1, null: 2 }

type SystemPair = NamePair & { security: number }

function pairOf(id: number, info: { en: string; zh: string } | undefined): NamePair {
  return info ? { id, en: info.en, zh: info.zh } : { id, en: String(id), zh: '' }
}

function systemOf(data: DataSet, id: number): SystemPair {
  const info = data.universe.systems.get(id)
  return info ? { id, en: info.en, zh: info.zh, security: info.security } : { id, en: String(id), zh: '', security: Number.NaN }
}

/** 集结星系的分类；它不在数据里时看其他被入侵星系，再不行看星域（虫洞、波赫文） */
function classOf(data: DataSet, staging: SystemPair, systems: readonly SystemPair[], regionId: number | undefined): SecClass {
  const known = [staging, ...systems].find((s) => Number.isFinite(s.security))
  if (!known) return secClassOf(0, regionId)
  return secClassOf(known.security, data.universe.systems.get(known.id)?.regionId ?? regionId)
}

/** ESI 的一条 → 带名字的一处入侵 */
export function describeIncursion(data: DataSet, raw: EsiIncursion): Incursion {
  const constellation = data.universe.constellations.get(raw.constellationId)
  const regionId = constellation?.regionId
  const staging = systemOf(data, raw.stagingSystemId)
  const others = raw.infestedSystems.filter((id, i, all) => id !== raw.stagingSystemId && all.indexOf(id) === i).map((id) => systemOf(data, id))
  const infested = raw.infestedSystems.includes(raw.stagingSystemId) ? [staging, ...others] : others
  return {
    constellation: pairOf(raw.constellationId, constellation),
    region: regionId === undefined ? null : pairOf(regionId, data.universe.regions.get(regionId)),
    staging,
    secClass: classOf(data, staging, infested, regionId),
    state: raw.state,
    influence: Number.isFinite(raw.influence) ? Math.min(1, Math.max(0, raw.influence)) : 0,
    hasBoss: raw.hasBoss,
    faction: pairOf(raw.factionId, data.universe.factions.get(raw.factionId)),
    systems: infested,
  }
}

/** 高安 → 低安 → 00；同一类里集结星系安全等级高的在前（不知道的放后面），再按星座 ID */
export function compareIncursions(a: Incursion, b: Incursion): number {
  const sec = (i: Incursion) => (i.staging && Number.isFinite(i.staging.security) ? i.staging.security : -Infinity)
  return CLASS_ORDER[a.secClass] - CLASS_ORDER[b.secClass] || sec(b) - sec(a) || a.constellation.id - b.constellation.id
}

export class IncursionsSource {
  private readonly failures: FailureMemo<CoreFailure>

  constructor(private readonly options: IncursionsOptions) {
    this.failures = new FailureMemo(options.clock, FAILURE_MEMO_SEC * 1000)
  }

  async get(): Promise<IncursionsResult | CoreFailure> {
    const data = this.dataSet()
    if (!data) return { ok: false, code: 'DATA_NOT_READY', message: '物品和星图数据还没加载好' }
    const remembered = this.failures.get()
    if (remembered) return remembered
    try {
      const result = await this.options.esi.incursions({ deadlineMs: this.options.deadlineMs ?? QUERY_DEADLINE_MS })
      this.failures.clear()
      return {
        incursions: result.value.map((raw) => describeIncursion(data, raw)).sort(compareIncursions),
        dataTime: result.lastModified ?? result.validatedAt,
        stale: result.stale,
      }
    } catch (e) {
      const detail = describeError(e)
      this.options.logger?.debug(`入侵取不到：${detail}`)
      // 调用方自己的时限到了（请求还在后台继续）不算失败，不记
      return this.failures.remember({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: detail }, !(isEsiError(e) && e.abandoned))
    }
  }

  private dataSet(): DataSet | undefined {
    try {
      return this.options.data.current()
    } catch (e) {
      if (e instanceof DataNotReadyError) return undefined
      throw e
    }
  }
}

export function createIncursions(options: IncursionsOptions): IncursionsSource {
  return new IncursionsSource(options)
}
