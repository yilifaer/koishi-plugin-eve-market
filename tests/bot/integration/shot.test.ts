// 网站截图走完整个插件：「截图 网址」、@机器人 的自动识别（每个网站单独开关）、「战报」认战报类网站、
// 管理员的「截图测试」。浏览器是假的 puppeteer 服务（按 goto 的地址决定页面高度、状态码、标题）。
// 链接里的编号都是编造的；回复里从不出现链接和域名。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOW_HINT_MS } from '../../../src/constants'
import { imageSize } from '../../../src/render'
import type { FakeSite } from '../../fakes/fake-browser'
import { FakeBrowser, gate } from '../../fakes/fake-browser'
import { FakeTime } from '../../fakes/fake-time'
import { GROUP, MEMBER, MEMBER2, USER } from '../../harness'
import type { Sent } from '../../harness'
import { TEST_START, card, startPlugin } from './plugin-env'
import type { EnvOptions, PluginEnv } from './plugin-env'

let env: PluginEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

async function start(options: EnvOptions = {}): Promise<PluginEnv> {
  env = await startPlugin(options)
  return env
}

// 规范化以后的地址（截图打开的就是它）
const BR = `https://br.evetools.org/br/${'1'.padStart(24, '0')}`
const WAR = 'https://warbeacon.net/br/related/30000142/202610061900/'
const JANICE = 'https://janice.e-351.com/a/AbC123'
const DOTLAN = 'https://evemaps.dotlan.net/map/Delve'
const CUSTOM = 'https://kb.example.com/kill/123'
const CUSTOM_ROW = { name: '示例KB', host: 'kb.example.com', pathPrefix: '/kill/', auto: true, maxImages: 1 }

function browserWith(pages: Record<string, FakeSite>): FakeBrowser {
  const browser = new FakeBrowser()
  for (const [url, site] of Object.entries(pages)) browser.sites.set(url, site)
  return browser
}

function jpegs(sent: Sent[]): Array<{ width: number; height: number }> {
  return sent.flatMap((s) => s.images).map((img) => {
    const m = /^data:image\/jpeg;base64,(.*)$/.exec(img.src)
    if (!m) throw new Error(`不是 JPEG：${img.src.slice(0, 30)}`)
    return imageSize(Buffer.from(m[1], 'base64'))!
  })
}

/** 回复里不能出现链接、域名 */
function noLinks(sent: Sent[]) {
  const all = sent.map((s) => `${s.markdown ?? ''}${s.text}`).join('\n')
  expect(all).not.toMatch(/evetools|warbeacon|janice|dotlan|e-351|example\.com|https?:/)
}

const texts = (sent: Sent[]) => sent.map((s) => s.text)

