// Janice 估价链接识别：janice.e-351.com/a/<编号>[/<小写子页面>]。识别规则（主机、路径）沿用 core/sites 里的内置 Janice 网站，
// 不在这里再写一份；这里再要求主机正好是 janice.e-351.com（不放过子域名），必须带 http(s)://。
// 只取出编号和子页面，用户给的网址本身永远不会被请求。

import { JANICE_HOST } from '../../constants'
import { createSiteRegistry } from '../sites'

export interface JaniceLink {
  /** 估价编号，保留大小写 */
  code: string
  /** 小写子页面（如 reprocess）；没有时 null */
  subpage: string | null
}

const registry = createSiteRegistry({
  sites: [{ id: 'janice', name: 'Janice', builtin: true, host: JANICE_HOST, pathPrefix: '', auto: true, maxImages: 1 }],
})

function toLink(url: string, host: string): JaniceLink | null {
  if (host !== JANICE_HOST) return null
  // url 是规范化后的 https://janice.e-351.com/a/<编号>[/<子页面>]
  const parts = new URL(url).pathname.split('/')
  return parts[2] ? { code: parts[2], subpage: parts[3] || null } : null
}

/** 一段文字里最靠前的 Janice 估价链接（每条消息只处理 1 个）；没有时 null */
export function findJaniceLink(text: string): JaniceLink | null {
  // 先找到的第一个 Janice 链接若主机不严格，不再往后找，免得绕过顺序
  const hit = registry.find(text)
  return hit ? toLink(hit.url, hit.host) : null
}

/** 最靠前的 Janice 估价链接在原文里的起点；没有时 null（和 findJaniceLink 找的是同一个） */
export function findJaniceLinkStart(text: string): number | null {
  const hit = registry.find(text)
  return hit && toLink(hit.url, hit.host) ? hit.start : null
}

/** 命令参数：整段就是一个 Janice 估价链接（前后空白可以有）。其他情况 null */
export function parseJaniceArg(input: string): JaniceLink | null {
  const hit = registry.parse(input)
  return hit ? toLink(hit.url, hit.host) : null
}

/** 编号 → 估价页的地址。只给截图用，不会出现在回复里 */
export function janicePageUrl(code: string, subpage: string | null = null): string {
  return `https://${JANICE_HOST}/a/${code}${subpage ? `/${subpage}` : ''}`
}
