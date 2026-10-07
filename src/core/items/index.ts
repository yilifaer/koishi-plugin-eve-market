// core/items 对外的接口：物品识别（§6.1）、搜索、相关物品、名字；新物品兜底。

export { createItemResolver } from './resolver'
export type { ItemReport, ItemResolverOptions, ManagedItemResolver } from './resolver'
export type { GlossaryReport } from './aliases'
export type { RemoteDeps, RemoteEsi } from './remote'
export { looksLikeFullName } from './remote'
export { nameKey, normalizeName, tokensOf } from './normalize'
