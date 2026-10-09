// core 的 AuthStore 在 minato 上的实现（§8.1）。只认 SecretBox 的密文：有人误把明文 refresh token
// 交进来时直接拒绝（报错里不带它的值），保证只泄露数据库拿不到 token（§8.2）。

import type { Context } from 'koishi'
import type { AuthRecord, AuthStatus, AuthStore, Clock } from '../core/ports'
import { AUTH_TABLE, extendAuthModel } from './models'
import type { AuthRow } from './models'

const STATUSES: readonly AuthStatus[] = ['NEEDS_AUTH', 'OK', 'DEGRADED', 'AUTH_ERROR']

/** SecretBox 的密文：v1:<keyId>:<iv>:<tag>:<data>（base64url） */
export const SEALED_PATTERN = /^v1:[0-9a-f]{8}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/

/** 档案名：字母（含汉字）、数字、下划线、短横线，最多 32 个字（和控制台「市场」表格的「授权档案」一样） */
export const PROFILE_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u

export const STORE_TEXT = {
  badProfile: '授权档案名只能用字母、数字、下划线和短横线，最多 32 个字',
  notSealed: 'refresh token 必须先用 SecretBox 加密再保存',
} as const

const toDate = (ms: number | null): Date | null => ms === null || !Number.isFinite(ms) ? null : new Date(ms)

function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

const str = (value: unknown): string => typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)

export function rowToRecord(row: Partial<AuthRow>): AuthRecord {
  const status = str(row.status) as AuthStatus
  return {
    profile: str(row.profile),
    characterId: str(row.characterId),
    characterName: str(row.characterName),
    ownerHash: str(row.ownerHash),
    scopes: str(row.scopes).split(/\s+/).filter(Boolean),
    refreshToken: str(row.refreshToken),
    keyId: str(row.keyId),
    // 读不懂的状态（例如更新版本写的）按还没授权处理
    status: STATUSES.includes(status) ? status : 'NEEDS_AUTH',
    lastError: str(row.lastError),
    lastErrorAt: toMs(row.lastErrorAt),
    lastRefreshAt: toMs(row.lastRefreshAt),
    lastSuccessAt: toMs(row.lastSuccessAt),
    authorizedAt: toMs(row.authorizedAt),
  }
}

export function recordToRow(rec: AuthRecord, now: number): Omit<AuthRow, 'id'> {
  if (!PROFILE_PATTERN.test(rec.profile)) throw new Error(STORE_TEXT.badProfile)
  if (rec.refreshToken && !SEALED_PATTERN.test(rec.refreshToken)) throw new Error(STORE_TEXT.notSealed)
  return {
    profile: rec.profile,
    characterId: rec.characterId,
    characterName: rec.characterName.slice(0, 100),
    ownerHash: rec.ownerHash.slice(0, 64),
    scopes: rec.scopes.join(' '),
    refreshToken: rec.refreshToken,
    keyId: rec.keyId,
    status: rec.status,
    lastError: rec.lastError,
    lastErrorAt: toDate(rec.lastErrorAt),
    lastRefreshAt: toDate(rec.lastRefreshAt),
    lastSuccessAt: toDate(rec.lastSuccessAt),
    authorizedAt: toDate(rec.authorizedAt),
    updatedAt: new Date(now),
  }
}

export class DatabaseAuthStore implements AuthStore {
  constructor(private readonly ctx: Context, private readonly clock: Clock = { now: () => Date.now() }) {}

  /** 按建档顺序 */
  async list(): Promise<AuthRecord[]> {
    const rows = await this.ctx.database.get(AUTH_TABLE, {})
    return [...rows].sort((a, b) => a.id - b.id).map(rowToRecord)
  }

  async get(profile: string): Promise<AuthRecord | undefined> {
    const [row] = await this.ctx.database.get(AUTH_TABLE, { profile })
    return row ? rowToRecord(row) : undefined
  }

  /** 按档案名新建或整行覆盖（id 不变） */
  async upsert(rec: AuthRecord): Promise<void> {
    await this.ctx.database.upsert(AUTH_TABLE, [recordToRow(rec, this.clock.now())], 'profile')
  }

  async remove(profile: string): Promise<void> {
    await this.ctx.database.remove(AUTH_TABLE, { profile })
  }
}

/** 注册表结构并返回 AuthStore（插件 apply 时调用；读写要等数据库就绪，也就是 ready 之后） */
export function createAuthStore(ctx: Context, clock?: Clock): AuthStore {
  extendAuthModel(ctx)
  return new DatabaseAuthStore(ctx, clock)
}
