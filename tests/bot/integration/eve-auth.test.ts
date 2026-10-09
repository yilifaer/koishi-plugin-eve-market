// EVE 授权和联盟建筑市场走完整个插件：真实的 Koishi + server 插件（经真实的 HTTP 打开授权页面）、内存数据库、
// 本机的假 ESI 兼假 EVE 登录服务器。授权 → 建筑市场同步 → 授权群里查价能看到建筑价格、别的群看不到；
// 授权或停靠权限异常时这个市场写「暂时不可用」，其他市场照常回答；「市场状态」「市场授权」只回应管理员。
// 页面、消息、日志、数据库里都找不到任何 token、授权码和 Client Secret。所有 ID 和名字都是编造的。

import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { PRESET_MARKETS } from '../../../src/config/presets'
import { ADMIN_PAGE_PATH, SSO_CALLBACK_PATH, SSO_START_PATH } from '../../../src/constants'
import { AesSecretBox, dataDir, loadSecretKey } from '../../../src/bot/ports'
import { AUTH_TABLE, SEALED_PATTERN } from '../../../src/storage'
import { rawOrder } from '../../fakes/fake-esi'
import type { FakeEsi } from '../../fakes/fake-esi'
import { GROUP, GROUP2, MEMBER, MEMBER2, USER } from '../../harness'
import { RAVEN, THE_FORGE, addOrders, buttonRows, card, freePort, jitaOrders, startPlugin, testClock } from './plugin-env'
import type { EnvOptions, PluginEnv } from './plugin-env'

const STRUCTURE = 1_000_000_000_401
const SYSTEM_XX1 = 30_000_142

let env: PluginEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

interface Reply {
  status: number
  location?: string
  body: string
}

function get(url: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
  })
}

const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

/** 页面里指向 path 的那个表单的一次性令牌 */
function formToken(body: string, path: string): string {
  const at = body.indexOf(`action="${path}"`)
  const end = body.indexOf('</form>', at)
  const token = at < 0 ? undefined : /name="t" value="([^"]+)"/.exec(body.slice(at, end))?.[1]
  if (!token) throw new Error(`页面里没有 ${path} 的表单`)
  return unescape(token)
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

interface AuthEnv {
  e: PluginEnv
  port: number
  base: string
  /** 浏览器那一段：打开授权页面 → 点「授权 default」→ 假 EVE 登录页 → 回调 → 结果页 */
  authorize(): Promise<Reply>
}

const structureRow = {
  name: '联盟市场A', aliases: '前线', type: 'structure', location: String(STRUCTURE), system: '', enabled: true,
  inDefaultList: 'auto', sortOrder: 5, visibility: 'auto', authProfile: 'default', note: '',
}

function ravenOrders(fake: FakeEsi) {
  addOrders(fake, THE_FORGE, jitaOrders(RAVEN, 258_400_000, 249_000_000))
  fake.structureInfo.set(STRUCTURE, { name: 'XX-1 - 联盟市场A', owner_id: 98_000_001, solar_system_id: SYSTEM_XX1, type_id: 35833 })
  fake.structureOrders.set(STRUCTURE, [
    rawOrder({ type_id: RAVEN, price: 270_000_000, location_id: STRUCTURE }),
    rawOrder({ type_id: RAVEN, price: 275_000_000, location_id: STRUCTURE }),
    rawOrder({ type_id: RAVEN, price: 240_000_000, location_id: STRUCTURE, is_buy_order: true, range: 'station' }),
  ])
}

