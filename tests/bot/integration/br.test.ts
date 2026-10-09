// 战报（§2.11）走完整个插件：「战报 <链接>」和 @机器人 的消息里带链接的自动识别。浏览器是假的 puppeteer 服务：
// 按 goto 的地址决定页面高度和状态码，截图返回只有文件头的假 JPEG（Uint8Array 视图）。检查分段、截断说明、
// 慢提示、回复额度、缓存、失败的说法，以及回复里从不回显链接。战报编号都是编造的。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOW_HINT_MS } from '../../../src/constants'
import { imageSize } from '../../../src/render'
import { FakeBrowser, fakeJpeg, gate } from '../../fakes/fake-browser'
import { FakeTime } from '../../fakes/fake-time'
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

const ID = (n: number) => n.toString(16).padStart(24, '0')
/** 规范化以后的地址（截图打开的就是它） */
const BR = (n: number) => `https://br.evetools.org/br/${ID(n)}`

function browserWith(pages: Record<number, { height?: number; status?: number; error?: string }>): FakeBrowser {
  const browser = new FakeBrowser()
  for (const [n, site] of Object.entries(pages)) browser.sites.set(BR(Number(n)), site)
  return browser
}

function jpegs(sent: Sent[]): Array<{ width: number; height: number; data: Buffer }> {
  return sent.flatMap((s) => s.images).map((img) => {
    const m = /^data:image\/jpeg;base64,(.*)$/.exec(img.src)
    if (!m) throw new Error(`不是 JPEG：${img.src.slice(0, 30)}`)
    const data = Buffer.from(m[1], 'base64')
    return { ...imageSize(data)!, data }
  })
}

/** 回复里不能出现链接、域名 */
function noLinks(sent: Sent[]) {
  const all = sent.map((s) => `${s.markdown ?? ''}${s.text}`).join('\n')
  expect(all).not.toMatch(/evetools|https?:/)
}

describe('战报: command', () => {
  it('a tall page is cut into two even JPEG segments of the exact bytes, and the page is closed', async () => {
    const browser = browserWith({ 1: { height: 6000 } })
    const e = await start({ puppeteer: browser })
    const sent = await e.h.group(`战报 ${BR(1)}`)
    expect(sent).toHaveLength(2)
    const images = jpegs(sent)
    expect(images.map((i) => [i.width, i.height])).toEqual([[1440, 3000], [1440, 3000]])
    // 截图是一大块内存上的视图：交出去的只有这一段
    expect(images[0].data.equals(fakeJpeg(1440, 3000, 1))).toBe(true)
    expect(images[1].data.equals(fakeJpeg(1440, 3000, 2))).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['', ''])
    expect(browser.pages[0].url).toBe(BR(1))
    expect(browser.open).toBe(0)
    noLinks(sent)
  })

  it('a link with extra path, query and upper case opens only the normalized address', async () => {
    const browser = browserWith({ 2: { height: 1200 } })
    const e = await start({ puppeteer: browser })
    const sent = await e.h.group(`战报 HTTPS://BR.EVETOOLS.ORG/br/${ID(2).toUpperCase()}/?ref=chat#top`)
    expect(jpegs(sent).map((i) => i.height)).toEqual([1200])
    expect(browser.pages.map((p) => p.url)).toEqual([BR(2)])
  })

  it('a page longer than 8000 pixels keeps the top 8000 and says so under the last image', async () => {
    const e = await start({ puppeteer: browserWith({ 3: { height: 9500 } }) })
    const sent = await e.h.group(`战报 ${BR(3)}`)
    expect(jpegs(sent).map((i) => i.height)).toEqual([4000, 4000])
    expect(sent.map((s) => s.text)).toEqual(['', '页面过长，已截取前 8000 像素'])
  })

  it('the same link within 10 minutes comes from the cache', async () => {
    const browser = browserWith({ 4: { height: 1000 } })
    const e = await start({ puppeteer: browser })
    await e.h.group(`战报 ${BR(4)}`)
    const again = await e.h.group(`战报 ${BR(4)}`)
    expect(jpegs(again).map((i) => i.height)).toEqual([1000])
    expect(browser.pages).toHaveLength(1)
  })

  it('without puppeteer: tells to contact the admin and logs it', async () => {
    const e = await start()
    expect((await e.h.group(`战报 ${BR(5)}`)).map((s) => s.text)).toEqual(['截图服务没有启动，请联系管理员。'])
    expect(e.logger.at('warn').join('\n')).toContain('puppeteer')
  })

  it('failures: HTTP status, unreachable site, broken link, just the command', async () => {
    const e = await start({ puppeteer: browserWith({ 6: { status: 404 }, 7: { error: 'net::ERR_NAME_NOT_RESOLVED at x' } }) })
    expect((await e.h.group(`战报 ${BR(6)}`)).map((s) => s.text)).toEqual(['战报页面打不开（网站返回 404），链接可能失效。'])
    expect((await e.h.group(`战报 ${BR(7)}`)).map((s) => s.text)).toEqual(['战报网站暂时访问不了，请稍后再试。'])
    const broken = await e.h.group('战报 https://br.evetools.org/br/12345')
    expect(broken.map((s) => s.text)).toEqual(['这个战报链接的格式不对：只支持 BR 工具的战报链接（br/ 加 24 位编号，或 related/ 加星系和时间）。'])
    noLinks(broken)
    expect(card(await e.h.group('战报')).split('\n')[0]).toBe('**战报用法**')
  })

  it('a message already 200 seconds old cannot be answered in time: busy, no queueing', async () => {
    const browser = browserWith({ 8: { height: 1000 } })
    const e = await start({ puppeteer: browser })
    expect((await e.h.group(`战报 ${BR(8)}`, { ageSec: 200 })).map((s) => s.text)).toEqual(['截图繁忙，请稍后再试。'])
    expect(browser.pages).toEqual([])
  })
})

