// 击杀（zKill 击杀转战报）走完整个插件：假 zKill + 假欧服接口 + 假浏览器。检查击杀卡片（Markdown 和纯文字）、两个战报按钮、
// 「战报 击杀 …」交给截图的地址（Warbeacon 是前后各 60 分钟的范围，BR 工具是整点）、自动识别的优先级和开关、失败的说法，
// 以及回复和按钮里从不出现网址。所有编号、名字、hash 都是编造的。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOW_HINT_MS } from '../../../src/constants'
import { FakeBrowser, gate } from '../../fakes/fake-browser'
import { rawKillmail } from '../../fakes/fake-esi'
import type { FakeEsi, RawKillmail } from '../../fakes/fake-esi'
import { FakeTime } from '../../fakes/fake-time'
import { FakeZkill, rawZkillKill } from '../../fakes/fake-zkill'
import type { ZkillFault } from '../../fakes/fake-zkill'
import type { Sent } from '../../harness'
import { TEST_START, buttonRows, buttons, card, startPlugin } from './plugin-env'
import type { EnvOptions, PluginEnv } from './plugin-env'

let env: PluginEnv | undefined
let zkill: FakeZkill | undefined

afterEach(async () => {
  await env?.stop()
  await zkill?.stop()
  env = undefined
  zkill = undefined
})

const KILL = 131234567
const HASH = '0123456789abcdef0123456789abcdef01234567'
const ESI_LINK = `https://esi.evetech.net/latest/killmails/${KILL}/${HASH}/`
const ZKILL_LINK = `https://zkillboard.com/kill/${KILL}/`

/** 攻击者：最后一击的舰船用小数据集里有的乌鸦级海军型 */
const ATTACKERS: RawKillmail['attackers'] = [
  { character_id: 2112000201, corporation_id: 98000201, ship_type_id: 638, weapon_type_id: 2977, final_blow: false, damage_done: 20000, security_status: -1.2 },
  { character_id: 2112000202, corporation_id: 98000201, alliance_id: 99000201, ship_type_id: 17636, weapon_type_id: 2977, final_blow: true, damage_done: 31234, security_status: 0.5 },
]

/** 假欧服接口里放好名字（没放的名字显示「未知」） */
function names(fake: FakeEsi) {
  fake.names.set(2112000101, { name: 'Some Pilot', category: 'character' })
  fake.names.set(98000101, { name: 'Some Corp', category: 'corporation' })
  fake.names.set(99000101, { name: 'Some Alliance', category: 'alliance' })
  fake.names.set(2112000202, { name: 'Other Pilot', category: 'character' })
  fake.names.set(98000201, { name: 'Other Corp', category: 'corporation' })
  fake.names.set(99000201, { name: 'Other Alliance', category: 'alliance' })
}

interface Setup extends EnvOptions {
  /** 击杀正文（欧服格式）的改动 */
  mail?: Partial<RawKillmail>
  zkb?: Parameters<typeof rawZkillKill>[2]
  /** zKill 回老格式（只有 hash 和估值），正文要问欧服接口 */
  minimal?: boolean
  /** 不给 zKill 放这个击杀 */
  noKill?: boolean
  withNames?: boolean
}

async function start(setup: Setup = {}): Promise<PluginEnv> {
  const { zkb, minimal, noKill, withNames, mail: override, ...options } = setup
  const mail: Partial<RawKillmail> = { attackers: ATTACKERS, ...override }
  zkill = await new FakeZkill().start()
  if (!noKill) zkill.kills.set(KILL, rawZkillKill(KILL, HASH, zkb, minimal ? 'minimal' : mail))
  env = await startPlugin({
    zkill,
    esi: (fake) => {
      if (withNames !== false) names(fake)
      fake.killmails.set(KILL, { hash: HASH, mail: rawKillmail(mail) })
    },
    ...options,
  })
  return env
}

/** 回复里不能出现网址、域名（卡片、文字、按钮都算） */
function noLinks(sent: Sent[]) {
  const all = [...sent.map((s) => `${s.markdown ?? ''}\n${s.text}`), ...buttons(sent)].join('\n')
  expect(all).not.toMatch(/https?:|zkillboard|evetools|warbeacon\.net|esi\.evetech|\.(?:com|org|net)\b/i)
}

const WARBEACON = 'https://warbeacon.net/br/related/30000142/202610141134/202610141334/'
const BR_URL = 'https://br.evetools.org/related/30000142/202610141200'

