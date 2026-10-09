// EVE 授权页面的内容（§7.4、§7.7）：写给电脑新手看的中文，一步一步来。
// 页面里只有档案名、角色名、建筑名和 ID，没有任何 token、口令、Client Secret；输出一律转义。

import {
  ADMIN_DELETE_PATH, ADMIN_PAGE_PATH, ADMIN_SEARCH_PATH, SSO_SCOPES, SSO_START_PATH, STRUCTURE_SEARCH_MAX_CHARS,
  STRUCTURE_SEARCH_MIN_CHARS,
} from '../constants'
import type { AuthStatus } from '../core/ports'
import type { AuthProfileStatus, MarketSourceState, MarketSourceStatus } from '../core/types'
import type { CallbackView } from './guard'
import { copyButton, href, html } from './html'
import type { Raw } from './html'

export type Tone = 'ok' | 'warn' | 'bad'

export interface Page {
  title: string
  body: Raw
}

const PROFILE_STATUS: Record<AuthStatus, { tone: Tone; label: string }> = {
  OK: { tone: 'ok', label: '正常' },
  NEEDS_AUTH: { tone: 'warn', label: '需要授权' },
  DEGRADED: { tone: 'warn', label: '暂时连不上 EVE（会自动重试）' },
  AUTH_ERROR: { tone: 'bad', label: '需要重新授权' },
}

const MARKET_STATE: Record<MarketSourceState, { tone: Tone; label: string }> = {
  OK: { tone: 'ok', label: '正常' },
  FIRST_SYNC: { tone: 'warn', label: '正在第一次同步' },
  NEEDS_AUTH: { tone: 'warn', label: '需要授权' },
  DEGRADED: { tone: 'warn', label: '同步出错（会自动重试）' },
  AUTH_ERROR: { tone: 'bad', label: '授权或停靠权限异常' },
}

const ACCESS_TEXT: Record<CallbackView['structures'][number]['access'], { tone: Tone; label: string }> = {
  ok: { tone: 'ok', label: '可以访问' },
  forbidden: { tone: 'bad', label: '没有权限（403）：这个角色不能停靠这个建筑，或者建筑没有对它开放市场' },
  not_found: { tone: 'bad', label: '找不到：检查「市场」表格里填的建筑 ID' },
  error: { tone: 'warn', label: '暂时查不到，稍后在 QQ 里发「市场状态」看看' },
}

const status = (tone: Tone, label: string) => html`<span class="${tone}"><span class="dot"></span>${label}</span>`

const backLink = () => html`<p><a href="${ADMIN_PAGE_PATH}">返回授权页面</a></p>`

// ------------------------------------------------------------------ 授权页面（首页）

export interface CallbackCheck {
  /** 应该填进 EVE 开发者网站的回调地址；看不出浏览器用的地址时 null */
  expected: string | null
  configured: string
  /** match：一致；mismatch：标红；https：地址一样但写成了 https（本页是 http 打开的）；unknown：看不出 */
  state: 'match' | 'mismatch' | 'https' | 'unknown'
}

export interface AdminView {
  clock: (ms: number) => string
  flash?: { tone: Tone; text: string }
  callback: CallbackCheck
  clientId: boolean
  clientSecret: boolean
  passphrase: boolean
  profiles: Array<{ info: AuthProfileStatus; startToken: string }>
  newProfileToken: string
  structures: MarketSourceStatus[]
  searchToken: string
  /** 能用来搜索的档案（状态正常） */
  searchProfiles: string[]
}

function callbackSection(view: AdminView): Raw {
  const { callback } = view
  const expected = callback.expected
  const checks: Record<CallbackCheck['state'], Raw> = {
    mismatch: html`<div class="box bad">控制台里「EVE 授权 → 回调地址」现在写的是 <code>${callback.configured}</code>，和上面这一行不一样，授权以后会回不到这里。请把控制台里的回调地址改成上面这一行并保存；EVE 开发者网站上的 Callback URL 也要一模一样。</div>`,
    https: html`<div class="box warn">控制台里「EVE 授权 → 回调地址」写的是 <code>${callback.configured}</code>，是 https 开头；本页是用 http 打开的，授权以后浏览器多半打不开 https 的地址。只有 Koishi 前面有 https 反向代理时 https 才对，一般请改成上面这一行（http 开头）并保存；EVE 开发者网站上的 Callback URL 也要一模一样。</div>`,
    match: html`<p>${status('ok', '和控制台里填的回调地址一致')}</p>`,
    unknown: html`<p class="muted">看不出浏览器用的地址；控制台里填的回调地址是 <code>${callback.configured}</code>。</p>`,
  }
  const check = checks[callback.state]
  const missing = !view.clientId || !view.clientSecret
  return html`<section>
<h2>第 1 步：EVE 开发者网站上的应用</h2>
<p>在 developers.eveonline.com 创建应用（连接类型选带 API 访问的那一种），勾选下面三项权限，「Callback URL」照抄这一行：</p>
${expected ? html`<p class="row"><code>${expected}</code>${copyButton(expected)}</p>` : html`<p><code>${callback.configured}</code></p>`}
${check}
<p class="muted small">权限：${SSO_SCOPES.map((s, i) => html`${i ? '、' : ''}<code>${s}</code>`)}</p>
<p>Client ID：${view.clientId ? status('ok', '已填') : status('bad', '没填')}　Secret Key：${view.clientSecret ? status('ok', '已填') : status('bad', '没填')}</p>
${missing ? html`<div class="box bad">先把应用的 Client ID 和 Secret Key 填进 Koishi 控制台本插件设置里的「EVE 授权」并保存，再刷新本页。Secret Key 只填在控制台里，不要发给任何人。</div>` : ''}
</section>`
}

