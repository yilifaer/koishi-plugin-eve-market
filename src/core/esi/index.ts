// core/esi 对外的接口：通用客户端（缓存、限流、分页、并发）和用到的路由的类型化封装。

import { EsiClient } from './client'
import type { EsiClientOptions, EsiPorts } from './client'
import { EsiApi } from './routes'

export {
  ESI_CACHE_MAX_BYTES,
  ESI_MAX_PAGES,
  ESI_MAX_RESPONSE_BYTES,
  ESI_META_KEY,
  ESI_STORE_KEY,
  EsiClient,
  userAgent,
} from './client'
export type {
  EsiAuth,
  EsiCallOptions,
  EsiClientOptions,
  EsiLanguage,
  EsiPagedResult,
  EsiPorts,
  EsiRequest,
  EsiResult,
} from './client'
export { MemoryResponseCache } from './cache'
export type { EsiCacheEntry, EsiCacheStore } from './cache'
export { EsiError, isEsiError } from './errors'
export type { EsiErrorKind } from './errors'
export { freshUntil, parseHttpDate, parseRateLimit, parseRetryAfter } from './headers'
export { EsiLimits, KNOWN_GROUPS, createLimitState, tokenCost } from './ratelimit'
export type { EsiLane, LimitState } from './ratelimit'
export {
  EsiApi,
  INDUSTRY_ACTIVITIES,
  MAX_IDS_NAMES,
  MAX_NAMES_IDS,
  parseAlliance,
  parseCharacter,
  parseCharacterSearch,
  parseCorpHistory,
  parseCorporation,
  parseHistory,
  parseIds,
  parseIncursions,
  parseIndustrySystems,
  parseKillmail,
  parseNames,
  parsePrices,
  parseRegionOrders,
  parseServerStatus,
  parseStation,
  parseStructureInfo,
  parseStructureOrders,
  parseStructureSearch,
  parseType,
} from './routes'
export type {
  AuthedOptions,
  EsiAlliance,
  EsiCharacter,
  EsiCorpHistoryRecord,
  EsiCorporation,
  EsiHistoryDay,
  EsiIdName,
  EsiIds,
  EsiIncursion,
  EsiIndustryActivity,
  EsiIndustrySystem,
  EsiKillAttacker,
  EsiKillParty,
  EsiKillmail,
  EsiMarketPrice,
  EsiName,
  EsiNameCategory,
  EsiOrder,
  EsiRegionOrder,
  EsiServerStatus,
  EsiStation,
  EsiStructureInfo,
  EsiStructureOrder,
  EsiType,
  OrderRange,
} from './routes'
export { ShapeError } from './shape'

/** 建一个客户端和它上面的路由封装 */
export function createEsi(ports: EsiPorts, options: EsiClientOptions = {}): EsiApi {
  return new EsiApi(new EsiClient(ports, options))
}
