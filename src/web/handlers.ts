// EVE 授权页面的处理逻辑（§7.4、§8.4），和 Koishi 无关：请求 → 响应，测试直接调用。
// 回调以外的路由只接受本机：socket 的对端地址是本机、没有任何转发头（经反向代理、内网穿透来的一律拒绝）、
// Host 是本机的写法（防 DNS 重绑定）；设了口令时再要口令；「授权」「删除」「搜索」要带页面渲染时发的一次性令牌。
// 日志里只有档案名和角色名。

import { randomBytes } from 'node:crypto'
import {
  ADMIN_DELETE_PATH, ADMIN_PAGE_PATH, ADMIN_SEARCH_PATH, READY_WAIT_MS, SSO_CALLBACK_PATH, SSO_START_PATH,
  STRUCTURE_SEARCH_MAX_CHARS, STRUCTURE_SEARCH_MIN_CHARS,
} from '../constants'
import type { Clock, Logger } from '../core/ports'
import type { AuthCompletion, CoreFailure, EveCore, Settings, StructureProbe } from '../core/types'
import { describeError, redact } from '../core/util'
import { PROFILE_PATTERN } from '../storage'
import { hostnameOf, isLocalHost, isLoopback, sameSecret } from './guard'
import type { AdminGuard, CallbackView } from './guard'
import { layout } from './html'
import {
  adminPage, callbackPage, confirmDeletePage, confirmStartPage, localOnlyPage, messagePage, notFoundPage, notReadyPage,
  passphrasePage, searchPage,
} from './pages'
import type { CallbackCheck, Page, SearchHitView } from './pages'

export interface WebRequest {
  /** 不写 = GET。koa 的 GET 路由也接 HEAD：HEAD 一律只回空页面，什么都不做 */
  method?: string
  path: string
  query: URLSearchParams
  /** socket 的对端地址 */
  remoteAddress?: string
  /** 带着反向代理、内网穿透加的转发头（X-Forwarded-For 等）：只看有没有 */
  forwarded?: boolean
  /** 请求头 Host，原样 */
  host?: string
  /** 请求头 Cookie，原样 */
  cookie?: string
  /** 请求头 Sec-Fetch-Site（浏览器自动带上）：别的网站发起的请求不执行任何操作 */
  fetchSite?: string
  /** 请求头 Sec-Purpose 或 Purpose：浏览器预取页面时不执行任何操作 */
  purpose?: string
}

export interface WebResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** 页面只用到 core 的这几部分 */
export type WebCore = Pick<EveCore, 'auth' | 'prices' | 'universe' | 'format'>

export interface WebCoreHandle {
  /** 等 core 准备好，最多 ms 毫秒；没准备好返回 null（CoreRuntime 就是这样） */
  ready(ms: number): Promise<WebCore | null>
}

export interface WebHandlerOptions {
  guard: AdminGuard
  clock: Clock
  logger: Logger
  /** 页面等 core 准备好最多多久；不写 = READY_WAIT_MS */
  readyWaitMs?: number
}

export const WEB_PATHS: readonly string[] = [ADMIN_PAGE_PATH, ADMIN_SEARCH_PATH, ADMIN_DELETE_PATH, SSO_START_PATH, SSO_CALLBACK_PATH]

export const SESSION_COOKIE = 'eve_market_admin'
const COOKIE_PATH = '/eve-market'
/** 回调参数的长度上限（正常的 code、state 远小于这个） */
const MAX_PARAM_CHARS = 2048
const MAX_MESSAGE_CHARS = 200

/**
 * 应该填进 EVE 开发者网站的回调地址：按浏览器请求的 Host 算（SSH 隧道会原样带上本地端口）。
 * 本页只能经 http 直接打开（经反向代理来的请求进不了本页），所以算出来的一律是 http；
 * 控制台里写成同一个地址的 https 时，授权以后浏览器打不开，单独提示
 */
export function checkCallback(host: string | undefined, configured: string): CallbackCheck {
  if (!hostnameOf(host)) return { expected: null, configured, state: 'unknown' }
  const expected = `http://${host}${SSO_CALLBACK_PATH}`
  const browser = new URL(expected)
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    return { expected, configured, state: 'mismatch' }
  }
  const sameTarget = url.host.toLowerCase() === browser.host.toLowerCase() && url.pathname === SSO_CALLBACK_PATH
  if (!sameTarget || url.search || url.hash) return { expected, configured, state: 'mismatch' }
  return { expected, configured, state: url.protocol === 'http:' ? 'match' : 'https' }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