describe('战报: automatic detection', () => {
  it('@bot with a link in the text: screenshots it; the link is not echoed', async () => {
    const browser = browserWith({ 9: { height: 1500 } })
    const e = await start({ puppeteer: browser })
    const sent = await e.h.group(`看看昨晚这场 ${BR(9)} 打得怎么样`)
    expect(jpegs(sent).map((i) => i.height)).toEqual([1500])
    noLinks(sent)
  })

  it('a direct message with a link counts too', async () => {
    const e = await start({ puppeteer: browserWith({ 10: { height: 1000 } }) })
    expect(jpegs(await e.h.direct(BR(10)))).toHaveLength(1)
  })

  it('related links work; only the first valid link of a message is used', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    await e.h.group('https://br.evetools.org/related/30000142/202610061900 和 https://br.evetools.org/related/30000144/202610061900')
    expect(browser.pages.map((p) => p.url)).toEqual(['https://br.evetools.org/related/30000142/202610061900'])
  })

  it('not addressed to the bot, another command, or brAuto off: no screenshot', async () => {
    const browser = browserWith({ 11: { height: 1000 } })
    const e = await start({ puppeteer: browser })
    expect(await e.h.group(BR(11), { at: false })).toEqual([])
    await e.h.group(`查价 ${BR(11)}`)
    expect(browser.pages).toEqual([])
    await e.stop()
    env = undefined

    const off = new FakeBrowser()
    const e2 = await start({ config: { render: { brAuto: false } }, puppeteer: off })
    const sent = await e2.h.group(`看看 ${BR(11)}`)
    expect(off.pages).toEqual([])
    expect(card(sent)).not.toMatch(/evetools/)
    // 写明「战报」时照常截图
    expect(jpegs(await e2.h.group(`战报 ${BR(11)}`))).toHaveLength(1)
  })
})

describe('战报: slow hint and reply budget', () => {
  it('not done after 3 seconds: one hint, then up to two images (3 messages in a group)', async () => {
    const time = new FakeTime(TEST_START)
    const browser = browserWith({ 12: { height: 7000 } })
    browser.holdGoto = gate()
    const e = await start({ puppeteer: browser, clock: time, scheduler: time })
    const pending = e.h.group(`战报 ${BR(12)}`)
    await vi.waitFor(() => expect(browser.pages).toHaveLength(1))
    await time.advance(SLOW_HINT_MS)
    await vi.waitFor(() => expect(e.h.qq.sent.map((s) => s.text)).toEqual(['⏳ 正在截取战报，一般要 10–30 秒…']))
    browser.holdGoto.open()
    const sent = await pending
    expect(sent).toHaveLength(3)
    expect(jpegs(sent).map((i) => i.height)).toEqual([3500, 3500])
  })

  it('in a direct chat the hint leaves room for one image, and the cut is explained', async () => {
    const time = new FakeTime(TEST_START)
    const browser = browserWith({ 13: { height: 7000 } })
    browser.holdGoto = gate()
    const e = await start({ puppeteer: browser, clock: time, scheduler: time })
    const pending = e.h.direct(`战报 ${BR(13)}`)
    await vi.waitFor(() => expect(browser.pages).toHaveLength(1))
    await time.advance(SLOW_HINT_MS)
    browser.holdGoto.open()
    const sent = await pending
    expect(sent).toHaveLength(2)
    expect(sent[0].text).toBe('⏳ 正在截取战报，一般要 10–30 秒…')
    expect(jpegs(sent).map((i) => i.height)).toEqual([3500])
    expect(sent[1].text).toBe('页面过长，已截取前 3500 像素')
  })

  it('a quick screenshot in a direct chat sends both images', async () => {
    const e = await start({ puppeteer: browserWith({ 14: { height: 7000 } }) })
    const sent = await e.h.direct(`战报 ${BR(14)}`)
    expect(jpegs(sent).map((i) => i.height)).toEqual([3500, 3500])
    expect(sent.map((s) => s.text)).toEqual(['', ''])
  })

  it('a second link waits for the first one, and its hint says how many are ahead', async () => {
    const time = new FakeTime(TEST_START)
    const browser = browserWith({ 15: { height: 1000 }, 16: { height: 1000 } })
    browser.holdGoto = gate()
    const e = await start({ puppeteer: browser, clock: time, scheduler: time })
    const first = e.h.group(`战报 ${BR(15)}`)
    await vi.waitFor(() => expect(browser.pages).toHaveLength(1))
    const second = e.h.group(`战报 ${BR(16)}`, { messageId: 'BR-SECOND' })
    await time.advance(SLOW_HINT_MS)
    await vi.waitFor(() => expect(e.h.qq.sent.map((s) => s.text)).toContain('⏳ 正在截取战报，一般要 10–30 秒…（前面还有 1 个）'))
    browser.holdGoto.open()
    await Promise.all([first, second])
    // 两条消息同时在处理：按回复的是哪条消息分开
    const of = (id: string | undefined) => e.h.qq.sent.filter((s) => (s.session?.messageId === 'BR-SECOND') === (id === 'BR-SECOND'))
    expect(of(undefined).map((s) => s.text)).toEqual(['⏳ 正在截取战报，一般要 10–30 秒…', ''])
    expect(of('BR-SECOND').map((s) => s.text)).toEqual(['⏳ 正在截取战报，一般要 10–30 秒…（前面还有 1 个）', ''])
    expect(jpegs(of(undefined))).toHaveLength(1)
    expect(jpegs(of('BR-SECOND'))).toHaveLength(1)
  })
})