describe('击杀: card', () => {
  it('Markdown card: title, loss, victim, place, EVE + Beijing time, value, attackers and final blow', async () => {
    const e = await start()
    const sent = await e.h.group(`击杀 ${KILL}`)
    expect(sent).toHaveLength(1)
    expect(card(sent)).toBe([
      '**击杀 #131234567**',
      '',
      '- 损失：乌鸦级 Raven',
      '- 受害者：Some Pilot（Some Corp / Some Alliance）',
      '- 地点：吉他 Jita 0.9 · 伏尔戈',
      '- 时间：EVE 2026-10-14 12:34 · 北京 20:34',
      '- 价值（zKill 估值） `452,000,000 ISK`（452.00M）',
      '- 参与：2 人，最后一击 Other Pilot（乌鸦级海军型 Raven Navy Issue）',
    ].join('\n'))
    noLinks(sent)
  })

  it('plain text card says the same without Markdown', async () => {
    const e = await start({ config: { display: { output: 'text' } } })
    const sent = await e.h.group(`击杀 ${KILL}`)
    const text = sent.map((s) => s.text).join('\n')
    expect(text).toContain('击杀 #131234567')
    expect(text).toContain('损失：乌鸦级 Raven')
    expect(text).toContain('受害者：Some Pilot（Some Corp / Some Alliance）')
    expect(text).toContain('时间：EVE 2026-10-14 12:34 · 北京 20:34')
    expect(text).toContain('价值（zKill 估值） 452,000,000 ISK (452.00M)')
    expect(text).toContain('参与：2 人，最后一击 Other Pilot（乌鸦级海军型 Raven Navy Issue）')
    expect(text).not.toContain('**')
    noLinks(sent)
  })

  it('a zKill link, a link with extra text and the bare id give the same card', async () => {
    const e = await start()
    const a = card(await e.h.group(`击杀 ${KILL}`))
    expect(card(await e.h.group(`击杀 ${ZKILL_LINK}`))).toBe(a)
    expect(card(await e.h.group(`击杀 zkillboard.com/kill/${KILL}`))).toBe(a)
    expect(card(await e.h.group(`击杀${KILL}`))).toBe(a)
    // 完整正文来自 zKill：只请求了一次，欧服接口只查名字
    expect(zkill!.count(/killID/)).toBe(1)
    expect(e.fake.requests.filter((r) => /killmails/.test(r.path))).toEqual([])
  })

  it('old minimal zKill format: the ESI killmail is requested and the card is the same', async () => {
    const full = await start()
    const a = card(await full.h.group(`击杀 ${KILL}`))
    await env!.stop()
    await zkill!.stop()
    const e = await start({ minimal: true })
    expect(card(await e.h.group(`击杀 ${KILL}`))).toBe(a)
    expect(e.fake.requests.filter((r) => /killmails/.test(r.path))).toHaveLength(1)
  })

  it('flags go behind the title; unknown names say 未知', async () => {
    const e = await start({ withNames: false, zkb: { npc: true, solo: true, awox: true } })
    const text = card(await e.h.group(`击杀 ${KILL}`))
    expect(text.split('\n')[0]).toBe('**击杀 #131234567 · NPC · 单杀 · 内鬼**')
    expect(text).toContain('- 受害者：未知')
    expect(text).toContain('最后一击 未知（乌鸦级海军型 Raven Navy Issue）')
  })

  it('a loss with no pilot (a structure) shows the corporation as the victim', async () => {
    const e = await start({
      mail: { victim: { corporation_id: 98000101, alliance_id: 99000101, ship_type_id: 638, damage_taken: 1000 } },
    })
    expect(card(await e.h.group(`击杀 ${KILL}`))).toContain('- 受害者：Some Corp（Some Alliance）')
  })

  it('Beijing time gets the date when it is already the next day', async () => {
    const e = await start({ mail: { killmail_time: '2026-12-31T20:10:30Z' } })
    expect(card(await e.h.group(`击杀 ${KILL}`))).toContain('- 时间：EVE 2026-12-31 20:10 · 北京 2027-01-01 04:10')
  })

  it('names that look like web addresses are scrubbed', async () => {
    const e = await start({ esi: (fake) => {
      names(fake)
      fake.names.set(2112000101, { name: 'www.evil-site.com', category: 'character' })
      fake.names.set(98000101, { name: 'Corp.org', category: 'corporation' })
    } })
    const sent = await e.h.group(`击杀 ${KILL}`)
    expect(card(sent)).toContain('受害者：\\[链接\\]（\\[链接\\] / Some Alliance）')
    noLinks(sent)
  })

  it('a wormhole kill has both buttons', async () => {
    const e = await start({ mail: { solar_system_id: 31000007 } })
    const sent = await e.h.group(`击杀 ${KILL}`)
    expect(buttons(sent)).toEqual([`BR 战报=>战报 击杀 ${KILL}`, `Warbeacon 战报=>战报 击杀 ${KILL} warbeacon`])
  })
})