describe('截图: command', () => {
  it.each([
    ['BR 工具', BR, BR, 6000, [3000, 3000]],
    ['Warbeacon', 'https://warbeacon.net/br/related/30000142/202610061900?x=1#top', WAR, 5000, [2500, 2500]],
    ['Janice', 'https://janice.e-351.com/a/AbC123/', JANICE, 3000, [3000]],
    ['DOTLAN', 'https://evemaps.dotlan.net/Map/Delve?x=1#top', DOTLAN, 6000, [4000]],
    ['自定义网站', 'http://KB.example.com/kill/123?x=1#top', `${CUSTOM}?x=1`, 2000, [2000]],
  ])('%s: opens only the normalized https address, 1440 wide, cut to the site limit', async (_name, link, opened, height, expected) => {
    const browser = browserWith({ [opened]: { height } })
    const e = await start({ puppeteer: browser, config: { screenshot: { custom: [CUSTOM_ROW] } } })
    const sent = await e.h.group(`截图 ${link}`)
    expect(browser.pages.map((p) => p.url)).toEqual([opened])
    expect(browser.pages[0].viewport?.width).toBe(1440)
    expect(jpegs(sent).map((i) => i.height)).toEqual(expected)
    expect(jpegs(sent).every((i) => i.width === 1440)).toBe(true)
    expect(browser.open).toBe(0)
    noLinks(sent)
  })

  it('a site not on the list, or switched off, is refused with the names of the others', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, config: { screenshot: { janice: { enabled: false } } } })
    const other = await e.h.group('截图 https://other.example.org/x')
    expect(texts(other)).toEqual(['这个网站不在截图名单里。能截的网站：BR 工具战报、Warbeacon 战报、DOTLAN 星图。'])
    noLinks(other)
    const off = await e.h.group(`截图 ${JANICE}`)
    expect(texts(off)).toEqual(['这个网站不在截图名单里。能截的网站：BR 工具战报、Warbeacon 战报、DOTLAN 星图。'])
    noLinks(off)
    expect(browser.pages).toEqual([])
  })

  it('a listed site with the wrong kind of page gets its own one-line hint', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    const cases: Array<[string, string]> = [
      ['https://janice.e-351.com/foo', '这个 Janice 估价结果链接的格式不对：只支持估价结果页。'],
      ['https://evemaps.dotlan.net/route/Jita:Amarr', '这个 DOTLAN 星图链接的格式不对：只支持星域、星系、联盟、军团页和星图。'],
      ['https://warbeacon.net/about', '这个 Warbeacon 战报链接的格式不对：只支持关联战报和单场战报页。'],
    ]
    for (const [link, line] of cases) {
      const sent = await e.h.group(`截图 ${link}`)
      expect(texts(sent)).toEqual([line])
      noLinks(sent)
    }
    // BR 沿用战报的说法
    expect(texts(await e.h.group('截图 https://br.evetools.org/br/12345'))[0]).toContain('这个战报链接的格式不对')
    expect(browser.pages).toEqual([])
  })

  it('without a link: a usage card that lists the enabled site names and no addresses', async () => {
    const e = await start({ puppeteer: new FakeBrowser(), config: { screenshot: { dotlan: { enabled: false }, custom: [CUSTOM_ROW] } } })
    const sent = await e.h.group('截图')
    const text = card(sent)
    expect(text.split('\n')[0]).toBe('**截图用法**')
    expect(text).toContain('BR 工具战报')
    expect(text).toContain('Warbeacon 战报')
    expect(text).toContain('Janice 估价结果')
    expect(text).toContain('示例KB')
    expect(text).not.toContain('DOTLAN')
    noLinks(sent)
  })

  it('the same link within 10 minutes comes from the cache', async () => {
    const browser = browserWith({ [JANICE]: { height: 1000 } })
    const e = await start({ puppeteer: browser })
    await e.h.group(`截图 ${JANICE}`)
    const again = await e.h.group(`截图 ${JANICE}`)
    expect(jpegs(again).map((i) => i.height)).toEqual([1000])
    expect(browser.pages).toHaveLength(1)
  })

  it('without puppeteer: tells to contact the admin and logs it', async () => {
    const e = await start()
    expect(texts(await e.h.group(`截图 ${JANICE}`))).toEqual(['截图服务没有启动，请联系管理员。'])
    expect(e.logger.at('warn').join('\n')).toContain('puppeteer')
  })

  it('failures: HTTP status, unreachable, verification page, redirect off the list, timeout', async () => {
    const browser = browserWith({
      'https://janice.e-351.com/a/Http404': { status: 404 },
      'https://janice.e-351.com/a/Unreach': { error: 'net::ERR_NAME_NOT_RESOLVED at x' },
      'https://janice.e-351.com/a/Verify1': { status: 403, challenge: true, title: 'Just a moment...' },
      'https://janice.e-351.com/a/Away123': { redirect: 'https://elsewhere.example.net/x' },
      'https://janice.e-351.com/a/Slow123': { timeout: true },
    })
    const e = await start({ puppeteer: browser })
    const run = async (id: string) => e.h.group(`截图 https://janice.e-351.com/a/${id}`)
    expect(texts(await run('Http404'))).toEqual(['页面打不开（网站返回 404），链接可能失效。'])
    expect(texts(await run('Unreach'))).toEqual(['网站暂时访问不了，请稍后再试。'])
    expect(texts(await run('Verify1'))).toEqual(['这个网站不让自动截图。'])
    expect(texts(await run('Away123'))).toEqual(['这个链接跳到了别的网站，没有截图。'])
    expect(texts(await run('Slow123'))).toEqual(['截图超时，链接可能失效，或者网站暂时访问不了。'])
    expect(browser.open).toBe(0)
  })

  it('a verification page that shows up while the page settles is also refused', async () => {
    const e = await start({ puppeteer: browserWith({ [DOTLAN]: { challenge: true, title: '请稍候…' } }) })
    expect(texts(await e.h.group(`截图 ${DOTLAN}`))).toEqual(['这个网站不让自动截图。'])
  })

  it('BR links keep the battle report wording for failures', async () => {
    const e = await start({ puppeteer: browserWith({ [BR]: { status: 404 } }) })
    expect(texts(await e.h.group(`截图 ${BR}`))).toEqual(['战报页面打不开（网站返回 404），链接可能失效。'])
  })

  it('a message already 200 seconds old cannot be answered in time: busy', async () => {
    const browser = browserWith({ [JANICE]: { height: 1000 } })
    const e = await start({ puppeteer: browser })
    expect(texts(await e.h.group(`截图 ${JANICE}`, { ageSec: 200 }))).toEqual(['截图繁忙，请稍后再试。'])
    expect(browser.pages).toEqual([])
  })
})

