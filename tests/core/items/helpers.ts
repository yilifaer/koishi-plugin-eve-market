// core/items 测试共用：小数据集或完整快照上的识别器，以及新物品兜底用的假 ESI、内存 BlobCache、手动时钟。

import { createItemResolver } from '../../../src/core/items'
import type { ManagedItemResolver, RemoteDeps, RemoteEsi } from '../../../src/core/items'
import type { EsiIds, EsiResult, EsiType } from '../../../src/core/esi'
import { createModuleStore } from '../../../src/core/ports'
import type { BlobCache, Clock } from '../../../src/core/ports'
import type { DataSet, GlossaryData, ItemAliasSetting, ItemInfo, Resolution } from '../../../src/core/types'
import { loadFixtureData, loadFixtureGlossary, loadSnapshotData, loadSnapshotGlossary, staticDataService } from '../../fixtures/data/load'

export interface ResolverSetup {
  aliases?: ItemAliasSetting[]
  glossary?: GlossaryData | null
  data?: DataSet
  remote?: RemoteDeps
  useGlossary?: boolean
}

export function fixtureResolver(setup: ResolverSetup = {}): ManagedItemResolver {
  const data = setup.data ?? loadFixtureData()
  const glossary = setup.glossary === undefined ? loadFixtureGlossary() : setup.glossary
  return createItemResolver({
    data: staticDataService(data, glossary),
    store: createModuleStore(),
    aliases: setup.aliases ?? [],
    remote: setup.remote,
    useGlossary: setup.useGlossary,
  })
}

let snapshot: ManagedItemResolver | undefined

/** 完整快照上的识别器（同一个测试文件里只建一次） */
export function snapshotResolver(): ManagedItemResolver {
  snapshot ??= fixtureResolver({ data: loadSnapshotData(), glossary: loadSnapshotGlossary() })
  return snapshot
}

/** 结果里的物品只看英文名，断言好写 */
export const ens = (items: readonly ItemInfo[]) => items.map((i) => i.en)

export function uniqueOf(r: Resolution) {
  if (r.kind !== 'unique') throw new Error(`应该唯一命中，实际是 ${r.kind}`)
  return r
}

export function listOf(r: Resolution): { candidates: ItemInfo[]; total: number } {
  if (r.kind === 'ambiguous' || r.kind === 'confirm' || r.kind === 'group') return r
  throw new Error(`应该列候选，实际是 ${r.kind}`)
}

// ------------------------------------------------------------------ 新物品兜底

export class ManualClock implements Clock {
  constructor(public t = Date.UTC(2026, 9, 7, 6, 20)) {}
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

export class MemoryBlobCache implements BlobCache {
  readonly entries = new Map<string, { body: Buffer; meta: Record<string, unknown> }>()

  async read(key: string) {
    const entry = this.entries.get(key)
    return entry ? { body: Buffer.from(entry.body), meta: { ...entry.meta } } : null
  }

  async write(key: string, body: Buffer, meta: Record<string, unknown>) {
    this.entries.set(key, { body: Buffer.from(body), meta: { ...meta } })
  }

  async remove(key: string) {
    this.entries.delete(key)
  }
}

const EMPTY_IDS: EsiIds = {
  agents: [], alliances: [], characters: [], constellations: [], corporations: [], factions: [],
  inventoryTypes: [], regions: [], stations: [], systems: [],
}

function result<T>(value: T): EsiResult<T> {
  return { value, lastModified: null, expiresAt: 0, validatedAt: 0, cached: false, stale: false }
}

/** 编造的新物品：名字 → typeID（按语言），typeID → /universe/types 的内容 */
export class FakeRemoteEsi implements RemoteEsi {
  readonly calls: string[] = []
  readonly names = new Map<string, number>()
  readonly types = new Map<number, EsiType>()
  fail = false
  /** 给了就等它（ESI 卡住） */
  hold?: Promise<void>

  add(type: EsiType, names: { en: string; zh?: string }) {
    this.types.set(type.typeId, type)
    this.names.set(`en:${names.en.toLowerCase()}`, type.typeId)
    if (names.zh) this.names.set(`zh:${names.zh}`, type.typeId)
  }

  async ids(names: readonly string[], language: 'en' | 'zh'): Promise<EsiResult<EsiIds>> {
    this.calls.push(`ids ${language} ${names.join(',')}`)
    await (this.hold ?? Promise.resolve())
    if (this.fail) throw new Error('ESI 不可用')
    const name = names[0]
    const id = this.names.get(`${language}:${language === 'en' ? name.toLowerCase() : name}`)
    return result(id === undefined ? EMPTY_IDS : { ...EMPTY_IDS, inventoryTypes: [{ id, name }] })
  }

  async type(typeId: number): Promise<EsiResult<EsiType>> {
    this.calls.push(`type ${typeId}`)
    const type = this.types.get(typeId)
    if (!type) throw new Error(`没有 ${typeId}`)
    return result(type)
  }
}

export function esiType(over: Partial<EsiType> & Pick<EsiType, 'typeId' | 'name'>): EsiType {
  return {
    groupId: 27,
    marketGroupId: 80,
    published: true,
    volume: 486000,
    packagedVolume: 50000,
    capacity: 800,
    portionSize: 1,
    ...over,
  }
}
