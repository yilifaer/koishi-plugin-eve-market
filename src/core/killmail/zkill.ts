// zKill 的击杀数据解析。现在的 zKill API 只返回 `[{ killmail_id, zkb: { hash, totalValue, npc, solo, awox, … } }]`
// （完整击杀要拿 hash 去欧服接口取）；编号不存在时是 `[]`。
// 字段名（killmail_id、zkb.hash、zkb.totalValue 的大小写）按记忆写的，待实测；猜错只改这一个函数和 ZKILL_KILL_PATH。

import { ZKILL_KILL_PATH } from '../../constants'
import { ShapeError } from '../esi'

export interface ZkillKill {
  /** 40 位小写十六进制 */
  hash: string
  /** zKill 的 totalValue；没有时 null */
  value: number | null
  npc: boolean
  solo: boolean
  awox: boolean
}

/** 击杀编号 → zKill 的 API 路径 */
export function zkillKillPath(killId: number): string {
  return ZKILL_KILL_PATH.replace('{id}', String(killId))
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ShapeError(`${what} 应该是对象`)
  return value as Record<string, unknown>
}

function flag(r: Record<string, unknown>, key: string): boolean {
  const v = r[key]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw new ShapeError(`zkb.${key} 应该是 true/false`)
  return v
}

function money(r: Record<string, unknown>, key: string): number | null {
  const v = r[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`zkb.${key} 应该是数字`)
  return v
}

/** `[]` → 'not-found'；格式不对抛 ShapeError（调用方当作「zKill 暂时不可用」） */
export function parseZkillKill(json: unknown, killId: number): ZkillKill | 'not-found' {
  if (!Array.isArray(json)) throw new ShapeError('zKill 击杀应该是数组')
  if (!json.length) return 'not-found'
  const r = object(json[0], '击杀')
  if (r.killmail_id !== killId) throw new ShapeError('killmail_id 和请求的编号对不上')
  const zkb = object(r.zkb, 'zkb')
  const hash = zkb.hash
  if (typeof hash !== 'string' || !/^[0-9a-f]{40}$/i.test(hash)) throw new ShapeError('zkb.hash 应该是 40 位十六进制')
  return {
    hash: hash.toLowerCase(),
    value: money(zkb, 'totalValue'),
    npc: flag(zkb, 'npc'),
    solo: flag(zkb, 'solo'),
    awox: flag(zkb, 'awox'),
  }
}