describe('截图: automatic detection', () => {
  it('@bot with a Janice link: screenshots it, unless that site has auto off', async () => {
    const browser = browserWith({ [JANICE]: { height: 1500 } })
    const e = await start({ puppeteer: browser })
    const sent = await e.h.group(`帮我看看 ${JANICE} 这个`)
    expect(jpegs(sent).map((i) => i.height)).toEqual([1500])
    noLinks(sent)
    await e.stop()
    env = undefined

    const off = new FakeBrowser()
    const e2 = await start({ puppeteer: off, config: { screenshot: { janice: { auto: false } } } })
    expect(card(await e2.h.group(`看看 ${JANICE}`))).not.toMatch(/janice/)
    expect(off.pages).toEqual([])
    // 写明「截图」时照常截图
    expect(jpegs(await e2.h.group(`截图 ${JANICE}`))).toHaveLength(1)
  })

  it('a switched-off site is not recognised at all; not addressed to the bot means nothing', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, config: { screenshot: { dotlan: { enabled: false } } } })
    await e.h.group(`看看 ${DOTLAN}`)
    expect(await e.h.group(JANICE, { at: false })).toEqual([])
    expect(browser.pages).toEqual([])
  })

  it('a custom site with auto on is recognised; the first usable link wins', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, config: { screenshot: { custom: [CUSTOM_ROW] } } })
    await e.h.group(`${CUSTOM} 还有 ${JANICE}`)
    expect(browser.pages.map((p) => p.url)).toEqual([CUSTOM])
  })

  it('a direct message with a DOTLAN link counts too', async () => {
    const e = await start({ puppeteer: browserWith({ [DOTLAN]: { height: 1000 } }) })
    expect(jpegs(await e.h.direct(DOTLAN))).toHaveLength(1)
  })

  it('a BR link still goes through 战报 (its wording), and the old switch still turns it off', async () => {
    const time = new FakeTime(TEST_START)
    const browser = browserWith({ [BR]: { height: 7000 } })
    browser.holdGoto = gate()
    const e = await start({ puppeteer: browser, clock: time, scheduler: time })
    const pending = e.h.direct(`看看 ${BR}`)
    await vi.waitFor(() => expect(browser.pages).toHaveLength(1))
    await time.advance(SLOW_HINT_MS)
    browser.holdGoto.open()
    const sent = await pending
    // 战报在单聊里发了提示就只发 1 张（和战报命令一样）
    expect(sent[0].text).toBe('⏳ 正在截取战报，一般要 10–30 秒…')
    expect(jpegs(sent)).toHaveLength(1)
    await e.stop()
    env = undefined

    const off = new FakeBrowser()
    const e2 = await start({ puppeteer: off, config: { render: { brAuto: false } } })
    await e2.h.group(`看看 ${BR}`)
    expect(off.pages).toEqual([])
  })
})

