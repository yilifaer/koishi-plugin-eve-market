// 拆到原料（§7）：展开、取价、聚合需求、挑建筑、炼金。入口是 runChain，由 IndustryService.chain() 调用。

export { runChain, mergeOptions } from './engine'
export { resolveTop } from './top'
export type { ChainTop, TopHelpers, TopJob } from './top'
export type { ChainHost } from './expand'
export { classifyMaterial } from './layers'
