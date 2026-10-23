// KB 人物卡出图：HTML 快照（三种人设）、转义、长名字缩字号、缺栏不输出、没有外部资源；
// 用假浏览器走一遍出图、缓存和单飞。

import { describe, expect, it } from 'vitest'
import { KB_CARD_JPEG_QUALITY, KB_CARD_MIN_HEIGHT, KB_CARD_SCALE, KB_CARD_WIDTH } from '../../src/constants'
import { KB_PALETTES } from '../../src/render/kb-theme'
import { createKbCards, createRenderer, headlineFontSize, kbCardHtml, kbCardKey } from '../../src/render'
import type { KbCardView } from '../../src/render'
import { FakeBrowser, gate } from '../fakes/fake-browser'
import { NOW_MS, PIXEL, emptyImages, ghost, images, rookie, soloHunter } from './kb-fixtures'

const view = (profile = soloHunter(), imgs = images()): KbCardView => ({ profile, images: imgs, now: NOW_MS })

describe('kbCardHtml snapshots', () => {
  it('solo hunter', () => expect(kbCardHtml(view())).toMatchSnapshot())
  it('solo hunter, day edition', () => expect(kbCardHtml({ ...view(), theme: 'light' })).toMatchSnapshot())
  it('rookie', () => expect(kbCardHtml(view(rookie()))).toMatchSnapshot())
  it('ghost with no records', () => expect(kbCardHtml(view(ghost(), emptyImages()))).toMatchSnapshot())
})

describe('kbCardHtml theme', () => {
  it('defaults to the night edition', () => {
    expect(kbCardHtml(view())).toBe(kbCardHtml({ ...view(), theme: 'dark' }))
    expect(kbCardHtml(view())).toContain('欧服 TRANQUILITY 夜间版')
  })

  it('light keeps the plain dateline and the beige paper', () => {
    const html = kbCardHtml({ ...view(), theme: 'light' })
    expect(html).toContain('欧服 TRANQUILITY 版')
    expect(html).not.toContain('夜间版')
    expect(html).toContain('--paper:#EFE6D2')
  })

  it('themes share one layout and differ only in colours', () => {
    const strip = (h: string) => h.replace(/<style>[\s\S]*?<\/style>/, '').replace(/rgba\([\d,.]+\)|#[0-9A-Fa-f]{6}|夜间版|版/g, '_')
    expect(strip(kbCardHtml({ ...view(), theme: 'dark' }))).toBe(strip(kbCardHtml({ ...view(), theme: 'light' })))
    expect(kbCardHtml({ ...view(), theme: 'dark' })).not.toBe(kbCardHtml({ ...view(), theme: 'light' }))
  })

  it('chart colours follow the theme', () => {
    expect(kbCardHtml({ ...view(), theme: 'dark' })).toContain('fill="#E6E0D2"')
    expect(kbCardHtml({ ...view(), theme: 'light' })).toContain('fill="#1B1A17"')
  })

  it('body text has comfortable contrast on both papers (WCAG AA, 4.5)', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    for (const p of Object.values(KB_PALETTES)) {
      for (const fg of [p.ink, p.mute, p.sub, p.foot, p.red, p.secHigh, p.secNull]) expect(ratio(fg, p.paper)).toBeGreaterThanOrEqual(4.5)
      expect(ratio('#FFFFFF', p.banner)).toBeGreaterThanOrEqual(4.5)
    }
    // 低安黄字沿用日间版原色（粗体、约 4.1），夜间版必须过线
    expect(ratio(KB_PALETTES.dark.secLow, KB_PALETTES.dark.paper)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(KB_PALETTES.light.secLow, KB_PALETTES.light.paper)).toBeGreaterThanOrEqual(4)
  })
})