async function start(options: Pick<EnvOptions, 'esi' | 'clock' | 'help'> & { sso?: Record<string, string> } = {}): Promise<AuthEnv> {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let fakeRef: FakeEsi | undefined
  const e = await startPlugin({
    serverPort: port,
    clock: options.clock,
    help: options.help,
    esi: (fake) => {
      fakeRef = fake
      ravenOrders(fake)
      options.esi?.(fake)
    },
    config: {
      markets: [...PRESET_MARKETS, structureRow],
      access: { admins: [MEMBER, USER], allowedGroups: [{ groupId: GROUP, enabled: true }] },
      sso: {
        clientId: 'test-client-id', clientSecret: 'test-client-secret', callbackUrl: `${base}${SSO_CALLBACK_PATH}`, ...options.sso,
      },
    },
  })
  env = e
  const fake = fakeRef!
  return {
    e,
    port,
    base,
    async authorize() {
      const admin = await get(`${base}${ADMIN_PAGE_PATH}`, { Host: `127.0.0.1:${port}` })
      expect(admin.status).toBe(200)
      const t = formToken(admin.body, SSO_START_PATH)
      const go = await get(`${base}${SSO_START_PATH}?profile=default&t=${encodeURIComponent(t)}`, { 'Sec-Fetch-Site': 'same-origin' })
      expect(go.status).toBe(302)
      expect(go.location!.startsWith(`${fake.base}/v2/oauth/authorize?`)).toBe(true)
      const login = await get(go.location!)
      expect(login.status).toBe(302)
      expect(login.location!.startsWith(`${base}${SSO_CALLBACK_PATH}?`)).toBe(true)
      const callback = await get(login.location!)
      expect(callback.status).toBe(303)
      return get(new URL(callback.location!, base).toString())
    },
  }
}

/** 测试里出现过的所有秘密：Client Secret、授权码、发出去的全部 token */
function secretsOf(fake: FakeEsi): string[] {
  const out = new Set<string>([fake.sso.clientSecret, ...fake.accessTokens, ...fake.refreshTokens])
  for (const r of fake.requests) {
    const form = new URLSearchParams(r.body)
    for (const name of ['code', 'refresh_token', 'token']) {
      const value = form.get(name)
      if (value) out.add(value)
    }
    const code = r.query.get('code')
    if (code) out.add(code)
    const bearer = r.headers.authorization
    if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) out.add(bearer.slice(7))
  }
  return [...out].filter((s) => s.length >= 6)
}

/** 第一次查价时试过一次（需要授权），所以授权后的第一次同步记成「恢复正常」 */
const synced = (e: PluginEnv) => e.logger.lines.some((l) => /建筑市场「联盟市场A」(第一次同步完成|同步恢复正常)/.test(l.text))