function profileRow(view: AdminView, row: AdminView['profiles'][number], canStart: boolean): Raw {
  const p = row.info
  const s = PROFILE_STATUS[p.status]
  const authorized = p.status !== 'NEEDS_AUTH' || !!p.characterName
  const error = p.lastError
    ? html`<div class="small bad">最近的错误：${p.lastError}${p.lastErrorAt ? `（${view.clock(p.lastErrorAt)}）` : ''}</div>`
    : ''
  const start = canStart
    ? html`<a class="btn" href="${href(SSO_START_PATH, { profile: p.profile, t: row.startToken })}">${authorized ? '重新授权' : '授权'}</a>`
    : html`<span class="muted small">先完成第 1 步</span>`
  const remove = authorized ? html`<a class="btn danger" href="${href(ADMIN_DELETE_PATH, { profile: p.profile })}">删除</a>` : ''
  return html`<tr>
<td><b>${p.profile}</b></td>
<td>${status(s.tone, s.label)}${error}</td>
<td>${p.characterName || html`<span class="muted">—</span>`}</td>
<td>${authorized ? `${p.scopesGranted}/${p.scopesRequired}` : '—'}</td>
<td>${p.lastRefreshAt ? view.clock(p.lastRefreshAt) : '—'}</td>
<td>${p.markets.length ? p.markets.join('、') : html`<span class="muted">没有</span>`}</td>
<td>${start}${remove}</td>
</tr>`
}

function profilesSection(view: AdminView): Raw {
  const canStart = view.clientId && view.clientSecret
  const table = view.profiles.length
    ? html`<table><tr><th>档案</th><th>状态</th><th>角色</th><th>权限</th><th>上次刷新</th><th>用到它的市场</th><th>操作</th></tr>
${view.profiles.map((row) => profileRow(view, row, canStart))}</table>`
    : html`<p class="muted">还没有授权档案。</p>`
  const suggestion = view.profiles.some((p) => p.info.profile === 'default') ? '' : 'default'
  const form = canStart
    ? html`<form method="get" action="${SSO_START_PATH}" class="row">
<label>新档案名 <input name="profile" value="${suggestion}" maxlength="32" required></label>
<input type="hidden" name="t" value="${view.newProfileToken}"><button type="submit">授权</button></form>`
    : ''
  return html`<section>
<h2>第 2 步：授权角色</h2>
<p>点「授权」会跳到 EVE 登录页。<b>浏览器里已经登录的 EVE 账号会被直接用上</b>，不对就先在那边退出；选<b>能停靠联盟建筑</b>的角色，然后同意。授权以后会回到「授权成功」页面。</p>
${table}
${form}
<p class="muted small">一般只要一个档案 default。只有个别建筑要用另一个角色时才新建档案，并在控制台「市场」表格的「授权档案」一栏写上它的名字。</p>
</section>`
}

function searchForm(token: string, profiles: string[], selected = '', q = ''): Raw {
  if (!profiles.length) return html`<p class="muted">完成第 2 步的授权以后才能搜索。</p>`
  const options = profiles.map((p) => html`<option value="${p}"${p === selected ? html` selected` : ''}>${p}</option>`)
  return html`<form method="get" action="${ADMIN_SEARCH_PATH}" class="row">
<label>用档案 <select name="profile">${options}</select></label>
<label>建筑名 <input name="q" value="${q}" minlength="${STRUCTURE_SEARCH_MIN_CHARS}" maxlength="${STRUCTURE_SEARCH_MAX_CHARS}" required placeholder="至少 ${STRUCTURE_SEARCH_MIN_CHARS} 个字"></label>
<input type="hidden" name="t" value="${token}"><button type="submit">搜索</button></form>`
}

