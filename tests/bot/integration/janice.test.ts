// 估价（Janice 现成估价）走完整个插件：假 Janice（真实 HTTP）+ 假浏览器。检查群里的四条回复顺序、单聊的三条加按钮、
// 慢提示丢截图、比例、没密钥 / 没权限 / 各种失败的说法、「估价 #编号」转给批量查价、自动识别和只处理一次，
// 以及假密钥只出现在请求头里，回复、按钮、日志、状态卡、配置问题里都没有，回复里没有网址。编号、名字、价格都是编造的。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOW_HINT_MS } from '../../../src/constants'
import { FakeBrowser } from '../../fakes/fake-browser'
import { FakeJanice } from '../../fakes/fake-janice'
import type { FakeItem, JaniceFault } from '../../fakes/fake-janice'
import { FakeTime } from '../../fakes/fake-time'
import { GROUP, MEMBER, MEMBER2, USER } from '../../harness'
import type { Sent } from '../../harness'
import { TEST_START, buttonRows, buttons, card, startPlugin } from './plugin-env'
import type { EnvOptions, PluginEnv } from './plugin-env'

const KEY = 'test-janice-key-0000'
const CODE = 'AbC123'
const LINK = `https://janice.e-351.com/a/${CODE}`
const PAGE = LINK
const BR = `https://br.evetools.org/br/${'1'.padStart(24, '0')}`

let env: PluginEnv | undefined
let janice: FakeJanice | undefined

afterEach(async () => {
  await env?.stop()
  await janice?.stop()
  env = undefined
  janice = undefined
})

interface Setup extends EnvOptions {
  /** 控制台 Janice 分组的改动；apiKey 默认填假密钥，写 '' = 没开通 */
  janiceConfig?: Record<string, unknown>
  /** 放什么估价；默认 AbC123 一份 */
  seed?: (fake: FakeJanice) => void
  allowed?: boolean
}

async function start(setup: Setup = {}): Promise<PluginEnv> {
  const { janiceConfig, seed, allowed, ...options } = setup
  janice = await new FakeJanice().start()
  if (seed) seed(janice)
  else janice.add(CODE)
  const config = options.config ?? {}
  env = await startPlugin({
    ...options,
    janice,
    config: {
      ...config,
      janice: { apiKey: KEY, ...janiceConfig },
      access: { allowedGroups: allowed === false ? [] : [{ groupId: GROUP, enabled: true }], ...config.access as object },
    },
  })
  return env
}

const texts = (sent: Sent[]) => sent.map((s) => s.text)
const images = (sent: Sent[]) => sent.flatMap((s) => s.images)

/** 回复里不能出现网址、域名（卡片、文字、按钮都算） */
function noLinks(sent: Sent[]) {
  const all = [...sent.map((s) => `${s.markdown ?? ''}\n${s.text}`), ...buttons(sent)].join('\n')
  expect(all).not.toMatch(/https?:|janice\.|e-351|\.(?:com|org|net)\b/i)
}