describe('kbCardHtml content', () => {
  it('prints system security with the shared formatter', () => {
    const p = rookie()
    p.places = [
      { systemId: 1, system: { ...p.places[0].system!, en: 'Deepnull', security: -0.38 }, kills: 2 },
      { systemId: 2, system: { ...p.places[0].system!, en: 'Edgeville', security: 0.04 }, kills: 1 },
    ]
    const html = kbCardHtml(view(p))
    expect(html).toContain('<small>-0.4</small>')
    expect(html).toContain('<small>0.1</small>')
  })

  it('writes the owner-decided texts', () => {
    const html = kbCardHtml(view())
    expect(html).toContain('YC128 年 10 月 14 日 星期三')
    expect(html).toContain('图：Hanako Kisaragi，摄于 Testville III - Fictional Academy')
    expect(html).toContain('建号：EVE 2020-05-17（北京 2020-05-18）')
    // 游戏里的头衔在军团行上面，原样显示
    expect(html).toContain('<div class="gt">Night Shift</div>')
    expect(html.indexOf('class="gt"')).toBeLessThan(html.indexOf('[MHL] Moonlit'))
    expect(html.indexOf('class="gt"')).toBeGreaterThan(html.indexOf('<h1'))
    expect(html).not.toContain('军团头衔')
    expect(html).toContain('[MHL] Moonlit Harbor Logistics')
    expect(html).toContain('&lt;FICT&gt; Fictional Federation')
    expect(html).toContain('最活跃：北京 02:00–05:00（EVE 18–21）')
    expect(html).toContain('近期大击杀')
    expect(html).toContain('近期大损失')
    expect(html).toContain('数据：zKillboard / 欧服官方接口 · 截至 EVE 2026-10-14 12:00')
    expect(html).toContain('<span>本报纯属娱乐</span>')
    // 没有中文名的船用英文名，不重复写小字
    expect(html).toContain('<b>Mystery Hull</b></div>')
  })

  it('escapes every text value', () => {
    const p = soloHunter()
    const evil = `<script>alert(1)</script> & "q" 'x'`
    p.name = evil
    p.headline = evil
    p.lede = evil
    p.title = evil
    p.mood = evil
    p.personaLabel = evil
    p.birthplace = evil
    p.footer = `${evil} · ${evil}`
    p.corporation = { id: 1, name: evil, ticker: '<T>' }
    p.alliance = { id: 2, name: evil, ticker: '&' }
    p.ships[0].zh = evil
    p.ships[0].en = evil + '2'
    const html = kbCardHtml(view(p))
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;x&#39;')
    expect(html).toContain('[&lt;T&gt;] ')
  })

  it('escapes titles, remarks, letter, fortune and ad', () => {
    const p = soloHunter()
    const evil = '<script>alert(1)</script>'
    p.titles = [evil]
    p.remarks = [evil]
    p.letter = { body: evil, sign: evil }
    p.fortune = { yi: [evil, evil], ji: [evil, evil], comment: evil }
    p.ad = evil
    const html = kbCardHtml(view(p))
    expect(html).not.toContain('<script')
    expect(html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g)?.length).toBe(10)
  })

  it('writes the fun sections when present', () => {
    const html = kbCardHtml(view())
    expect(html).toContain('<span>本报授予称号：</span><b>泡泡大师</b><b>战列舰老炮</b>')
    expect(html).toContain('<span>本报锐评</span>')
    expect(html).toContain('<h3><span>读者来信</span></h3>')
    expect(html).toContain('——一位热心的读者')
    expect(html).toContain('<b>宜</b><span>蹲门　买保险</span>')
    expect(html).toContain('<b>忌</b><span>贪最后一发　关掉预警</span>')
    expect(html).toContain('<i>广告</i>')
  })

  it('omits fun sections without content', () => {
    const p = soloHunter()
    p.titles = []
    p.remarks = []
    p.letter = null
    p.fortune = { yi: [], ji: [], comment: '' }
    p.ad = null
    const html = kbCardHtml(view(p))
    for (const gone of ['class="titles"', '本报锐评', '读者来信', '今日运势', 'class="ad"', 'class="fun"']) expect(html, gone).not.toContain(gone)
    // 只有来信时来信独占一行
    p.letter = { body: '来信', sign: '——读者' }
    const only = kbCardHtml(view(p))
    expect(only).toContain('读者来信')
    expect(only).not.toContain('今日运势')
  })

  it('lets the headline use two lines: the font shrinks to fit two, the ellipsis only comes past two', () => {
    expect(headlineFontSize('独狼出没！')).toBe(58)
    // 一行放不下、两行放得下：字号比一行时大
    const twoLines = '新星升起！Mika Tsukishiro 初入新伊甸'
    const size2 = headlineFontSize(twoLines)
    expect(size2).toBeLessThan(58)
    expect(size2).toBeGreaterThan(30)
    const long = '保护期刚过：' + 'Abcdefghijklmnopqrstuvwxyz'.repeat(3)
    const size = headlineFontSize(long)
    expect(size).toBeLessThan(58)
    expect(size).toBeGreaterThanOrEqual(30)
    const p = soloHunter()
    p.headline = long
    const html = kbCardHtml(view(p))
    expect(html).toContain(`<h1 style="font-size:${size}px">`)
    expect(html).toMatch(/h1\{[^}]*-webkit-line-clamp:2/)
    expect(html).not.toMatch(/h1\{[^}]*white-space:nowrap/)
    p.headline = '长'.repeat(80)
    expect(headlineFontSize(p.headline)).toBe(30)
  })

  it('a 27-character Chinese headline fits two lines at a readable size', () => {
    const size = headlineFontSize('个人英雄主义？不存在的，我们只认真飞船，认认真真地飞')
    expect(size).toBeGreaterThanOrEqual(30)
    expect(size).toBeLessThan(58)
  })

  it('omits sections that have no data', () => {
    const html = kbCardHtml(view(ghost(), emptyImages()))
    for (const gone of ['class="grid"', '王牌座驾', '常出没', '作息', '近 12 个月', '近期大击杀', '近期大损失', 'class="org"', 'class="two"', '<small>北京时间</small>']) {
      expect(html, gone).not.toContain(gone)
    }
    expect(html).toContain('新伊甸查无此人战绩')
    expect(html).toContain('图：Ren Aoyagi，摄于新伊甸某处')
    // 没有近况时横幅右侧不留空小字
    expect(html).toContain('<div class="banner"><span>号外 · 神秘人物</span></div>')
  })

  it('shows only the pieces present: no recent rows, labels-only activity, no alliance', () => {
    const html = kbCardHtml(view(rookie()))
    expect(html).not.toContain('近期大击杀')
    expect(html).not.toContain('class="hours"')
    expect(html).toContain('主要活跃时段：欧洲时段 / 美东时段')
    expect(html).not.toContain('最活跃：')
    expect(html).not.toContain('FICT')
    expect(html).not.toContain('危险度')
    expect(html).toContain('<h2><span>常出没</span></h2>')
  })

  it('has no http(s) resource and only data: images that look sniffed', () => {
    for (const v of [view(), view(rookie()), view(ghost(), emptyImages())]) {
      const html = kbCardHtml(v)
      expect(html).not.toMatch(/https?:/i)
      expect(html).not.toMatch(/<link|<script|@import|url\((?!#)/i)
      for (const m of html.matchAll(/<img [^>]*src="([^"]*)"/g)) expect(m[1]).toMatch(/^data:image\/png;base64,/)
    }
    expect(kbCardHtml(view())).toContain(`src="${PIXEL}"`)
    expect(kbCardHtml(view())).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data:")
  })

  it('refuses anything that is not a data: image (silhouette instead)', () => {
    const bad = { portrait: 'https://images.example/p.jpg', corporation: 'data:text/html;base64,AAAA', alliance: 'javascript:1', ships: { 1001: 'data:image/png;base64,"onerror=x' } }
    const html = kbCardHtml(view(soloHunter(), bad))
    expect(html).not.toMatch(/https?:|javascript:|<img /i)
    expect(html).toContain('<svg viewBox="0 0 200 240"')
  })

  it('is a pure function of its input', () => {
    expect(kbCardHtml(view())).toBe(kbCardHtml(view()))
  })
})

function setup() {
  const browser = new FakeBrowser()
  const renderer = createRenderer({ pages: () => browser.page })
  let now = NOW_MS
  const cards = createKbCards(renderer, { now: () => now })
  return { browser, renderer, cards, advance: (ms: number) => { now += ms } }
}

describe('createKbCards', () => {
  it('renders a JPEG at 720×1040 CSS px, scale 1.5, quality from constants, and closes the page', async () => {
    const { browser, cards } = setup()
    const out = await cards.get(view())
    expect(out.mime).toBe('image/jpeg')
    expect(out.data[0]).toBe(0xff)
    const page = browser.pages[0]
    expect(page.closed).toBe(true)
    expect(page.javaScript).toBe(false)
    expect(page.viewport).toEqual({ width: KB_CARD_WIDTH, height: KB_CARD_MIN_HEIGHT, deviceScaleFactor: KB_CARD_SCALE })
    expect(page.shots[0]).toMatchObject({ type: 'jpeg', quality: KB_CARD_JPEG_QUALITY, fullPage: true })
    expect(page.html).toBe(kbCardHtml(view()))
  })

  it('caches by character and profile time, and expires after the card cache time', async () => {
    const { browser, cards, advance } = setup()
    const a = await cards.get(view())
    expect(await cards.get(view())).toBe(a)
    expect(cards.cached(view())).toBe(a)
    expect(browser.pages).toHaveLength(1)
    const newer = soloHunter()
    newer.updatedAt += 1
    expect(kbCardKey(view(newer))).not.toBe(kbCardKey(view()))
    await cards.get(view(newer))
    expect(browser.pages).toHaveLength(2)
    advance(61 * 60_000)
    expect(cards.cached(view())).toBeUndefined()
    cards.clear()
  })

  it('cache key includes the theme, and default equals dark', async () => {
    const { browser, cards } = setup()
    expect(kbCardKey({ ...view(), theme: 'light' })).not.toBe(kbCardKey({ ...view(), theme: 'dark' }))
    expect(kbCardKey(view())).toBe(kbCardKey({ ...view(), theme: 'dark' }))
    await cards.get({ ...view(), theme: 'dark' })
    expect(cards.cached({ ...view(), theme: 'light' })).toBeUndefined()
    await cards.get({ ...view(), theme: 'light' })
    expect(browser.pages).toHaveLength(2)
  })

  it('cache key includes the UTC date: a new UTC day never reuses yesterday card', async () => {
    const { browser, cards } = setup()
    const day = 86_400_000
    const midnight = Math.floor(NOW_MS / day) * day + day
    const before: KbCardView = { ...view(), now: midnight - 1000 }
    const after: KbCardView = { ...view(), now: midnight + 1000 }
    expect(kbCardKey(before)).not.toBe(kbCardKey(after))
    expect(kbCardKey(before)).toBe(kbCardKey({ ...before, now: midnight - 2000 }))
    await cards.get(before)
    await cards.get(after)
    expect(browser.pages).toHaveLength(2)
    expect(cards.cached(after)).toBeDefined()
  })

  it('shares one render between simultaneous requests', async () => {
    const { browser, cards } = setup()
    browser.holdShot = gate()
    const first = cards.get(view())
    const second = cards.get(view())
    await new Promise((r) => setTimeout(r, 10))
    browser.holdShot.open()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(browser.pages).toHaveLength(1)
  })

  it('does not cache a card without a portrait, and surfaces render errors', async () => {
    const { browser, cards } = setup()
    await cards.get(view(soloHunter(), emptyImages()))
    expect(cards.cached(view(soloHunter(), emptyImages()))).toBeUndefined()
    browser.shotError = 'boom'
    await expect(cards.get(view())).rejects.toMatchObject({ name: 'RenderError' })
  })
})