describe('战报: Warbeacon and other sites', () => {
  it('「战报」also takes a Warbeacon link', async () => {
    const browser = browserWith({ [WAR]: { height: 1200 } })
    const e = await start({ puppeteer: browser })
    const sent = await e.h.group(`战报 ${WAR}`)
    expect(jpegs(sent).map((i) => i.height)).toEqual([1200])
    expect(browser.pages.map((p) => p.url)).toEqual([WAR])
    noLinks(sent)
  })

  it('a Warbeacon link on its own (auto) uses 战报 too', async () => {
    const e = await start({ puppeteer: browserWith({ [WAR]: { height: 1000 } }) })
    expect(jpegs(await e.h.group(WAR))).toHaveLength(1)
  })

  it('「战报」with a Janice link says it is not a battle report', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    const sent = await e.h.group(`战报 ${JANICE}`)
    expect(texts(sent)).toEqual(['这不是战报链接。截别的网站请发「截图 网址」。'])
    noLinks(sent)
    expect(browser.pages).toEqual([])
  })

  it('「战报」with a bad Warbeacon link or a bad BR link keeps saying the format is wrong', async () => {
    const e = await start({ puppeteer: new FakeBrowser() })
    expect(texts(await e.h.group('战报 https://warbeacon.net/about'))).toEqual(['这个 Warbeacon 战报链接的格式不对：只支持关联战报和单场战报页。'])
    expect(texts(await e.h.group('战报 https://br.evetools.org/br/12345'))[0]).toContain('这个战报链接的格式不对')
  })

  it('BR switched off: 「战报」 says so', async () => {
    const e = await start({ puppeteer: new FakeBrowser(), config: { screenshot: { br: { enabled: false } } } })
    const sent = await e.h.group(`战报 ${BR}`)
    expect(texts(sent)).toEqual(['战报截图没有开启（控制台「截图」里关掉了）。'])
    noLinks(sent)
  })
})

describe('截图: slow hint and reply budget', () => {
  it('in a group: hint, then up to 3 images when the site allows 3', async () => {
    const time = new FakeTime(TEST_START)
    const browser = browserWith({ [JANICE]: { height: 11000 } })
    browser.holdGoto = gate()
    const e = await start({ puppeteer: browser, clock: time, scheduler: time, config: { screenshot: { janice: { maxImages: 3 } } } })
    const pending = e.h.group(`截图 ${JANICE}`)
    await vi.waitFor(() => expect(browser.pages).toHaveLength(1))
    await time.advance(SLOW_HINT_MS)
    await vi.waitFor(() => expect(texts(e.h.qq.sent)).toEqual(['⏳ 正在截图，一般要 10–30 秒…']))
    browser.holdGoto.open()
    const sent = await pending
    expect(sent).toHaveLength(4)
    expect(jpegs(sent)).toHaveLength(3)
  })

  it('in a direct chat the hint leaves room for 2 images and the cut is explained', async () => {
    const time = new FakeTime(TEST_START)
    const browser = browserWith({ [JANICE]: { height: 11000 } })
    browser.holdGoto = gate()
    const e = await start({ puppeteer: browser, clock: time, scheduler: time, config: { screenshot: { janice: { maxImages: 3 } } } })
    const pending = e.h.direct(`截图 ${JANICE}`)
    await vi.waitFor(() => expect(browser.pages).toHaveLength(1))
    await time.advance(SLOW_HINT_MS)
    browser.holdGoto.open()
    const sent = await pending
    expect(sent[0].text).toBe('⏳ 正在截图，一般要 10–30 秒…')
    expect(jpegs(sent).map((i) => i.height)).toEqual([3667, 3667])
    expect(sent.at(-1)!.text).toBe('页面过长，已截取前 7334 像素')
  })

  it('a page longer than the limit says so under the last image', async () => {
    // 假时钟：慢提示不会触发（页面稳定要等真实的几秒）
    const time = new FakeTime(TEST_START)
    const e = await start({ puppeteer: browserWith({ [DOTLAN]: { height: 9000 } }), clock: time, scheduler: time })
    const sent = await e.h.group(`截图 ${DOTLAN}`)
    expect(jpegs(sent).map((i) => i.height)).toEqual([4000])
    expect(texts(sent)).toEqual(['页面过长，已截取前 4000 像素'])
  })
})