function marketsSection(view: AdminView): Raw {
  if (!view.structures.length) {
    return html`<section><h2>建筑市场</h2><p class="muted">控制台的「市场」表格里还没有玩家建筑。用第 3 步找到建筑 ID，再按页面上给出的那一行加进表格。</p></section>`
  }
  const rows = view.structures.map((m) => {
    const s = MARKET_STATE[m.state]
    const error = m.lastError
      ? html`${m.lastError.status ? `${m.lastError.status} ` : ''}${m.lastError.message}${m.lastErrorAt ? `（${view.clock(m.lastErrorAt)}）` : ''}`
      : html`<span class="muted">—</span>`
    const orders = m.pages !== null && m.orders !== null ? `${m.pages} 页 ${m.orders.toLocaleString('en-US')} 单` : '—'
    return html`<tr><td><b>${m.name}</b></td><td>${m.authProfile || html`<span class="muted">不用授权</span>`}</td>
<td>${status(s.tone, s.label)}${m.paused ? html`<div class="small muted">24 小时没人查，同步已暂停（有人查时自动恢复）</div>` : ''}</td>
<td>${m.lastSyncAt ? view.clock(m.lastSyncAt) : '—'}</td><td>${orders}</td><td class="small">${error}</td></tr>`
  })
  return html`<section><h2>建筑市场</h2>
<table><tr><th>市场</th><th>授权档案</th><th>状态</th><th>同步于</th><th>订单</th><th>最近的错误</th></tr>${rows}</table>
<p class="muted small">在 QQ 里发「市场状态」也能看到这些。</p></section>`
}

export function adminPage(view: AdminView): Page {
  const flash = view.flash ? html`<div class="box ${view.flash.tone}">${view.flash.text}</div>` : ''
  return {
    title: 'EVE 授权',
    body: html`<h1>EVE 授权</h1>
<p class="muted">联盟建筑市场要用一个能停靠的角色授权，插件才能读到建筑里的订单。按下面三步做一次就行。</p>
${flash}
${callbackSection(view)}
${profilesSection(view)}
<section><h2>第 3 步：按名字找建筑</h2>
<p>输入建筑名字的一部分，用授权过的角色搜索，再把结果那一行照抄进控制台的「市场」表格（类型选「玩家建筑」）。</p>
${searchForm(view.searchToken, view.searchProfiles)}</section>
${marketsSection(view)}
<p class="muted small">时间都是北京时间。本页只接受在 Koishi 所在电脑上直接打开（经 SSH 隧道也算；经反向代理、内网穿透转发的不算）${view.passphrase ? '，并且设了口令' : ''}。页面上不显示任何 EVE 令牌和 Secret Key，但也不要截图发到群里。</p>`,
  }
}

// ------------------------------------------------------------------ 按名字找建筑

export interface SearchHitView {
  id: string
  name: string
  system: string
}

export interface SearchView {
  token: string
  profiles: string[]
  profile: string
  q: string
  /** 页面上的提示（链接过期、字数不够等） */
  notice?: { tone: Tone; text: string }
  /** 搜过才有 */
  hits?: SearchHitView[]
}

function hitRow(hit: SearchHitView, profile: string): Raw {
  const id = html`<td class="row"><code>${hit.id}</code>${copyButton(hit.id)}</td>`
  // 搜得到、但看不到详情：这个角色多半不能停靠，同步会被拒绝
  if (!hit.name) {
    return html`<tr><td><span class="muted">（看不到名字）</span></td><td>—</td>${id}</tr>
<tr><td colspan="3" class="small warn">档案 ${profile} 的角色搜得到这个建筑，但看不到它的名字和星系：多半不能停靠，加进「市场」表格以后同步会被拒绝（403）。要用它的话，换一个能停靠它的角色授权以后再搜。</td></tr>`
  }
  const system = hit.system ? html`建筑所在星系「${hit.system}」` : html`建筑所在星系留空（插件会自己查）`
  return html`<tr><td><b>${hit.name}</b></td><td>${hit.system || '—'}</td>${id}</tr>
<tr><td colspan="3" class="small">加进「市场」表格这样填：名称「${hit.name}」（可以改短，群友查价时要打这个名字或别名）· 类型「玩家建筑」· 位置「<code>${hit.id}</code>」· ${system}· 授权档案「${profile}」</td></tr>`
}

export function searchPage(view: SearchView): Page {
  const notice = view.notice ? html`<div class="box ${view.notice.tone}">${view.notice.text}</div>` : ''
  let results: Raw | string = ''
  if (view.hits) {
    results = view.hits.length
      ? html`<p>用档案 ${view.profile} 搜「${view.q}」，找到 ${view.hits.length} 个：</p>
<table><tr><th>名称</th><th>星系</th><th>建筑 ID</th></tr>${view.hits.map((h) => hitRow(h, view.profile))}</table>`
      : html`<p>用档案 ${view.profile} 搜「${view.q}」，没有找到。换个写法试试（名字的一部分就行）；只能搜到这个角色能看到的建筑。</p>`
  }
  return {
    title: '按名字找建筑',
    body: html`<h1>按名字找建筑</h1>${backLink()}
<section>${searchForm(view.token, view.profiles, view.profile, view.q)}${notice}${results}</section>`,
  }
}

