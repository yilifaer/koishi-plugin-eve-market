// 走势（§2.4）走完整个插件：成交历史来自本机的假 ESI，出图用假的 puppeteer 服务（假页面返回只有文件头的 PNG），
// 有 CHROME_PATH 时再用真的 Chromium 出一张图。检查 2 条消息（图 + 小卡片）、按钮、各种降级、慢提示和回复额度。
// 历史数字都是编造的示例值。

import fs from 'node:fs'
import type { Browser } from 'puppeteer-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PRESET_MARKETS } from '../../../src/config/presets'
import { SLOW_HINT_MS } from '../../../src/constants'
import { imageSize } from '../../../src/render'
import { parseTrendArgs } from '../../../src/bot/commands/trend'
import type { RawHistory } from '../../fakes/fake-esi'
import { FakeBrowser, fakePng, gate } from '../../fakes/fake-browser'
import { FakeTime } from '../../fakes/fake-time'
import type { Sent } from '../../harness'
import {
  ALLIANCE_MARKET, MARKETS_WITH_ALLIANCE, PLEX, RAVEN, TEST_START, THE_FORGE, addOrders, buttonRows, buttons, card, jitaOrders,
  puppeteerPlugin, startPlugin,
} from './plugin-env'
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

const DAY = 86_400_000
const allowed = { allowedGroups: [{ groupId: 'C0FFEE00000000000000000000000001', enabled: true }] }

