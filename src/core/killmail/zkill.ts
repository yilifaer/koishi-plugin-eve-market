// zKill 的击杀数据解析。zKill API 返回 `[{ killmail_id, killmail_time, solar_system_id, victim, attackers, zkb: { hash, totalValue, npc, solo, awox, … } }]`
// （完整击杀 + zkb 估值和标记，格式 2026-10-14 已用真实响应核对）；编号不存在时是 `[]`。
// 老格式只有 killmail_id 和 zkb，没有击杀正文：body 为 null，调用方再用 hash 去欧服接口取。
// 字段名猜错只改这一个函数和 ZKILL_KILL_PATH。

import { ZKILL_KILL_PATH } from '../../constants'
import { ShapeError, parseKillmail } from '../esi'
import type { EsiKillmail } from '../esi'

export interface ZkillKill {
  /** 40 位小写十六进制 */
  hash: string
  /** zKill 的 totalValue；没有时 null */
  value: number | null
  npc: boolean
  solo: boolean
  awox: boolean
  /** 响应里带的完整击杀（时间、星系、受害者、攻击者）；老格式或正文读不懂时 null */
  body: EsiKillmail | null
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

/** 有击杀正文就按欧服击杀的格式读；读不懂当作没有，让调用方回头问欧服接口 */
function readBody(r: Record<string, unknown>, killId: number): EsiKillmail | null {
  if (r.victim === undefined && r.attackers === undefined) return null
  try {
    const body = parseKillmail(r)
    return body.killId === killId ? body : null
  } catch {
    return null
  }
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
    body: readBody(r, killId),
  }
}
