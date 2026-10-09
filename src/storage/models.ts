// 数据库表（§8.1）：只放授权档案。refresh token 存的是 SecretBox 的密文，明文绝不进数据库。

import type { Context } from 'koishi'

export const AUTH_TABLE = 'eve_market_auth'

export interface AuthRow {
  id: number
  /** 档案名，例如 default；唯一 */
  profile: string
  /** 存成字符串，不怕大数 */
  characterId: string
  characterName: string
  /** JWT 的 owner；角色转手后会变 */
  ownerHash: string
  /** 空格分隔 */
  scopes: string
  /** 密文：v1:<keyId>:<iv>:<tag>:<data>（base64url） */
  refreshToken: string
  keyId: string
  /** NEEDS_AUTH | OK | DEGRADED | AUTH_ERROR */
  status: string
  /** 只写原因，不写 token */
  lastError: string
  lastErrorAt: Date | null
  lastRefreshAt: Date | null
  lastSuccessAt: Date | null
  authorizedAt: Date | null
  updatedAt: Date | null
}

declare module 'koishi' {
  interface Tables {
    eve_market_auth: AuthRow
  }
}

const time = { type: 'timestamp', nullable: true } as const

export function extendAuthModel(ctx: Context): void {
  ctx.model.extend(AUTH_TABLE, {
    id: 'unsigned',
    profile: 'string(64)',
    characterId: 'string(20)',
    characterName: 'string(100)',
    ownerHash: 'string(64)',
    scopes: 'text',
    refreshToken: 'text',
    keyId: 'string(16)',
    status: 'string(16)',
    lastError: 'text',
    lastErrorAt: time,
    lastRefreshAt: time,
    lastSuccessAt: time,
    authorizedAt: time,
    updatedAt: time,
  }, { primary: 'id', autoInc: true, unique: ['profile'] })
}
