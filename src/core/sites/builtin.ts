// 4 个内置网站的识别规则和页面参数。Warbeacon、Janice、DOTLAN 的路径格式和页面参数是第一版的推测，
// 要在生产机上用「截图测试」核对；需要改时只改这个文件里对应的一行。BR 工具委托 universe/br-link。

import { BR_SETTLE_MS, BR_VIEWPORT_HEIGHT, BR_VIEWPORT_WIDTH } from '../../constants'
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

// Warbeacon：/br/ 后面 1–4 段（推测）
const WARBEACON = /^\/br\/([A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,64}){0,3})\/?$/
// Janice：/a/<编号>（编号长度和字符是推测，大小写要保留）
const JANICE = /^\/a\/([A-Za-z0-9]{4,16})\/?$/
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
    badLinkHint: '只支持战报页',
    profile: { ...VIEWPORT, waitUntil: 'networkidle2', settleMs: 3000 },
    path: (path) => {
      const m = WARBEACON.exec(path)
      return m ? `/br/${m[1]}` : null
    },
  },
  {
    id: 'janice',
    kind: 'appraisal',
    name: 'Janice 估价结果',
    host: 'janice.e-351.com',
    badLinkHint: '只支持估价结果页',
    profile: { ...VIEWPORT, waitUntil: 'networkidle2', settleMs: 2000 },
    path: (path) => {
      const m = JANICE.exec(path)
      return m ? `/a/${m[1]}` : null
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
