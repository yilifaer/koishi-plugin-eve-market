// 测试用的数据。两份：
// - 小数据集（本目录，由 scripts/make-fixture.mjs 从快照抽出来）：Raven、矿物、PLEX、几个植入体套装、T2 装备、
//   护盾扩展装置小中大、涂装、蓝图和反应、五个交易中心、代号星系、势力；格式和在线数据完全一样。
// - 插件自带的完整快照（data/）：回归用例和耗时测试用，第一次用到时才读，同一个测试文件里只读一次。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { DATA_FILES } from '../../../src/constants'
import { loadDataSet, parseGlossary, parseManifest } from '../../../src/core/data'
import type { DataFileName } from '../../../src/core/data'
import type { DataManifest, DataService, DataSet, DataStatus, GlossaryData, ItemInfo } from '../../../src/core/types'

export const FIXTURE_DIR = __dirname
export const SNAPSHOT_DIR = path.resolve(__dirname, '../../../data')
/** 加载时间固定，结果可以直接比较 */
export const FIXTURE_LOADED_AT = Date.UTC(2026, 9, 7, 6, 0)

export interface RawDataFiles {
  manifestBody: Buffer
  manifest: DataManifest
  files: Record<DataFileName, Buffer>
  glossary: Buffer
}

function readRaw(dir: string, read: (name: string) => Buffer): RawDataFiles {
  const manifestBody = fs.readFileSync(path.join(dir, 'manifest.json'))
  const files = {} as Record<DataFileName, Buffer>
  for (const name of DATA_FILES) files[name] = read(name)
  return { manifestBody, manifest: parseManifest(manifestBody), files, glossary: read('glossary.yaml') }
}

/** 小数据集的原始文件（manifest、三个数据文件、黑话表） */
export function fixtureFiles(): RawDataFiles {
  return readRaw(FIXTURE_DIR, (name) => fs.readFileSync(path.join(FIXTURE_DIR, name)))
}

/** 完整快照解压后的原始文件 */
export function snapshotFiles(): RawDataFiles {
  return readRaw(SNAPSHOT_DIR, (name) => zlib.gunzipSync(fs.readFileSync(path.join(SNAPSHOT_DIR, `${name}.gz`))))
}

let fixtureData: DataSet | undefined
let fixtureGlossary: GlossaryData | undefined
let snapshotData: DataSet | undefined
let snapshotGlossary: GlossaryData | undefined

export function loadFixtureData(): DataSet {
  if (!fixtureData) {
    const raw = fixtureFiles()
    fixtureData = loadDataSet(raw.manifest, raw.files, 'bundled', FIXTURE_LOADED_AT)
  }
  return fixtureData
}

export function loadFixtureGlossary(): GlossaryData {
  fixtureGlossary ??= parseGlossary(fixtureFiles().glossary, 'bundled', FIXTURE_LOADED_AT).data
  return fixtureGlossary
}

export function loadSnapshotData(): DataSet {
  if (!snapshotData) {
    const raw = snapshotFiles()
    snapshotData = loadDataSet(raw.manifest, raw.files, 'bundled', FIXTURE_LOADED_AT)
  }
  return snapshotData
}

export function loadSnapshotGlossary(): GlossaryData {
  snapshotGlossary ??= parseGlossary(snapshotFiles().glossary, 'bundled', FIXTURE_LOADED_AT).data
  return snapshotGlossary
}

/** 按英文名找物品（测试里用，找不到直接抛错） */
export function itemByName(data: DataSet, en: string) {
  for (let row = 0; row < data.types.size; row++) {
    if (data.types.en[row] === en) return data.types.item(row)
  }
  throw new Error(`数据里没有「${en}」`)
}

/**
 * 固定数据的 DataService（别的模块的单测用，不联网、不读文件）。update() 换一个版本并通知 onUpdate 的监听者，
 * 用来测「数据更新后重建索引、重新检查配置」
 */
/** 小数据集里能上市场、有中文名的前 n 种物品（按 typeID；不含涂装和 PLEX） */
export function marketItems(n: number): ItemInfo[] {
  const data = loadFixtureData()
  const out: ItemInfo[] = []
  for (let r = 0; r < data.types.size && out.length < n; r++) {
    const it = data.types.item(r)
    if (it.marketGroupId !== null && it.zh && !it.en.includes('SKIN') && it.typeId !== 44992) out.push(it)
  }
  if (out.length < n) throw new Error(`fixture 只有 ${out.length} 种`)
  return out
}

export function staticDataService(data: DataSet = loadFixtureData(), glossary: GlossaryData | null = loadFixtureGlossary()) {
  const listeners = new Set<(data: DataSet, glossary: GlossaryData | null) => void>()
  let current = data
  let currentGlossary = glossary
  const status = (): DataStatus => ({
    ready: true,
    origin: current.origin,
    buildNumber: current.manifest.buildNumber,
    dataRevision: current.manifest.dataRevision,
    sdeReleaseDate: current.manifest.sdeReleaseDate,
    generatedAt: current.manifest.generatedAt,
    ageDays: 0,
    lastCheckAt: null,
    lastConfirmedAt: null,
    lastError: '',
    glossary: { origin: currentGlossary?.origin ?? null, entries: currentGlossary?.entries.length ?? 0, lastConfirmedAt: null, lastError: '' },
  })
  const service: DataService & { update(data: DataSet, glossary?: GlossaryData | null): void } = {
    current: () => current,
    glossary: () => currentGlossary,
    status,
    refresh: async () => ({ changed: false, glossaryChanged: false, checked: false }),
    onUpdate(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(next, nextGlossary = currentGlossary) {
      current = next
      currentGlossary = nextGlossary
      for (const listener of listeners) listener(current, currentGlossary)
    },
  }
  return service
}
