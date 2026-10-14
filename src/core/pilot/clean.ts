// 军团头衔（ESI 人物信息的 title）的清理：可能带 HTML / 颜色标签、网址、控制字符。

import { KB_TITLE_MAX_CHARS } from '../../constants'

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' }

/** 控制字符、零宽字符、双向控制字符 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g
const SCHEME_URL = /[a-z][a-z0-9+.-]*:\/\/\S*/gi
/** 裸域名只认这些常见后缀，免得「Mr.Bob」「Dr.Strange」被当成网址 */
const COMMON_TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'me', 'cc', 'tv', 'gg', 'xyz', 'top', 'app', 'dev', 'site', 'online', 'club', 'shop', 'vip',
  'cn', 'ru', 'uk', 'de', 'jp', 'kr', 'fr', 'us', 'eu', 'nl', 'pl', 'br', 'in', 'au', 'ca',
]
const WWW_PREFIX = /\bwww[.。｡]\S*/gi
const DOMAIN_LIKE = new RegExp(`[\\w-]+(?:[.。｡][\\w-]+)*[.。｡](?:${COMMON_TLDS.join('|')})(?![\\w-])`, 'gi')

/** 去标签、还原常见转义、去掉网址和不可见字符、合成一行、截到 max 个字；清理完是空的返回 null */
export function cleanTitle(raw: string | null | undefined, max = KB_TITLE_MAX_CHARS): string | null {
  if (typeof raw !== 'string') return null
  // 全角的点和字母先转成 ASCII，网址的判断才认得出
  let text = raw.normalize('NFKC').replace(/<[^>]*>/g, '')
  text = text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (e) => ENTITIES[e] ?? e)
  // 还原出来的 < > 不能再组成标签
  text = text.replace(/[<>]/g, '').replace(INVISIBLE, ' ').replace(SCHEME_URL, '').replace(WWW_PREFIX, '').replace(DOMAIN_LIKE, '')
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return null
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : text
}