describe('估价: group order', () => {
  it('card, price copy, item list, screenshot — in that order, 4 messages', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    const sent = await e.h.group(`估价 ${LINK}`)
    expect(sent).toHaveLength(4)
    expect(sent[0].markdown).toBeDefined()
    expect(card([sent[0]])).toMatchInlineSnapshot(`
      "**Janice 估价 AbC123**
      Jita 4-4 · 收购 · 即时价

      - 出售 \`10,000.00 ISK\`（10.00K）
      - 收购 \`8,000.00 ISK\`（8.00K）
      - 中间 \`9,000.00 ISK\`（9.00K）

      **估价信息**

      - 物品：2 种，共 1,250 件
      - 打包体积：12.5 m³
      - 价格时间：EVE 2026-10-14 09:50 · 北京 17:50
      - 到期：EVE 2026-10-21 10:00 · 北京 18:00

      **主要物品**

      - 三钛合金 Tritanium × 1,000
      - 类晶体胶矿 Pyerite × 250"
    `)
    expect(sent[1].text).toBe('出售 10000\n收购 8000\n中间 9000')
    expect(sent[2].text).toBe('Tritanium\t1000\nPyerite\t250')
    expect(sent[3].images).toHaveLength(1)
    expect(browser.pages.map((p) => p.url)).toEqual([PAGE])
    expect(buttons(sent)).toEqual([])
    noLinks(sent)
  })

  it('@ with a link and nothing else gives the same four messages, handled once', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    const sent = await e.h.group(`看看这个 ${LINK} 怎么样`)
    expect(sent).toHaveLength(4)
    expect(sent[1].text).toBe('出售 10000\n收购 8000\n中间 9000')
    expect(janice!.count()).toBe(1)
    expect(browser.pages).toHaveLength(1)
  })

  it('BR link first, Janice link second: only the first one is handled (screenshot of the BR)', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    await e.h.group(`${BR} 还有 ${LINK}`)
    expect(browser.pages.map((p) => p.url)).toEqual([BR])
    expect(janice!.count()).toBe(0)
  })

  it('Janice link first, BR link second: the appraisal wins', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    const sent = await e.h.group(`${LINK} 还有 ${BR}`)
    expect(sent).toHaveLength(4)
    expect(janice!.count()).toBe(1)
    expect(browser.pages.map((p) => p.url)).toEqual([PAGE])
  })

  it('a link with a subpage still reads by code', async () => {
    const e = await start({ puppeteer: new FakeBrowser() })
    const sent = await e.h.group(`${LINK}/reprocess`)
    expect(sent).toHaveLength(4)
    expect(janice!.requests.map((r) => r.path)).toEqual([`/api/rest/v2/appraisal/${CODE}`])
  })

  it('Janice site on but auto-shot off: a button instead of the picture', async () => {
    const e = await start({ puppeteer: new FakeBrowser(), config: { screenshot: { janice: { auto: false } } } })
    const sent = await e.h.group(`估价 ${LINK}`)
    expect(sent).toHaveLength(3)
    expect(buttonRows(sent)).toEqual([[`网页截图=>截图 janice ${CODE}`]])
  })

  it('Janice site switched off: no screenshot and no button, the data still comes', async () => {
    const e = await start({ puppeteer: new FakeBrowser(), config: { screenshot: { janice: { enabled: false } } } })
    const sent = await e.h.group(`估价 ${LINK}`)
    expect(sent).toHaveLength(3)
    expect(buttons(sent)).toEqual([])
  })

  it('without puppeteer there is no screenshot and no button', async () => {
    const e = await start()
    const sent = await e.h.group(`估价 ${LINK}`)
    expect(sent).toHaveLength(3)
    expect(buttons(sent)).toEqual([])
  })

  it('a long item list is cut by the reply budget and the card says how many lines were left out', async () => {
    const items: FakeItem[] = Array.from({ length: 400 }, (_, i) => ({
      eid: 34, name: `Made-up Item Number ${String(i).padStart(4, '0')} With A Long Name`, amount: i + 1, sell: 10, buy: 8, split: 9,
    }))
    const e = await start({ puppeteer: new FakeBrowser(), seed: (f) => f.add(CODE, {}, items) })
    const sent = await e.h.group(`估价 ${LINK}`)
    // 卡片 + 价格 + 清单 2 块，没有截图
    expect(sent).toHaveLength(4)
    expect(images(sent)).toHaveLength(0)
    const omitted = /另有 (\d+) 行没发/.exec(card([sent[0]]))
    expect(omitted).not.toBeNull()
    const sentLines = texts(sent.slice(2)).join('\n').split('\n').length
    expect(sentLines + Number(omitted![1])).toBe(400)
    expect(buttonRows(sent)).toEqual([[`网页截图=>截图 janice ${CODE}`]])
  })
})

describe('估价: direct message', () => {
  it('3 messages and a screenshot button (never the picture)', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, janiceConfig: { who: 'all' } })
    const sent = await e.h.direct(`估价 ${LINK}`)
    expect(sent).toHaveLength(3)
    expect(sent[1].text).toBe('出售 10000\n收购 8000\n中间 9000')
    expect(sent[2].text).toBe('Tritanium\t1000\nPyerite\t250')
    expect(buttonRows(sent)).toEqual([[`网页截图=>截图 janice ${CODE}`]])
    expect(images(sent)).toHaveLength(0)
    expect(browser.pages).toHaveLength(0)
    noLinks(sent)
  })

  it('the button runs the screenshot with the rebuilt address', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, janiceConfig: { who: 'all' } })
    const sent = await e.h.direct(`截图 janice ${CODE}`)
    expect(browser.pages.map((p) => p.url)).toEqual([PAGE])
    expect(images(sent)).toHaveLength(1)
    noLinks(sent)
  })
})