// ------------------------------------------------------------------ 确认页、口令、提示

export function confirmStartPage(profile: string, token: string, expired: boolean): Page {
  return {
    title: '开始授权',
    body: html`<h1>开始授权</h1>
<section>${expired ? html`<p class="warn">刚才的链接已经过期或用过了。</p>` : ''}
<p>要授权档案 <b>${profile}</b>，点下面的按钮跳到 EVE 登录页。</p>
<p><a class="btn" href="${href(SSO_START_PATH, { profile, t: token })}">授权 ${profile}</a></p></section>${backLink()}`,
  }
}

export function confirmDeletePage(profile: string, token: string, expired: boolean): Page {
  return {
    title: '删除授权档案',
    body: html`<h1>删除授权档案</h1>
<section>${expired ? html`<p class="warn">刚才的链接已经过期或用过了。</p>` : ''}
<p>确定要删除授权档案 <b>${profile}</b> 吗？删除以后，用它的建筑市场会显示「需要授权」，要用的话得重新授权。</p>
<p>插件会顺便请 EVE 撤销这次授权；想彻底放心，也可以在 EVE 账号管理页的第三方应用里撤销。</p>
<p><a class="btn danger" href="${href(ADMIN_DELETE_PATH, { profile, t: token })}">确定删除 ${profile}</a><a class="btn plain" href="${ADMIN_PAGE_PATH}">不删了</a></p></section>`,
  }
}

export function passphrasePage(wrong: boolean): Page {
  return {
    title: '输入口令',
    body: html`<h1>EVE 授权</h1>
<section><p>这个页面设了口令（控制台本插件设置里「EVE 授权 → 授权页面的口令」）。</p>
${wrong ? html`<div class="box bad">口令不对，请再试一次。</div>` : ''}
<form method="get" action="${ADMIN_PAGE_PATH}" class="row"><label>口令 <input type="password" name="key" autocomplete="current-password" required autofocus></label><button type="submit">进入</button></form>
</section>`,
  }
}

export function messagePage(title: string, tone: Tone, lines: string[], back = true): Page {
  return {
    title,
    body: html`<h1>${title}</h1><section><div class="box ${tone}">${lines.map((l, i) => html`${i ? html`<br>` : ''}${l}`)}</div></section>${back ? backLink() : ''}`,
  }
}

export function localOnlyPage(): Page {
  return messagePage('只接受本机访问', 'bad', [
    'EVE 授权页面只接受 Koishi 所在电脑的访问。',
    '请在那台电脑上（或者经 SSH 隧道）用 http://127.0.0.1:端口 或 http://localhost:端口 打开；经反向代理、内网穿透转发过来的访问不算本机。',
  ], false)
}

export function notReadyPage(): Page {
  return messagePage('插件还没准备好', 'warn', [
    '插件还在启动，或者启动时出了错。请等几秒再刷新本页；一直这样的话，看一下 Koishi 的日志。',
  ], false)
}

export function notFoundPage(): Page {
  return messagePage('没有这个页面', 'warn', ['请从 Koishi 控制台本插件设置页顶部的「打开 EVE 授权页面」进入。'], false)
}

// ------------------------------------------------------------------ 授权结果

export function callbackPage(view: CallbackView): Page {
  if (!view.ok) return messagePage(view.title, 'bad', [...view.lines, '回到授权页面，重新点「授权」再试一次。'])
  const rows = view.structures.map((s) => {
    const a = ACCESS_TEXT[s.access]
    return html`<tr><td><b>${s.market}</b></td><td>${s.name || html`<code>${s.structureId}</code>`}</td><td>${s.system || '—'}</td><td>${status(a.tone, a.label)}</td></tr>`
  })
  const table = view.structures.length
    ? html`<table><tr><th>市场</th><th>建筑</th><th>星系</th><th>结果</th></tr>${rows}</table>`
    : html`<p class="muted">还没有用这个档案的建筑市场。回到授权页面，用「按名字找建筑」找到建筑 ID，再加进控制台的「市场」表格。</p>`
  return {
    title: view.title,
    body: html`<h1>${view.title}</h1>
<section><div class="box ok">档案 <b>${view.profile}</b> 已经授权给角色「${view.characterName}」。授权已经加密保存在本机，可以关掉这个页面了。</div>
${view.lines.map((l) => html`<p>${l}</p>`)}
<h2>各建筑市场能不能访问</h2>${table}</section>${backLink()}`,
  }
}
