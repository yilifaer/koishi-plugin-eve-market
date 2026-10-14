// KB 人物卡走完整个插件：假 ESI、假 zKill、假图片服务、假浏览器（真实 HTTP，不连外网）。检查 ID / 名字 / 链接 / 别名 / 小写、
// 候选卡片和编号回复、各种失败的说法、不显示名单、范围三档、频道限速、没有浏览器和出图失败时的文字版简报、zKill 挂了照样出卡、
// @机器人 带人物链接的自动识别和优先级、回复里没有网址、单聊的额度。人物、军团、联盟、编号都是编造的。

import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRESET_MARKETS } from '../../../src/config/presets'
import { ADMIN_PAGE_PATH, KB_CHANNEL_PER_MIN, SLOW_HINT_MS, SSO_CALLBACK_PATH, SSO_START_PATH } from '../../../src/constants'
import { FakeBrowser } from '../../fakes/fake-browser'
import { FakeEsi, rawCharacter, rawKillmail, rawOrder } from '../../fakes/fake-esi'
import { FakeImages } from '../../fakes/fake-images'
import { FakeTime } from '../../fakes/fake-time'
import { FakeZkill, rawZkillKill } from '../../fakes/fake-zkill'
import { GROUP, GROUP2, MEMBER, USER } from '../../harness'
import type { Sent } from '../../harness'
import { RAVEN, THE_FORGE, TEST_START, addOrders, buttonRows, buttons, card, freePort, jitaOrders, startPlugin } from './plugin-env'
import type { EnvOptions, PluginEnv } from './plugin-env'

const HANAKO = 2119876543
const HASH = '0123456789abcdef0123456789abcdef01234567'
const LINK = `https://zkillboard.com/character/${HANAKO}/`
const KILL_LINK = 'https://zkillboard.com/kill/131234567/'
const BR = `https://br.evetools.org/br/${'1'.padStart(24, '0')}`
const CORP = 98000501

let env: PluginEnv | undefined
let zkill: FakeZkill | undefined
let images: FakeImages | undefined

afterEach(async () => {
  await env?.stop()
  await zkill?.stop()
  await images?.stop()
  env = undefined
  zkill = undefined
  images = undefined
})

/** 假 ESI 里放一个人物：Hanako Kisaragi，Moonlit Harbor Logistics [MHL]，Fictional Federation <FICT> */
function seedPilot(esi: FakeEsi, id = HANAKO, name = 'Hanako Kisaragi') {
  esi.idNames.en.set(name.toLowerCase(), { category: 'characters', id, name })
  esi.characters.set(id, rawCharacter({ name }))
  esi.corporations.set(CORP, { name: 'Moonlit Harbor Logistics', ticker: 'MHL' })
  esi.alliances.set(99000501, { name: 'Fictional Federation', ticker: 'FICT' })
  esi.corpHistory.set(id, [])
}

function seedZkill(fake: FakeZkill, id = HANAKO) {
  fake.stats.set(id, {
    shipsDestroyed: 120, shipsLost: 30, iskDestroyed: 9e9, iskLost: 1e9, soloKills: 3,
    topAllTime: [{ type: 'ship', data: [{ kills: 50, shipTypeID: 638 }] }],
  })
  fake.charKills.set(id, [rawZkillKill(131234567, HASH, { totalValue: 4e9 })])
}

interface Setup extends Omit<EnvOptions, 'zkill' | 'images'> {
  /** 控制台 KB 分组的改动 */
  kb?: Record<string, unknown>
  /** 不放浏览器 */
  noBrowser?: boolean
  browser?: FakeBrowser
  /** zKill 里不放战绩 */
  noStats?: boolean
}

async function start(setup: Setup = {}): Promise<PluginEnv & { browser: FakeBrowser }> {
  const { kb, noBrowser, noStats, esi, ...options } = setup
  const browser = setup.browser ?? new FakeBrowser()
  zkill = await new FakeZkill().start()
  images = await new FakeImages().start()
  if (!noStats) seedZkill(zkill)
  zkill.kills.set(131234567, rawZkillKill(131234567, HASH))
  const config = options.config ?? {}
  const e = await startPlugin({
    ...options,
    zkill,
    images,
    ...noBrowser ? {} : { puppeteer: browser },
    esi: (fake) => {
      seedPilot(fake)
      fake.killmails.set(131234567, { hash: HASH, mail: rawKillmail() })
      esi?.(fake)
    },
    config: { ...config, kb: { ...kb } },
  })
  env = e
  return Object.assign(e, { browser })
}

