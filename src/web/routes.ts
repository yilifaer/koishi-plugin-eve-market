// 把 EVE 授权页面挂到 ctx.server（@koishijs/plugin-server 的 koa 路由）上，全部是 GET，不依赖请求体解析。
// 插件里这样用：ctx.inject(['server'], (c) => installWebRoutes(c, runtime, settings))；插件停用时路由跟着撤掉。

import type { IncomingMessage } from 'node:http'
import type { Context } from 'koishi'
import { koishiLogger, moduleStore, systemClock } from '../bot/ports'
import type { Clock, Logger, ModuleStore } from '../core/ports'
import type { Settings } from '../core/types'
import { AdminGuard, PROXY_HEADERS } from './guard'
import { WEB_PATHS, createWebHandler } from './handlers'
import type { WebCoreHandle, WebRequest } from './handlers'

/** koa 的 Context 里用到的部分 */
interface KoaContextLike {
  req: IncomingMessage
  status: number
  body: unknown
  set(field: string, value: string): void
}

/** ctx.server 里用到的部分（自己声明，不依赖它的类型包） */
interface RouterLike {
  get(path: string, middleware: (koa: KoaContextLike, next: () => Promise<unknown>) => Promise<void>): unknown
}

export interface WebRouteOptions {
  /** 一次性令牌、口令会话、state 放在哪里；不写 = 模块级存储（控制台保存配置后还在） */
  store?: ModuleStore
  logger?: Logger
  clock?: Clock
  readyWaitMs?: number
}

const GUARD_KEY = 'web/admin-guard'

/**
 * 地址取 socket 的对端；转发头（X-Forwarded-For 等）只看有没有，从不拿它的值来放行。
 * Host、Cookie、Sec-Fetch-Site、预取标记原样交给处理函数
 */
export function toWebRequest(req: IncomingMessage, path: string): WebRequest {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const header = (name: string) => {
    const value = req.headers[name]
    return typeof value === 'string' ? value : undefined
  }
  return {
    method: req.method,
    path,
    query: url.searchParams,
    remoteAddress: req.socket?.remoteAddress,
    forwarded: PROXY_HEADERS.some((name) => req.headers[name] !== undefined),
    host: header('host'),
    cookie: header('cookie'),
    fetchSite: header('sec-fetch-site'),
    purpose: header('sec-purpose') ?? header('purpose'),
  }
}

/** 没有 server 服务时返回 false（什么都不做） */
export function installWebRoutes(ctx: Context, core: WebCoreHandle, settings: Settings, options: WebRouteOptions = {}): boolean {
  const router = (ctx as unknown as { server?: RouterLike }).server
  if (!router || typeof router.get !== 'function') return false
  const handle = createWebHandler(core, settings, {
    guard: (options.store ?? moduleStore()).get(GUARD_KEY, () => new AdminGuard()),
    clock: options.clock ?? systemClock,
    logger: options.logger ?? koishiLogger(ctx),
    readyWaitMs: options.readyWaitMs,
  })
  for (const path of WEB_PATHS) {
    router.get(path, async (koa) => {
      const res = await handle(toWebRequest(koa.req, path))
      koa.status = res.status
      for (const [name, value] of Object.entries(res.headers)) koa.set(name, value)
      koa.body = res.body
    })
  }
  return true
}
