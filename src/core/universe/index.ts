// core/universe 对外的接口：中英对照（§2.13）、星图名字（数据优先，ESI 兜底）、安全等级分类、
// 入侵（§2.9）、服务器状态（§2.12）、势力图（§2.10）。

export { createUniverseService } from './service'
export type { ManagedUniverseService, UniverseServiceOptions } from './service'
export { secClassOf, UniverseNames } from './names'
export type { NameKind, NamesEsi, UniverseNamesDeps } from './names'
export { compareIncursions, createIncursions, describeIncursion } from './incursions'
export type { IncursionsEsi, IncursionsOptions, IncursionsSource } from './incursions'
export { createServerStatus, nextDowntime } from './status'
export type { ServerStatusOptions, ServerStatusSource, StatusEsi } from './status'
export { MAP_KINDS, createInfluenceMaps, mapCacheKey } from './maps'
export type { InfluenceMapsOptions, ManagedInfluenceMaps } from './maps'
export { BR_HOST, findBrLink, mentionsBrHost, parseBrLink } from './br-link'
export type { BrLink, BrLinkKind } from './br-link'
