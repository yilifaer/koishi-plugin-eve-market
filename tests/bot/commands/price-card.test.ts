// 查价卡片（§2.2.2–§2.2.5、§2.2.9）：默认市场、指定市场 + 数量、PLEX、市场出错、植入体套装，三种价格显示方式和纯文字。

import { describe, expect, it } from 'vitest'
import { pieceName, priceCard, setCard } from '../../../src/bot/commands/price-card'
import type { CardEnv, PriceCardInput, SetCardInput } from '../../../src/bot/commands/price-card'
import { PRESET_MARKETS } from '../../../src/config/presets'
import type { DisplaySettings, ImplantSet, PriceQuote } from '../../../src/core/types'
import { ALLIANCE_ROW, MINUTE, NOW, item, marketOf, md, quote, testCore, text } from './helpers'
import type { TestCore } from './helpers'

const RAVEN = item('Raven')
const config = { markets: [...PRESET_MARKETS, ALLIANCE_ROW] }

function envOf(core: TestCore): CardEnv {
  return { core, display: core.settings.display, now: NOW }
}

function input(core: TestCore, quotes: PriceQuote[], extra: Partial<PriceCardInput> = {}): PriceCardInput {
  const jita = marketOf(core, 'jita 4-4')
  return {
    item: RAVEN,
    quantity: null,
    quotes: quotes.map((q) => ({ market: marketOf(core, q.marketKey), quote: q })),
    base: { market: jita, quote: quotes.find((q) => q.marketKey === 'jita 4-4') ?? null },
    single: false,
    global: false,
    meta: [],
    notices: [],
    actions: [],
    ...extra,
  }
}

