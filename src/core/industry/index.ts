// core/industry 对外的接口（§6.7）：公式、修正、工业地点和建筑、星系成本指数和调整价、制造和反应的计算、多买清单。

export * from './compare'
export * from './formulas'
export * from './modifiers'
export {
  MAX_RIGS,
  createIndustryLocations,
  defaultStructure,
  findStructure,
  locationSupports,
  locationVisibleTo,
  structuresFor,
} from './locations'
export type { BuildableLocations, IndustryLocation, IndustryLocations, IndustryStructure, IndustrySystem } from './locations'
export {
  INDICES_REVALIDATE_WAIT_MS,
  INDICES_STORE_KEY,
  INDICES_WARM_DELAY_MS,
  INDICES_WARM_SPREAD_MS,
  adjustedTable,
  costIndexOf,
  createIndustryIndices,
  indicesTable,
} from './indices'
export type {
  AdjustedPrices,
  CostIndices,
  IndexFetchOptions,
  IndicesEsi,
  IndustryIndices,
  IndustryIndicesOptions,
  SystemIndices,
} from './indices'
export { STEP_INDICES_WAIT_MS, createIndustryService } from './service'
export type { IndustryServiceOptions } from './service'
export { classifyMaterial, mergeOptions, resolveTop, runChain } from './chain'
export type { ChainHost, ChainTop } from './chain'
export { chunkLines, multibuyBlocks, multibuyLines } from './multibuy'
export type { MultibuyOptions } from './multibuy'
