// 网站名单：把控制台整理过的设置变成「找链接 / 复查链接 / 提到了哪个网站」的函数。

import { findBrLink, parseBrLink } from '../universe'
import { BUILTIN_SITES, CUSTOM_PROFILE, MAX_URL_LENGTH } from './builtin'
import type { BuiltinSite } from './builtin'
import { customUrl } from './custom'
import { readToken, schemeStarts } from './extract'
import type { LinkToken } from './extract'
import { hostMatches } from './host'
import type { ShotProfile, SiteInfo, SiteLink, SiteRegistry, SiteRegistryInput, SiteSettingInput } from './types'

interface Rule {
  site: SiteInfo
  builtin?: BuiltinSite
  prefix: string
}

const clampImages = (n: number) => (Number.isFinite(n) ? Math.min(3, Math.max(1, Math.trunc(n))) : 1)

function buildRules(input: SiteRegistryInput): Rule[] {
  const rules: Rule[] = []
  const byId = new Map(input.sites.map((s) => [s.id, s]))
  for (const builtin of BUILTIN_SITES) {
    const setting = byId.get(builtin.id)
    if (!setting) continue
    rules.push({ builtin, prefix: '', site: infoOf(setting, builtin.host, builtin.kind, { ...builtin.profile, maxImages: clampImages(setting.maxImages) }, builtin) })
  }
  for (const setting of input.sites) {
    if (setting.builtin) continue
    const host = setting.host.trim().toLowerCase()
    if (!host) continue
    rules.push({ prefix: setting.pathPrefix, site: infoOf(setting, host, 'custom', { ...CUSTOM_PROFILE, maxImages: clampImages(setting.maxImages) }) })
  }
  return rules
}

function infoOf(s: SiteSettingInput, host: string, kind: SiteInfo['kind'], profile: ShotProfile, builtin?: BuiltinSite): SiteInfo {
  return {
    id: s.id,
    name: s.name,
    kind,
    host,
    auto: s.auto,
    profile,
    legacyText: builtin?.id === 'br',
    badLinkHint: builtin ? builtin.badLinkHint : '只支持指定的页面',
  }
}

/** 内置网站的域名（不管启用没有）：这些域名的链接只交给内置规则 */
const builtinOwner = (host: string) => BUILTIN_SITES.find((b) => hostMatches(host, b.host))

function match(rule: Rule, token: LinkToken): string | null {
  if (!hostMatches(token.host, rule.site.host)) return null
  if (rule.builtin) {
    const path = rule.builtin.path?.(token.path)
    return path ? limited(`https://${token.host}${path}`) : null
  }
  return customUrl(token.host, token.path, token.query, rule.prefix)
}

const limited = (url: string) => (url.length <= MAX_URL_LENGTH ? url : null)

export function createSiteRegistry(input: SiteRegistryInput): SiteRegistry {
  const rules = buildRules(input)
  const sites = rules.map((r) => r.site)
  const hosts = [...new Set(sites.map((s) => s.host))]
  const brRule = rules.find((r) => r.builtin?.id === 'br')

  /** 一个链接起点：BR 走 br-link 的规则，其余按主机分给内置或自定义 */
  function linkAt(text: string, start: number, nextStart: number, filter: ((site: SiteInfo) => boolean) | undefined): SiteLink | null {
    if (brRule && (!filter || filter(brRule.site))) {
      const br = findBrLink(text.slice(start, nextStart))
      if (br) return { site: brRule.site, url: br.url, host: br.host, start }
    }
    const token = readToken(text, start, true)
    if (!token) return null
    const owner = builtinOwner(token.host)
    for (const rule of rules) {
      if (rule.builtin?.id === 'br') continue
      if (owner ? rule.builtin !== owner : rule.builtin) continue
      if (filter && !filter(rule.site)) continue
      const url = match(rule, token)
      if (url) return { site: rule.site, url, host: token.host, start }
    }
    return null
  }

  return {
    sites,
    hosts,
    find(text, filter) {
      if (!rules.length) return null
      // 只看前 20 个链接起点，防止恶意长文本拖慢
      const starts = schemeStarts(text)
      for (let i = 0; i < Math.min(starts.length, 20); i++) {
        const link = linkAt(text, starts[i], i + 1 < starts.length ? starts[i + 1] : text.length, filter)
        if (link) return link
      }
      return null
    },
    parse(input) {
      const text = input.trim()
      if (!text || !rules.length) return null
      if (brRule) {
        const br = parseBrLink(text)
        if (br) return { site: brRule.site, url: br.url, host: br.host, start: 0 }
      }
      const token = readToken(text, 0, false)
      if (!token || token.end !== text.length) return null
      const owner = builtinOwner(token.host)
      for (const rule of rules) {
        if (rule.builtin?.id === 'br') continue
        if (owner ? rule.builtin !== owner : rule.builtin) continue
        const url = match(rule, token)
        if (url) return { site: rule.site, url, host: token.host, start: 0 }
      }
      return null
    },
    mentioned(text) {
      const lower = text.toLowerCase()
      return sites.find((s) => lower.includes(s.host)) ?? null
    },
    isListedHost(host) {
      const h = host.toLowerCase()
      return hosts.some((d) => hostMatches(h, d))
    },
  }
}