function headers(nonce: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
  }
}

function render(status: number, page: Page): WebResponse {
  const nonce = randomBytes(16).toString('base64')
  return {
    status,
    headers: { ...headers(nonce), 'Content-Type': 'text/html; charset=utf-8' },
    body: layout(page.title, page.body, nonce),
  }
}

function redirect(location: string, status = 303, extra: Record<string, string> = {}): WebResponse {
  return { status, headers: { ...headers(randomBytes(16).toString('base64')), Location: location, ...extra }, body: '' }
}

/** 从 core 来的说明：再脱敏一次、截短 */
const clean = (text: string | undefined) => redact(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS)

const param = (query: URLSearchParams, name: string) => (query.get(name) ?? '').trim()

/** 会改状态的操作只在本站页面上点击（或手动打开）时执行；预取、别的网站发起的一律只显示确认页，令牌不动 */
export function mayAct(req: Pick<WebRequest, 'fetchSite' | 'purpose'>): boolean {
  if (req.purpose && /prefetch|prerender/i.test(req.purpose)) return false
  return !req.fetchSite || req.fetchSite === 'same-origin' || req.fetchSite === 'none'
}

/** core 的说明都是完整的句子；末尾补上句号 */
function sentence(text: string): string {
  return /[。！？]$/.test(text) ? text : `${text}。`
}

/** 搜索失败：core 的说明已经写清楚原因和下一步，原样显示 */
function failureText(profile: string, failure: CoreFailure): string {
  const message = clean(failure.message)
  if (message) return `用档案 ${profile} 搜索没有成功：${sentence(message)}`
  return failure.code === 'UPSTREAM_UNAVAILABLE' ? '暂时连不上 EVE，请稍后再试。' : '搜索没有成功，请稍后再试。'
}

function completionFailure(c: Extract<AuthCompletion, { ok: false }>, configured: boolean): CallbackView {
  const message = clean(c.message)
  const view = (lines: string[], title = '授权没有完成'): CallbackView => ({ ok: false, title, lines, structures: [] })
  switch (c.reason) {
    case 'bad_state':
      return view(['这次授权的链接已经过期（10 分钟内有效）或者已经用过了。'], '授权链接已失效')
    case 'exchange_failed':
      // 应用本身的问题（Client ID、Secret Key 不对，EVE 拒绝了请求）
      return view([
        `向 EVE 换取授权时失败${message ? `：${sentence(message)}` : '。'}`,
        '请检查控制台里的 Client ID、Secret Key 和回调地址，是否和 EVE 开发者网站上的完全一致。',
      ])
    case 'unavailable':
      return view([sentence(message || '暂时连不上 EVE 登录服务器'), '过几分钟再试。'])
    case 'not_configured':
      return view([
        sentence(message || '「EVE 授权」里还没有填 Client ID 和 Secret Key'),
        ...configured ? [] : ['先填进 Koishi 控制台本插件设置里的「EVE 授权」并保存。'],
      ])
    default:
      // 权限不够、授权码失效、没能保存：core 的说明里已经写了怎么办
      return view([sentence(message || '授权没有完成')])
  }
}