const texts = (sent: Sent[]) => sent.map((s) => s.text)
const pics = (sent: Sent[]) => sent.flatMap((s) => s.images)

/** 回复里不能出现网址、域名（卡片、文字、按钮都算） */
function noLinks(sent: Sent[]) {
  const all = [...sent.map((s) => `${s.markdown ?? ''}\n${s.text}`), ...buttons(sent)].join('\n')
  expect(all).not.toMatch(/https?:|zkillboard|evetech|\.(?:com|org|net)\b/i)
}

describe('KB: one card per query', () => {
  it('KB <ID> sends exactly one image and nothing else', async () => {
    const e = await start()
    const sent = await e.h.group(`KB ${HANAKO}`)
    expect(sent).toHaveLength(1)
    expect(pics(sent)).toHaveLength(1)
    expect(sent[0].text).toBe('')
    expect(e.browser.pages).toHaveLength(1)
    expect(e.browser.pages[0].html).toContain('Hanako Kisaragi')
    noLinks(sent)
  })

  it('a name works, case does not matter', async () => {
    const e = await start()
    expect(pics(await e.h.group('KB hanako KISARAGI'))).toHaveLength(1)
    expect(e.browser.pages[0].html).toContain('Hanako Kisaragi')
  })

  it('a zKill character link works and the link itself is never requested', async () => {
    const e = await start()
    const sent = await e.h.group(`KB ${LINK}`)
    expect(pics(sent)).toHaveLength(1)
    expect(zkill!.requests.every((r) => r.path.startsWith('/api/'))).toBe(true)
    expect(e.fake.requests.every((r) => !r.path.includes('zkillboard'))).toBe(true)
    noLinks(sent)
  })

  it('the alias 战绩 and the lowercase kb are the same command', async () => {
    const e = await start()
    expect(pics(await e.h.group(`战绩 ${HANAKO}`))).toHaveLength(1)
    expect(pics(await e.h.group(`kb ${HANAKO}`))).toHaveLength(1)
    expect(pics(await e.h.group(`Kb hanako kisaragi`))).toHaveLength(1)
    // 同一个人的成图在缓存里，只出一次
    expect(e.browser.pages).toHaveLength(1)
    expect(e.logger.at('warn').filter((l) => /冲突|重名/.test(l))).toEqual([])
  })

  it('no argument gives the usage card', async () => {
    const e = await start()
    const sent = await e.h.group('KB')
    expect(sent).toHaveLength(1)
    expect(card(sent)).toContain('KB 用法')
    expect(card(sent)).toContain('战绩')
    noLinks(sent)
  })

  it('shows in the help card', async () => {
    const e = await start()
    const help = card(await e.h.group('帮助'))
    expect(help).toContain('KB + 人物英文名、ID 或 zKill 人物链接')
    noLinks(await e.h.group('帮助'))
  })
})

describe('KB: failures', () => {
  it('an incomplete name without market authorization asks for the full name', async () => {
    const e = await start()
    const sent = await e.h.group('KB Hanako')
    expect(texts(sent)).toEqual(['欧服没有叫 “Hanako” 的人物。名字要写完整（大小写无所谓），也可以发人物 ID。'])
    expect(pics(sent)).toHaveLength(0)
    noLinks(sent)
  })

  it('a Chinese name is explained, not looked up', async () => {
    const e = await start()
    const before = e.fake.requests.length
    expect(texts(await e.h.group('KB 如月花子'))).toEqual(['欧服人物名都是英文，请写游戏里的英文名。'])
    expect(e.fake.requests.length).toBe(before)
  })

  it('a name with odd characters is rejected without a request', async () => {
    const e = await start()
    expect(texts(await e.h.group('KB ab'))).toEqual(['人物名不对：请写 3–37 个字的英文名，或者人物 ID。'])
  })

  it('an ID that is not a character', async () => {
    const e = await start()
    expect(texts(await e.h.group(`KB ${CORP}`))).toEqual(['这个 ID 不是人物（可能是军团、联盟或 NPC）。'])
  })

  it('ESI down', async () => {
    const e = await start({ esi: (fake) => fake.fault('GET', /^\/characters\/\d+$/, { status: 503 }, 50) })
    expect(texts(await e.h.group(`KB ${HANAKO}`))).toEqual(['欧服接口暂时连不上，请稍后再试。'])
  })

  it('echoed names never carry a URL', async () => {
    const e = await start()
    const sent = await e.h.group('KB evil.example.com')
    expect(texts(sent)[0]).toMatch(/链接/)
    expect(texts(sent)[0]).not.toContain('example')
    noLinks(sent)
  })
})