describe('击杀: buttons', () => {
  it('two buttons that only contain the command word, 击杀, digits and warbeacon', async () => {
    const e = await start()
    const sent = await e.h.group(`击杀 ${KILL}`)
    expect(buttonRows(sent)).toEqual([[`BR 战报=>战报 击杀 ${KILL}`, `Warbeacon 战报=>战报 击杀 ${KILL} warbeacon`]])
    expect(sent[0].rows[0][0].primary).toBe(true)
    noLinks(sent)
  })

  it('Warbeacon switched off in the console: only the BR button', async () => {
    const e = await start({ config: { screenshot: { warbeacon: { enabled: false } } } })
    const sent = await e.h.group(`击杀 ${KILL}`)
    expect(buttons(sent)).toEqual([`BR 战报=>战报 击杀 ${KILL}`])
    expect(card(sent)).not.toContain('两个战报网站')
  })

  it('BR switched off: only the Warbeacon button; both off: no buttons and one line says why', async () => {
    const one = await start({ config: { screenshot: { br: { enabled: false } } } })
    expect(buttons(await one.h.group(`击杀 ${KILL}`))).toEqual([`Warbeacon 战报=>战报 击杀 ${KILL} warbeacon`])
    await env!.stop()
    await zkill!.stop()
    const both = await start({ config: { screenshot: { br: { enabled: false }, warbeacon: { enabled: false } } } })
    const sent = await both.h.group(`击杀 ${KILL}`)
    expect(buttons(sent)).toEqual([])
    expect(card(sent)).toContain('两个战报网站都在控制台关掉了')
  })

  it('an abyssal kill has no buttons and says there is no battle report', async () => {
    const e = await start({ mail: { solar_system_id: 32000001 } })
    const sent = await e.h.group(`击杀 ${KILL}`)
    expect(buttons(sent)).toEqual([])
    expect(card(sent)).toContain('深渊里的击杀没有对应的战报')
    expect(card(sent)).toContain('- 地点：未知')
  })

  it('with clickable = none the buttons become text lines', async () => {
    const e = await start({ config: { display: { clickable: 'none' } } })
    const sent = await e.h.group(`击杀 ${KILL}`)
    expect(buttons(sent)).toEqual([])
    expect(card(sent)).toContain(`战报 击杀 ${KILL}`)
  })
})

