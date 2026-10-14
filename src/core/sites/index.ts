// core/sites 对外的接口：截图网站名单（识别链接、域名检查、内网判断）。

export { createSiteRegistry } from './registry'
export { BUILTIN_SITES, CUSTOM_PROFILE, MAX_URL_LENGTH, checkBuiltinUrl } from './builtin'
export type { BuiltinSite } from './builtin'
export { checkConfigHost, hostMatches, isPrivateNetworkHost } from './host'
export type { ConfigHostCheck } from './host'
export type {
  BuiltinSiteId, ShotProfile, SiteInfo, SiteKind, SiteLink, SiteRegistry, SiteRegistryInput, SiteSettingInput,
} from './types'