describe('KB: hidden list', () => {
  const hidden = [{ characterId: String(HANAKO), note: '示例', enabled: true }]

  it('answers one line by ID and by name and makes no zKill request', async () => {
    const e = await start({ kb: { hidden } })
    expect(texts(await e.h.group(`KB ${HANAKO}`))).toEqual(['这个人物的战绩不在这里显示。'])
    expect(texts(await e.h.group('KB hanako kisaragi'))).toEqual(['这个人物的战绩不在这里显示。'])
    expect(texts(await e.h.group(`KB ${LINK}`))).toEqual(['这个人物的战绩不在这里显示。'])
    expect(zkill!.requests).toEqual([])
    expect(e.browser.pages).toHaveLength(0)
  })

  it('a disabled row does not hide anyone, a bad row is a config issue', async () => {
    const e = await start({ kb: { hidden: [{ characterId: String(HANAKO), note: '', enabled: false }, { characterId: 'Hanako', note: '', enabled: true }] } })
    expect(pics(await e.h.group(`KB ${HANAKO}`))).toHaveLength(1)
    expect(e.logger.at('warn').some((l) => l.includes('不显示的人物第 2 行'))).toBe(true)
  })
})

describe('KB: scope', () => {
  const allowed = { allowedGroups: [{ groupId: GROUP, enabled: true }] }

  it('allowed: other groups get one line, the authorized group works', async () => {
    const e = await start({ kb: { scope: 'allowed' }, config: { access: allowed } })
    expect(pics(await e.h.group(`KB ${HANAKO}`))).toHaveLength(1)
    expect(texts(await e.h.group(`KB ${HANAKO}`, { channelId: GROUP2 }))).toEqual(['KB 人物卡只对授权的群和私聊开放。'])
  })

  it('allowed: a stranger in a DM gets one line, an admin does not', async () => {
    const e = await start({ kb: { scope: 'allowed' }, config: { access: { ...allowed, admins: [USER] } } })
    expect(texts(await e.h.direct(`KB ${HANAKO}`, { userId: MEMBER }))).toEqual(['KB 人物卡只对授权的群和私聊开放。'])
    expect(pics(await e.h.direct(`KB ${HANAKO}`))).toHaveLength(1)
  })

  it('all: everyone in every group and DM', async () => {
    const e = await start({ config: { access: allowed } })
    expect(pics(await e.h.group(`KB ${HANAKO}`, { channelId: GROUP2 }))).toHaveLength(1)
    expect(pics(await e.h.direct(`KB ${HANAKO}`, { userId: MEMBER }))).toHaveLength(1)
  })

  it('off: one line, no requests; links are not turned into cards', async () => {
    const e = await start({ kb: { scope: 'off' } })
    expect(texts(await e.h.group(`KB ${HANAKO}`))).toEqual(['KB 人物卡没有开启。'])
    const link = await e.h.group(LINK)
    expect(pics(link)).toHaveLength(0)
    expect(zkill!.requests).toEqual([])
    expect(card(await e.h.group('帮助'))).not.toContain('人物战绩卡')
  })
})