describe('战报 击杀: screenshot addresses', () => {
  it('warbeacon: the range form, 60 minutes before and after the kill, to the minute', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    const sent = await e.h.group(`战报 击杀 ${KILL} warbeacon`)
    expect(browser.pages.map((p) => p.url)).toEqual([WARBEACON])
    expect(sent.flatMap((s) => s.images)).toHaveLength(1)
    noLinks(sent)
  })

  it('BR tool (default and explicit): the whole hour of the kill', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    await e.h.group(`战报 击杀 ${KILL}`)
    await e.h.group(`战报 击杀 ${KILL} BR`)
    // 同一个地址 10 分钟内用缓存
    expect(browser.pages.map((p) => p.url)).toEqual([BR_URL])
  })

  it('a zKill link, an ESI link and the short site words (any case) work too', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    await e.h.group(`战报 ${ZKILL_LINK} WB`)
    expect(browser.pages.map((p) => p.url)).toEqual([WARBEACON])
    // 欧服链接不问 zKill
    const before = zkill!.requests.length
    await e.h.group(`战报 ${ESI_LINK}`)
    expect(browser.pages.map((p) => p.url)).toEqual([WARBEACON, BR_URL])
    expect(zkill!.requests.length).toBe(before)
  })

  it('the old forms still work and a bad kill id is explained', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    await e.h.group('战报 https://br.evetools.org/related/30000142/202610061900')
    expect(browser.pages.map((p) => p.url)).toEqual(['https://br.evetools.org/related/30000142/202610061900'])
    const bad = await e.h.group('战报 击杀 abc')
    expect(bad.map((s) => s.text)).toEqual(['击杀编号不对：请写 zKill 击杀链接，或者纯数字的击杀编号。'])
    expect(card(await e.h.group('战报'))).toContain('战报 击杀 编号')
  })

  it('a site switched off in the console is refused without asking zKill', async () => {
    const e = await start({ puppeteer: new FakeBrowser(), config: { screenshot: { warbeacon: { enabled: false } } } })
    const sent = await e.h.group(`战报 击杀 ${KILL} warbeacon`)
    expect(sent.map((s) => s.text)).toEqual(['这个战报网站在控制台关掉了'])
    expect(zkill!.requests).toEqual([])
  })

  it('an abyssal kill has no battle report; without puppeteer the usual notice', async () => {
    const abyss = await start({ puppeteer: new FakeBrowser(), mail: { solar_system_id: 32000001 } })
    expect((await abyss.h.group(`战报 击杀 ${KILL}`)).map((s) => s.text)).toEqual(['这个击杀在深渊里，没有对应的战报。'])
    await env!.stop()
    await zkill!.stop()
    const none = await start()
    expect((await none.h.group(`战报 击杀 ${KILL}`)).map((s) => s.text)).toEqual(['截图服务没有启动，请联系管理员。'])
    expect(zkill!.requests).toEqual([])
  })

  it('screenshot failures use the usual wording', async () => {
    const browser = new FakeBrowser()
    browser.sites.set(BR_URL, { status: 404 })
    const e = await start({ puppeteer: browser })
    expect((await e.h.group(`战报 击杀 ${KILL}`)).map((s) => s.text)).toEqual(['战报页面打不开（网站返回 404），链接可能失效。'])
  })

  it('a slow screenshot gets the usual hint after 3 seconds', async () => {
    const time = new FakeTime(TEST_START)
    const browser = new FakeBrowser()
    browser.holdGoto = gate()
    const e = await start({ puppeteer: browser, clock: time, scheduler: time })
    const pending = e.h.group(`战报 击杀 ${KILL}`)
    await vi.waitFor(() => expect(browser.pages).toHaveLength(1))
    await time.advance(SLOW_HINT_MS)
    await vi.waitFor(() => expect(e.h.qq.sent.map((s) => s.text)).toEqual(['⏳ 正在截取战报，一般要 10–30 秒…']))
    browser.holdGoto.open()
    const sent = await pending
    expect(sent.at(-1)!.images).toHaveLength(1)
  })
})

describe('击杀: failures', () => {
  const failWith = async (fault: ZkillFault, extra: Setup = {}) => {
    const e = await start(extra)
    zkill!.faults.push(fault)
    return e.h.group(`击杀 ${KILL}`)
  }

  it('not in zKill (wrong id or too new)', async () => {
    const sent = await failWith({ kind: 'raw', body: '[]' })
    expect(sent.map((s) => s.text)).toEqual(['zKill 上没有这个击杀（编号不对，或者刚发生还没收录，过几分钟再试）。'])
    expect(buttons(sent)).toEqual([])
  })

  it('zKill unreachable', async () => {
    const sent = await failWith({ kind: 'status', status: 500, body: 'oops' })
    expect(sent.map((s) => s.text)).toEqual(['zKill 暂时连不上，请稍后再试。'])
    noLinks(sent)
  })

  it('throttled: waits as long as Retry-After says, at least one minute', async () => {
    const sent = await failWith({ kind: 'rate-limit', retryAfter: 150 })
    expect(sent.map((s) => s.text)).toEqual(['zKill 让我们慢一点，请 3 分钟后再试。'])
    // 被拦的验证页同样
    await env!.stop()
    await zkill!.stop()
    expect((await failWith({ kind: 'challenge' })).map((s) => s.text)).toEqual(['zKill 让我们慢一点，请 5 分钟后再试。'])
  })

  it('zKill answers in the old format and the ESI killmail is gone: the EU server wording', async () => {
    const e = await start({ minimal: true })
    e.fake.killmails.clear()
    const sent = await e.h.group(`击杀 ${KILL}`)
    expect(sent.map((s) => s.text)).toEqual(['欧服接口暂时取不到击杀详情，请稍后再试。'])
  })

  it('an ESI link nobody knows', async () => {
    const e = await start()
    e.fake.killmails.clear()
    const sent = await e.h.group(`击杀 ${ESI_LINK}`)
    expect(sent.map((s) => s.text)).toEqual(['欧服接口里没有这个击杀（链接不对，或者击杀还没收录）。'])
  })

  it('no argument: usage; a wrong argument: one sentence', async () => {
    const e = await start()
    expect(card(await e.h.group('击杀')).split('\n')[0]).toBe('**击杀用法**')
    expect((await e.h.group('击杀 123abc')).map((s) => s.text)).toEqual(['击杀编号不对：请写 zKill 击杀链接，或者纯数字的击杀编号。'])
    expect((await e.h.group('击杀 https://zkillboard.com/character/123/')).map((s) => s.text)).toEqual(['击杀编号不对：请写 zKill 击杀链接，或者纯数字的击杀编号。'])
    expect(zkill!.requests).toEqual([])
  })
})

