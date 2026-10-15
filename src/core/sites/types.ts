// 网站截图名单（见 DECISIONS 的截图一条）：哪些网站、哪些链接可以截，纯函数，不依赖 Koishi。

export type BuiltinSiteId = 'br' | 'warbeacon' | 'janice' | 'dotlan'
export type SiteKind = 'battle-report' | 'appraisal' | 'map' | 'custom'

export interface ShotProfile {
  viewportWidth: number
  viewportHeight: number
  /** 页面开始加载后最多再等多久网络安静下来；一直不安静（长连接、广告）也照样往下截，0 = 不等 */
  idleMs: number
  /** 加载后最多再等多久让页面高度稳定 */
  settleMs: number
  /** 有这个元素才算加载好（只给内置网站用，代码里写死） */
  readySelector?: string
  /** 内部滚动框里的内容比框高才算加载好（内容在内部滚动容器里的单页应用，只给内置网站用）；最多等 readyTimeoutMs，没给就按总时限扣掉余量 */
  readyScroll?: boolean
  readyTimeoutMs?: number
  /** 页面按 100dvh 排版、内容在内部容器里滚动：截图前把视口加高到容器装得下（只给内置网站用） */
  growViewport?: boolean
  /** 截图前隐藏的元素（广告、横幅），只给内置网站用 */
  hideSelectors?: readonly string[]
  /** 截图前隐藏的浮动条：position 为 fixed / sticky、文字里含其中之一、面积不大、不含图表的元素才会藏（不会藏到页面主体），只给内置网站用 */
  hideFixedTexts?: readonly string[]
  /** 页面上的同意框：找到文字完全等于其中之一的按钮就点一下（写「拒绝」一类的，不要写同意），只给内置网站用 */
  dismissTexts?: readonly string[]
  /** 1–3，来自控制台；最高高度 = maxImages × 每张的高度 */
  maxImages: number
  /** 单次截图最长等多少秒（30–180，来自控制台；包含打开、等待和截图，不含排队） */
  maxWaitSec: number
}

export interface SiteInfo {
  /** 'br' | 'warbeacon' | 'janice' | 'dotlan' | 'custom-<行号>' */
  id: string
  /** 回复里用的名字，不含网址 */
  name: string
  kind: SiteKind
  /** 小写；匹配它本身和它的子域名 */
  host: string
  auto: boolean
  profile: ShotProfile
  /** 只有 br 为 true：沿用战报的文案 */
  legacyText: boolean
  /** 链接格式不对时的提示，例如「只支持估价结果页」 */
  badLinkHint: string
}

export interface SiteLink {
  site: SiteInfo
  /** 规范化后的 https 地址；缓存键，也是唯一会被打开的地址 */
  url: string
  /** 小写的主机名 */
  host: string
  /** 在原文里的位置（用来选「第一个」） */
  start: number
}

/** 注册表的输入：一个启用的网站（和控制台里整理过的设置一致） */
export interface SiteSettingInput {
  id: string
  name: string
  builtin: boolean
  host: string
  pathPrefix: string
  auto: boolean
  maxImages: number
  /** 最长等待（秒）；旧配置没有这一项时按网站的默认值 */
  maxWaitSec?: number
}

export interface SiteRegistryInput {
  sites: readonly SiteSettingInput[]
}

export interface SiteRegistry {
  /** 只含启用的，按：内置顺序 → 自定义行顺序 */
  readonly sites: readonly SiteInfo[]
  /** 守卫用的名单（小写域名，去重） */
  readonly hosts: readonly string[]
  find(text: string, filter?: (site: SiteInfo) => boolean): SiteLink | null
  /** 整串就是一个链接（命令参数复查用） */
  parse(input: string): SiteLink | null
  /** 提到了名单里的域名（给「格式不对」用） */
  mentioned(text: string): SiteInfo | null
  isListedHost(host: string): boolean
}
