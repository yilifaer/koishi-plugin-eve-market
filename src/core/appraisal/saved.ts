// 估价编号（§2.0.10）：整份清单放不进 100 字的按钮，存在模块级存储里（插件重载后还在），
// APPRAISAL_ID_HOURS 小时有效（每次重算重新计时），最多 APPRAISAL_ID_MAX 份，LRU。
// 编号 4 位，只用不容易看错的字符，至少一个字母（和物品的 #638 区分开）。

import { APPRAISAL_ID_ALPHABET, APPRAISAL_ID_HOURS, APPRAISAL_ID_LENGTH, APPRAISAL_ID_MAX } from '../../constants'
import type { Clock, ModuleStore } from '../ports'
import type { PriceSide } from '../types'
import { LruCache } from '../util'
import type { Random } from '../util'
import type { ItemList } from './lines'

export const APPRAISAL_STORE_KEY = 'appraisal/saved'
export const APPRAISAL_TTL_MS = APPRAISAL_ID_HOURS * 3600_000

/** 上一次估价用的参数：按钮里只写要改的那一项（「#K7Q2 buy」），其余照上一次 */
export interface SavedParams {
  marketKey?: string
  side?: PriceSide
  modifierPct?: number
}

export interface SavedAppraisal {
  list: ItemList
  params: SavedParams
  savedAt: number
}

const BASE = APPRAISAL_ID_ALPHABET.length
const HAS_LETTER = /[A-Z]/

function encode(n: number): string {
  let out = ''
  for (let i = 0; i < APPRAISAL_ID_LENGTH; i++) {
    out = APPRAISAL_ID_ALPHABET[n % BASE] + out
    n = Math.floor(n / BASE)
  }
  return out
}

export class SavedAppraisals {
  private readonly lru: LruCache<string, SavedAppraisal>

  constructor(store: ModuleStore, private readonly clock: Clock, private readonly random: Random) {
    // 不在存储里放带时钟的对象：插件重载后时钟端口会换，过期时间在这里按 savedAt 算
    this.lru = store.get(APPRAISAL_STORE_KEY, () => new LruCache<string, SavedAppraisal>({ max: APPRAISAL_ID_MAX }))
  }

  save(list: ItemList, params: SavedParams = {}): { id: string; saved: SavedAppraisal } {
    const id = this.newId()
    const saved: SavedAppraisal = { list, params, savedAt: this.clock.now() }
    this.lru.set(id, saved)
    return { id, saved }
  }

  /** 过期或不存在 → undefined；取到的同时重新计时 */
  get(id: string): SavedAppraisal | undefined {
    const key = id.toUpperCase()
    const saved = this.lru.get(key)
    if (!saved) return undefined
    const now = this.clock.now()
    if (now - saved.savedAt >= APPRAISAL_TTL_MS) {
      this.lru.delete(key)
      return undefined
    }
    saved.savedAt = now
    return saved
  }

  /** 随机取一个；碰上已经用了的（或者全是数字）就往后找下一个空的 */
  private newId(): string {
    const space = BASE ** APPRAISAL_ID_LENGTH
    const r = this.random()
    const start = Number.isFinite(r) ? Math.min(space - 1, Math.max(0, Math.floor(r * space))) : 0
    for (let step = 0; step < space; step++) {
      const id = encode((start + step) % space)
      if (HAS_LETTER.test(id) && !this.taken(id)) return id
    }
    throw new Error('估价编号用完了')
  }

  private taken(id: string): boolean {
    const saved = this.lru.peek(id)
    return !!saved && this.clock.now() - saved.savedAt < APPRAISAL_TTL_MS
  }
}
