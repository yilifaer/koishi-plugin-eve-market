// 入侵（§2.9）、势力图 / 联盟势力图（§2.10）、服务器状态（§2.12）、翻译（§2.13）走完整个插件：
// ESI 是本机的假 ESI，势力图从本机的一个小 HTTP 服务下载（tests/core/universe/fixtures 里的小图）。
// 所有 ID、名字、数字都是编造的（SDE 里的公共数据除外）。

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOW_HINT_MS } from '../../../src/constants'
import { rawIncursion } from '../../fakes/fake-esi'
import { FakeTime } from '../../fakes/fake-time'
import { gate } from '../../fakes/fake-browser'
import type { Gate } from '../../fakes/fake-browser'
import type { Sent } from '../../harness'
import { TEST_START, buttonRows, card, startPlugin } from './plugin-env'
import type { EnvOptions, PluginEnv } from './plugin-env'

let env: PluginEnv | undefined
let site: ImageSite | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
  await site?.stop()
  site = undefined
})

async function start(options: EnvOptions = {}): Promise<PluginEnv> {
  env = await startPlugin(options)
  return env
}

// ------------------------------------------------------------------ 入侵

// 小数据集里的星座和星系
const MEKASHTAD = 20000009 // 德里克，Iosantin 0.450343
const ELFRARD = 20000355 // 摩登赫斯，Egbinger 0.034555
const KH730 = 20000132 // 大荒野，代号星系
const IOSANTIN = 30000062
const EGBINGER = 30002420
const NIH = 30000900
const JPL = 30000901
const NK = 30000902
const BLOOD_RAIDERS = 500012

describe('入侵', () => {
  it('lists every incursion, high → low → null-sec, with the staging system first and the shared faction in the footer', async () => {
    const e = await start({
      esi: (fake) => {
        fake.incursions = [
          rawIncursion({ constellation_id: KH730, staging_solar_system_id: NIH, infested_solar_systems: [JPL, NIH, NK], state: 'withdrawing', has_boss: true, influence: 1 }),
          rawIncursion({ constellation_id: ELFRARD, staging_solar_system_id: EGBINGER, infested_solar_systems: [EGBINGER], state: 'mobilizing', influence: 0.125 }),
          rawIncursion({ has_boss: false }),
        ]
      },
    })
    const sent = await e.h.group('入侵')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toMatch(new RegExp(`^${escape([
      '**当前入侵 · 3 处（高安 1 · 低安 1 · 00 1）**',
      '',
      '**1. 木本呂 · 伏尔戈 · 高安**',
      '',
      '- 集结星系 吉他 0.9',
      '- 状态 立足 · 影响力 64.0% · Boss 未出现',
      '- 被入侵星系（3）吉他、皮尔米特、新加达里',
      '',
      '**2. 厄佛拉德 · 摩登赫斯 · 低安**',
      '',
      // 0 < sec < 0.05 显示成 0.1
      '- 集结星系 伊格贝格尔 0.1',
      '- 状态 动员 · 影响力 12.5% · Boss 未出现',
      '- 被入侵星系（1）伊格贝格尔',
      '',
      '**3. 730-KH · 大荒野 · 00**',
      '',
      '- 集结星系 NIH-02 0.0',
      '- 状态 撤退 · 影响力 100.0% · Boss 已出现',
      '- 被入侵星系（3）NIH-02、JPL-RA、NK-7XO',
      '',
      '***',
      '欧服 · 入侵势力 萨沙共和国 · 更新于 ',
    ].join('\n'))}\\d\\d:\\d\\d$`))
    expect(buttonRows(sent)).toEqual([])
  })

  it('different factions are written next to each incursion instead', async () => {
    const e = await start({
      esi: (fake) => {
        fake.incursions = [rawIncursion(), rawIncursion({ constellation_id: MEKASHTAD, staging_solar_system_id: IOSANTIN, infested_solar_systems: [IOSANTIN], faction_id: BLOOD_RAIDERS })]
      },
    })
    const out = card(await e.h.group('入侵'))
    expect(out).toContain('**1. 木本呂 · 伏尔戈 · 高安 · 萨沙共和国')
    expect(out).toContain('**2. 莫卡什塔德 · 德里克 · 高安 · 血袭者同盟')
    expect(out).toContain('- 集结星系 艾萨恩汀 0.5')
    expect(out).toMatch(/欧服 · 更新于 \d\d:\d\d$/)
  })

  it('no incursion: one sentence', async () => {
    const e = await start({ esi: (fake) => { fake.incursions = [] } })
    expect((await e.h.group('入侵')).map((s) => s.text)).toEqual(['当前欧服没有进行中的入侵。'])
  })

  it('ESI down: one sentence, no hint', async () => {
    const e = await start({ esi: (fake) => fake.fault('GET', /^\/incursions$/, { status: 500 }, 5) })
    expect((await e.h.group('入侵')).map((s) => s.text)).toEqual(['⚠ 暂时取不到入侵信息（ESI 没有响应），请稍后再试'])
  })

  it('「入侵者是谁」is not the command', async () => {
    const e = await start({ esi: (fake) => { fake.incursions = [rawIncursion()] } })
    expect(card(await e.h.group('入侵者是谁'))).not.toContain('当前入侵')
    expect(e.fake.count(/^\/incursions$/)).toBe(0)
  })
})

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ------------------------------------------------------------------ 服务器状态

