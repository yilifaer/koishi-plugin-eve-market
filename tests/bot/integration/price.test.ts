// 查价（§2.2）走完整个插件：真实的 Koishi、前置中间件、命令、core（小数据集 + 本机假 ESI），FakeBot 记录发出去的内容。

import { afterEach, describe, expect, it } from 'vitest'
import { PRESET_MARKETS } from '../../../src/config/presets'
import { rawOrder } from '../../fakes/fake-esi'
import { GROUP, GROUP2, FakeBot } from '../../harness'
import {
  ALLIANCE_MARKET, AMARR_STATION, DOMAIN, MARKETS_WITH_ALLIANCE, PLEX, RAVEN, STRUCTURE_ID, THE_FORGE, addOrders, buttonRows, buttons, card,
  jitaOrders, startPlugin, testClock,
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

const allowed = { allowedGroups: [{ groupId: GROUP, enabled: true }] }
const ravenOrders = (fake: Parameters<NonNullable<EnvOptions['esi']>>[0]) => {
  addOrders(fake, THE_FORGE, jitaOrders(RAVEN, 258_400_000, 249_000_000))
  addOrders(fake, THE_FORGE, [
    rawOrder({ type_id: RAVEN, price: 270_000_000, location_id: STRUCTURE_ID }),
    rawOrder({ type_id: RAVEN, price: 240_000_000, location_id: STRUCTURE_ID, is_buy_order: true, range: 'station' }),
  ])
}

describe('查价: markets and visibility', () => {
  it('an allowed group sees Jita and the alliance market with ▲▼ and the notice', async () => {
    const e = await start({
      config: { markets: MARKETS_WITH_ALLIANCE, access: allowed, notices: { list: [{ text: '矿石收购按 Jita 收购价 92%', visibility: 'allowed', enabled: true }] } },
      esi: ravenOrders,
    })
    const sent = await e.h.group('查价 乌鸦级')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toMatch(/^\*\*乌鸦级\*\* Raven · 战列舰\n\n\*\*Jita 4-4\*\*\n\n- 出售 `258,400,000 ISK`（258\.40M）/)
    expect(sent[0].markdown).toContain('**联盟市场A**\n\n- 出售 `270,000,000 ISK`（270.00M）▲4.5%\n- 中间 `255,000,000 ISK`（255.00M）\n- 收购 `240,000,000 ISK`（240.00M）▼3.6%')
    expect(sent[0].markdown).toMatch(/\*\*\*\n欧服 · 更新于 \d\d:\d\d · ▲▼ 与 Jita 4-4 比较\n> 📢 矿石收购按 Jita 收购价 92%$/)
    expect(buttonRows(sent)).toEqual([['月度走势=>走势 乌鸦级 月', '季度走势=>走势 乌鸦级 季', '相关物品=>搜索 乌鸦级', '制造成本=>制造 乌鸦级']])
  })

  it('another group sees only public markets and public notices', async () => {
    const e = await start({
      config: { markets: MARKETS_WITH_ALLIANCE, access: allowed, notices: { list: [{ text: '只给授权群', visibility: 'allowed', enabled: true }, { text: '所有群', visibility: 'all', enabled: true }] } },
      esi: ravenOrders,
    })
    const out = card(await e.h.group('查价 乌鸦级', { channelId: GROUP2 }))
    expect(out).not.toContain('联盟市场A')
    expect(out).not.toContain('只给授权群')
    expect(out).toContain('> 📢 所有群')
    expect(out).not.toMatch(/[▲▼]/)
  })

  it('a restricted market in an unauthorized group answers exactly like a market that does not exist', async () => {
    const e = await start({ config: { markets: MARKETS_WITH_ALLIANCE, access: allowed }, esi: ravenOrders })
    const hidden = await e.h.group('查价 联盟市场A 乌鸦级', { channelId: GROUP2 })
    const alias = await e.h.group('查价 前线 乌鸦级', { channelId: GROUP2 })
    const missing = await e.h.group('查价 TEST 乌鸦级', { channelId: GROUP2 })
    expect(card(hidden).replace('联盟市场A', 'TEST')).toBe(card(missing))
    expect(card(alias).replace('前线', 'TEST')).toBe(card(missing))
    expect(card(missing)).toBe('未知市场：TEST\n\n当前可用市场：Jita 4-4 · Amarr · Dodixie · Rens · Hek')
    expect(buttonRows(missing)).toEqual([['Jita=>查价 Jita 乌鸦级', 'Amarr=>查价 Amarr 乌鸦级', 'Dodixie=>查价 Dodixie 乌鸦级', 'Rens=>查价 Rens 乌鸦级']])
    expect(buttonRows(hidden)).toEqual(buttonRows(missing))
    // 授权群里同一个名字照常查价
    expect(card(await e.h.group('查价 联盟市场A 乌鸦级'))).toContain('**联盟市场A**')
  })

  it('a named market with a quantity compares with Jita and shows totals', async () => {
    const e = await start({ config: { markets: MARKETS_WITH_ALLIANCE, access: allowed }, esi: ravenOrders })
    const sent = await e.h.group('查价 联盟市场A 乌鸦级*10')
    expect(sent[0].markdown).toContain('**乌鸦级** Raven ×10 · 战列舰\n\n**联盟市场A**\n\n- 出售 `270,000,000 ISK`（270.00M）▲4.5% · 合计 2.70B')
    expect(sent[0].markdown).toMatch(/欧服 · 联盟市场A 更新于 \d\d:\d\d · ▲▼ 与 Jita 4-4 比较/)
    // 玩家建筑没有成交历史：走势按钮不带市场
    expect(buttonRows(sent)).toEqual([['月度走势=>走势 乌鸦级 月', '季度走势=>走势 乌鸦级 季', '相关物品=>搜索 联盟市场A 乌鸦级', '制造成本=>制造 乌鸦级*10']])
  })

  it('an older market is marked, a failing market says ESI did not answer, the others are fine', async () => {
    const markets = PRESET_MARKETS.map((m) => (m.name === 'Amarr' || m.name === 'Dodixie' ? { ...m, inDefaultList: 'yes' } : m))
    const e = await start({
      config: { markets },
      esi: (fake) => {
        ravenOrders(fake)
        addOrders(fake, DOMAIN, [rawOrder({ type_id: RAVEN, price: 250_000_000, location_id: AMARR_STATION })])
        fake.touch('orders:10000043', fake.clock() - 20 * 60_000)
        fake.fault('GET', /^\/markets\/10000032\/orders$/, { status: 500 }, 2)
      },
    })
    const out = card(await e.h.group('查价 乌鸦级'))
    expect(out).toMatch(/\*\*Amarr\*\* · 2\d 分钟前\n\n- 出售 `250,000,000 ISK`（250\.00M）▼3\.3%\n- 中间 —\n- 收购 暂无买单/)
    expect(out).toContain('**Dodixie**\n⚠ ESI 暂时没有响应')
    expect(out).toContain('**Jita 4-4**\n\n- 出售 `258,400,000 ISK`')
  })

  it('during the daily DT a failing market says so', async () => {
    const markets = PRESET_MARKETS.map((m) => (m.name === 'Dodixie' ? { ...m, inDefaultList: 'yes' } : m))
    const e = await start({
      config: { markets },
      clock: testClock(Date.UTC(2026, 9, 7, 11, 10)),
      esi: (fake) => {
        ravenOrders(fake)
        fake.fault('GET', /^\/markets\/10000032\/orders$/, { status: 500 }, 2)
      },
    })
    const out = card(await e.h.group('查价 乌鸦级'))
    expect(out).toContain('**Dodixie**\n⚠ DT 维护中，暂时取不到价格')
    expect(out).toContain('**Jita 4-4**\n\n- 出售 `258,400,000 ISK`')
  })

  it('a structure market that still needs authorization is unavailable; Jita answers as usual', async () => {
    const e = await start({ config: { markets: [...PRESET_MARKETS, { ...ALLIANCE_MARKET, authProfile: 'default' }], access: allowed }, esi: ravenOrders })
    const out = card(await e.h.group('查价 乌鸦级'))
    expect(out).toContain('**联盟市场A**\n⚠ 市场数据暂时不可用（ESI 授权或建筑访问权限异常）')
    expect(out).toContain('**Jita 4-4**\n\n- 出售 `258,400,000 ISK`')
  })
})

describe('查价: items', () => {
  it('PLEX uses the global market and the default quantity of 500', async () => {
    const e = await start({ esi: (fake) => addOrders(fake, 19000001, jitaOrders(PLEX, 5_012_000, 4_861_000, { location_id: 60003760 })) })
    const out = card(await e.h.group('查价 Amarr PLEX'))
    expect(out).toContain('**PLEX** ×500 · 伊甸币\n\n**PLEX 全局市场**\n\n- 出售 `5,012,000 ISK`（5.01M）· 合计 2.51B')
    expect(out).toMatch(/欧服 · 更新于 \d\d:\d\d · PLEX 全宇宙统一交易，不分市场/)
    expect(e.fake.count(/^\/markets\/19000001\/orders$/)).toBe(1)
    expect(e.fake.count(/^\/markets\/10000043\/orders$/)).toBe(0)
  })

  it('market + item and the whole text are both exact: the market wins, with a button for all markets', async () => {
    const markets = PRESET_MARKETS.map((m) => (m.name === 'Amarr' ? { ...m, aliases: 'Navy' } : m))
    const e = await start({ config: { markets } })
    const sent = await e.h.group('查价 Navy Cap Booster 800')
    expect(card(sent)).toContain('**电容注电器装料 800** Cap Booster 800')
    expect(card(sent)).toContain('**Amarr**')
    expect(buttonRows(sent)[0]).toContain('查所有市场=>查价 #32014')
    expect(card(await e.h.group('查价 #32014'))).toContain('**海军电容注电器装料 800** Navy Cap Booster 800')
  })

  it('a new item not in the data yet is found by its exact name on ESI and marked as new', async () => {
    const NEW_SHIP = 99_000_001
    const e = await start({
      esi: (fake) => {
        fake.idNames.en.set('brand new frigate', { category: 'inventory_types', id: NEW_SHIP, name: 'Brand New Frigate' })
        fake.types.set(NEW_SHIP, { type_id: NEW_SHIP, name: 'Brand New Frigate', description: '', group_id: 27, market_group_id: 80, published: true, volume: 27_289 })
        addOrders(fake, THE_FORGE, jitaOrders(NEW_SHIP, 1_500_000, 1_200_000))
      },
    })
    const out = card(await e.h.group('查价 Brand New Frigate'))
    expect(out).toContain('**Brand New Frigate** · 战列舰\n（新物品，数据还没收录）\n\n**Jita 4-4**\n\n- 出售 `1,500,000 ISK`（1.50M）')
  })

  it('an alias says which name it used', async () => {
    const e = await start({ esi: ravenOrders })
    expect(card(await e.h.group('查价 乌鸦'))).toContain('**乌鸦级** Raven · 战列舰\n按「乌鸦级」查询')
  })

  it('implant sets list every piece', async () => {
    const e = await start()
    const out = card(await e.h.group('查价 高级水晶套装'))
    expect(out.split('\n')[0]).toBe('**高级水晶套装** High-grade Crystal · 6 件')
    expect(out).toContain('- 阿尔法型 · 出售 — · 收购 —')
    expect(out).toContain('- **合计** 出售 缺 6 件')
  })

  it('ambiguous names list candidates that keep the market and quantity; a numbered reply runs one', async () => {
    const e = await start({ esi: (fake) => addOrders(fake, 10000043, [rawOrder({ type_id: 3831, price: 2_000_000, location_id: AMARR_STATION })]) })
    const list = await e.h.group('查价 Amarr 护盾扩展装置 II*4')
    expect(list[0].markdown?.split('\n')[0]).toBe('**「护盾扩展装置 II」可能是以下物品，请选择：**')
    expect(buttonRows(list)[0]).toEqual(['1=>查价 Amarr 小型护盾扩展装置 II*4', '2=>查价 Amarr 中型护盾扩展装置 II*4', '3=>查价 Amarr 大型护盾扩展装置 II*4'])
    const picked = card(await e.h.group('2'))
    expect(picked).toContain('**中型护盾扩展装置 II** Medium Shield Extender II ×4')
    expect(picked).toContain('**Amarr**\n\n- 出售 `2,000,000 ISK`（2.00M）· 合计 8.00M')
    // 编号后面带数量：换掉原来的数量
    await e.h.group('查价 Amarr 护盾扩展装置 II*4')
    expect(card(await e.h.group('2*10'))).toContain('×10')
  })

  it('not found: suggestions to click, and a search hint that finds something', async () => {
    const e = await start()
    const sent = await e.h.group('查价 乌鸦机')
    // 搜索不容错：「搜索 乌鸦机」什么都没有，提示改成和建议共同的开头
    expect(sent[0].markdown?.split('\n\n')[0]).toBe('没有找到「乌鸦机」对应的物品。\n也可以换成英文名、完整的中文名，或者发送「搜索 乌鸦」。')
    expect(buttonRows(sent)[0]).toEqual(['1=>查价 乌鸦级', '2=>查价 乌鸦级海军型', '3=>查价 乌鸦级政府型'])
    expect(card(await e.h.group('搜索 乌鸦'))).not.toContain('没有名字里包含')
    expect(card(await e.h.group('查价 Ravn'))).toContain('或者发送「搜索 Rav」')
    // 什么都搜不到时不提搜索
    expect(card(await e.h.group('查价 zzzzqqqq'))).toBe('没有找到「zzzzqqqq」对应的物品。\n也可以换成英文名、完整的中文名。')
  })

  it('items that cannot be traded say so', async () => {
    const e = await start()
    // 0.2.0 起配「制造成本」（按它的产品，§2.2.7）
    const sent = await e.h.group('查价 Warrior II Blueprint')
    expect(card(sent)).toBe('武士蓝图 II 不能在市场上交易（T2 蓝图一般通过发明获得）。')
    expect(buttons(sent)).toEqual(['制造成本=>制造 武士 II'])
  })

  it('a bad quantity asks for a positive integer', async () => {
    const e = await start()
    expect((await e.h.group('查价 乌鸦级*0.5'))[0].text).toBe('数量要是正整数')
  })

  it('only「查价」or only a market shows how to use it, with the markets of this group', async () => {
    const e = await start()
    for (const input of ['查价', '查价 Jita']) {
      const sent = await e.h.group(input)
      expect(sent[0].markdown).toBe([
        '**查价用法**',
        '- 查价 乌鸦级：查本群的默认市场\n- 查价 Jita 乌鸦级*10：指定市场和数量\n- 中文名、英文名、常用简称都可以',
        '本群可查的市场：Jita 4-4 · Amarr · Dodixie · Rens · Hek',
      ].join('\n\n'))
      expect(buttonRows(sent)).toEqual([['查价 PLEX=>查价 PLEX', '输入物品=>查价 ']])
    }
  })

  it('several lines are handled as a batch appraisal and say so', async () => {
    const e = await start({ esi: ravenOrders })
    const sent = await e.h.group('查价 Raven*2\nRaven Navy Issue')
    expect(sent[0].markdown?.split('\n').slice(0, 2)).toEqual(['**批量估价** · Jita 4-4 · 出售价', '多行内容已按批量查价处理'])
  })
})

describe('查价: output settings', () => {
  it('output = text sends plain text with the actions written out', async () => {
    const e = await start({ config: { display: { output: 'text' } }, esi: ravenOrders })
    const sent = await e.h.group('查价 乌鸦级')
    expect(sent[0].markdown).toBeUndefined()
    expect(sent[0].text).toMatch(/^乌鸦级 Raven · 战列舰\n【Jita 4-4】\n出售 258,400,000 ISK \(258\.40M\)\n中间 253,700,000 ISK \(253\.70M\)\n收购 249,000,000 ISK \(249\.00M\)\n———\n欧服 · 更新于 \d\d:\d\d\n月度走势：@我 发送「走势 乌鸦级 月」\n季度走势：@我 发送「走势 乌鸦级 季」$/)
  })

  it('clickable = none sends Markdown without buttons and writes the numbers out', async () => {
    const e = await start({ config: { display: { clickable: 'none' } } })
    const sent = await e.h.group('查价 护盾扩展装置 II')
    expect(sent[0].rows).toEqual([])
    expect(sent[0].markdown).toContain('@我 回复编号（5 分钟内有效），也可以直接发送「查价 小型护盾扩展装置 II」')
  })

  it('the console sandbox gets plain text when allowSandbox is on, nothing when it is off', async () => {
    for (const allowSandbox of [true, false]) {
      let sandbox: FakeBot | undefined
      const e = await start({
        config: { general: { allowSandbox } },
        esi: ravenOrders,
        setup: (app) => app.plugin({ name: 'sandbox-bot', apply: (ctx) => { sandbox = new FakeBot(ctx, { platform: 'sandbox:test', selfId: 'sandbox-bot' }) } }),
      })
      const sent = await e.h.send(sandbox!, '查价 乌鸦级', { direct: true, userId: 'tester' })
      if (allowSandbox) expect(sent[0].text).toMatch(/^乌鸦级 Raven · 战列舰\n【Jita 4-4】/)
      else expect(sent).toEqual([])
      await e.stop()
      env = undefined
    }
  })
})