describe('priceCard', () => {
  it('default markets: one section per market, ▲▼ against Jita, older markets marked, notices after the footer', () => {
    const core = testCore(config)
    const card = priceCard(envOf(core), input(core, [
      quote('jita 4-4', 638, 258_400_000, 249_000_000),
      quote('联盟市场a', 638, 270_000_000, 240_000_000, { dataTime: NOW - 18 * MINUTE }),
      quote('amarr', 638, 275_000_000, null),
    ], { notices: ['联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告'] }))
    expect(md(card)).toBe([
      '**乌鸦级** Raven · 战列舰',
      '**Jita 4-4**\n\n- 出售 `258,400,000 ISK`（258.40M）\n- 中间 `253,700,000 ISK`（253.70M）\n- 收购 `249,000,000 ISK`（249.00M）',
      '**联盟市场A** · 18 分钟前\n\n- 出售 `270,000,000 ISK`（270.00M）▲4.5%\n- 中间 `255,000,000 ISK`（255.00M）\n- 收购 `240,000,000 ISK`（240.00M）▼3.6%',
      '**Amarr**\n\n- 出售 `275,000,000 ISK`（275.00M）▲6.4%\n- 中间 —\n- 收购 暂无买单',
      '***\n欧服 · 更新于 14:20 · ▲▼ 与 Jita 4-4 比较\n> 📢 联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告',
    ].join('\n\n'))
  })

  it('one named market with a quantity: totals follow priceDisplayMode, the footer names the market', () => {
    const core = testCore(config)
    const card = priceCard(envOf(core), input(core, [quote('联盟市场a', 638, 270_000_000, 240_000_000, { dataTime: NOW - 4 * MINUTE })], {
      quantity: 10,
      single: true,
      base: { market: marketOf(core, 'jita 4-4'), quote: quote('jita 4-4', 638, 258_400_000, 249_000_000) },
    }))
    expect(md(card)).toBe([
      '**乌鸦级** Raven ×10 · 战列舰',
      '**联盟市场A**\n\n- 出售 `270,000,000 ISK`（270.00M）▲4.5% · 合计 2.70B\n- 中间 `255,000,000 ISK`（255.00M）· 合计 2.55B\n- 收购 `240,000,000 ISK`（240.00M）▼3.6% · 合计 2.40B',
      '***\n欧服 · 联盟市场A 更新于 14:16 · ▲▼ 与 Jita 4-4 比较',
    ].join('\n\n'))
  })

  it('without the base quote in time there are no arrows and no comparison note', () => {
    const core = testCore(config)
    const card = priceCard(envOf(core), input(core, [quote('联盟市场a', 638, 270_000_000, 240_000_000)], {
      single: true,
      base: { market: marketOf(core, 'jita 4-4'), quote: null },
    }))
    expect(md(card)).not.toMatch(/[▲▼]/)
  })

  it('never shows 0 ISK: a market with no orders says so on both sides', () => {
    const core = testCore(config)
    const card = priceCard(envOf(core), input(core, [quote('jita 4-4', 638, null, null)]))
    expect(md(card)).toContain('- 出售 暂无卖单\n- 中间 —\n- 收购 暂无买单')
    expect(md(card)).not.toContain('0 ISK')
  })

  it('PLEX: one global section and a footer explaining why, even when a market was named', () => {
    const core = testCore(config)
    const plex = item('PLEX')
    const card = priceCard(envOf(core), {
      ...input(core, [quote('联盟市场a', plex.typeId, 5_012_000, 4_861_000, { source: 'global' })], { single: true, global: true, quantity: 500 }),
      item: plex,
      base: undefined,
    })
    expect(md(card)).toBe([
      '**PLEX** ×500 · 伊甸币',
      '**PLEX 全局市场**\n\n- 出售 `5,012,000 ISK`（5.01M）· 合计 2.51B\n- 中间 `4,936,500 ISK`（4.94M）· 合计 2.47B\n- 收购 `4,861,000 ISK`（4.86M）· 合计 2.43B',
      '***\n欧服 · 更新于 14:20 · PLEX 全宇宙统一交易，不分市场',
    ].join('\n\n'))
  })

  it('a market that fails shows one sentence, the others answer normally', () => {
    const core = testCore(config)
    const card = priceCard(envOf(core), input(core, [
      quote('jita 4-4', 638, 258_400_000, 249_000_000),
      quote('联盟市场a', 638, null, null, { status: 'auth_error', reason: 'auth', dataTime: null }),
      quote('amarr', 638, 260_000_000, 250_000_000, { status: 'stale', reason: 'cache', dataTime: NOW - 23 * MINUTE }),
    ]))
    const out = md(card)
    expect(out).toContain('**联盟市场A**\n⚠ 市场数据暂时不可用（ESI 授权或建筑访问权限异常）')
    expect(out).toContain('**Amarr** · 23 分钟前（缓存）\n\n- 出售 `260,000,000 ISK`（260.00M）▲0.6%')
    expect(out).toContain('**Jita 4-4**\n\n- 出售 `258,400,000 ISK`')
  })

  it('the meta line says which name matched or that the item is new', () => {
    const core = testCore(config)
    const card = priceCard(envOf(core), input(core, [quote('jita 4-4', 638, 1, 1)], { meta: ['按「乌鸦级」查询'] }))
    expect(md(card).split('\n')[1]).toBe('按「乌鸦级」查询')
  })

  it.each<[DisplaySettings['priceDisplayMode'], string]>([
    ['full_and_compact', '- 出售 `270,000,000 ISK`（270.00M）· 合计 2.70B'],
    ['full_only', '- 出售 `270,000,000 ISK` · 合计 2,700,000,000 ISK'],
    ['compact_only', '- 出售 `270.00M` · 合计 2.70B'],
  ])('priceDisplayMode %s', (mode, line) => {
    const core = testCore(config, { priceDisplayMode: mode })
    const card = priceCard(envOf(core), input(core, [quote('联盟市场a', 638, 270_000_000, 240_000_000)], { quantity: 10, single: true, base: undefined }))
    expect(md(card).split('\n')).toContain(line)
  })

  it('numberStyle bold and plain', () => {
    const core = testCore(config)
    const card = priceCard(envOf(core), input(core, [quote('jita 4-4', 638, 258_400_000, null)], { base: undefined }))
    expect(md(card, { numberStyle: 'bold' })).toContain('- 出售 **258,400,000 ISK**（258.40M）')
    expect(md(card, { numberStyle: 'plain' })).toContain('- 出售 258,400,000 ISK（258.40M）')
  })

  it('renders as plain text when Markdown is not used (§2.2.9)', () => {
    const core = testCore(config)
    const card = priceCard(envOf(core), input(core, [
      quote('jita 4-4', 638, 258_400_000, 249_000_000),
      quote('联盟市场a', 638, 270_000_000, 240_000_000),
    ], {
      notices: ['联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告'],
      actions: [[{ label: '相关物品', command: { id: 'search', args: '乌鸦级' } }]],
    }))
    expect(text(card)).toBe([
      '乌鸦级 Raven · 战列舰',
      '【Jita 4-4】',
      '出售 258,400,000 ISK (258.40M)',
      '中间 253,700,000 ISK (253.70M)',
      '收购 249,000,000 ISK (249.00M)',
      '【联盟市场A】',
      '出售 270,000,000 ISK (270.00M) ▲4.5%',
      '中间 255,000,000 ISK (255.00M)',
      '收购 240,000,000 ISK (240.00M) ▼3.6%',
      '———',
      '欧服 · 更新于 14:20 · ▲▼ 与 Jita 4-4 比较',
      '📢 联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告',
      '相关物品：@我 发送「搜索 乌鸦级」',
    ].join('\n'))
  })
})

