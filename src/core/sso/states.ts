// 授权 state（§7.4、§8.4）：32 字节随机数，只能用一次，10 分钟有效，最多同时 5 个（多了丢最早的）。
// 放在模块级存储里：在 EVE 登录页停留期间控制台保存了配置（插件重载），回来照样能完成授权。

import { randomBytes } from 'node:crypto'
import { SSO_STATE_MAX, SSO_STATE_TTL_MIN } from '../../constants'
import type { Clock, ModuleStore } from '../ports'

const STORE_KEY = 'sso:states'
const STATE_BYTES = 32

interface Pending {
  profile: string
  createdAt: number
}

export class AuthStates {
  private readonly pending: Map<string, Pending>

  constructor(private readonly clock: Clock, store?: ModuleStore, private readonly ttlMs = SSO_STATE_TTL_MIN * 60_000, private readonly max = SSO_STATE_MAX) {
    this.pending = store ? store.get(STORE_KEY, () => new Map<string, Pending>()) : new Map()
  }

  get size(): number {
    this.prune()
    return this.pending.size
  }

  create(profile: string): string {
    this.prune()
    // Map 按插入顺序，第一个就是最早的
    while (this.pending.size >= this.max) this.pending.delete(this.pending.keys().next().value as string)
    const state = randomBytes(STATE_BYTES).toString('base64url')
    this.pending.set(state, { profile, createdAt: this.clock.now() })
    return state
  }

  /** 取出 state 对应的档案名；不管有没有过期，取一次就作废。没有或过期返回 null */
  take(state: string): string | null {
    const hit = this.pending.get(state)
    if (!hit) return null
    this.pending.delete(state)
    return this.clock.now() - hit.createdAt <= this.ttlMs ? hit.profile : null
  }

  private prune() {
    const now = this.clock.now()
    for (const [state, p] of this.pending) {
      if (now - p.createdAt > this.ttlMs) this.pending.delete(state)
    }
  }
}
