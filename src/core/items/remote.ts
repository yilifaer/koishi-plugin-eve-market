// 新物品兜底（§6.1.9，旧插件的「补库」，不写数据库）：本地数据还没收录的新物品，按精确名问 ESI。
// POST /universe/ids（先按查询的语言，再换另一种）→ GET /universe/types/{id} → 临时的 ItemInfo。
// 只有能上市场的才用；结果（包括「查不到」）在 BlobCache 里存 7 天，同一个查询同时只请求一次。

import { REMOTE_ITEM_CACHE_DAYS, REMOTE_QUERY_MAX_CHARS, REMOTE_QUERY_MIN_CHARS } from '../../constants'
import { sha256 } from '../data'
import type { EsiApi, EsiLanguage, EsiType } from '../esi'
import type { BlobCache, Clock, Logger } from '../ports'
import { NO_ID } from '../types'
import type { DataSet, ItemInfo } from '../types'
import { describeError, LruCache, SingleFlight } from '../util'
import { hasHan, nameKey } from './normalize'

/** 用到的两个 ESI 路由（core/esi 的封装，测试里换成假的） */
export type RemoteEsi = Pick<EsiApi, 'ids' | 'type'>

export interface RemoteDeps {
  esi: RemoteEsi
  cache: BlobCache
  clock: Clock
  logger?: Logger
}

const DAY = 24 * 3600 * 1000
const TTL_MS = REMOTE_ITEM_CACHE_DAYS * DAY
const MEMORY_MAX = 500
/** 同名的物品最多看几个 */
const MAX_IDS = 3
const CACHE_PREFIX = 'items/remote'

interface CachedLookup {
  query: string
  item: ItemInfo | null
}

/** 看起来像一个完整的名字：2–100 个字、不含 *、不是纯数字、至少有一个字母或汉字 */
export function looksLikeFullName(query: string): boolean {
  const text = query.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const length = [...text].length
  if (length < REMOTE_QUERY_MIN_CHARS || length > REMOTE_QUERY_MAX_CHARS) return false
  return !text.includes('*') && !/^[#\d\s]+$/.test(text) && /\p{L}/u.test(text)
}

function isItemInfo(value: unknown): value is ItemInfo {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.typeId === 'number' && typeof v.en === 'string' && typeof v.zh === 'string' && typeof v.groupId === 'number'
}

function decode(body: Buffer): CachedLookup | null {
  try {
    const raw = JSON.parse(body.toString('utf8')) as { query?: unknown; item?: unknown }
    if (typeof raw.query !== 'string') return null
    if (raw.item === null) return { query: raw.query, item: null }
    return isItemInfo(raw.item) ? { query: raw.query, item: Object.freeze(raw.item) } : null
  } catch {
    return null
  }
}

export class RemoteItems {
  private readonly flights = new SingleFlight<string, ItemInfo | null>()
  private readonly memory: LruCache<string, ItemInfo | null>

  constructor(private readonly deps: RemoteDeps, private readonly data: () => DataSet) {
    this.memory = new LruCache({ max: MEMORY_MAX, ttlMs: TTL_MS, now: () => deps.clock.now() })
  }

  /** 查不到、不能上市场、或者 ESI 出错都返回 null（出错不缓存，下次再试） */
  lookup(query: string): Promise<ItemInfo | null> {
    if (!looksLikeFullName(query)) return Promise.resolve(null)
    const name = query.normalize('NFKC').replace(/\s+/g, ' ').trim()
    const key = nameKey(name)
    if (this.memory.has(key)) return Promise.resolve(this.memory.get(key) ?? null)
    return this.flights.run(key, () => this.load(name, key))
  }

  private cacheKey(key: string): string {
    return `${CACHE_PREFIX}/${sha256(key).slice(0, 32)}`
  }

  private async load(name: string, key: string): Promise<ItemInfo | null> {
    const cached = await this.readCache(key)
    if (cached !== undefined) return cached
    let item: ItemInfo | null
    try {
      item = await this.fetch(name, key)
    } catch (e) {
      this.deps.logger?.debug('新物品兜底：ESI 查询失败，不缓存：%s', describeError(e))
      return null
    }
    await this.writeCache(key, name, item)
    return item
  }

  /** undefined = 没有能用的缓存 */
  private async readCache(key: string): Promise<ItemInfo | null | undefined> {
    let entry: Awaited<ReturnType<BlobCache['read']>>
    try {
      entry = await this.deps.cache.read(this.cacheKey(key))
    } catch {
      return undefined
    }
    const at = entry?.meta.at
    if (!entry || typeof at !== 'number') return undefined
    const left = at + TTL_MS - this.deps.clock.now()
    const value = decode(entry.body)
    if (left <= 0 || !value || nameKey(value.query) !== key) return undefined
    this.memory.set(key, value.item, left)
    return value.item
  }

  private async writeCache(key: string, query: string, item: ItemInfo | null) {
    this.memory.set(key, item)
    const body = Buffer.from(JSON.stringify({ query, item } satisfies CachedLookup))
    try {
      await this.deps.cache.write(this.cacheKey(key), body, { at: this.deps.clock.now() })
    } catch (e) {
      this.deps.logger?.debug('新物品兜底：写缓存失败：%s', describeError(e))
    }
  }

  private async fetch(name: string, key: string): Promise<ItemInfo | null> {
    const languages: EsiLanguage[] = hasHan(name) ? ['zh', 'en'] : ['en', 'zh']
    for (const language of languages) {
      const { value } = await this.deps.esi.ids([name], language)
      // 名字完全一样的排前面
      const exact = (name: string) => (nameKey(name) === key ? 0 : 1)
      const hits = [...value.inventoryTypes].sort((a, b) => exact(a.name) - exact(b.name)).slice(0, MAX_IDS)
      for (const hit of hits) {
        const item = await this.toItem(hit.id, language === 'zh' ? hit.name : '')
        if (item) return item
      }
    }
    return null
  }

  private async toItem(typeId: number, zh: string): Promise<ItemInfo | null> {
    const data = this.data()
    const row = data.types.rowOf(typeId)
    if (row >= 0) return data.types.marketGroup[row] === NO_ID ? null : data.types.item(row)
    const { value } = await this.deps.esi.type(typeId, { language: 'en' })
    return value.published && value.marketGroupId !== null ? toItemInfo(value, zh, data) : null
  }
}

function toItemInfo(type: EsiType, zh: string, data: DataSet): ItemInfo {
  const volume = type.volume ?? 0
  return Object.freeze({
    typeId: type.typeId,
    en: type.name,
    zh,
    groupId: type.groupId,
    categoryId: data.groups.get(type.groupId)?.categoryId ?? NO_ID,
    marketGroupId: type.marketGroupId,
    metaGroupId: null,
    techLevel: null,
    volume,
    packagedVolume: type.packagedVolume ?? volume,
    portionSize: type.portionSize ?? 1,
    capacity: type.capacity || null,
    variationParent: null,
  })
}
