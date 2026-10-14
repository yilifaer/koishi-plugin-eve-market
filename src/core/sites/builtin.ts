// 4 个内置网站的识别规则和页面参数。Warbeacon、Janice 的链接格式已用真实链接和网站前端路由核对；
// DOTLAN 的路径（/map/<星域>[/<星系>|/sov…]、/region/…、/system/…[/kills]、/alliance/…、/corp/…）2026-10-14 核对过能打开；
// 页面参数（等待时间、视口）还要在生产机上用「截图测试」调。需要改时只改这个文件里对应的一行。BR 工具委托 universe/br-link。

import { BR_SETTLE_MS, BR_VIEWPORT_HEIGHT, BR_VIEWPORT_WIDTH, JANICE_CODE_PATTERN, JANICE_HOST } from '../../constants'
import { BR_HOST } from '../universe'
import type { BuiltinSiteId, ShotProfile, SiteKind } from './types'

export interface BuiltinSite {
  id: BuiltinSiteId
  kind: SiteKind
  /** 默认名字（回复里用） */
  name: string
  host: string
  badLinkHint: string
  profile: Omit<ShotProfile, 'maxImages'>
  /** 路径（已去掉参数和锚点）合格时给出规范化后的路径，否则 null；BR 不用这个，走 br-link */
  path?: (path: string) => string | null
}

const VIEWPORT = { viewportWidth: BR_VIEWPORT_WIDTH, viewportHeight: BR_VIEWPORT_HEIGHT }

// Warbeacon 三种路径：关联战报（星系 8 位 + 时间 12 位）、关联战报的时间范围、单场战报（uuid）
const WARBEACON_RELATED = /^\/br\/related\/(\d{8})\/(\d{12})(?:\/(\d{12}))?\/?$/
const WARBEACON_REPORT = /^\/br\/report\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i
// Janice：/a/<编号>（大小写要保留），后面可以跟一段小写子页面（如 reprocess）
const JANICE = new RegExp(`^\\/a\\/(${JANICE_CODE_PATTERN})(?:\\/([a-z]{1,20}))?\\/?$`)
// DOTLAN：第一段是这五种之一，后面 1–3 段
const DOTLAN = /^\/(map|region|system|alliance|corp)((?:\/[A-Za-z0-9_.'%()-]{1,80}){1,3})\/?$/i

export const BUILTIN_SITES: readonly BuiltinSite[] = [
  {
    id: 'br',
    kind: 'battle-report',
    name: 'BR 工具战报',
    host: BR_HOST,
    badLinkHint: '只支持战报页',
    profile: { ...VIEWPORT, waitUntil: 'networkidle2', settleMs: BR_SETTLE_MS },
  },
  {
    id: 'warbeacon',
    kind: 'battle-report',
    name: 'Warbeacon 战报',
    host: 'warbeacon.net',
    badLinkHint: '只支持关联战报和单场战报页',
    profile: { ...VIEWPORT, waitUntil: 'networkidle2', settleMs: 3000 },
    path: (path) => {
      const r = WARBEACON_RELATED.exec(path)
      if (r) return `/br/related/${r[1]}/${r[2]}/${r[3] ? `${r[3]}/` : ''}`
      const u = WARBEACON_REPORT.exec(path)
      return u ? `/br/report/${u[1].toLowerCase()}` : null
    },
  },
  {
    id: 'janice',
    kind: 'appraisal',
    name: 'Janice 估价结果',
    host: JANICE_HOST,
    badLinkHint: '只支持估价结果页',
    profile: { ...VIEWPORT, waitUntil: 'networkidle2', settleMs: 2000 },
    path: (path) => {
      const m = JANICE.exec(path)
      return m ? `/a/${m[1]}${m[2] ? `/${m[2]}` : ''}` : null
    },
  },
  {
    id: 'dotlan',
    kind: 'map',
    name: 'DOTLAN 星图',
    host: 'evemaps.dotlan.net',
    badLinkHint: '只支持星域、星系、联盟、军团页和星图',
    profile: { ...VIEWPORT, waitUntil: 'load', settleMs: 2000 },
    path: (path) => {
      const m = DOTLAN.exec(path)
      if (!m) return null
      // 段不能只是点（防 .. 跳目录）
      if (m[2].split('/').some((seg) => /^\.+$/.test(seg))) return null
      return `/${m[1].toLowerCase()}${m[2]}`
    },
  },
]

/** 自定义网站的页面参数 */
export const CUSTOM_PROFILE: Omit<ShotProfile, 'maxImages'> = { ...VIEWPORT, waitUntil: 'networkidle2', settleMs: 2000 }

/** 最长的规范化地址 */
export const MAX_URL_LENGTH = 500

/** 一个地址按内置网站的规则检查：主机对、路径合格时给出规范化后的地址，否则 null（BR 不走这里，用 parseBrLink） */
export function checkBuiltinUrl(id: Exclude<BuiltinSiteId, 'br'>, url: string): string | null {
  const site = BUILTIN_SITES.find((b) => b.id === id)
  if (!site?.path) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.host !== site.host) return null
  const path = site.path(u.pathname)
  return path ? `https://${site.host}${path}` : null
}
