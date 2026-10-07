// 星域、星座、星系、势力的中英文名：数据（universe.json）优先；数据里没有的 ID 用 ESI /universe/names 补英文名，
// 补到的缓存 7 天；ESI 也没有或出错时名字就写 ID 本身（§6.9：数据里万一缺某个 ID 就显示这个 ID）。

import { REMOTE_ITEM_CACHE_DAYS } from '../../constants'
import { DataNotReadyError } from '../data'
import { MAX_NAMES_IDS } from '../esi'
import type { EsiApi, EsiNameCategory } from '../esi'
import type { Clock, Logger } from '../ports'
import type { DataService, DataSet, NamePair, SecClass, SystemInfo, SystemView } from '../types'
import { describeError, LruCache } from '../util'

export type NameKind = 'region' | 'constellation' | 'system' | 'faction'

/** 用到的 ESI 路由（core/esi 的封装，测试里换成假的） */
export type NamesEsi = Pick<EsiApi, 'names'>

export interface UniverseNamesDeps {
  data: Pick<DataService, 'current'>
  clock: Clock
  /** 不给时只用数据 */
  esi?: NamesEsi
  logger?: Logger
}

const ESI_CATEGORY: Record<NameKind, EsiNameCategory> = {
  region: 'region',
  constellation: 'constellation',
  system: 'solar_system',
  faction: 'faction',
}

const DAY = 24 * 3600 * 1000
const REMOTE_MAX = 2000
/** 虫洞星域从这个 ID 开始；波赫文（Pochven）也按 00 算（§6.7.3） */
const WORMHOLE_REGION_FROM = 11_000_000
const POCHVEN_REGION = 10_000_070

/** 高安 ≥ 0.45；低安 > 0；其余（含虫洞和波赫文）00。按真实安全等级分，显示时另外取整 */
export function secClassOf(security: number, regionId?: number): SecClass {
  if (regionId !== undefined && (regionId >= WORMHOLE_REGION_FROM || regionId === POCHVEN_REGION)) return 'null'
  if (security >= 0.45) return 'high'
  return security > 0 ? 'low' : 'null'
}

function pair(id: number, info: { en: string; zh: string } | undefined): NamePair | undefined {
  return info ? { id, en: info.en, zh: info.zh } : undefined
}

export class UniverseNames {
  private readonly remote: LruCache<string, string>

  constructor(private readonly deps: UniverseNamesDeps) {
    this.remote = new LruCache({ max: REMOTE_MAX, ttlMs: REMOTE_ITEM_CACHE_DAYS * DAY, now: () => deps.clock.now() })
  }

  /** 数据里的名字；数据还没加载好或者没有这个 ID 时 undefined */
  known(kind: NameKind, id: number): NamePair | undefined {
    const data = this.dataSet()
    if (!data) return undefined
    const { universe } = data
    switch (kind) {
      case 'region':
        return pair(id, universe.regions.get(id))
      case 'constellation':
        return pair(id, universe.constellations.get(id))
      case 'system':
        return pair(id, universe.systems.get(id))
      case 'faction':
        return pair(id, universe.factions.get(id))
    }
  }

  system(id: number): SystemView | undefined {
    const info = this.dataSet()?.universe.systems.get(id)
    return info ? this.view(info) : undefined
  }

  /** 每个 ID 都有结果：数据 → ESI 补的英文名（中文名为空）→ ID 本身 */
  async lookup(kind: NameKind, ids: readonly number[]): Promise<Map<number, NamePair>> {
    const out = new Map<number, NamePair>()
    const missing: number[] = []
    for (const id of new Set(ids)) {
      const found = this.known(kind, id) ?? this.cached(kind, id)
      if (found) out.set(id, found)
      else missing.push(id)
    }
    if (missing.length) await this.fetch(kind, missing)
    for (const id of missing) out.set(id, this.cached(kind, id) ?? { id, en: String(id), zh: '' })
    return out
  }

  // ---------------------------------------------------------------- 内部

  private dataSet(): DataSet | undefined {
    try {
      return this.deps.data.current()
    } catch (e) {
      if (e instanceof DataNotReadyError) return undefined
      throw e
    }
  }

  private view(info: SystemInfo): SystemView {
    return {
      id: info.id,
      en: info.en,
      zh: info.zh,
      security: info.security,
      secClass: secClassOf(info.security, info.regionId),
      constellation: this.known('constellation', info.constellationId) ?? null,
      region: this.known('region', info.regionId) ?? null,
    }
  }

  private cached(kind: NameKind, id: number): NamePair | undefined {
    const en = this.remote.get(`${kind}:${id}`)
    return en === undefined ? undefined : { id, en, zh: '' }
  }

  /** ESI 只给英文名；分类对不上的不收。出错时不缓存，下次再试 */
  private async fetch(kind: NameKind, ids: number[]): Promise<void> {
    const { esi, logger } = this.deps
    const valid = ids.filter((id) => Number.isSafeInteger(id) && id > 0)
    if (!esi || !valid.length) return
    for (let at = 0; at < valid.length; at += MAX_NAMES_IDS) {
      try {
        const { value } = await esi.names(valid.slice(at, at + MAX_NAMES_IDS))
        for (const hit of value) {
          if (hit.category === ESI_CATEGORY[kind]) this.remote.set(`${kind}:${hit.id}`, hit.name)
        }
      } catch (e) {
        logger?.debug('星图名字：ESI 查询失败，显示 ID：%s', describeError(e))
      }
    }
  }
}