describe('截图测试', () => {
  const admins = { access: { admins: [MEMBER, `qq:${USER}`] } }

  it('only admins have it: others get no reply at all, and the help does not list it', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, config: admins })
    expect(await e.h.group(`截图测试 ${JANICE}`, { userId: MEMBER2 })).toEqual([])
    expect(card(await e.h.group('帮助', { userId: MEMBER2 }))).not.toContain('截图测试')
    expect(browser.pages).toEqual([])
  })

  it('an admin gets a diagnostic card and then the images, and the cache is not used', async () => {
    const browser = browserWith({ [JANICE]: { height: 5000, title: '估价 AbC123' } })
    const e = await start({ puppeteer: browser, config: admins })
    const first = await e.h.group(`截图测试 ${JANICE}`)
    expect(first).toHaveLength(3)
    const text = card(first.slice(0, 1))
    expect(text).toContain('Janice 估价结果')
    expect(text).toContain('HTTP 状态')
    expect(text).toContain('200')
    expect(text).toContain('估价 AbC123')
    expect(text).toContain('5000')
    expect(jpegs(first).map((i) => i.height)).toEqual([2500, 2500])
    noLinks(first)
    // 不用缓存：再发一次又打开一个页面（普通「截图」会用缓存）
    await e.h.group(`截图测试 ${JANICE}`)
    expect(browser.pages).toHaveLength(2)
    await e.h.group(`截图 ${JANICE}`)
    expect(browser.pages).toHaveLength(2)
  })

  it('failures are explained in the card with the reason code', async () => {
    const e = await start({ puppeteer: browserWith({ [JANICE]: { status: 403, challenge: true, title: 'Just a moment...' } }), config: admins })
    const sent = await e.h.group(`截图测试 ${JANICE}`)
    const text = card(sent)
    expect(text).toContain('blocked')
    expect(text).toContain('这个网站不让自动截图。')
    noLinks(sent)
  })

  it('a successful check lists the open time and every step', async () => {
    const e = await start({ puppeteer: browserWith({ [JANICE]: { height: 1000 } }), config: admins })
    const text = card(await e.h.group(`截图测试 ${JANICE}`))
    expect(text).toMatch(/打开用时：\d+\.\d 秒/)
    expect(text).toContain('各步用时：打开页面(goto)')
    expect(text).toContain('等网络安静')
    expect(text).toContain('等页面稳定')
    expect(text).toMatch(/截图 \d+\.\d 秒/)
    expect(text).not.toContain('卡在')
  })

  it('a timeout in goto says which step it was stuck in', async () => {
    const e = await start({ puppeteer: browserWith({ [JANICE]: { timeout: true } }), config: admins })
    const sent = await e.h.group(`截图测试 ${JANICE}`)
    const text = card(sent)
    expect(text).toContain('卡在：打开页面(goto)')
    expect(text).toContain('打开用时：未知')
    expect(text).toContain('timeout')
    noLinks(sent)
  })

  it('a blocked redirect shows in the card; an unlisted site is refused like 「截图」', async () => {
    const e = await start({ puppeteer: browserWith({ [JANICE]: { redirect: 'https://elsewhere.example.net/' } }), config: admins })
    expect(card(await e.h.group(`截图测试 ${JANICE}`))).toContain('redirect')
    expect(texts(await e.h.group('截图测试 https://other.example.org/x'))[0]).toContain('这个网站不在截图名单里')
  })

  it('a title that looks like a link is not echoed', async () => {
    const e = await start({ puppeteer: browserWith({ [JANICE]: { height: 1000, title: 'see janice.e-351.com now' } }), config: admins })
    noLinks(await e.h.group(`截图测试 ${JANICE}`))
  })

  it('help lists it on its own line for admins, with a topic', async () => {
    const e = await start({ puppeteer: new FakeBrowser(), config: { access: { ...admins.access, allowedGroups: [{ groupId: GROUP, enabled: true }] } } })
    expect(card(await e.h.group('帮助'))).toContain('- 截图测试（只有管理员能用）')
    expect(card(await e.h.group('帮助 截图测试'))).toContain('**截图测试**（管理员）')
  })
})

describe('截图: help', () => {
  it('the main card has one text line and no button; 「帮助 截图」 explains it without addresses', async () => {
    const e = await start({ puppeteer: new FakeBrowser() })
    const main = await e.h.group('帮助')
    expect(main[0].markdown).toContain('- 截图 + 网址：BR 工具战报、Warbeacon 战报、Janice 估价、DOTLAN 星图')
    expect(main.flatMap((s) => s.rows).flat().map((b) => b.label)).not.toContain('截图')
    const topic = await e.h.group('帮助 截图')
    expect(card(topic)).toContain('**截图**')
    noLinks(topic)
  })
})
