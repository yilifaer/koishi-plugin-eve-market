// 自定义网站：域名（含子域名）加可选的网址开头。保留查询参数，去掉锚点。

import { MAX_URL_LENGTH } from './builtin'

/** 路径、参数里允许的字符（不含空白、`\`、`|`、`^` 这类） */
const PATH = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/
const QUERY = /^\?[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*$/

/** 路径是否落在网址开头之下（按段边界：/kb 不匹配 /kbx） */
export function underPrefix(path: string, prefix: string): boolean {
  if (!prefix || prefix === '/') return true
  if (prefix.endsWith('/')) return path.startsWith(prefix)
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** 合格时给出规范化地址，否则 null */
export function customUrl(host: string, path: string, query: string, prefix: string): string | null {
  if (!PATH.test(path)) return null
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return null
  if (query && !QUERY.test(query)) return null
  if (!underPrefix(path, prefix)) return null
  const url = `https://${host}${path}${query === '?' ? '' : query}`
  return url.length <= MAX_URL_LENGTH ? url : null
}