describe('截图 janice 编号', () => {
  it('keeps the code case, ignores a bad code, and says so when Janice is switched off', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser })
    await e.h.group('截图 janice zZ9yX8')
    expect(browser.pages.map((p) => p.url)).toEqual(['https://janice.e-351.com/a/zZ9yX8'])
    const bad = await e.h.group('截图 janice a/b')
    expect(texts(bad).join('')).not.toMatch(/https?:/)
    expect(browser.pages).toHaveLength(1)
    await env!.stop()
    await janice!.stop()
    const off = await start({ puppeteer: browser, config: { screenshot: { janice: { enabled: false } } } })
    const sent = await off.h.group(`截图 janice ${CODE}`)
    expect(texts(sent)[0]).toContain('不在截图名单里')
    expect(browser.pages).toHaveLength(1)
    noLinks(sent)
  })
})

describe('估价: Janice 不在截图名单里时按消息顺序', () => {
  const DOTLAN = 'https://evemaps.dotlan.net/map/Delve/Jita'

  it('Janice link first → 估价', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, config: { screenshot: { janice: { enabled: false } } } })
    const sent = await e.h.group(`${LINK} ${DOTLAN}`)
    expect(card([sent[0]])).toContain('估价')
    expect(browser.pages.map((p) => p.url)).not.toContain(DOTLAN)
  })

  it('listed site link first → 网站截图, not 估价', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, config: { screenshot: { janice: { enabled: false } } } })
    await e.h.group(`${DOTLAN} ${LINK}`)
    expect(browser.pages.map((p) => p.url)).toEqual([DOTLAN])
    expect(janice!.requests).toHaveLength(0)
  })
})

describe('估价: percentage', () => {
  it('0.93 is applied to the three totals (floored) and the card says so', async () => {
    const items: FakeItem[] = [{ eid: 34, name: 'Tritanium', amount: 10, sell: 1111, buy: 999, split: 1055 }]
    const e = await start({ seed: (f) => f.add(CODE, { pricePercentage: 0.93 }, items) })
    const sent = await e.h.group(`估价 ${LINK}`)
    // 1111 × 0.93 = 1033.23, 999 × 0.93 = 929.07, 1055 × 0.93 = 981.15
    expect(sent[1].text).toBe('出售 1033\n收购 929\n中间 981')
    expect(card([sent[0]])).toContain('按这份估价设定的 93%')
  })

  it('a missing percentage counts as 100% and the card has the note', async () => {
    const e = await start({ seed: (f) => f.add(CODE, { pricePercentage: undefined }) })
    const sent = await e.h.group(`估价 ${LINK}`)
    expect(sent[1].text).toBe('出售 10000\n收购 8000\n中间 9000')
    expect(card([sent[0]])).toContain('比例读不到，按 100% 显示')
  })

  it('100% shows no percentage line', async () => {
    const e = await start()
    const sent = await e.h.group(`估价 ${LINK}`)
    expect(card([sent[0]])).not.toMatch(/按这份估价设定|比例读不到/)
  })
})

describe('估价: no key / no permission', () => {
  it('no key: the command says it is not enabled and still attaches the screenshot', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, janiceConfig: { apiKey: '' } })
    const sent = await e.h.group(`估价 ${LINK}`)
    expect(texts(sent)[0]).toBe('Janice 估价还没开通（管理员要在控制台填 Janice 的 API 密钥）。')
    expect(images(sent)).toHaveLength(1)
    expect(janice!.requests).toEqual([])
    noLinks(sent)
  })

  it('no key: a bare link only gets the screenshot, nothing else', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, janiceConfig: { apiKey: '' } })
    const sent = await e.h.group(LINK)
    expect(sent).toHaveLength(1)
    expect(images(sent)).toHaveLength(1)
    expect(texts(sent)).toEqual([''])
    expect(janice!.requests).toEqual([])
  })

  it('no key and no browser: only the one line (and the usual screenshot notice for the link)', async () => {
    const e = await start({ janiceConfig: { apiKey: '' } })
    const sent = await e.h.group(`估价 ${LINK}`)
    expect(texts(sent)).toEqual(['Janice 估价还没开通（管理员要在控制台填 Janice 的 API 密钥）。'])
  })

  it('who = allowed: a group that is not authorised gets one line from the command and only the screenshot from a link', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, allowed: false })
    const cmd = await e.h.group(`估价 ${LINK}`)
    expect(texts(cmd)).toEqual(['Janice 估价只对授权的群和私聊开放。'])
    const bare = await e.h.group(LINK)
    expect(bare).toHaveLength(1)
    expect(images(bare)).toHaveLength(1)
    expect(janice!.requests).toEqual([])
  })

  it('who = admins: members are refused, an admin is served; who = all: anyone', async () => {
    const e = await start({ janiceConfig: { who: 'admins' }, config: { access: { admins: [MEMBER2] } } })
    expect(texts(await e.h.group(`估价 ${LINK}`))).toEqual(['Janice 估价现在只有管理员能用。'])
    expect(await e.h.group(`估价 ${LINK}`, { userId: MEMBER2 })).toHaveLength(3)
    await env!.stop()
    await janice!.stop()
    const all = await start({ janiceConfig: { who: 'all' }, allowed: false })
    expect((await all.h.group(`估价 ${LINK}`)).length).toBeGreaterThanOrEqual(3)
  })

  it('who = allowed in direct messages: an authorised user is served, a stranger is not', async () => {
    const e = await start({ config: { access: { allowedUsers: [{ userId: USER, enabled: true }] } } })
    expect(await e.h.direct(`估价 ${LINK}`)).toHaveLength(3)
    expect(texts(await e.h.direct(`估价 ${LINK}`, { userId: MEMBER2 }))).toEqual(['Janice 估价只对授权的群和私聊开放。'])
  })
})