export function createWebHandler(core: WebCoreHandle, settings: Settings, options: WebHandlerOptions): (req: WebRequest) => Promise<WebResponse> {
  const { guard, clock, logger } = options
  const waitMs = options.readyWaitMs ?? READY_WAIT_MS
  const sso = settings.sso
  const configured = () => !!sso.clientId && !!sso.clientSecret

  /** 设了口令时：有效的会话 cookie，或者这次带了对的口令（发 cookie，跳回不带口令的地址） */
  function passphrase(req: WebRequest): WebResponse | null {
    if (!sso.adminKey) return null
    const now = clock.now()
    const key = req.query.get('key')
    if (key !== null) {
      if (!sameSecret(key, sso.adminKey)) return render(403, passphrasePage(true))
      const session = guard.openSession(sso.adminKey, now)
      const cookie = `${SESSION_COOKIE}=${session.cookie}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${session.maxAgeSec}`
      return redirect(ADMIN_PAGE_PATH, 303, { 'Set-Cookie': cookie })
    }
    if (guard.hasSession(readCookie(req.cookie, SESSION_COOKIE), sso.adminKey, now)) return null
    return render(200, passphrasePage(false))
  }

  /** 星系名；数据里没有这个星系时 showId 决定显示 ID 还是空 */
  function systemName(c: WebCore, id: number | null | undefined, showId = true): string {
    if (!id) return ''
    const sys = c.universe.system(id)
    return sys ? sys.zh || sys.en : showId ? String(id) : ''
  }

  /** 状态正常、能拿来搜索的档案 */
  const usableProfiles = (c: WebCore) => c.auth.profiles().filter((p) => p.status === 'OK').map((p) => p.profile)

  function admin(c: WebCore, req: WebRequest): WebResponse {
    const now = clock.now()
    const profiles = c.auth.profiles()
    const deleted = param(req.query, 'msg') === 'deleted' ? param(req.query, 'profile') : ''
    return render(200, adminPage({
      clock: (ms) => c.format.clock(ms),
      flash: deleted && PROFILE_PATTERN.test(deleted) ? { tone: 'ok', text: `已删除授权档案 ${deleted}。` } : undefined,
      callback: checkCallback(req.host, sso.callbackUrl),
      clientId: !!sso.clientId,
      clientSecret: !!sso.clientSecret,
      passphrase: !!sso.adminKey,
      profiles: profiles.map((info) => ({ info, startToken: guard.issueAction('start', now, info.profile) })),
      newProfileToken: guard.issueAction('start', now),
      structures: c.prices.sources().filter((m) => m.type === 'structure'),
      searchToken: guard.issueAction('search', now),
      searchProfiles: usableProfiles(c),
    }))
  }

  async function search(c: WebCore, req: WebRequest): Promise<WebResponse> {
    const now = clock.now()
    const profiles = usableProfiles(c)
    const q = param(req.query, 'q').slice(0, STRUCTURE_SEARCH_MAX_CHARS)
    const profile = param(req.query, 'profile') || profiles[0] || ''
    const token = req.query.get('t')
    const view = (extra: Partial<Parameters<typeof searchPage>[0]> = {}) => render(200, searchPage({
      token: guard.issueAction('search', now), profiles, profile, q, ...extra,
    }))
    if (!q) return view()
    if (!mayAct(req) || !guard.useAction(token, 'search', now)) {
      return view({ notice: { tone: 'warn', text: '刚才的页面已经过期，请再点一次「搜索」。' } })
    }
    if (!PROFILE_PATTERN.test(profile)) return view({ notice: { tone: 'bad', text: '档案名不对。' } })
    if ([...q].length < STRUCTURE_SEARCH_MIN_CHARS) {
      return view({ notice: { tone: 'warn', text: `至少输入 ${STRUCTURE_SEARCH_MIN_CHARS} 个字。` } })
    }
    const result = await c.auth.searchStructures(profile, q)
    if (!Array.isArray(result)) return view({ notice: { tone: 'bad', text: failureText(profile, result) } })
    // 照抄进表格的星系名必须是数据里有的；没有时留空（授权后插件自己查）
    const hits: SearchHitView[] = result.map((h) => ({ id: h.id, name: h.name, system: systemName(c, h.systemId, false) }))
    return view({ hits })
  }

  async function remove(c: WebCore, req: WebRequest): Promise<WebResponse> {
    const now = clock.now()
    const profile = param(req.query, 'profile')
    if (!PROFILE_PATTERN.test(profile)) return render(400, messagePage('档案名不对', 'bad', ['请回到授权页面，从列表里点「删除」。']))
    const token = req.query.get('t')
    if (!mayAct(req) || !guard.useAction(token, 'delete', now, profile)) {
      return render(200, confirmDeletePage(profile, guard.issueAction('delete', now, profile), token !== null))
    }
    // 日志由 core 写（「EVE 授权档案 … 已删除」）
    await c.auth.remove(profile)
    return redirect(`${ADMIN_PAGE_PATH}?${new URLSearchParams({ msg: 'deleted', profile })}`)
  }

  function start(c: WebCore, req: WebRequest): WebResponse {
    const now = clock.now()
    const profile = param(req.query, 'profile') || 'default'
    if (!PROFILE_PATTERN.test(profile)) {
      return render(400, messagePage('档案名不对', 'bad', ['档案名只能用文字、数字、- 和 _（最多 32 个字）。']))
    }
    if (!configured()) {
      return render(400, messagePage('还不能授权', 'bad', ['先把 Client ID 和 Secret Key 填进 Koishi 控制台本插件设置里的「EVE 授权」并保存。']))
    }
    const token = req.query.get('t')
    if (!mayAct(req) || !guard.useAction(token, 'start', now, profile)) {
      return render(200, confirmStartPage(profile, guard.issueAction('start', now, profile), token !== null))
    }
    let begun: { url: string; state: string }
    try {
      begun = c.auth.beginAuth(profile)
    } catch (e) {
      return render(500, messagePage('还不能授权', 'bad', [clean(describeError(e))]))
    }
    guard.rememberState(begun.state, profile, now)
    return redirect(begun.url, 302)
  }

  function probeView(c: WebCore, probe: StructureProbe): CallbackView['structures'][number] {
    return {
      market: probe.marketName,
      structureId: probe.structureId,
      name: probe.structureName ?? '',
      system: systemName(c, probe.systemId),
      access: probe.access,
    }
  }

  async function callback(req: WebRequest): Promise<WebResponse> {
    const now = clock.now()
    const resultId = param(req.query, 'r')
    if (resultId) {
      const view = guard.result(resultId, now)
      return view ? render(200, callbackPage(view)) : render(404, messagePage('结果页已过期', 'warn', ['授权结果只保留 10 分钟。回到授权页面就能看到现在的状态。']))
    }
    const state = param(req.query, 'state').slice(0, MAX_PARAM_CHARS)
    const code = param(req.query, 'code').slice(0, MAX_PARAM_CHARS)
    const error = param(req.query, 'error').slice(0, 64)
    if (error) {
      // 只有真的发出去过的 state 才写日志（不让随便什么人刷日志）
      if (state && guard.useState(state, now)) logger.warn(`EVE 授权没有完成：登录页返回 ${clean(error)}`)
      return render(400, messagePage('授权被取消', 'bad', [`EVE 登录页没有完成授权（${clean(error)}），可能点了取消，或者没有同意权限。`, '回到授权页面，重新点「授权」再试一次。']))
    }
    if (!state || !code) return render(400, messagePage('链接不完整', 'bad', ['这个地址应该由 EVE 登录页自动跳回来，不要手动打开。']))
    const c = await core.ready(waitMs)
    if (!c) return render(503, notReadyPage())
    const pending = guard.useState(state, now)
    // 不认识的 state 直接回答，不存结果页、不写日志（回调不限来源，不让外面的请求挤掉所有者的结果）
    if (!pending) return render(400, callbackPage(completionFailure({ ok: false, reason: 'bad_state', message: '' }, configured())))
    const done = await c.auth.completeAuth(code, state)
    let view: CallbackView
    if (done.ok) {
      view = {
        ok: true,
        title: '授权成功',
        profile: done.profile,
        characterName: done.characterName,
        lines: [],
        structures: done.structures.map((p) => probeView(c, p)),
      }
      // 授权成功的日志由 core 写
    } else {
      view = completionFailure(done, configured())
      logger.warn(`EVE 授权没有完成（档案 ${pending.profile}，${done.reason}）：${clean(done.message)}`)
    }
    // 跳到结果页：刷新页面不会再用一次 code
    return redirect(`${SSO_CALLBACK_PATH}?${new URLSearchParams({ r: guard.saveResult(view, now) })}`)
  }

  /** 本机直接打开：对端地址是本机、没有转发头、Host 是本机的写法（或者和回调地址的主机名一样） */
  const local = (req: WebRequest) => isLoopback(req.remoteAddress) && !req.forwarded && isLocalHost(req.host, sso.callbackUrl)

  async function guarded(req: WebRequest): Promise<WebResponse> {
    if (!local(req)) return render(403, localOnlyPage())
    const gate = passphrase(req)
    if (gate) return gate
    const c = await core.ready(waitMs)
    if (!c) return render(503, notReadyPage())
    switch (req.path) {
      case ADMIN_PAGE_PATH: return admin(c, req)
      case ADMIN_SEARCH_PATH: return search(c, req)
      case ADMIN_DELETE_PATH: return remove(c, req)
      default: return start(c, req)
    }
  }

  return async (req) => {
    if (req.method && req.method !== 'GET') return { status: 200, headers: headers(randomBytes(16).toString('base64')), body: '' }
    try {
      if (req.path === SSO_CALLBACK_PATH) return await callback(req)
      if (WEB_PATHS.includes(req.path)) return await guarded(req)
      return render(404, notFoundPage())
    } catch (e) {
      const reason = clean(describeError(e))
      logger.warn(`EVE 授权页面出错：${reason}`)
      return render(500, messagePage('出错了', 'bad', [reason, '请稍后再试；一直这样的话，看一下 Koishi 的日志。']))
    }
  }
}