describe('KB: rate limit', () => {
  it(`${KB_CHANNEL_PER_MIN} per channel per minute, then one line until the minute is over`, async () => {
    const time = new FakeTime(TEST_START)
    const e = await start({ clock: time })
    for (let i = 0; i < KB_CHANNEL_PER_MIN; i++) expect(pics(await e.h.group(`KB ${HANAKO}`))).toHaveLength(1)
    expect(texts(await e.h.group(`KB ${HANAKO}`))).toEqual(['查得太快了，稍等一会'])
    // 别的频道不受影响
    expect(pics(await e.h.group(`KB ${HANAKO}`, { channelId: GROUP2 }))).toHaveLength(1)
    await time.advance(61_000)
    expect(pics(await e.h.group(`KB ${HANAKO}`))).toHaveLength(1)
  })

  it('malformed input does not use up the minute', async () => {
    const e = await start()
    const before = e.fake.requests.length
    for (let i = 0; i < KB_CHANNEL_PER_MIN + 1; i++) {
      expect(texts(await e.h.group('KB 如月花子'))).toEqual(['欧服人物名都是英文，请写游戏里的英文名。'])
      expect(texts(await e.h.group('KB ab'))).toEqual(['人物名不对：请写 3–37 个字的英文名，或者人物 ID。'])
      expect(texts(await e.h.group('KB bad<>name'))).not.toEqual(['查得太快了，稍等一会'])
    }
    expect(e.fake.requests.length).toBe(before)
    expect(pics(await e.h.group(`KB ${HANAKO}`))).toHaveLength(1)
  })

  it('the usage card does not use up the minute', async () => {
    const e = await start()
    for (let i = 0; i < KB_CHANNEL_PER_MIN + 2; i++) await e.h.group('KB')
    expect(pics(await e.h.group(`KB ${HANAKO}`))).toHaveLength(1)
  })
})

describe('KB: text brief', () => {
  it('no browser: a text card with the numbers, names scrubbed, no URL', async () => {
    const e = await start({ noBrowser: true })
    const sent = await e.h.group(`KB ${HANAKO}`)
    expect(sent).toHaveLength(1)
    expect(pics(sent)).toHaveLength(0)
    const text = card(sent)
    expect(text).toContain('**Hanako Kisaragi｜')
    expect(text).toContain('Moonlit Harbor Logistics')
    expect(text).toContain('Fictional Federation')
    expect(text).toContain('击毁 120 · 损失 30 · 单杀 3')
    noLinks(sent)
  })

  it('a render failure falls back to the text brief and logs the pilot ID only', async () => {
    const browser = new FakeBrowser()
    browser.shotError = 'boom'
    const e = await start({ browser })
    const sent = await e.h.group(`KB ${HANAKO}`)
    expect(pics(sent)).toHaveLength(0)
    expect(card(sent)).toContain('击毁 120')
    const warn = e.logger.at('warn').join('\n')
    expect(warn).toContain(`人物 ${HANAKO}`)
    expect(warn).not.toContain('Hanako')
  })

  it('a pilot name with a domain-like piece is scrubbed in the brief', async () => {
    const e = await start({
      noBrowser: true,
      esi: (fake) => {
        fake.idNames.en.set('mina.example.com', { category: 'characters', id: 2119876544, name: 'Mina.example.com' })
        fake.characters.set(2119876544, rawCharacter({ name: 'Mina.example.com' }))
        fake.corpHistory.set(2119876544, [])
        seedZkill(zkill!, 2119876544)
      },
    })
    // 名字里带点号，通过 ID 查
    const sent = await e.h.group('KB 2119876544')
    expect(card(sent)).toMatch(/\\\[链接\\\]/)
    expect(card(sent)).not.toContain('example')
    noLinks(sent)
  })
})

