// 批量查价（§2.3）走完整个插件：表头、批量清单待办、估价编号按钮、未知市场、市场不可用、长清单拆分、慢提示。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRESET_MARKETS } from '../../../src/config/presets'
import { SLOW_HINT_MS } from '../../../src/constants'
import { rawOrder } from '../../fakes/fake-esi'
import { FakeTime } from '../../fakes/fake-time'
import { marketItems } from '../../fixtures/data/load'
import { GROUP } from '../../harness'
import type { Sent } from '../../harness'
import {
  ALLIANCE_MARKET, AMARR_STATION, DOMAIN, PYERITE, RAVEN, TEST_START, THE_FORGE, TRITANIUM, addOrders, buttons, card, jitaOrders, startPlugin,
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

const prices = (fake: Parameters<NonNullable<EnvOptions['esi']>>[0]) => {
  addOrders(fake, THE_FORGE, jitaOrders(RAVEN, 270_000_000, 250_000_000))
  addOrders(fake, THE_FORGE, jitaOrders(TRITANIUM, 5.4, 5))
  addOrders(fake, THE_FORGE, jitaOrders(PYERITE, 13.2, 12))
}
const idOf = (sent: Sent[]) => /估价 #([A-Z0-9]{4})|#([A-Z0-9]{4})（/.exec(card(sent))?.slice(1).find(Boolean) ?? ''

describe('批量查价: header and pending list', () => {
  it('「批量查价 -5% jita」keeps -5% as text (strictOptions) and asks for the list; the next message is the list', async () => {
    const e = await start({ esi: prices })
    const header = await e.h.group('批量查价 -5% jita')
    expect(header[0].markdown).toBe([
      '**批量查价 · Jita 4-4 · 出售价 -5%**',
      '请在 5 分钟内 @我 粘贴清单：一行一个，可以直接从游戏里复制，也可以粘贴装配。',
      '- 例：Raven*2\n- 例：Tritanium 1000000',
    ].join('\n\n'))
    const result = await e.h.group('Raven*2\nTritanium 1000000\nPyerite 500000')
    expect(result[0].markdown).toContain('**批量估价 · Jita 4-4 · 出售价 -5%**\n\n**合计** `524,400,000 ISK`（524.40M）\n调整前 552.00M · 3 种 · 1,500,002 件')
    expect(result[0].markdown).toContain('1. **Raven** ×2 · `513.00M`\n    - 单价 270.00M → 256.50M')
  })

  it('the header can be on the second line', async () => {
    const e = await start({ esi: prices })
    expect(card(await e.h.group('批量查价\nJita buy\nRaven*2'))).toContain('**批量估价 · Jita 4-4 · 收购价')
  })

  it('「取消」clears the pending list; with nothing pending it is ignored', async () => {
    const e = await start({ esi: prices })
    await e.h.group('批量查价 Jita')
    expect((await e.h.group('取消'))[0].text).toBe('已取消。')
    expect(card(await e.h.group('Raven*2\nTritanium 1000000'))).not.toContain('批量估价')
    expect(await e.h.group('取消')).toEqual([])
  })

  it('a command sent while a list is pending still runs as that command, ours or another plugin\'s', async () => {
    const e = await start({
      esi: prices,
      setup: (app) => app.plugin({ name: 'ping', apply: (ctx) => { ctx.command('ping').action(() => 'pong') } }),
    })
    await e.h.group('批量查价 Jita')
    expect(card(await e.h.group('/查价 乌鸦级'))).toContain('**乌鸦级 Raven · 战列舰')
    expect(card(await e.h.group('ping'))).toBe('pong')
    // 待办还在：下一条清单照样接上
    expect(card(await e.h.group('Raven*2\nTritanium 10'))).toContain('**批量估价 · Jita 4-4 · 出售价')
  })

  it('nothing recognized: warnings only, and the list can be pasted again', async () => {
    const e = await start({ esi: prices })
    const sent = await e.h.group('批量查价 Jita -5%\nzzzz qqqq\nyyyy wwww')
    expect(card(sent)).toContain('⚠ 有 2 行没有计入合计：')
    expect(card(sent)).not.toContain('**合计')
    expect(card(await e.h.group('Raven*2'))).toContain('**批量估价 · Jita 4-4 · 出售价 -5%')
  })

  it('nothing recognized but candidates offered: replying with a number picks one, pasting again still works', async () => {
    const e = await start({ esi: (fake) => {
      prices(fake)
      addOrders(fake, THE_FORGE, jitaOrders(3831, 2_000_000, null))
    } })
    const sent = await e.h.group('批量查价\n护盾扩展装置 II')
    expect(card(sent)).toContain('第 1 行「护盾扩展装置 II」可能是 3 种物品，请写完整名称')
    expect(card(sent)).toContain('点下面的编号，或者 @我 回复编号（5 分钟内有效）')
    const picked = card(await e.h.group('2'))
    expect(picked).toContain('**批量估价 · Jita 4-4 · 出售价')
    expect(picked).toContain('中型护盾扩展装置 II')
    expect(picked).toContain('`2.00M`')
    // 批量清单待办还在
    expect(card(await e.h.group('Raven*2\nTritanium 10'))).toContain('**批量估价')
  })

  it('the numbered reply works in text output too', async () => {
    const e = await start({ esi: prices, config: { display: { output: 'text' } } })
    const sent = await e.h.group('批量查价\n护盾扩展装置 II')
    expect(sent[0].text).toContain('回复 @我 1：第 1 行：小型护盾扩展装置 II')
    expect((await e.h.group('3'))[0].text).toContain('大型护盾扩展装置 II')
  })

  it('line numbers count from the first line of the list, wherever the header was written', async () => {
    const e = await start({ esi: prices })
    await e.h.group('批量查价 Jita -5%')
    const pasted = card(await e.h.group('Raven*2\nzzzz qqqq'))
    expect(pasted).toContain('第 2 行「zzzz qqqq」没有找到')
    for (const input of ['批量查价\nRaven*2\nzzzz qqqq', '批量查价 Jita -5%\nRaven*2\nzzzz qqqq', '批量查价\nJita buy\nRaven*2\nzzzz qqqq']) {
      expect(card(await e.h.group(input)), input).toContain('第 2 行「zzzz qqqq」没有找到')
    }
    // 替换按钮用同一套行号
    const sent = await e.h.group('批量查价 Jita\nRaven*2\n护盾扩展装置 II')
    expect(buttons(sent)[0]).toMatch(/^1=>批量查价 #[A-Z0-9]{4} 2=#380$/)
  })

  it('nothing priced at all: the total is a dash, never 0 ISK; the ID and buttons stay', async () => {
    const e = await start({ esi: prices })
    const sent = await e.h.group('批量查价 Amarr -5%\nRaven*2\nTritanium*10')
    const out = card(sent)
    expect(out).toContain('**批量估价 · Amarr · 出售价 -5%**\n\n**合计 —**\n没有取到任何价格')
    expect(out).toContain('- 第 1 行 Raven：Amarr 无有效卖单')
    expect(out).not.toMatch(/\b0(\.00)? ISK|调整前|0 种/)
    const id = idOf(sent)
    expect(id).toMatch(/^[A-Z0-9]{4}$/)
    expect(buttons(sent)).toContain(`改用 Jita=>批量查价 #${id} Jita`)
    expect(card(await e.h.group(`批量查价 #${id} Jita`))).toContain('`513.00M`')
  })
})

describe('批量查价: appraisal ID buttons', () => {
  it('reprices the saved list with another price type or market', async () => {
    const e = await start({ esi: (fake) => {
      prices(fake)
      addOrders(fake, 10000043, [rawOrder({ type_id: RAVEN, price: 280_000_000, location_id: 60008494 })])
    } })
    const first = await e.h.group('批量查价 Amarr\nRaven*2')
    const id = idOf(first)
    expect(buttons(first)).toEqual([`改用收购价=>批量查价 #${id} buy`, `改用中间价=>批量查价 #${id} mid`, `改用 Jita=>批量查价 #${id} Jita`])
    expect(card(await e.h.group(`批量查价 #${id} buy`))).toContain('**批量估价 · Amarr · 收购价')
    const jita = card(await e.h.group(`批量查价 #${id} Jita`))
    expect(jita).toContain('**批量估价 · Jita 4-4 · 收购价')
    expect(jita).toContain('`500.00M`')
  })

  it('unknown market in the header: the list is saved and the buttons reprice it', async () => {
    const e = await start({ esi: prices })
    const sent = await e.h.group('批量查价 TEST sell\nRaven*2')
    expect(card(sent)).toBe('未知市场：TEST\n\n当前可用市场：Jita 4-4 · Amarr · Dodixie · Rens · Hek')
    const jitaButton = buttons(sent)[0]
    expect(jitaButton).toMatch(/^Jita=>批量查价 #[A-Z0-9]{4} Jita$/)
    const result = await e.h.group(jitaButton.split('=>')[1])
    expect(card(result)).toContain('**批量估价 · Jita 4-4 · 出售价')
    expect(card(result)).toContain('`540.00M`')
  })

  it('an expired or unknown ID asks to paste again', async () => {
    const e = await start()
    expect((await e.h.group('批量查价 #ZZZZ'))[0].text).toBe('这份估价已过期，请重新粘贴清单')
  })

  it('two markets or an adjustment out of range are explained', async () => {
    const e = await start()
    expect((await e.h.group('批量查价 Jita Amarr\nRaven'))[0].text).toBe('一次只能选一个市场')
    expect((await e.h.group('批量查价 -95%\nRaven'))[0].text).toBe('要打 95 折请写 -5%、95% 或 95折')
  })

  it('an unavailable market: no total, never switches by itself, offers the other markets', async () => {
    const e = await start({
      esi: prices,
      config: { markets: [...PRESET_MARKETS, { ...ALLIANCE_MARKET, authProfile: 'default' }], access: { allowedGroups: [{ groupId: GROUP, enabled: true }] } },
    })
    const sent = await e.h.group('批量查价 联盟市场A -5%\nRaven*2')
    const id = idOf(sent)
    expect(card(sent)).toBe([
      '**批量估价 · 联盟市场A · 出售价 -5%**',
      '⚠ 联盟市场A 市场数据暂时不可用（ESI 授权或建筑访问权限异常）',
      `清单已保存为 #${id}（24 小时内有效），可以先改用其他市场估价。`,
    ].join('\n\n'))
    expect(buttons(sent)).toEqual([
      `改用 Jita=>批量查价 #${id} Jita`, `改用 Amarr=>批量查价 #${id} Amarr`, `改用 Dodi…=>批量查价 #${id} Dodixie`, `改用 Rens=>批量查价 #${id} Rens`,
    ])
    expect(card(await e.h.group(`批量查价 #${id} Jita`))).toContain('**批量估价 · Jita 4-4 · 出售价 -5%')
  })

  it('unresolved lines get numbered candidates that replace the line', async () => {
    const e = await start({ esi: prices })
    const sent = await e.h.group('批量查价\nRaven*2\n护盾扩展装置 II')
    const id = idOf(sent)
    expect(card(sent)).toContain('第 2 行「护盾扩展装置 II」可能是 3 种物品，请写完整名称')
    expect(buttons(sent).slice(0, 3)).toEqual([`1=>批量查价 #${id} 2=#380`, `2=>批量查价 #${id} 2=#3831`, `3=>批量查价 #${id} 2=#3841`])
    // 回复编号和点按钮一样
    expect(card(await e.h.group('3'))).toContain('大型护盾扩展装置 II')
  })
})

describe('批量查价: fittings and freight', () => {
  it('an EFT fitting is appraised as a fitting, with loaded charges and freight from Jita', async () => {
    const e = await start({
      esi: (fake) => {
        prices(fake)
        addOrders(fake, THE_FORGE, [
          ...jitaOrders(19739, 2_100_000, null),
          ...jitaOrders(203, 260, null),
          ...jitaOrders(2185, 450_000, null),
        ])
      },
      config: { freight: { routes: [{ name: '前线', iskPerM3: 800, collateralPct: 1, maxVolume: 350_000, visibility: 'public', enabled: true }] } },
    })
    const sent = await e.h.group([
      '批量查价',
      '[Raven, 刷怪乌鸦]',
      'Cruise Missile Launcher II, Scourge Cruise Missile',
      'Cruise Missile Launcher II, Scourge Cruise Missile',
      '',
      'Hammerhead II x5',
    ].join('\n'))
    const out = card(sent)
    expect(out).toMatch(/^\*\*装配估价 · 乌鸦级「刷怪乌鸦」\*\*\nJita 4-4 · 出售价\n\n\*\*合计\*\* /)
    expect(out).toContain('- 船体 乌鸦级 · `270.00M`')
    expect(out).toContain('- 装备 2 件 · `4.20M`')
    expect(out).toMatch(/装填弹药按满装计算（2 × [\d,]+ 发）/)
    expect(out).toMatch(/🚚 运到 前线 约 `[\d,]+ ISK`（[\d.]+M）· 800 ISK\/m³ \+ 押金 1% · 到货成本 [\d.]+M/)
  })
})

describe('批量查价: long lists and the reply budget', () => {
  const items = marketItems(60)
  const allPriced = (fake: Parameters<NonNullable<EnvOptions['esi']>>[0]) =>
    addOrders(fake, THE_FORGE, items.flatMap((it, i) => jitaOrders(it.typeId, (i + 1) * 1_000_000, null)))
  const list = items.map((it) => `${it.en}*1`).join('\n')

  it('41–120 types are split into at most 3 messages in a group, buttons only on the last', async () => {
    const e = await start({ esi: allPriced })
    const sent = await e.h.group(`批量查价\n${list}`)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(sent.length).toBeLessThanOrEqual(3)
    expect(sent[0].markdown).toContain('**合计')
    expect(sent[0].rows).toEqual([])
    expect(sent[1].markdown).toMatch(/^\*\*批量估价 #[A-Z0-9]{4} 明细 2\/\d\*\*/)
    expect(sent[sent.length - 1].rows.length).toBeGreaterThan(0)
    const rows = sent.flatMap((s) => (s.markdown ?? '').split('\n').filter((l) => l.startsWith('- ')))
    expect(rows).toHaveLength(60)
  })

  it('in a direct chat one message less', async () => {
    const e = await start({ esi: allPriced })
    const sent = await e.h.direct(`批量查价\n${list}`)
    expect(sent.length).toBeLessThanOrEqual(2)
  })

  it('a slow cold start sends one hint after 3 seconds, then the result', async () => {
    // 时钟和定时器都是假的：拨到 3 秒发出提示，再放行 ESI
    const time = new FakeTime(TEST_START)
    const e = await start({ esi: allPriced, clock: time, scheduler: time })
    const release = e.fake.hold(/^\/markets\/10000002\/orders$/)
    try {
      const pending = e.h.group(`批量查价\n${items.slice(0, 35).map((it) => it.en).join('\n')}`)
      await vi.waitFor(() => expect(e.fake.count(/^\/markets\/10000002\/orders$/)).toBeGreaterThan(0))
      await time.advance(SLOW_HINT_MS - 1)
      expect(e.h.qq.sent).toEqual([])
      await time.advance(1)
      await vi.waitFor(() => expect(e.h.qq.sent.map((s) => s.text)).toEqual(['⏳ 正在查询 35 种物品的价格…']))
      release()
      const sent = await pending
      expect(sent[0].text).toBe('⏳ 正在查询 35 种物品的价格…')
      expect(sent[1].markdown).toContain('**合计')
    } finally {
      release()
    }
  })

  it('a quick answer sends no hint', async () => {
    const time = new FakeTime(TEST_START)
    const e = await start({ esi: allPriced, clock: time, scheduler: time })
    const sent = await e.h.group(`批量查价\n${items.slice(0, 35).map((it) => it.en).join('\n')}`)
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toContain('**合计')
    expect(time.pending).toBe(0)
  })
})

describe('批量查价: comparing with Jita never delays the answer', () => {
  const items = marketItems(20)
  const atAmarr = (fake: Parameters<NonNullable<EnvOptions['esi']>>[0]) => {
    addOrders(fake, DOMAIN, items.map((it, i) => rawOrder({ type_id: it.typeId, price: (i + 1) * 1_000_000, location_id: AMARR_STATION })))
    addOrders(fake, THE_FORGE, items.map((it, i) => rawOrder({ type_id: it.typeId, price: (i + 1) * 1_100_000 })))
  }

  it('Jita requests go on the background lane after the main ones, so held Jita requests do not block Amarr', async () => {
    const e = await start({ esi: atAmarr })
    const release = e.fake.hold(/^\/markets\/10000002\/orders$/)
    try {
      const started = Date.now()
      const sent = await e.h.group(`批量查价 Amarr\n${items.map((it) => `${it.en}*1`).join('\n')}`)
      expect(Date.now() - started).toBeLessThan(5000)
      const out = card(sent)
      expect(out).toMatch(/\*\*合计\*\* `210,000,000 ISK`（210\.00M）\n20 种 · 20 件/)
      expect(out).not.toContain('按 Jita')
      const paths = e.fake.requests.map((r) => r.path)
      expect(paths.indexOf('/markets/10000043/orders')).toBeLessThan(paths.indexOf('/markets/10000002/orders'))
    } finally {
      release()
    }
  })

  it('once Jita is cached the comparison line shows up', async () => {
    const e = await start({ esi: atAmarr })
    const list = items.map((it) => `${it.en}*1`).join('\n')
    await e.h.group(`批量查价 Jita\n${list}`)
    expect(card(await e.h.group(`批量查价 Amarr\n${list}`))).toContain('按 Jita 4-4 出售价合计 231.00M（Amarr 低 9.1%）')
  })
})