describe('服务器状态', () => {
  it('players, start time, next downtime and version; EVE time and Beijing time', async () => {
    // 测试时钟从 EVE 时间 2026-10-07 06:20 开始；开服 11:05:12（前一天）
    const e = await start({ esi: (fake) => { fake.serverStatus = { players: 21873, server_version: '3012345', start_time: '2026-10-06T11:05:12Z' } } })
    const sent = await e.h.group('服务器状态')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toMatch(new RegExp(`^${escape([
      '**欧服状态 · 🟢 在线**',
      '',
      '- 在线人数 `21,873`',
      '- 本次开服 10/06 19:05（已运行 19 小时 1',
    ].join('\n'))}\\d 分）\\n- 下次维护 10/07 19:00（EVE 时间 11:00）\\n- 服务器版本 3012345\\n\\nEVE 时间 06:2\\d · 北京时间 14:2\\d$`))
    expect(buttonRows(sent)).toEqual([])
  })

  it('VIP mode in the title', async () => {
    const e = await start({ esi: (fake) => { fake.serverStatus = { players: 12, server_version: '3012345', start_time: '2026-10-07T05:00:00Z', vip: true } } })
    expect(card(await e.h.group('服务器状态')).split('\n')[0]).toBe('**欧服状态 · 🟡 VIP 模式（只有开发人员能登录）**')
  })

  it('cannot reach the server: explains the daily downtime in both clocks', async () => {
    const e = await start({ esi: (fake) => fake.fault('GET', /^\/status$/, { status: 503 }, 5) })
    expect((await e.h.group('服务器状态')).map((s) => s.text)).toEqual([
      '🔴 连不上欧服。现在可能在例行维护（每天 EVE 时间 11:00，北京时间 19:00，一般 15–30 分钟）。',
    ])
  })
})

// ------------------------------------------------------------------ 势力图

const FIXTURES = path.join(__dirname, '../../core/universe/fixtures')
const PNG = fs.readFileSync(path.join(FIXTURES, 'influence.png'))
const JPEG = fs.readFileSync(path.join(FIXTURES, 'coalition.jpg'))

interface ImageSite {
  url(name: string): string
  requests: string[]
  /** 设置以后请求先等它放行 */
  hold?: Gate
  /** 一律回这个状态码 */
  status?: number
  stop(): Promise<void>
}