describe('EVE 授权 → 建筑市场 → 查价', () => {
  it('authorizes through the web routes, syncs the structure and shows its prices only in the allowed group', async () => {
    const { e, authorize } = await start()

    // 授权之前：建筑市场写「暂时不可用」，Jita 照常
    const before = card(await e.h.group('查价 乌鸦级'))
    expect(before).toContain('**Jita 4-4**\n\n- 出售 `258,400,000 ISK`')
    expect(before).toContain('**联盟市场A**')
    expect(before).toContain('市场数据暂时不可用（ESI 授权或建筑访问权限异常）')
    expect(card(await e.h.direct('市场状态'))).toContain('联盟市场A：🟡 需要授权（授权页面里的档案 default）')
    expect(e.fake.count(/^\/markets\/structures\//)).toBe(0)

    const result = await authorize()
    expect(result.status).toBe(200)
    expect(result.body).toContain('授权成功')
    expect(result.body).toContain('Test Pilot')
    expect(result.body).toContain('XX-1 - 联盟市场A')
    expect(result.body).toContain('可以访问')

    // 授权成功后马上同步一次
    await until(() => synced(e))
    const sent = await e.h.group('查价 乌鸦级')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toContain('**联盟市场A**\n\n- 出售 `270,000,000 ISK`（270.00M）▲4.5%\n- 中间 `255,000,000 ISK`（255.00M）\n- 收购 `240,000,000 ISK`（240.00M）▼3.6%')
    expect(card(await e.h.group('查价 前线 乌鸦级'))).toContain('**联盟市场A**')

    // 别的群：和这个市场不存在一样
    const other = card(await e.h.group('查价 乌鸦级', { channelId: GROUP2 }))
    expect(other).toContain('**Jita 4-4**')
    expect(other).not.toContain('联盟市场A')
    expect(card(await e.h.group('查价 联盟市场A 乌鸦级', { channelId: GROUP2 }))).toContain('未知市场：联盟市场A')

    // 管理员看状态
    const status = card(await e.h.direct('市场状态'))
    expect(status).toMatch(/联盟市场A：🟢 正常 · 建筑市场 · 同步于 \d\d:\d\d · 1 页 3 单/)
    expect(status).toMatch(/授权档案 default：🟢 令牌有效 · 权限 3\/3 · 刷新于 \d\d:\d\d/)
    expect(status).toContain('Jita 4-4：🟢 正常 · NPC 市场 · 最近请求')
    expect(status).not.toContain('授权页面：需要')
    const auth = card(await e.h.direct('市场授权'))
    expect(auth).toMatch(/default：🟢 正常 · 角色「Test Pilot」· 权限 3\/3 · 刷新于 \d\d:\d\d/)
    expect(auth).toContain('使用的市场：联盟市场A')

    // 数据库里只有密文；消息、日志、数据库里都没有秘密
    const rows = await e.h.app.database.get(AUTH_TABLE, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].refreshToken).toMatch(SEALED_PATTERN)
    const seen = [before, status, auth, card(sent), result.body, JSON.stringify(rows), e.logger.lines.map((l) => l.text).join('\n')].join('\n')
    const secrets = secretsOf(e.fake)
    expect(secrets.length).toBeGreaterThan(3)
    for (const secret of secrets) expect(seen).not.toContain(secret)
  })

  it('a structure without docking access answers 暂时不可用 while the other markets still answer', async () => {
    const { e, authorize } = await start({ esi: (fake) => fake.forbiddenStructures.add(STRUCTURE) })
    const result = await authorize()
    expect(result.body).toContain('授权成功')
    expect(result.body).toContain('没有权限')
    await until(() => e.fake.count(/^\/markets\/structures\//) > 0 && e.logger.at('warn').some((t) => t.includes('建筑市场「联盟市场A」')))

    const sent = await e.h.group('查价 乌鸦级')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toContain('**Jita 4-4**\n\n- 出售 `258,400,000 ISK`')
    expect(sent[0].markdown).toContain('**联盟市场A**')
    expect(sent[0].markdown).toContain('市场数据暂时不可用（ESI 授权或建筑访问权限异常）')
    expect(sent[0].markdown).not.toContain('270,000,000')

    const status = card(await e.h.group('市场状态'))
    expect(status).toMatch(/联盟市场A：🔴 授权异常 · 还没有成功过\n {4}- 403（没有建筑访问权限）· \d\d:\d\d/)
    // 档案本身没问题：只标这一个建筑
    expect(status).toMatch(/授权档案 default：🟢 令牌有效/)
  })

  it('a revoked refresh token hides the old prices and asks to re-authorize', async () => {
    // 建筑订单马上过期：「市场状态 刷新」会重新同步它（没过期的不重拉）。时钟可以往后拨
    const base = testClock()
    let shift = 0
    const { e, authorize } = await start({ esi: (fake) => { fake.maxAge.orders = 0 }, clock: { now: () => base.now() + shift } })
    await authorize()
    await until(() => synced(e))
    expect(card(await e.h.group('查价 乌鸦级'))).toContain('270,000,000')

    // 授权被撤销，access token 也作废：「市场状态 刷新」时重新同步，ESI 回 401，档案刷新时发现刷新令牌失效
    // （刚换来不到 10 秒的 token 被拒时不重复刷新，所以先把时钟拨后一分钟）
    e.fake.refreshTokens.clear()
    for (const token of [...e.fake.accessTokens]) e.fake.expire(token)
    shift = 60_000
    const refreshed = card(await e.h.direct('市场状态 刷新'))
    expect(refreshed).toContain('刷新结果：')
    expect(refreshed).toContain('授权档案 default：🔴 需要重新授权')
    expect(refreshed).toContain('刷新令牌失效')

    const sent = card(await e.h.group('查价 乌鸦级'))
    expect(sent).toContain('**Jita 4-4**\n\n- 出售 `258,400,000 ISK`')
    expect(sent).toContain('市场数据暂时不可用（ESI 授权或建筑访问权限异常）')
    expect(sent).not.toContain('270,000,000')
    expect(card(await e.h.direct('市场授权'))).toMatch(/default：🔴 需要重新授权[\s\S]*刷新令牌失效/)
  })
})

describe('停用插件（控制台保存配置）的时候正在刷新', () => {
  it('the refresh still finishes and the rotated refresh token is saved, so the reloaded plugin keeps working', async () => {
    const base = testClock()
    let shift = 0
    const { e, authorize } = await start({ esi: (fake) => { fake.maxAge.orders = 0 }, clock: { now: () => base.now() + shift } })
    await authorize()
    await until(() => synced(e))
    const before = (await e.h.app.database.get(AUTH_TABLE, {}))[0].refreshToken

    // access token 到期：「市场状态 刷新」重新同步建筑，要先刷新；刷新请求卡在 EVE 那边
    const refreshGrant = (r: { body: string }) => new URLSearchParams(r.body).get('grant_type') === 'refresh_token'
    const release = e.fake.hold(/^\/v2\/oauth\/token$/, refreshGrant)
    const calls = e.fake.count(/^\/v2\/oauth\/token$/, 'POST')
    shift = 20 * 60_000
    const pending = e.h.direct('市场状态 刷新')
    await until(() => e.fake.count(/^\/v2\/oauth\/token$/, 'POST') === calls + 1)

    // 这时插件被停用；EVE 随后换出新的 refresh token（旧的作废）
    e.plugin().dispose()
    release()
    await pending
    // 刷新照样做完：数据库里存的是 EVE 新换出来、还有效的那个
    const box = new AesSecretBox(await loadSecretKey(dataDir(e.h.app)))
    const stored = async () => box.open((await e.h.app.database.get(AUTH_TABLE, {}))[0].refreshToken)
    const end = Date.now() + 5000
    while (!e.fake.refreshTokens.has(await stored()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(e.fake.refreshTokens.has(await stored())).toBe(true)
    expect((await e.h.app.database.get(AUTH_TABLE, {}))[0].refreshToken).not.toBe(before)
    expect(e.logger.at('warn').join('\n')).not.toContain('没能写进数据库')
  })
})

describe('市场状态 / 市场授权', () => {
  it('only admins get an answer, and only in a direct chat or an allowed group', async () => {
    const { e } = await start()
    // 不是管理员：不回复（和命令不存在一样）
    expect(await e.h.group('市场状态', { userId: MEMBER2 })).toEqual([])
    expect(await e.h.group('市场授权', { userId: MEMBER2 })).toEqual([])
    // 管理员在没授权的群里：也不回复
    expect(await e.h.group('市场状态', { channelId: GROUP2 })).toEqual([])
    // 管理员在授权群里、单聊里：回复
    const status = await e.h.group('市场状态')
    expect(status).toHaveLength(1)
    expect(card(status)).toMatch(/^\*\*数据状态\*\* · \d\d:\d\d\n\n- Jita 4-4：🟢 正常 · NPC 市场 · 还没有人查/)
    expect(card(status)).toContain('物品数据：SDE build')
    expect(card(status)).toContain('配置问题：市场第 6 行「联盟市场A」使用的授权档案 default 还没有授权')
    expect(card(status)).toContain('命令冲突：无')
    expect(buttonRows(status)).toEqual([['立即刷新=>市场状态 刷新', '市场授权=>市场授权']])
    const auth = await e.h.direct('市场授权')
    expect(card(auth)).toBe([
      '**EVE 授权档案**',
      '',
      '- default：🟡 需要授权',
      '    - 使用的市场：联盟市场A',
      '',
      '要授权或重新授权：在浏览器里打开 Koishi 控制台，进本插件的设置页，点最上面的「打开 EVE 授权页面」。',
    ].join('\n'))
    expect(buttonRows(auth)).toEqual([['市场状态=>市场状态']])
  })

  it('without the server plugin both say so', async () => {
    const e = await startPlugin({
      config: { markets: [...PRESET_MARKETS, structureRow], access: { admins: [USER] } },
    })
    env = e
    const status = card(await e.h.direct('市场状态'))
    expect(status).toContain('授权页面：需要 Koishi 的 server 插件')
    expect(status).toContain('联盟市场A：🟡 需要授权（控制台「EVE 授权」里还没填 Client ID 和 Secret Key）')
    const auth = card(await e.h.direct('市场授权'))
    expect(auth).toContain('控制台「EVE 授权」里还没填 Client ID 和 Secret Key。')
    expect(auth).toContain('授权页面：需要 Koishi 的 server 插件')
  })

  it('Koishi\'s own help never mentions them to someone who is not an admin here', async () => {
    const { e } = await start({ help: true })
    const asked = ['help -H', 'help 市场状态', 'help 市场授权', '市场状态 -h', '市场授权 -h', 'help', '市场状态', '市场授权']
    const others: Array<{ channelId?: string; userId?: string }> = [{ userId: MEMBER2 }, { userId: MEMBER2, channelId: GROUP2 }, { channelId: GROUP2 }]
    for (const who of others) {
      for (const text of asked) {
        const reply = card(await e.h.group(text, who))
        expect(reply, `${text} ${JSON.stringify(who)}`).not.toMatch(/市场状态|市场授权/)
      }
    }
    for (const text of asked) expect(card(await e.h.direct(text, { userId: MEMBER2 })), text).not.toMatch(/市场状态|市场授权/)
    // 「help 市场状态」和问一个不存在的命令一样
    expect(card(await e.h.group('help 市场状态', { userId: MEMBER2 }))).toBe(card(await e.h.group('help 没有这个命令', { userId: MEMBER2 })))

    // 管理员在授权群、单聊里照常
    expect(card(await e.h.group('help -H'))).toContain('市场状态')
    expect(card(await e.h.group('市场状态 -h'))).toContain('市场状态')
    expect(card(await e.h.direct('help 市场授权'))).toContain('市场授权')
    expect(card(await e.h.group('市场状态'))).toContain('数据状态')

    // Koishi 权限等级 4 以上也算管理员（判断时用户数据已经读好）
    await e.h.authority(MEMBER2, 4)
    expect(card(await e.h.group('市场状态', { userId: MEMBER2 }))).toContain('数据状态')
    expect(card(await e.h.group('市场授权 -h', { userId: MEMBER2 }))).toContain('市场授权')
    expect(card(await e.h.group('help -H', { userId: MEMBER2 }))).toContain('市场状态')
    expect(card(await e.h.group('市场状态', { userId: MEMBER2, channelId: GROUP2 }))).toBe('')
  })

  it('help lists the admin commands only for admins', async () => {
    const { e } = await start()
    expect(card(await e.h.group('帮助'))).toContain('**管理**\n\n- 市场状态 · 市场授权（只有管理员能用）')
    expect(card(await e.h.group('帮助', { userId: MEMBER2 }))).not.toContain('市场状态')
    expect(card(await e.h.group('帮助 市场状态'))).toContain('**市场状态**（管理员）')
    expect(card(await e.h.group('帮助 市场状态', { userId: MEMBER2 }))).not.toContain('（管理员）')
  })
})