/** 2026-09-08 到 2026-10-06 每天一行：均价从 250M 每天涨 1M，成交 400 */
function ravenHistory(days = 29, first = '2026-09-08'): RawHistory[] {
  const start = Date.parse(`${first}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => {
    const average = 250_000_000 + i * 1_000_000
    return {
      date: new Date(start + i * DAY).toISOString().slice(0, 10),
      average,
      highest: average * 1.02,
      lowest: average * 0.98,
      volume: 400,
      order_count: 1000,
    }
  })
}

const withHistory = (fake: Parameters<NonNullable<EnvOptions['esi']>>[0]) => {
  fake.history.set(`${THE_FORGE}:${RAVEN}`, ravenHistory())
}

const CARD = [
  '📈 **乌鸦级 · 伏尔戈 · 近 30 天**',
  '',
  '- 最近日均价 `278,000,000 ISK`（278.00M）▲11.2%',
  '- 30 天最高 278.00M · 最低 250.00M',
  '- 日均成交 400 艘 · 日均成交额 105.60B',
  '',
  '数据是整个伏尔戈星域的成交，每天更新一次',
].join('\n')

/** 发出去的图片（data: 地址）→ MIME 和字节 */
function imageOf(sent: Sent): { mime: string; data: Buffer } {
  const src = sent.images[0]?.src ?? ''
  const m = /^data:([^;]+);base64,(.*)$/.exec(src)
  if (!m) throw new Error(`不是图片：${src.slice(0, 40)}`)
  return { mime: m[1], data: Buffer.from(m[2], 'base64') }
}

describe('走势: arguments', () => {
  it('the range is the last word (月/季/年, 月度…, 30/90/365), default 月', () => {
    expect(parseTrendArgs('乌鸦级')).toEqual({ rest: '乌鸦级', range: 'month' })
    expect(parseTrendArgs('乌鸦级 季')).toEqual({ rest: '乌鸦级', range: 'quarter' })
    expect(parseTrendArgs('Jita 乌鸦级 年度')).toEqual({ rest: 'Jita 乌鸦级', range: 'year' })
    expect(parseTrendArgs('PLEX 365')).toEqual({ rest: 'PLEX', range: 'year' })
    expect(parseTrendArgs('乌鸦级 90 天')).toEqual({ rest: '乌鸦级', range: 'quarter' })
    expect(parseTrendArgs('月')).toEqual({ rest: '', range: 'month' })
    // 名字里的数字不是范围
    expect(parseTrendArgs('Cap Booster 800')).toEqual({ rest: 'Cap Booster 800', range: 'month' })
  })
})

describe('走势: image and card', () => {
  it('two messages: a 1600×900 PNG, then the small card with the other ranges and 查价', async () => {
    const browser = new FakeBrowser()
    const e = await start({ esi: withHistory, puppeteer: browser })
    const sent = await e.h.group('走势 乌鸦级')
    expect(sent).toHaveLength(2)
    const image = imageOf(sent[0])
    expect(image.mime).toBe('image/png')
    expect(imageSize(image.data)).toEqual({ width: 1600, height: 900 })
    expect(image.data.equals(fakePng(1600, 900, 1))).toBe(true)
    expect(sent[0].markdown).toBeUndefined()
    expect(sent[1].markdown).toBe(CARD)
    expect(buttonRows(sent)).toEqual([['季度走势=>走势 乌鸦级 季', '年度走势=>走势 乌鸦级 年', '查价=>查价 乌鸦级']])
    // 出图的页面：自包含的 HTML，关掉 JavaScript，图上写「伏尔戈（Jita 4-4）」，用完就关
    const [page] = browser.pages
    expect(page.javaScript).toBe(false)
    expect(page.viewport).toEqual({ width: 800, height: 450, deviceScaleFactor: 2 })
    expect(page.html).toContain('乌鸦级 Raven')
    expect(page.html).toContain('伏尔戈（Jita 4-4）')
    expect(browser.open).toBe(0)
  })

  it('the same chart again comes from the cache: no new page', async () => {
    const browser = new FakeBrowser()
    const e = await start({ esi: withHistory, puppeteer: browser })
    await e.h.group('走势 乌鸦级')
    const again = await e.h.group('走势 乌鸦级 月')
    expect(again).toHaveLength(2)
    expect(imageOf(again[0]).data.equals(fakePng(1600, 900, 1))).toBe(true)
    expect(browser.pages).toHaveLength(1)
    expect(e.fake.count(/^\/markets\/10000002\/history$/)).toBe(1)
  })

  it('two markets in the same region each get a chart with their own title', async () => {
    const browser = new FakeBrowser()
    const region = { ...PRESET_MARKETS[1], name: '星域甲', aliases: '', type: 'region', location: 'The Forge', inDefaultList: 'no', sortOrder: 20 }
    const e = await start({ config: { markets: [...PRESET_MARKETS, region] }, esi: withHistory, puppeteer: browser })
    await e.h.group('走势 乌鸦级')
    const sent = await e.h.group('走势 星域甲 乌鸦级')
    expect(sent).toHaveLength(2)
    expect(browser.pages).toHaveLength(2)
    expect(browser.pages[0].html).toContain('伏尔戈（Jita 4-4）')
    expect(browser.pages[1].html).toContain('伏尔戈')
    expect(browser.pages[1].html).not.toContain('Jita 4-4')
    expect(imageOf(sent[0]).data.equals(fakePng(1600, 900, 2))).toBe(true)
    // 历史只取了一次（同一个星域）
    expect(e.fake.count(/^\/markets\/10000002\/history$/)).toBe(1)
  })

  it('after UTC midnight the chart is drawn again for the new window, even if the history has not changed yet', async () => {
    const browser = new FakeBrowser()
    let now = Date.UTC(2026, 9, 7, 20, 0)
    const e = await start({ esi: withHistory, puppeteer: browser, clock: { now: () => now } })
    const evening = await e.h.group('走势 乌鸦级')
    expect(browser.pages[0].html).toContain('截至 2026-10-06')
    now = Date.UTC(2026, 9, 8, 6, 0)
    const morning = await e.h.group('走势 乌鸦级')
    expect(browser.pages).toHaveLength(2)
    expect(imageOf(morning[0]).data.equals(imageOf(evening[0]).data)).toBe(false)
    // 新窗口（09/09–10/08）的第一天是 251M：图和卡片的涨跌一致
    expect(morning[1].markdown).toContain('▲10.8%')
    expect(browser.pages[1].html).toContain('▲10.8%')
    expect(evening[1].markdown).toContain('▲11.2%')
    expect(browser.pages[0].html).toContain('▲11.2%')
  })

  it('季 and 年 are other windows; the card leaves out the current range', async () => {
    const e = await start({ esi: (fake) => fake.history.set(`${THE_FORGE}:${RAVEN}`, ravenHistory(200, '2026-03-20')), puppeteer: new FakeBrowser() })
    const quarter = await e.h.group('走势 乌鸦级 季')
    expect(quarter[1].markdown?.split('\n')[0]).toBe('📈 **乌鸦级 · 伏尔戈 · 近 90 天**')
    expect(quarter[1].markdown).toContain('- 90 天最高')
    expect(buttonRows(quarter)).toEqual([['月度走势=>走势 乌鸦级 月', '年度走势=>走势 乌鸦级 年', '查价=>查价 乌鸦级']])
    const year = await e.h.group('走势 乌鸦级 年')
    expect(year[1].markdown?.split('\n')[0]).toBe('📈 **乌鸦级 · 伏尔戈 · 近 365 天**')
    expect(buttonRows(year)).toEqual([['月度走势=>走势 乌鸦级 月', '季度走势=>走势 乌鸦级 季', '查价=>查价 乌鸦级']])
  })

  it('a named NPC market uses its region and keeps the market in the buttons', async () => {
    const e = await start({ esi: (fake) => fake.history.set(`10000043:${RAVEN}`, ravenHistory()), puppeteer: new FakeBrowser() })
    const sent = await e.h.group('走势 Amarr 乌鸦级')
    expect(sent[1].markdown?.split('\n')[0]).toBe('📈 **乌鸦级 · 多美 · 近 30 天**')
    expect(buttonRows(sent)).toEqual([['季度走势=>走势 Amarr 乌鸦级 季', '年度走势=>走势 Amarr 乌鸦级 年', '查价=>查价 Amarr 乌鸦级']])
  })

  it('PLEX uses the global market', async () => {
    const e = await start({ esi: (fake) => fake.history.set(`19000001:${PLEX}`, ravenHistory()), puppeteer: new FakeBrowser() })
    const sent = await e.h.group('走势 PLEX')
    expect(sent[1].markdown?.split('\n')[0]).toBe('📈 **PLEX · 全局市场 · 近 30 天**')
    expect(sent[1].markdown).toContain('数据是全宇宙统一市场的成交，每天更新一次')
    expect(e.fake.count(/^\/markets\/19000001\/history$/)).toBe(1)
  })

  it('an implant set adds up its pieces', async () => {
    const e = await start({
      esi: (fake) => {
        for (const id of [20121, 20157, 20158, 20159, 20160, 20161]) fake.history.set(`${THE_FORGE}:${id}`, ravenHistory())
      },
      puppeteer: new FakeBrowser(),
    })
    const sent = await e.h.group('走势 高级水晶套装')
    expect(sent[1].markdown?.split('\n')[0]).toBe('📈 **高级水晶套装 · 伏尔戈 · 近 30 天**')
    // 6 件的均价相加
    expect(sent[1].markdown).toContain('- 最近日均价 `1,668,000,000 ISK`（1.67B）▲11.2%')
    // 成交量是各件加起来的；成交额是各件的成交额相加（每件 105.60B），不是总件数乘套装价
    expect(sent[1].markdown).toContain('- 日均成交 2,400 件 · 日均成交额 633.60B')
    expect(buttonRows(sent)[0][0]).toBe('季度走势=>走势 高级水晶套装 季')
  })

  it('a rarely traded item: the daily volume keeps a decimal instead of rounding to 0', async () => {
    // 30 天里 5 天各成交 1 艘，均价 95B
    const rare = ravenHistory().filter((_, i) => i % 6 === 0).map((d) => ({ ...d, average: 95e9, highest: 96e9, lowest: 94e9, volume: 1 }))
    expect(rare).toHaveLength(5)
    const e = await start({ esi: (fake) => fake.history.set(`${THE_FORGE}:${RAVEN}`, rare) })
    const sent = await e.h.group('走势 乌鸦级')
    expect(sent[0].markdown).toContain('- 日均成交 0.2 艘 · 日均成交额 16.38B')
  })

  it('the price card of a named NPC market links to its trend', async () => {
    const e = await start({ esi: (fake) => addOrders(fake, 10000043, jitaOrders(RAVEN, 250_000_000, null, { location_id: 60008494 })) })
    const sent = await e.h.group('查价 Amarr 乌鸦级')
    expect(buttonRows(sent)[0].slice(0, 2)).toEqual(['月度走势=>走势 Amarr 乌鸦级 月', '季度走势=>走势 Amarr 乌鸦级 季'])
  })
})

describe('走势: no image', () => {
  it('without puppeteer: one card with a 15-step text trend', async () => {
    const e = await start({ esi: withHistory })
    const sent = await e.h.group('走势 乌鸦级')
    expect(sent).toHaveLength(1)
    expect(sent[0].images).toEqual([])
    const lines = sent[0].markdown!.split('\n')
    expect(lines.slice(0, 5)).toEqual(CARD.split('\n').slice(0, 5))
    expect(lines[5]).toMatch(/^- 走势 [▁▂▃▄▅▆▇█]{15}$/)
    expect(lines[5]).toMatch(/^- 走势 ▁.*█$/)
    expect(e.logger.at('warn')).toEqual([])
  })

  it('puppeteer enabled after the plugin started is used from then on', async () => {
    const e = await start({ esi: withHistory })
    expect(await e.h.group('走势 乌鸦级')).toHaveLength(1)
    const browser = new FakeBrowser()
    const fork = e.h.app.plugin(puppeteerPlugin(browser))
    try {
      const sent = await e.h.group('走势 乌鸦级')
      expect(sent).toHaveLength(2)
      expect(imageOf(sent[0]).mime).toBe('image/png')
      expect(browser.pages).toHaveLength(1)
    } finally {
      fork.dispose()
    }
    // puppeteer 停用以后又回到文字卡片
    expect(await e.h.group('走势 乌鸦级 季')).toHaveLength(1)
  })

  it('a render error falls back to the text trend and is logged', async () => {
    const browser = new FakeBrowser()
    browser.shotError = 'Protocol error: Target closed'
    const e = await start({ esi: withHistory, puppeteer: browser })
    const sent = await e.h.group('走势 乌鸦级')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toMatch(/\n- 走势 [▁▂▃▄▅▆▇█]{15}\n/)
    expect(e.logger.at('warn').join('\n')).toContain('走势图出图失败')
    expect(browser.open).toBe(0)
  })

  it('an image the platform refuses: the card carries the text trend instead', async () => {
    const e = await start({ esi: withHistory, puppeteer: new FakeBrowser() })
    e.h.qq.fail({ code: 40034001, message: 'upload failed' })
    const sent = await e.h.group('走势 乌鸦级')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toMatch(/\n- 走势 [▁▂▃▄▅▆▇█]{15}\n/)
  })

  it('fewer than 3 trading days: says so, no image', async () => {
    const browser = new FakeBrowser()
    const e = await start({ esi: (fake) => fake.history.set(`${THE_FORGE}:${RAVEN}`, ravenHistory(2, '2026-10-05')), puppeteer: browser })
    const sent = await e.h.group('走势 乌鸦级')
    expect(card(sent)).toBe('📈 **乌鸦级 · 伏尔戈 · 近 30 天**\n\n近 30 天成交太少，无法绘图')
    expect(buttonRows(sent)).toEqual([['季度走势=>走势 乌鸦级 季', '年度走势=>走势 乌鸦级 年', '查价=>查价 乌鸦级']])
    expect(browser.pages).toEqual([])
  })

  it('no trades at all in the region', async () => {
    const e = await start({ puppeteer: new FakeBrowser() })
    expect(card(await e.h.group('走势 乌鸦级'))).toBe('📈 **乌鸦级 · 伏尔戈 · 近 30 天**\n\n乌鸦级在伏尔戈没有成交记录')
  })

  it('ESI failing: one line, nothing else', async () => {
    const e = await start({ esi: (fake) => fake.fault('GET', /^\/markets\/10000002\/history$/, { status: 500 }, 5) })
    const sent = await e.h.group('走势 乌鸦级')
    expect(sent.map((s) => s.text)).toEqual(['⚠ ESI 暂时没有响应，取不到成交历史，请稍后再试'])
  })
})

describe('走势: markets and items', () => {
  it('a player structure market has no history: explains and offers the Jita trend, never switches silently', async () => {
    const e = await start({ config: { markets: MARKETS_WITH_ALLIANCE, access: allowed }, esi: withHistory, puppeteer: new FakeBrowser() })
    const sent = await e.h.group(`走势 ${ALLIANCE_MARKET.name} 乌鸦级 季`)
    expect(card(sent)).toBe('联盟市场A 是玩家建筑市场，ESI 不提供成交历史')
    expect(buttonRows(sent)).toEqual([['看Jita走势=>走势 Jita 乌鸦级 季']])
    expect(e.fake.count(/history/)).toBe(0)
  })

  it('PLEX with a player structure market still shows the global market (its history does not depend on the market)', async () => {
    const e = await start({
      config: { markets: MARKETS_WITH_ALLIANCE, access: allowed },
      esi: (fake) => fake.history.set(`19000001:${PLEX}`, ravenHistory()),
      puppeteer: new FakeBrowser(),
    })
    const sent = await e.h.group(`走势 ${ALLIANCE_MARKET.name} PLEX`)
    expect(sent).toHaveLength(2)
    expect(sent[1].markdown?.split('\n')[0]).toBe('📈 **PLEX · 全局市场 · 近 30 天**')
    expect(sent[1].markdown).toContain('数据是全宇宙统一市场的成交，每天更新一次')
    // 按钮里不带玩家建筑市场
    expect(buttonRows(sent)).toEqual([['季度走势=>走势 伊甸币 季', '年度走势=>走势 伊甸币 年', '查价=>查价 伊甸币']])
    expect(e.fake.count(/^\/markets\/19000001\/history$/)).toBe(1)
  })

  it('an unknown market offers only markets with a trading history (no player structures)', async () => {
    const e = await start({ config: { markets: MARKETS_WITH_ALLIANCE, access: allowed } })
    const sent = await e.h.group('走势 TEST 乌鸦级')
    expect(card(sent)).toBe('未知市场：TEST\n\n当前可用市场：Jita（Jita 4-4） · Amarr · Dodixie · Rens · Hek')
    expect(buttons(sent)).toEqual(['Jita=>走势 Jita 乌鸦级 月', 'Amarr=>走势 Amarr 乌鸦级 月', 'Dodixie=>走势 Dodixie 乌鸦级 月', 'Rens=>走势 Rens 乌鸦级 月', 'Hek=>走势 Hek 乌鸦级 月'])
    // 查价照样列出玩家建筑市场
    expect(card(await e.h.group('查价 TEST 乌鸦级'))).toContain(ALLIANCE_MARKET.name)
  })

  it('an unknown market keeps the item and the range in its buttons', async () => {
    const e = await start()
    const sent = await e.h.group('走势 TEST 乌鸦级 年')
    expect(card(sent)).toBe('未知市场：TEST\n\n当前可用市场：Jita（Jita 4-4） · Amarr · Dodixie · Rens · Hek')
    expect(buttonRows(sent)[0][0]).toBe('Jita=>走势 Jita 乌鸦级 年')
  })

  it('several matches: numbered choices that keep the range', async () => {
    const e = await start()
    const sent = await e.h.group('走势 护盾扩展装置 II 季')
    expect(sent[0].markdown?.split('\n')[0]).toBe('**「护盾扩展装置 II」可能是以下物品，请选择：**')
    expect(buttonRows(sent)[0][0]).toBe('1=>走势 小型护盾扩展装置 II 季')
  })

  it('just the command: usage', async () => {
    const e = await start({ config: { markets: PRESET_MARKETS } })
    const sent = await e.h.group('走势')
    expect(sent[0].markdown?.split('\n')[0]).toBe('**走势用法**')
    expect(sent[0].markdown).toContain('- 走势 Amarr 乌鸦级：指定 NPC 市场（按它所在的星域）')
  })
})

describe('走势: slow hint and reply budget', () => {
  it('a first render that takes over 3 seconds sends one hint, then the image and the card', async () => {
    const time = new FakeTime(TEST_START)
    const browser = new FakeBrowser()
    browser.holdShot = gate()
    const e = await start({ esi: withHistory, puppeteer: browser, clock: time, scheduler: time })
    const pending = e.h.group('走势 乌鸦级')
    await vi.waitFor(() => expect(browser.pages[0]?.shots.length).toBe(1))
    await time.advance(SLOW_HINT_MS - 1)
    expect(e.h.qq.sent).toEqual([])
    await time.advance(1)
    await vi.waitFor(() => expect(e.h.qq.sent.map((s) => s.text)).toEqual(['⏳ 正在画走势图…']))
    browser.holdShot.open()
    const sent = await pending
    expect(sent).toHaveLength(3)
    expect(sent[1].images).toHaveLength(1)
    expect(sent[2].markdown).toBe(CARD)
  })

  it('disposing the plugin in the middle of a render closes the page and sends nothing more (like 战报)', async () => {
    const browser = new FakeBrowser()
    browser.holdShot = gate()
    const e = await start({ esi: withHistory, puppeteer: browser })
    const pending = e.h.group('走势 乌鸦级')
    await vi.waitFor(() => expect(browser.pages[0]?.shots.length).toBe(1))
    e.plugin().dispose()
    await vi.waitFor(() => expect(browser.open).toBe(0))
    browser.holdShot.open()
    await pending.catch(() => undefined)
    expect(e.h.qq.sent).toEqual([])
  })

  it('a quick render sends no hint', async () => {
    const time = new FakeTime(TEST_START)
    const e = await start({ esi: withHistory, puppeteer: new FakeBrowser(), clock: time, scheduler: time })
    expect(await e.h.group('走势 乌鸦级')).toHaveLength(2)
    expect(time.pending).toBe(0)
  })

  it('without puppeteer a slow answer is a text query: no hint', async () => {
    const time = new FakeTime(TEST_START)
    const e = await start({ esi: withHistory, clock: time, scheduler: time })
    const release = e.fake.hold(/^\/markets\/10000002\/history$/)
    try {
      const pending = e.h.group('走势 乌鸦级')
      await vi.waitFor(() => expect(e.fake.count(/history/)).toBe(1))
      await time.advance(SLOW_HINT_MS + 1)
      release()
      const sent = await pending
      expect(sent).toHaveLength(1)
      expect(sent[0].text).not.toContain('⏳')
    } finally {
      release()
    }
  })

  it('with puppeteer, a slow history answer is still a text query: no hint before a card without a chart', async () => {
    const time = new FakeTime(TEST_START)
    const browser = new FakeBrowser()
    // 没有成交历史（404），而且回得很慢
    const e = await start({ puppeteer: browser, clock: time, scheduler: time })
    const release = e.fake.hold(/^\/markets\/10000002\/history$/)
    try {
      const pending = e.h.group('走势 乌鸦级')
      await vi.waitFor(() => expect(e.fake.count(/history/)).toBe(1))
      await time.advance(SLOW_HINT_MS + 500)
      release()
      const sent = await pending
      expect(card(sent)).toBe('📈 **乌鸦级 · 伏尔戈 · 近 30 天**\n\n乌鸦级在伏尔戈没有成交记录')
      expect(browser.pages).toEqual([])
    } finally {
      release()
    }
  })

  it('a slow history followed by a cached chart: no hint either', async () => {
    const time = new FakeTime(TEST_START)
    const browser = new FakeBrowser()
    const e = await start({ esi: withHistory, puppeteer: browser, clock: time, scheduler: time })
    expect(await e.h.group('走势 乌鸦级')).toHaveLength(2)
    // 缓存过期，历史要重新取，取得很慢
    await time.advance(2 * 3600_000)
    const release = e.fake.hold(/^\/markets\/10000002\/history$/)
    try {
      const pending = e.h.group('走势 乌鸦级')
      await vi.waitFor(() => expect(e.fake.count(/history/)).toBe(2))
      await time.advance(SLOW_HINT_MS + 500)
      release()
      const sent = await pending
      expect(sent).toHaveLength(2)
      expect(sent[0].images).toHaveLength(1)
      expect(browser.pages).toHaveLength(1)
    } finally {
      release()
    }
  })

  it('in a direct chat (one message less) a slow render sends no hint, so the image and the card both fit', async () => {
    const time = new FakeTime(TEST_START)
    const browser = new FakeBrowser()
    browser.holdShot = gate()
    const e = await start({ esi: withHistory, puppeteer: browser, clock: time, scheduler: time })
    const pending = e.h.direct('走势 乌鸦级')
    await vi.waitFor(() => expect(browser.pages[0]?.shots.length).toBe(1))
    await time.advance(SLOW_HINT_MS + 1)
    browser.holdShot.open()
    const sent = await pending
    expect(sent).toHaveLength(2)
    expect(sent[0].images).toHaveLength(1)
    expect(sent[1].markdown).toBe(CARD)
  })
})

// ------------------------------------------------------------------ 真浏览器

const CHROME = process.env.CHROME_PATH
const hasChrome = !!CHROME && fs.existsSync(CHROME)

describe.skipIf(!hasChrome)('走势 with a real Chromium behind the puppeteer service', () => {
  let browser: Browser

  beforeAll(async () => {
    const puppeteer = (await import('puppeteer-core')).default
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('sends a real 1600×900 PNG and closes the page', async () => {
    const before = (await browser.pages()).length
    const e = await start({ esi: withHistory, puppeteer: { page: () => browser.newPage() } })
    const sent = await e.h.group('走势 乌鸦级')
    expect(sent).toHaveLength(2)
    const image = imageOf(sent[0])
    expect(image.mime).toBe('image/png')
    expect(imageSize(image.data)).toEqual({ width: 1600, height: 900 })
    expect(image.data.length).toBeGreaterThan(20_000)
    expect(sent[1].markdown).toBe(CARD)
    expect((await browser.pages()).length).toBe(before)
  }, 30_000)
})