describe('估价: failures', () => {
  const failWith = async (fault: JaniceFault, extra: Setup = {}) => {
    const e = await start(extra)
    janice!.faults.push(fault)
    return e.h.group(`估价 ${LINK}`)
  }

  it('404 and 400: not found', async () => {
    const e = await start({ seed: () => {} })
    expect(texts(await e.h.group(`估价 ${LINK}`))).toEqual(['Janice 上没有这份估价（编号不对或已经过期）。'])
    await env!.stop()
    await janice!.stop()
    expect(texts(await failWith({ kind: 'status', status: 400 }))).toEqual(['Janice 上没有这份估价（编号不对或已经过期）。'])
  })

  it('401 and 403: the key problem is not explained in the group', async () => {
    expect(texts(await failWith({ kind: 'status', status: 401 }))).toEqual(['Janice 估价暂时用不了。'])
    await env!.stop()
    await janice!.stop()
    expect(texts(await failWith({ kind: 'status', status: 403 }))).toEqual(['Janice 估价暂时用不了。'])
  })

  it('429: busy with the minutes, then no new request during the cooldown', async () => {
    const sent = await failWith({ kind: 'rate-limit', retryAfter: 120 })
    expect(texts(sent)).toEqual(['Janice 现在太忙，2 分钟后再试。'])
    const again = await env!.h.group(`估价 ${LINK}`)
    expect(texts(again)[0]).toMatch(/^Janice 现在太忙，\d+ 分钟后再试。$/)
    expect(janice!.count()).toBe(1)
  })

  it('5xx and a broken body: down / unreadable', async () => {
    expect(texts(await failWith({ kind: 'status', status: 500 }))).toEqual(['Janice 暂时连不上，可以先用「批量查价」。'])
    await env!.stop()
    await janice!.stop()
    const e = await start({ seed: (f) => f.appraisals.set(CODE, { code: CODE }) })
    expect(texts(await e.h.group(`估价 ${LINK}`))).toEqual(['Janice 返回的内容读不懂，请稍后再试。'])
  })
})

describe('估价: slow', () => {
  it('after 3 seconds the hint goes first and the screenshot is dropped for a button', async () => {
    const time = new FakeTime(TEST_START)
    const browser = new FakeBrowser()
    let release!: () => void
    const e = await start({ puppeteer: browser, clock: time, scheduler: time, seed: (f) => { f.add(CODE); f.hold = new Promise<void>((r) => { release = r }) } })
    const pending = e.h.group(`估价 ${LINK}`)
    await vi.waitFor(() => expect(janice!.count()).toBe(1))
    await time.advance(SLOW_HINT_MS)
    await vi.waitFor(() => expect(e.h.qq.sent.map((s) => s.text)).toEqual(['⏳ 正在读取 Janice 估价…']))
    release()
    const sent = await pending
    expect(sent).toHaveLength(4)
    expect(sent[0].text).toBe('⏳ 正在读取 Janice 估价…')
    expect(sent[2].text).toBe('出售 10000\n收购 8000\n中间 9000')
    expect(images(sent)).toHaveLength(0)
    expect(browser.pages).toHaveLength(0)
    expect(buttonRows(sent)).toEqual([[`网页截图=>截图 janice ${CODE}`]])
  })
})

