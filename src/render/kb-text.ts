// 人物卡的文字版：出图服务不可用时发这个；另外放卡片和文字版共用的数字、日期写法。
// 纯函数，不 import koishi；名字等原样输出，发送前由 bot 层按平台处理。

import type { PilotKill, PilotProfile, PilotShipRef } from '../core/types'
import { BEIJING_UTC_OFFSET_HOURS } from '../constants'

/** 1,284 */
export function countText(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** ISK 简写：845.2B、410M、3.2K；小于 1000 原样 */
export function iskShort(value: number): string {
  const units: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [base, unit] of units) {
    if (value >= base) return `${(Math.round((value / base) * 10) / 10).toString()}${unit}`
  }
  return String(Math.max(0, Math.round(value)))
}

/** 百分比：整数不带小数，其余一位 */
export function percentText(value: number): string {
  return `${Math.round(value * 10) / 10}%`
}

const pad = (v: number) => String(v).padStart(2, '0')

/** 毫秒 → UTC 的 YYYY-MM-DD */
export function utcDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** 毫秒 → 北京时间的 YYYY-MM-DD */
export function beijingDate(ms: number): string {
  return utcDate(ms + BEIJING_UTC_OFFSET_HOURS * 3_600_000)
}

/** 毫秒 → UTC 的 YYYY-MM-DD HH:mm */
export function utcMinute(ms: number): string {
  const d = new Date(ms)
  return `${utcDate(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** 毫秒 → UTC 的 MM-DD */
export function utcMonthDay(ms: number): string {
  return utcDate(ms).slice(5)
}

/** 舰船的显示名：优先中文，没有中文用英文 */
export function shipName(ship: PilotShipRef | null): string {
  if (!ship) return '未知舰船'
  return ship.zh || ship.en || `#${ship.typeId}`
}

/** 军团 / 联盟的一行：`[TICK] 名字`，联盟用尖括号 */
export function orgLine(org: { name: string; ticker?: string }, brackets: '[]' | '<>'): string {
  return org.ticker ? `${brackets[0]}${org.ticker}${brackets[1]} ${org.name}` : org.name
}

function bigEvent(label: string, kill: PilotKill): string {
  const place = kill.system ? kill.system.en : `#${kill.systemId}`
  return `${label}：${shipName(kill.ship)} ${iskShort(kill.value)} · ${place} · ${utcMonthDay(kill.time)}`
}

/**
 * 文字版简报（没有浏览器时用）：名字、军团 / 联盟、头衔、击毁 / 损失 / 单杀 / 效率、前 3 艘船、前 3 个星系、
 * 活跃时段、近期大击杀 / 大损失。没有的行不输出
 */
export function kbCardText(profile: PilotProfile): string {
  const lines: string[] = []
  lines.push(`${profile.name}｜${profile.personaLabel}`)
  const orgs = [
    profile.corporation && `军团 ${orgLine(profile.corporation, '[]')}`,
    profile.alliance && `联盟 ${orgLine(profile.alliance, '<>')}`,
  ].filter(Boolean)
  if (orgs.length) lines.push(orgs.join('　'))
  if (profile.title) lines.push(`头衔：${profile.title}`)
  if (profile.birthday !== null) lines.push(`建号：EVE ${utcDate(profile.birthday)}（北京 ${beijingDate(profile.birthday)}）`)
  const t = profile.totals
  if (t.kills + t.losses > 0) {
    const parts = [`击毁 ${countText(t.kills)}`, `损失 ${countText(t.losses)}`, `单杀 ${countText(t.solo)}`]
    if (t.efficiency !== null) parts.push(`效率 ${percentText(t.efficiency)}`)
    lines.push(parts.join(' · '))
  } else {
    lines.push(profile.partial.includes('zkill') ? '战绩暂时取不到' : '暂无击杀或损失记录')
  }
  if (profile.ships.length) {
    lines.push(`常驾舰船：${profile.ships.slice(0, 3).map((s) => `${shipName(s)} ${countText(s.kills)} 杀`).join('、')}`)
  }
  if (profile.places.length) {
    lines.push(`常出没：${profile.places.slice(0, 3).map((p) => `${p.system ? p.system.en : `#${p.systemId}`} ${countText(p.kills)}`).join('、')}`)
  }
  if (profile.activity?.text) lines.push(`活跃时段：${profile.activity.text}`)
  if (profile.recentKill) lines.push(bigEvent('近期大击杀', profile.recentKill))
  if (profile.recentLoss) lines.push(bigEvent('近期大损失', profile.recentLoss))
  return lines.join('\n')
}