describe('KB: zKill trouble', () => {
  it('zKill down: still a card (the unknown persona), nothing extra', async () => {
    const e = await start()
    for (let i = 0; i < 6; i++) zkill!.faults.push({ kind: 'status', status: 500 })
    const sent = await e.h.group(`KB ${HANAKO}`)
    expect(sent).toHaveLength(1)
    expect(pics(sent)).toHaveLength(1)
    expect(e.browser.pages[0].html).toContain('Hanako Kisaragi')
  })

  it('zKill throttled: still a card and no extra line', async () => {
    const e = await start()
    for (let i = 0; i < 6; i++) zkill!.faults.push({ kind: 'rate-limit', retryAfter: 60 })
    const sent = await e.h.group(`KB ${HANAKO}`)
    expect(sent).toHaveLength(1)
    expect(pics(sent)).toHaveLength(1)
  })

  it('zKill down with no browser: the brief says the record is unavailable', async () => {
    const e = await start({ noBrowser: true })
    for (let i = 0; i < 6; i++) zkill!.faults.push({ kind: 'status', status: 500 })
    const sent = await e.h.group(`KB ${HANAKO}`)
    expect(card(sent)).toContain('战绩暂时取不到')
  })

  it('recent: false makes only one zKill request (the statistics)', async () => {
    const e = await start({ kb: { recent: false } })
    await e.h.group(`KB ${HANAKO}`)
    expect(zkill!.count(/\/api\/(kills|losses)\//)).toBe(0)
    expect(zkill!.count(/\/api\/stats\//)).toBeGreaterThan(0)
  })
})

describe('KB: slow and budget', () => {
  it('in a group the slow hint goes first, then the image', async () => {
    const time = new FakeTime(TEST_START)
    const browser = new FakeBrowser()
    let release!: () => void
    browser.holdShot = { promise: new Promise<void>((r) => { release = r }), open: () => release() }
    const e = await start({ browser, clock: time, scheduler: time })
    const pending = e.h.group(`KB ${HANAKO}`)
    // 假时钟：zKill 的请求间隔、图片下载都靠它推进
    await vi.waitFor(async () => { await time.advance(500); expect(browser.pages.length).toBe(1) }, { timeout: 5000 })
    await time.advance(SLOW_HINT_MS)
    await vi.waitFor(() => expect(e.h.qq.sent.map((s) => s.text)).toEqual(['⏳ 正在查询人物战绩，一般要 5–15 秒…']))
    release()
    const sent = await pending
    expect(sent).toHaveLength(2)
    expect(sent[0].text).toContain('正在查询人物战绩')
    expect(pics([sent[1]])).toHaveLength(1)
  })

  it('in a DM there is only room for the image: no slow hint', async () => {
    const time = new FakeTime(TEST_START)
    const browser = new FakeBrowser()
    let release!: () => void
    browser.holdShot = { promise: new Promise<void>((r) => { release = r }), open: () => release() }
    const e = await start({ browser, clock: time, scheduler: time })
    const pending = e.h.direct(`KB ${HANAKO}`)
    await vi.waitFor(async () => { await time.advance(500); expect(browser.pages.length).toBe(1) }, { timeout: 5000 })
    await time.advance(SLOW_HINT_MS)
    expect(e.h.qq.sent).toHaveLength(0)
    release()
    const sent = await pending
    expect(sent).toHaveLength(1)
    expect(pics(sent)).toHaveLength(1)
  })
})

describe('KB: auto', () => {
  it('@bot with a character link sends the card, handled once', async () => {
    const e = await start()
    const sent = await e.h.group(`看看这个人 ${LINK} 怎么样`)
    expect(sent).toHaveLength(1)
    expect(pics(sent)).toHaveLength(1)
    expect(e.browser.pages).toHaveLength(1)
    noLinks(sent)
  })

  it('kb.auto off: the link is not turned into a card', async () => {
    const e = await start({ kb: { auto: false } })
    const sent = await e.h.group(LINK)
    expect(pics(sent)).toHaveLength(0)
    expect(zkill!.requests).toEqual([])
    // 命令照常可用
    expect(pics(await e.h.group(`KB ${LINK}`))).toHaveLength(1)
  })

  it('a listed screenshot-site link comes before a character link', async () => {
    const e = await start()
    await e.h.group(`${LINK} ${BR}`)
    expect(e.browser.pages.map((p) => p.url)).toEqual([BR])
    expect(zkill!.requests).toEqual([])
  })

  it('a kill link comes before a character link, in either order', async () => {
    const e = await start()
    const first = await e.h.group(`${LINK} ${KILL_LINK}`)
    expect(card(first)).toContain('击杀 #131234567')
    expect(pics(first)).toHaveLength(0)
    const second = await e.h.group(`${KILL_LINK} ${LINK}`)
    expect(card(second)).toContain('击杀 #131234567')
    expect(zkill!.count(/\/api\/stats\//)).toBe(0)
  })

  it('a character link comes before item names', async () => {
    const e = await start()
    addOrders(e.fake, THE_FORGE, jitaOrders(RAVEN, 258_400_000, 249_000_000))
    const sent = await e.h.group(`乌鸦级 ${LINK}`)
    expect(pics(sent)).toHaveLength(1)
    expect(card(sent)).not.toContain('乌鸦级')
  })
})

// ------------------------------------------------------------------ 候选（需要市场授权才能模糊搜索）

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
  })
}

const unescapeHtml = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

function formToken(body: string, path: string): string {
  const at = body.indexOf(`action="${path}"`)
  const token = at < 0 ? undefined : /name="t" value="([^"]+)"/.exec(body.slice(at, body.indexOf('</form>', at)))?.[1]
  if (!token) throw new Error(`页面里没有 ${path} 的表单`)
  return unescapeHtml(token)
}

const STRUCTURE = 1_000_000_000_401
const STRUCTURE_ROW = {
  name: '联盟市场A', aliases: '前线', type: 'structure', location: String(STRUCTURE), system: '', enabled: true,
  inDefaultList: 'auto', sortOrder: 5, visibility: 'auto', authProfile: 'default', note: '',
}
const SIBLINGS: Array<[number, string]> = [[2119876601, 'Hanako Kisaragi Jr'], [2119876602, 'Hanako Aoyagi'], [HANAKO, 'Hanako Kisaragi']]

describe('KB: candidates (market authorized)', () => {
  async function authorized(kb?: Record<string, unknown>) {
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const e = await start({
      serverPort: port,
      kb,
      esi: (fake) => {
        addOrders(fake, THE_FORGE, jitaOrders(RAVEN, 258_400_000, 249_000_000))
        fake.structureInfo.set(STRUCTURE, { name: 'XX-1 - 联盟市场A', owner_id: 98_000_001, solar_system_id: 30_000_142, type_id: 35833 })
        fake.structureOrders.set(STRUCTURE, [rawOrder({ type_id: RAVEN, price: 270_000_000, location_id: STRUCTURE })])
        for (const [id, name] of SIBLINGS) {
          fake.names.set(id, { name, category: 'character' })
          fake.characters.set(id, rawCharacter({ name }))
          fake.corpHistory.set(id, [])
        }
        fake.characterSearch.set('Hanako', SIBLINGS.map(([id]) => id))
      },
      config: {
        markets: [...PRESET_MARKETS, STRUCTURE_ROW],
        sso: { clientId: 'test-client-id', clientSecret: 'test-client-secret', callbackUrl: `${base}${SSO_CALLBACK_PATH}` },
      },
    })
    const admin = await get(`${base}${ADMIN_PAGE_PATH}`, { Host: `127.0.0.1:${port}` })
    const t = formToken(admin.body, SSO_START_PATH)
    const go = await get(`${base}${SSO_START_PATH}?profile=default&t=${encodeURIComponent(t)}`, { 'Sec-Fetch-Site': 'same-origin' })
    const login = await get(go.location!)
    const callback = await get(login.location!)
    expect(callback.status).toBe(303)
    await vi.waitFor(() => expect(e.logger.lines.some((l) => /建筑市场「联盟市场A」(第一次同步完成|同步恢复正常)/.test(l.text))).toBe(true), { timeout: 5000 })
    return e
  }

  it('lists up to 8 numbered candidates with KB <ID> buttons; replying a number sends that card', async () => {
    const e = await authorized()
    const sent = await e.h.group('KB Hanako')
    expect(sent).toHaveLength(1)
    const text = card(sent)
    expect(text).toContain('可能是以下人物')
    expect(text).toContain('Hanako Kisaragi')
    expect(text).toContain('Hanako Aoyagi')
    // 名字以输入开头、短的在前
    expect(text.indexOf('Hanako Aoyagi')).toBeLessThan(text.indexOf('Hanako Kisaragi Jr'))
    expect(buttons(sent).every((b) => /=>KB \d+$/.test(b))).toBe(true)
    expect(buttonRows(sent).flat()).toHaveLength(3)
    noLinks(sent)

    // 回编号：第 3 个是 Hanako Kisaragi Jr（排序：Aoyagi、Kisaragi、Kisaragi Jr）
    const index = buttons(sent).findIndex((b) => b.endsWith(`KB ${HANAKO}`))
    const reply = await e.h.group(String(index + 1))
    expect(pics(reply)).toHaveLength(1)
    expect(e.browser.pages[0].html).toContain('Hanako Kisaragi')
  })

  it('hidden people are not listed as candidates', async () => {
    const e = await authorized({ hidden: [{ characterId: String(HANAKO), note: '', enabled: true }] })
    const text = card(await e.h.group('KB Hanako'))
    expect(text).toContain('Hanako Aoyagi')
    expect(text).not.toContain('Hanako Kisaragi\n')
    expect(buttons(await e.h.group('KB Hanako')).some((b) => b.endsWith(`KB ${HANAKO}`))).toBe(false)
  })
})
