// core/universe 对外的接口：中英对照（§2.13）、星图名字（数据优先，ESI 兜底）、安全等级分类。

export { createUniverseService } from './service'
export type { ManagedUniverseService, UniverseServiceOptions } from './service'
export { secClassOf, UniverseNames } from './names'
export type { NameKind, NamesEsi, UniverseNamesDeps } from './names'
