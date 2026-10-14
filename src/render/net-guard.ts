// 截图时的网络守卫（DECISIONS 的截图一条）：开请求拦截，只放行该放行的请求。
// 1. 主框架的跳转（服务器重定向、页面脚本跳转）必须是 https 且主机在名单里，否则中止并记 blockedRedirects。
//    本次 goto 产生的第一个主框架请求不检查：这个地址在 goto 之前已经按名单检查过。
// 2. 其余请求（图片、脚本、子框架……）主机是本机 / 内网地址就中止并记 blockedPrivate；data:、blob: 放行，其他协议中止。
// 不依赖 puppeteer：请求和页面只用 renderer.ts 里的最小接口，拿不到的信息（frame、resourceType）有退路。

import type { Logger } from '../core/ports'
import { hostMatches, isPrivateNetworkHost } from '../core/sites'
import type { PageRequest, RenderPage } from './renderer'

export interface NetGuardStats {
  /** 被拦下的主框架跳转（跳出名单、非 https） */
  blockedRedirects: number
  /** 被拦下的内网 / 本机请求 */
  blockedPrivate: number
}

export interface NetGuard {
  readonly stats: NetGuardStats
}

export interface NetGuardOptions {
  /** 主框架允许去的域名（所有启用网站的域名，含子域名） */
  allowHosts: readonly string[]
  logger?: Pick<Logger, 'debug'>
}

const BLOCKED = 'blockedbyclient'
const MAX_LOG_CHARS = 200

/** 主框架的导航请求（拿不到 frame 信息时按 document 类型处理） */
function isMainNavigation(request: PageRequest, page: RenderPage): boolean {
  const type = request.resourceType?.()
  const navigation = request.isNavigationRequest ? request.isNavigationRequest() : type === 'document'
  if (!navigation) return false
  const frame = request.frame?.()
  const main = page.mainFrame?.()
  if (frame && main) return frame === main
  return type === 'document'
}

/** 给页面装上守卫；必须在 goto 之前调用 */
export async function installNetGuard(page: RenderPage, options: NetGuardOptions): Promise<NetGuard> {
  const stats: NetGuardStats = { blockedRedirects: 0, blockedPrivate: 0 }
  const allow = options.allowHosts.map((host) => host.toLowerCase())
  let first = true

  const decide = (request: PageRequest): boolean => {
    const raw = request.url()
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return false
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return true
    const web = url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:'
    if (!web) return false
    if (isMainNavigation(request, page)) {
      if (first) {
        first = false
        return true
      }
      const ok = url.protocol === 'https:' && allow.some((domain) => hostMatches(url.hostname.toLowerCase(), domain))
      if (!ok) stats.blockedRedirects++
      return ok
    }
    if (isPrivateNetworkHost(url.hostname)) {
      stats.blockedPrivate++
      return false
    }
    return true
  }

  const handle = (request: PageRequest) => {
    try {
      if (request.isInterceptResolutionHandled?.()) return
      if (decide(request)) request.continue().catch(() => undefined)
      else {
        options.logger?.debug(`截图页面的请求已拦截：${request.url().slice(0, MAX_LOG_CHARS)}`)
        request.abort(BLOCKED).catch(() => undefined)
      }
    } catch {
      // 页面已经关了；判断本身出错时宁可中止
      try {
        request.abort(BLOCKED).catch(() => undefined)
      } catch {
        // 同上
      }
    }
  }

  await page.setRequestInterception(true)
  page.on('request', handle)
  return { stats }
}