describe('setCard', () => {
  const core = testCore(config)
  const res = core.items.resolve('高级水晶', { scope: 'market' })
  if (res.kind !== 'set') throw new Error('高级水晶 should be a set')
  const set: ImplantSet = res.set
  const prices = [31.5e6, 33.2e6, 35e6, 38.9e6, 41.2e6, 128e6]
  const buys = [28e6, 29.1e6, 31.4e6, 34e6, 36.5e6, 112e6]
  const quotesOf = (key: string, sell: number[], buy: Array<number | null>) =>
    new Map(set.items.map((it, i) => [it.typeId, quote(key, it.typeId, sell[i], buy[i])]))

  function setInput(extra: Partial<SetCardInput> = {}): SetCardInput {
    const jita = { market: marketOf(core, 'jita 4-4'), quotes: quotesOf('jita 4-4', prices, buys) }
    const alliance = { market: marketOf(core, '联盟市场a'), quotes: quotesOf('联盟市场a', prices.map((p) => p * 1.0338), [...buys.slice(0, 5), null]) }
    return { set, quantity: null, markets: [jita, alliance], base: jita, notices: [], actions: [], ...extra }
  }

  it('names each piece by its grade', () => {
    expect(set.items.map((i) => pieceName(set, i))).toEqual(['阿尔法型', '贝它型', '伽玛型', '德尔塔型', '伊普西隆型', '欧米伽型'])
  })

  it('lists every piece for the first market, one total line for the others; a missing piece is counted, not zero', () => {
    const out = md(setCard(envOf(core), setInput()))
    expect(out).toBe([
      '**高级水晶套装** High-grade Crystal · 6 件',
      [
        '**Jita 4-4**',
        '',
        '- 阿尔法型 · 出售 31.50M · 收购 28.00M',
        '- 贝它型 · 出售 33.20M · 收购 29.10M',
        '- 伽玛型 · 出售 35.00M · 收购 31.40M',
        '- 德尔塔型 · 出售 38.90M · 收购 34.00M',
        '- 伊普西隆型 · 出售 41.20M · 收购 36.50M',
        '- 欧米伽型 · 出售 128.00M · 收购 112.00M',
        '- **合计** 出售 `307,800,000 ISK`（307.80M）',
        '- **合计** 收购 `271,000,000 ISK`（271.00M）',
      ].join('\n'),
      '**联盟市场A** 合计 出售 318.20M ▲3.4% · 收购 缺 1 件',
      '***\n欧服 · 更新于 14:20 · ▲▼ 与 Jita 4-4 比较',
    ].join('\n\n'))
  })

  it('a quantity multiplies the totals', () => {
    const out = md(setCard(envOf(core), setInput({ quantity: 2, markets: [setInput().markets[0]] })))
    expect(out).toContain('**高级水晶套装** High-grade Crystal ×2 · 6 件')
    expect(out).toContain('- **合计** 出售 `615,600,000 ISK`（615.60M）')
  })

  // 每一件跟 listPriceDisplayMode；第一个市场的合计、其他市场的合计行跟 priceDisplayMode
  it.each([
    ['full_and_compact', 'compact_only', '31.50M', '`307,800,000 ISK`（307.80M）', '318.20M'],
    ['full_only', 'compact_only', '31.50M', '`307,800,000 ISK`', '318,203,640 ISK'],
    ['compact_only', 'compact_only', '31.50M', '`307.80M`', '318.20M'],
    ['full_and_compact', 'inherit', '31,500,000 ISK（31.50M）', '`307,800,000 ISK`（307.80M）', '318.20M'],
    ['full_only', 'inherit', '31,500,000 ISK', '`307,800,000 ISK`', '318,203,640 ISK'],
  ] as const)('priceDisplayMode %s, listPriceDisplayMode %s', (mode, list, piece, total, other) => {
    const c = testCore(config, { priceDisplayMode: mode, listPriceDisplayMode: list })
    const jita = { market: marketOf(c, 'jita 4-4'), quotes: quotesOf('jita 4-4', prices, buys) }
    const alliance = { market: marketOf(c, '联盟市场a'), quotes: quotesOf('联盟市场a', prices.map((p) => p * 1.0338), [...buys.slice(0, 5), null]) }
    const out = md(setCard(envOf(c), { set, quantity: null, markets: [jita, alliance], base: jita, notices: [], actions: [] }))
    expect(out).toContain(`- 阿尔法型 · 出售 ${piece} · `)
    expect(out).toContain(`- **合计** 出售 ${total}`)
    expect(out).toContain(`**联盟市场A** 合计 出售 ${other} ▲3.4% · 收购 缺 1 件`)
  })

  it('a market without any price says why', () => {
    const failed = { market: marketOf(core, '联盟市场a'), quotes: null }
    const out = md(setCard(envOf(core), setInput({ markets: [setInput().markets[0], failed] })))
    expect(out).toContain('**联盟市场A** ⚠ 查询超时，暂时取不到价格')
  })
})