describe('击杀: automatic detection', () => {
  const NONE = ''

  it('@bot with a zKill link in the text: the card, and the link is not echoed', async () => {
    const e = await start()
    const sent = await e.h.group(`你们看这个 ${ZKILL_LINK} 好惨`)
    expect(card(sent)).toContain('**击杀 #131234567**')
    expect(buttons(sent)).toHaveLength(2)
    noLinks(sent)
    // 私聊也一样
    expect(card(await e.h.direct(ZKILL_LINK))).toContain('**击杀 #131234567**')
  })

  it('an ESI link in the text works and does not ask zKill (no value line)', async () => {
    const e = await start()
    const sent = await e.h.group(`看 ${ESI_LINK}`)
    expect(card(sent)).toContain('**击杀 #131234567**')
    expect(card(sent)).not.toContain('价值')
    expect(zkill!.requests).toEqual([])
    noLinks(sent)
  })

  it('priority: a listed site link first, then the zKill link, then item names', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    // 名单里的网站（BR 工具）在前：只截图，不出击杀卡片，也不问 zKill
    const shot = await e.h.group(`${ZKILL_LINK} https://br.evetools.org/related/30000142/202610061900`)
    expect(browser.pages.map((p) => p.url)).toEqual(['https://br.evetools.org/related/30000142/202610061900'])
    expect(shot.flatMap((s) => s.images)).toHaveLength(1)
    expect(card(shot)).not.toContain('击杀 #')
    expect(zkill!.requests).toEqual([])
    // 击杀链接排在物品名前面
    const sent = await e.h.group(`乌鸦级 ${ZKILL_LINK}`)
    expect(card(sent)).toContain('**击杀 #131234567**')
    expect(card(sent)).not.toContain('出售价')
    // 只有物品名：照旧查价
    expect(card(await e.h.group('乌鸦级'))).not.toContain('击杀 #')
  })

  it('a message is handled once: two kill links give one card for the first', async () => {
    const e = await start()
    const sent = await e.h.group(`${ZKILL_LINK} https://zkillboard.com/kill/999/`)
    expect(sent).toHaveLength(1)
    expect(zkill!.count(/killID\/131234567/)).toBe(1)
    expect(zkill!.count(/killID\/999/)).toBe(0)
  })

  it('killAuto off: nothing triggers, but the command still works', async () => {
    const e = await start({ config: { screenshot: { killAuto: false } } })
    const sent = await e.h.group(`你们看这个 ${ZKILL_LINK} 好惨`)
    expect(card(sent)).not.toContain('击杀 #')
    expect(zkill!.requests).toEqual([])
    expect(card(await e.h.group(`击杀 ${KILL}`))).toContain('**击杀 #131234567**')
  })

  it('not addressed to the bot: nothing; replies never contain links', async () => {
    const e = await start()
    expect(await e.h.group(ZKILL_LINK, { at: false })).toEqual([])
    expect(zkill!.requests).toEqual([])
    noLinks(await e.h.group(`${NONE}${ZKILL_LINK}`))
  })
})

describe('help', () => {
  it('the main help has one line for 击杀 and the 战报 help mentions 战报 击杀 编号', async () => {
    const e = await start()
    expect(card(await e.h.group('帮助'))).toContain('击杀 + zKill 击杀链接或编号')
    expect(card(await e.h.group('帮助 战报'))).toMatch(/战报 击杀 \\?<编号/)
  })
})
