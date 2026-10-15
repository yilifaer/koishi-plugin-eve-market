// 人物卡在真 Chromium 里出图（CHROME_PATH；没有浏览器时整组跳过）：JPEG、1080 像素宽、页面关闭、图片能显示

import fs from 'node:fs'
import type { Browser } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KB_CARD_MIN_HEIGHT, KB_CARD_SCALE, KB_CARD_WIDTH } from '../../src/constants'
import { createKbCards, createRenderer, imageSize } from '../../src/render'
import type { PageFactory } from '../../src/render'
import { NOW_MS, emptyImages, ghost, images, soloHunter } from './kb-fixtures'

const CHROME = process.env.CHROME_PATH
const hasChrome = !!CHROME && fs.existsSync(CHROME)

describe.skipIf(!hasChrome)('KB card in a real Chromium', () => {
  let browser: Browser
  let factory: PageFactory

  beforeAll(async () => {
    const puppeteer = (await import('puppeteer-core')).default
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    factory = () => browser.newPage()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('renders a full card and a sparse card as JPEGs, 1080 px wide, and closes the pages', async () => {
    const before = (await browser.pages()).length
    const cards = createKbCards(createRenderer({ pages: () => factory }), { now: () => NOW_MS })
    const full = await cards.get({ profile: soloHunter(), images: images(), now: NOW_MS })
    expect(full.mime).toBe('image/jpeg')
    expect(full.data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true)
    const size = imageSize(full.data)!
    expect(size.width).toBe(KB_CARD_WIDTH * KB_CARD_SCALE)
    // 内容比最小高度长就截整页
    expect(size.height).toBeGreaterThan(KB_CARD_MIN_HEIGHT * KB_CARD_SCALE)
    expect(full.data.length).toBeGreaterThan(30_000)
    expect(full.data.length).toBeLessThan(1_500_000)

    // 没有整活儿栏的稀疏卡：撑不满最小高度
    const bare = { ...ghost(), letter: null, ad: null, remarks: [], titles: [], fortune: { yi: [], ji: [], comment: '' } }
    const sparse = await cards.get({ profile: bare, images: emptyImages(), now: NOW_MS })
    expect(imageSize(sparse.data)).toEqual({ width: KB_CARD_WIDTH * KB_CARD_SCALE, height: KB_CARD_MIN_HEIGHT * KB_CARD_SCALE })
    expect((await browser.pages()).length).toBe(before)
  }, 60_000)
})
