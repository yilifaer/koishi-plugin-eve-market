// core/data 对外的接口：数据服务、按版本缓存派生结构、给测试和脚本用的读取函数。

export { createDataService, DataNotReadyError, DATA_STORE_KEY } from './service'
export type { DataPorts, DataServiceOptions, ManagedDataService } from './service'
export { memoByKey } from './memo'
export { checkShrink, loadDataSet, tableCounts, verifyFiles } from './dataset'
export type { DataFiles } from './dataset'
export { checkGlossarySize, glossaryKey, parseGlossary } from './glossary'
export type { ParsedGlossary } from './glossary'
export { compareVersion, DataError, dataKey, parseManifest, sha256 } from './shapes'
export type { DataErrorKind, DataFileName } from './shapes'
export { CACHE_KEYS, GLOSSARY_FILE, readBundledFiles, readBundledGlossary, readBundledManifest } from './source'