async function imageSite(): Promise<ImageSite> {
  const files: Record<string, { body: Buffer; type: string }> = {
    '/influence.png': { body: PNG, type: 'image/png' },
    '/coalition.jpg': { body: JPEG, type: 'image/jpeg' },
  }
  const state: ImageSite = {
    url: (name) => `http://127.0.0.1:${(server.address() as AddressInfo).port}/${name}`,
    requests: [],
    async stop() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
  const server = http.createServer(async (req, res) => {
    state.requests.push(req.url ?? '')
    await state.hold?.promise
    const file = files[req.url ?? '']
    if (state.status || !file) {
      res.statusCode = state.status ?? 404
      res.end('not here')
      return
    }
    res.setHeader('content-type', file.type)
    res.end(file.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  site = state
  return state
}

function mapConfig(s: ImageSite) {
  return { render: { influenceMapUrl: s.url('influence.png'), coalitionMapUrl: s.url('coalition.jpg') } }
}

function imageOf(sent: Sent): { mime: string; data: Buffer } {
  const m = /^data:([^;]+);base64,(.*)$/.exec(sent.images[0]?.src ?? '')
  if (!m) throw new Error('不是图片')
  return { mime: m[1], data: Buffer.from(m[2], 'base64') }
}

describe('势力图 / 联盟势力图', () => {
  it('sends the downloaded image as it is, with its MIME from the file itself', async () => {
    const s = await imageSite()
    const e = await start({ config: mapConfig(s) })
    const influence = await e.h.group('势力图')
    expect(influence).toHaveLength(1)
    expect(imageOf(influence[0])).toEqual({ mime: 'image/png', data: PNG })
    // 图片下面的说明文字和图片在同一条消息里（样式自检 2-1 确认过）
    expect(influence[0].text).toMatch(/^欧服势力图 · 来源 Verite · 图片更新于 \d\d:\d\d$/)
    const coalition = await e.h.group('联盟势力图')
    expect(imageOf(coalition[0])).toEqual({ mime: 'image/jpeg', data: JPEG })
    expect(coalition[0].text).toMatch(/^欧服联盟势力图 · 来源 Verite · /)
  })

  it('the second time comes from the local cache', async () => {
    const s = await imageSite()
    const e = await start({ config: mapConfig(s) })
    await e.h.group('势力图')
    const before = s.requests.length
    expect(imageOf((await e.h.group('势力图'))[0]).data.equals(PNG)).toBe(true)
    expect(s.requests.length).toBe(before)
  })

  it('no address configured, or nothing downloadable: one sentence', async () => {
    const off = await start()
    expect((await off.h.group('势力图')).map((x) => x.text)).toEqual(['势力图没有开启（控制台里没有填图片地址）。'])
    await off.stop()
    env = undefined
    const s = await imageSite()
    s.status = 500
    const e = await start({ config: mapConfig(s) })
    expect((await e.h.group('联盟势力图')).map((x) => x.text)).toEqual(['联盟势力图暂时获取不到，请稍后再试。'])
  })

  it('a download over 3 seconds sends one hint first; in a direct chat there is no room for it', async () => {
    const s = await imageSite()
    s.hold = gate()
    const time = new FakeTime(TEST_START)
    const e = await start({ config: mapConfig(s), clock: time, scheduler: time })
    const pending = e.h.group('势力图')
    await vi.waitFor(() => expect(s.requests).toContain('/influence.png'))
    await time.advance(SLOW_HINT_MS)
    await vi.waitFor(() => expect(e.h.qq.sent.map((x) => x.text)).toEqual(['⏳ 正在下载势力图…']))
    s.hold.open()
    const sent = await pending
    expect(sent).toHaveLength(2)
    expect(imageOf(sent[1]).data.equals(PNG)).toBe(true)

    s.hold = gate()
    const direct = e.h.direct('联盟势力图')
    await vi.waitFor(() => expect(s.requests).toContain('/coalition.jpg'))
    await time.advance(SLOW_HINT_MS)
    s.hold.open()
    const one = await direct
    expect(one).toHaveLength(1)
    expect(imageOf(one[0]).mime).toBe('image/jpeg')
  })

  it('an image the platform refuses: one sentence instead', async () => {
    const s = await imageSite()
    const e = await start({ config: mapConfig(s) })
    e.h.qq.fail({ code: 40034001, message: 'upload failed' })
    expect((await e.h.group('势力图')).map((x) => x.text)).toEqual(['势力图发送失败，请稍后再试。'])
  })
})

// ------------------------------------------------------------------ 翻译

describe('翻译 / 中英对照', () => {
  it('one item: both names, then category and group', async () => {
    const e = await start()
    expect(card(await e.h.group('翻译 三钛合金'))).toBe('**三钛合金 ⇄ Tritanium**\n材料 · 矿物')
    expect(card(await e.h.group('翻译 tritanium'))).toBe('**三钛合金 ⇄ Tritanium**\n材料 · 矿物')
  })

  it('an item with aliases lists them (the console aliases are the way to see them)', async () => {
    const e = await start({ config: { aliases: [{ alias: '大鸟', target: 'Raven', enabled: true }] } })
    const out = card(await e.h.group('翻译 大鸟'))
    expect(out.split('\n').slice(0, 2)).toEqual(['**乌鸦级 ⇄ Raven**', '舰船 · 战列舰'])
    expect(out.split('\n')[2]).toMatch(/^别名：.*大鸟/)
  })

  it('the alias 中英对照 works; a system shows its region and security', async () => {
    const e = await start()
    const sent = await e.h.group('中英对照 Jita')
    expect(card(sent)).toBe('**吉他 ⇄ Jita**\n星系 · 伏尔戈 · 0.9')
    expect(buttonRows(sent)).toEqual([])
  })

  it('several results are numbered; places carry their kind', async () => {
    const e = await start()
    const out = card(await e.h.group('翻译 护盾扩展装置 II'))
    expect(out.split('\n')[0]).toMatch(/^\*\*「护盾扩展装置 II」找到 \d+ 个\*\*$/)
    expect(out).toContain('1. 小型护盾扩展装置 II ⇄ Small Shield Extender II')
  })

  it('nothing found, and just the command', async () => {
    const e = await start()
    expect((await e.h.group('翻译 完全不存在的东西')).map((x) => x.markdown)).toEqual(['没有找到「完全不存在的东西」的中英对照。'])
    expect(card(await e.h.group('翻译')).split('\n')[0]).toBe('**翻译用法**')
  })

  it('nothing found: the echoed words are escaped only where Markdown is rendered, so no backslashes show', async () => {
    const e = await start()
    // Markdown 消息里的反斜杠转义不会显示出来
    expect((await e.h.group('翻译 http://x.com a_b*c')).map((x) => x.markdown)).toEqual(['没有找到「\\[链接\\] a\\_b\\*c」的中英对照。'])
    await e.stop()
    const plain = await start({ config: { display: { output: 'text' } } })
    expect((await plain.h.group('翻译 http://x.com a_b*c')).map((x) => x.text)).toEqual(['没有找到「[链接] a_b*c」的中英对照。'])
  })
})
