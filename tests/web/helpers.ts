// web 测试共用：直接调用处理函数，从页面里取链接和表单里的一次性令牌。

import type { Clock } from '../../src/core/ports'
import { AdminGuard, createWebHandler } from '../../src/web'
import type { WebResponse } from '../../src/web'
import { MemoryLogger, fakeCore, settingsWith } from './fake-core'

export class ManualClock implements Clock {
  constructor(public t = Date.UTC(2026, 9, 7, 6, 20)) {}
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

export interface GetOptions {
  query?: Record<string, string>
  remote?: string
  host?: string
  cookie?: string
  /** 带着反向代理加的转发头 */
  forwarded?: boolean
  fetchSite?: string
}

export function setup(sso: Record<string, string> = {}, guard = new AdminGuard()) {
  const fc = fakeCore()
  const clock = new ManualClock()
  const logger = new MemoryLogger()
  const settings = settingsWith(sso)
  const handle = createWebHandler(fc.handle, settings, { guard, clock, logger, readyWaitMs: 50 })
  const get = (path: string, o: GetOptions = {}) => handle({
    path,
    query: new URLSearchParams(o.query),
    remoteAddress: o.remote ?? '127.0.0.1',
    host: o.host ?? '127.0.0.1:5140',
    cookie: o.cookie,
    forwarded: o.forwarded,
    fetchSite: o.fetchSite,
  })
  return { fc, clock, logger, guard, settings, handle, get }
}

const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

/** 页面里所有链接（已经去掉 HTML 转义） */
export function links(res: WebResponse): URL[] {
  return [...res.body.matchAll(/href="([^"]*)"/g)].map((m) => new URL(unescape(m[1]), 'http://127.0.0.1:5140'))
}

export function linkTo(res: WebResponse, path: string, params: Record<string, string> = {}): URL | undefined {
  return links(res).find((u) => u.pathname === path && Object.entries(params).every(([k, v]) => u.searchParams.get(k) === v))
}

/** 指向 action 的表单里隐藏的令牌 */
export function formToken(res: WebResponse, action: string): string | undefined {
  const at = res.body.indexOf(`action="${action}"`)
  if (at < 0) return undefined
  const end = res.body.indexOf('</form>', at)
  return /name="t" value="([^"]+)"/.exec(res.body.slice(at, end))?.[1]
}

export function queryOf(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams)
}
