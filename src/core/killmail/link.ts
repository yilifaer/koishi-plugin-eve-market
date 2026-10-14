// 击杀链接识别：zkillboard.com/kill/<编号>/，以及带 hash 的欧服官方击杀地址（esi.evetech.net/.../killmails/<编号>/<hash>/）。
// 主机名必须正好是 zkillboard.com / www.zkillboard.com / esi.evetech.net：前面不能紧挨着字母、数字、`.`、`@`、`:`、`/`、`-`
// （防止 evilzkillboard.com、zkillboard.com.evil.cn、user@zkillboard.com 之类被认出来）；不带 https:// 的写法也认。
// 只取出编号（和 hash），用户给的网址本身永远不会被请求。

import { KILL_ID_MAX_DIGITS } from '../../constants'

export type KillLinkSource = 'zkill' | 'esi' | 'id'

export interface KillLink {
  killId: number
  /** 欧服官方地址里带的 40 位 hash（小写）；其他来源 null */
  hash: string | null
  source: KillLinkSource
}

const START = String.raw`(?<![\w.@:/-])(?:https?:\/\/)?`
const ZKILL = new RegExp(`${START}(?:www\\.)?zkillboard\\.com\\/kill\\/(\\d{1,${KILL_ID_MAX_DIGITS}})(?!\\d)`, 'i')
const ESI = new RegExp(`${START}esi\\.evetech\\.net\\/(?:(?:latest|dev|legacy|v\\d+)\\/)?killmails\\/(\\d{1,${KILL_ID_MAX_DIGITS}})\\/([0-9a-f]{40})(?![0-9a-f])`, 'i')
const PLAIN = new RegExp(`^\\d{1,${KILL_ID_MAX_DIGITS}}$`)

function toLink(m: RegExpExecArray, source: 'zkill' | 'esi'): KillLink | null {
  const killId = Number(m[1])
  if (!(killId > 0)) return null
  return { killId, hash: source === 'esi' ? m[2].toLowerCase() : null, source }
}

/** 一段文字里最靠前的有效击杀链接（每条消息只处理 1 个）；没有时 null */
export function findKillLink(text: string): KillLink | null {
  const found = (['zkill', 'esi'] as const)
    .map((source) => {
      const m = (source === 'zkill' ? ZKILL : ESI).exec(text)
      return m && toLink(m, source) ? { index: m.index, link: toLink(m, source)! } : null
    })
    .filter((f): f is { index: number; link: KillLink } => f !== null)
    .sort((a, b) => a.index - b.index)
  return found[0]?.link ?? null
}

/**
 * 命令参数：纯数字（1–12 位，大于 0），或整段就是一个击杀链接（前后空白、末尾的 `/`、参数、锚点可以有）。
 * 其他情况 null。
 */
export function parseKillArg(input: string): KillLink | null {
  const text = input.trim()
  if (PLAIN.test(text)) {
    const killId = Number(text)
    return killId > 0 ? { killId, hash: null, source: 'id' } : null
  }
  for (const [re, source] of [[ZKILL, 'zkill'], [ESI, 'esi']] as const) {
    const m = re.exec(text)
    if (!m || m.index !== 0) continue
    const rest = text.slice(m[0].length)
    if (rest && !/^[/?#]\S*$/.test(rest)) continue
    const link = toLink(m, source)
    if (link) return link
  }
  return null
}
