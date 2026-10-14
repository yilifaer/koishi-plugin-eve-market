// 在消息里找 http(s):// 起点，并把后面的一段切成 主机 / 路径 / 参数。只做切分，不判断是哪个网站。

/** 链接里最长看多少个字符（再长的不是正常链接） */
const MAX_TOKEN = 1000
/** 链接到这些字符结束：空白、尖括号、引号、中文和全角标点 */
const TERMINATOR = /[\s<>"`　-〿㐀-鿿＀-￯]/
const SCHEME = /^https?:\/\//i
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
/** 严格的主机：只有字母数字、点、连字符；至少两段。`@` `:` `\` `%` 都过不了 */
const HOST = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`, 'i')

export interface LinkToken {
  /** 小写主机 */
  host: string
  /** 路径，至少是 `/`；已去掉参数和锚点 */
  path: string
  /** 参数，含开头的 `?`；没有时是空串 */
  query: string
  /** 在原文里的结束位置 */
  end: number
}

/** 文字里每一个 http:// 或 https:// 出现的位置（包括嵌在别的网址参数里的） */
export function schemeStarts(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/https?:\/\//gi)) out.push(m.index)
  return out
}

function trimTail(input: string): string {
  let end = input.length
  // 括号个数只数一次，之后随去掉的字符递减，保持线性
  let open = 0
  let close = 0
  for (const ch of input) {
    if (ch === '(') open++
    else if (ch === ')') close++
  }
  while (end > 0) {
    const c = input[end - 1]
    if ('.,;:!?\'"]}'.includes(c)) end--
    else if (c === ')' && close > open) {
      close--
      end--
    } else break
  }
  return input.slice(0, end)
}

/**
 * 从 start 开始读一个链接。strip 为真时去掉末尾的标点（消息里的链接）；
 * 为假时原样读（整串就是链接的检查）。主机不合格、链接太长时返回 null。
 */
export function readToken(text: string, start: number, strip: boolean): LinkToken | null {
  const scheme = SCHEME.exec(text.slice(start, start + 8))
  if (!scheme) return null
  const bodyStart = start + scheme[0].length
  const chunk = text.slice(bodyStart, bodyStart + MAX_TOKEN + 1)
  const stop = chunk.search(TERMINATOR)
  if (stop < 0 && chunk.length > MAX_TOKEN) return null
  let body = stop < 0 ? chunk : chunk.slice(0, stop)
  const hash = body.indexOf('#')
  if (hash >= 0) body = body.slice(0, hash)
  if (strip) body = trimTail(body)
  const cut = body.search(/[/?]/)
  const host = (cut < 0 ? body : body.slice(0, cut)).toLowerCase()
  if (host.length > 253 || !HOST.test(host)) return null
  const rest = cut < 0 ? '' : body.slice(cut)
  const q = rest.indexOf('?')
  const path = (q < 0 ? rest : rest.slice(0, q)) || '/'
  const query = q < 0 ? '' : rest.slice(q)
  return { host, path, query, end: stop < 0 ? bodyStart + chunk.length : bodyStart + stop }
}