describe('估价: other arguments', () => {
  it('估价 #ID runs 批量查价 #ID', async () => {
    const e = await start()
    const batch = await e.h.group('批量查价\n三钛合金*10')
    const id = /#([A-Z0-9]{4})/.exec(card(batch))![1]
    const direct = card(await e.h.group(`批量查价 #${id}`))
    const viaJanice = card(await e.h.group(`估价 #${id}`))
    expect(viaJanice).toBe(direct)
    expect(janice!.requests).toEqual([])
    // 不存在的编号和批量查价说法一样
    expect(card(await e.h.group('估价 #ZZ99'))).toBe(card(await e.h.group('批量查价 #ZZ99')))
  })

  it('other text: one line and a 批量查价 button with the original text', async () => {
    const e = await start()
    const sent = await e.h.group('估价 乌鸦级*3')
    expect(card(sent)).toContain('估价 后面写 Janice 估价链接；要估一段清单请用「批量查价」')
    expect(buttonRows(sent)).toEqual([['批量查价=>批量查价 乌鸦级*3']])
    expect(janice!.requests).toEqual([])
  })

  it('no button when the text is too long, has several lines, or looks like an address', async () => {
    const e = await start()
    const line = '估价 后面写 Janice 估价链接；要估一段清单请用「批量查价」'
    for (const arg of [`乌鸦级*3 ${'x'.repeat(100)}`, 'https://example.com/a/AbC123', 'abc.def']) {
      const sent = await e.h.group(`估价 ${arg}`)
      expect(buttons(sent), arg).toEqual([])
      expect(texts(sent).join('') + card(sent)).toContain(line)
    }
  })

  it('an impostor host is not a Janice link', async () => {
    const e = await start()
    const sent = await e.h.group('估价 https://janice.e-351.com.evil.example/a/AbC123')
    expect(buttons(sent)).toEqual([])
    expect(janice!.requests).toEqual([])
  })

  it('no argument: usage', async () => {
    const e = await start()
    const text = card(await e.h.group('估价'))
    expect(text).toContain('估价用法')
    expect(text).not.toMatch(/https?:|janice\.|e-351/i)
  })
})

describe('估价: status line and help', () => {
  it('市场状态 says configured / not configured / the last error, never the key', async () => {
    const e = await start({ config: { access: { admins: [MEMBER] } } })
    expect(card(await e.h.group('市场状态'))).toContain('Janice 估价：已开通')
    janice!.faults.push({ kind: 'status', status: 401 })
    await e.h.group(`估价 ${LINK}`)
    const text = card(await e.h.group('市场状态'))
    expect(text).toMatch(/Janice 估价：已开通 · 🔴 密钥被 Janice 拒绝了/)
    expect(text).not.toContain(KEY)
    await env!.stop()
    await janice!.stop()
    const none = await start({ janiceConfig: { apiKey: '' }, config: { access: { admins: [MEMBER] } } })
    expect(card(await none.h.group('市场状态'))).toContain('Janice 估价：未开通')
  })

  it('help has one line about 估价', async () => {
    const e = await start()
    const text = card(await e.h.group('帮助'))
    expect(text.split('\n').filter((l) => l.includes('估价 + Janice'))).toHaveLength(1)
  })
})

describe('估价: the key never leaks', () => {
  it('only the request header carries it; replies, buttons, logs, status and issues do not', async () => {
    const browser = new FakeBrowser()
    const e = await start({ puppeteer: browser, config: { access: { admins: [MEMBER] } } })
    const all: Sent[] = []
    all.push(...await e.h.group(`估价 ${LINK}`))
    for (const fault of [{ kind: 'status', status: 401 }, { kind: 'status', status: 500 }, { kind: 'raw', body: `{"apikey":"${KEY}"}` }] as JaniceFault[]) {
      janice!.faults.push(fault)
      all.push(...await e.h.group(`估价 ${LINK.replace(CODE, 'Zz9Yx8')}`))
    }
    all.push(...await e.h.group('市场状态'), ...await e.h.direct('估价'))
    const out = [...all.map((s) => `${s.markdown ?? ''}\n${s.text}`), ...buttons(all), ...e.logger.lines.map((l) => l.text)].join('\n')
    expect(out).not.toContain(KEY)
    expect(janice!.requests.every((r) => r.apiKey === KEY)).toBe(true)
    expect(JSON.stringify(e.fake.requests)).not.toContain(KEY)
    expect(out).toContain('Janice')
  })
})
