// 战报（br.evetools.org）链接识别（§2.11）。规则沿用 yyyhf 的 eve-br（MIT，见 NOTICE）：
// `https?://[^/\s]*br\.evetools\.org/(?:br/[a-f0-9]{24}|related/\d{8}/\d{12})`，不区分大小写。
// 在这之上：主机名转小写后只认 br.evetools.org 和它的子域名（防止被用来访问任意网址）；
// 编号后面紧跟着同类字符（多一位十六进制或数字）的不算；后面的路径、参数、标点都不要，
// 统一成 `https://<主机>/br/<编号>` 或 `https://<主机>/related/<星系>/<时间>`，截图和缓存都只用这个地址。

import { KILL_BR_ROUNDING, RELATED_BR_SOURCES } from '../../constants'

/** 战报网站的主机名 */
export const BR_HOST = 'br.evetools.org'

export type BrLinkKind = 'br' | 'related'

export interface BrLink {
  kind: BrLinkKind
  /** 规范化后的地址：https、主机名和路径小写，不带参数；也是缓存的键 */
  url: string
  /** 小写的主机名（br.evetools.org 或它的子域名） */
  host: string
  /** br：24 位十六进制编号；related：`星系ID/时间`（8 位 + 12 位数字） */
  id: string
}

// 主机名部分照旧插件写得宽一些（遇到 / 或空白结束，中文也算结束），找到以后再严格检查
const LINK = /https?:\/\/([^/\s　-〿㐀-鿿＀-￯]*br\.evetools\.org)\/(?:(br)\/([a-f0-9]{24})(?![a-f0-9])|(related)\/(\d{8})\/(\d{12})(?!\d))/gi

/** 只认 br.evetools.org 和它的子域名；不能带用户名、端口这类东西 */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*br\.evetools\.org$/

function toLink(m: RegExpExecArray): BrLink | null {
  const host = m[1].toLowerCase()
  if (!HOST.test(host)) return null
  if (m[2]) {
    const id = m[3].toLowerCase()
    return { kind: 'br', url: `https://${host}/br/${id}`, host, id }
  }
  const id = `${m[5]}/${m[6]}`
  return { kind: 'related', url: `https://${host}/related/${id}`, host, id }
}

/** 消息里第一个有效的战报链接；没有时 null（每条消息只处理 1 个） */
export function findBrLink(text: string): BrLink | null {
  for (const m of text.matchAll(LINK)) {
    const link = toLink(m)
    if (link) return link
  }
  return null
}

/**
 * 整段文字就是一个战报链接（前后空白、末尾的 `/`、参数、锚点可以有）时返回它，否则 null。
 * 截图前用它再检查一遍地址，只打开规范化后的地址。
 */
export function parseBrLink(input: string): BrLink | null {
  const text = input.trim()
  const m = new RegExp(LINK.source, 'i').exec(text)
  if (!m || m.index !== 0) return null
  const rest = text.slice(m[0].length)
  if (rest && !/^[/?#]\S*$/.test(rest)) return null
  return toLink(m)
}

/** 文字里提到了战报网站（用来在链接格式不对时给出提示） */
export function mentionsBrHost(text: string): boolean {
  return text.toLowerCase().includes(BR_HOST)
}

// ------------------------------------------------------------------ 按星系和时间拼 related 地址（击杀转战报）

const HOUR_MS = 3_600_000

export type RelatedRounding = 'floor' | 'nearest'

/**
 * 「这个星系这个整点小时的相关战斗」地址：时间取 UTC，向下取整（或四舍五入）到整点，星系 ID 必须正好 8 位。
 * 拼完再过一遍 parseBrLink，通过的才返回；格式不对时 null。
 */
export function relatedBrUrl(systemId: number, timeMs: number, rounding: RelatedRounding = KILL_BR_ROUNDING): string | null {
  if (!Number.isInteger(systemId) || !/^\d{8}$/.test(String(systemId))) return null
  if (!Number.isFinite(timeMs)) return null
  const hours = rounding === 'nearest' ? Math.round(timeMs / HOUR_MS) : Math.floor(timeMs / HOUR_MS)
  const d = new Date(hours * HOUR_MS)
  const year = d.getUTCFullYear()
  if (!(year >= 1000 && year <= 9999)) return null
  const p2 = (n: number) => String(n).padStart(2, '0')
  const time = `${year}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}00`
  const url = RELATED_BR_SOURCES[0].template.replace('{system}', String(systemId)).replace('{time}', time)
  return parseBrLink(url)?.url ?? null
}
