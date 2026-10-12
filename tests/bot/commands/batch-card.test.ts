// 批量查价的卡片（§2.3.2–§2.3.5）：详细、紧凑、拆分、超过 120 种；警告、回退、未识别的候选；装配估价和运费；
// 只发表头、一行都没认出来、整个市场不可用。

import { describe, expect, it } from 'vitest'
import { headerCard, nothingCard, resultCards, unavailableCard, warningLines } from '../../../src/bot/commands/batch-card'
import type { BatchEnv, ResultOptions } from '../../../src/bot/commands/batch-card'
import { PRESET_MARKETS } from '../../../src/config/presets'
import type { AppraisalResult, AppraisalRow } from '../../../src/core/types'
import { marketItems } from '../../fixtures/data/load'
import { ALLIANCE_ROW, NOW, adjusted, appraisal, buttons, item, marketOf, md, row, testCore, text } from './helpers'
import type { TestCore } from './helpers'

const core = testCore({
  markets: [...PRESET_MARKETS, ALLIANCE_ROW],
  freight: { routes: [{ name: '前线', iskPerM3: 800, collateralPct: 1, maxVolume: 350_000, visibility: 'public', enabled: true }] },
})
const jita = marketOf(core, 'jita 4-4')
const alliance = marketOf(core, '联盟市场a')

function env(c: TestCore = core): BatchEnv {
  return { core: c, display: c.settings.display, routes: c.settings.freight.routes, commandName: '批量查价', base: jita }
}

const options = (extra: Partial<ResultOptions> = {}): ResultOptions => ({ all: false, maxParts: 3, notices: [], ...extra })

/** n 行，金额从大到小是 n, n-1, … 百万 */
function manyRows(n: number): AppraisalRow[] {
  const items = marketItems(Math.min(n, 120))
  return Array.from({ length: n }, (_, i) => row({ ...items[i % items.length], typeId: 900_000 + i }, 1, (i + 1) * 1e6, { sourceLines: [i + 1] }))
}

describe('detailed layout (≤ 10 types)', () => {
  const rows = [
    adjusted(row(item('Raven'), 2, 270e6, { sourceLines: [1] }), -5),
    adjusted(row(item('Tritanium'), 1_000_000, 5.4, { sourceLines: [2] }), -5),
    adjusted(row(item('Pyerite'), 500_000, 13.2, { sourceLines: [3] }), -5),
  ]
  const result = appraisal(alliance, rows, { modifierPct: -5, dataTime: NOW - 4 * 60_000 })

  it('matches the §2.3.2 example: paste order, unit before and after the adjustment, packaged volume', () => {
    const cards = resultCards(env(), result, options({ notices: ['联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告'] }))
    expect(cards).toHaveLength(1)
    expect(md(cards[0])).toBe([
      '**批量估价 · 联盟市场A · 出售价 -5%**',
      '**合计** `524,400,000 ISK`（524.40M）\n调整前 552.00M · 3 种 · 1,500,002 件',
      [
        '1. **乌鸦级** ×2 · `513.00M`',
        '    - 单价 270.00M → 256.50M',
        '2. **三钛合金** ×1,000,000 · `5.13M`',
        '    - 单价 5.40 → 5.13',
        '3. **类晶体胶矿** ×500,000 · `6.27M`',
        '    - 单价 13.20 → 12.54',
      ].join('\n'),
      '📦 打包体积 115,000 m³',
      '***\n欧服 · 联盟市场A 更新于 14:16 · 估价 #K7Q2\n> 📢 联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告',
    ].join('\n\n'))
    expect(buttons(cards[0])).toEqual([['改用收购价=>批量查价 #K7Q2 buy', '改用中间价=>批量查价 #K7Q2 mid', '改用 Jita=>批量查价 #K7Q2 Jita']])
  })

  it('adds the comparison with the base market when it came back in time', () => {
    const vs = { ...result, vsBase: { marketKey: 'jita 4-4', side: 'sell' as const, total: 528.2e6, diffPct: 4.5 } }
    expect(md(resultCards(env(), vs, options())[0])).toContain('调整前 552.00M · 3 种 · 1,500,002 件\n按 Jita 4-4 出售价合计 528.20M（联盟市场A 高 4.5%）')
  })

  it('without an adjustment there is no「调整前」and the unit is shown once', () => {
    const plain = appraisal(jita, [row(item('Raven'), 2, 258.4e6)])
    const out = md(resultCards(env(), plain, options())[0])
    expect(out).toContain('**合计** `516,800,000 ISK`（516.80M）\n1 种 · 2 件')
    expect(out).toContain('1. **乌鸦级** ×2 · `516.80M`\n    - 单价 258.40M')
    // 估价市场就是基准市场：没有「改用 Jita」
    expect(buttons(resultCards(env(), plain, options())[0])).toEqual([['改用收购价=>批量查价 #K7Q2 buy', '改用中间价=>批量查价 #K7Q2 mid']])
  })

  it('names follow the language of the pasted line; prefix matches get ≈, fallback rows get †', () => {
    const rows2 = [
      row(item('Raven'), 1, 1e6, { lang: 'en' }),
      row(item('Raven Navy Issue'), 1, 2e6, { approx: true }),
      row(item('Tritanium'), 1, 3, { fallback: { marketKey: 'jita 4-4', side: 'sell' } }),
    ]
    const out = md(resultCards(env(), appraisal(alliance, rows2), options())[0])
    expect(out).toContain('1. **Raven** ×1')
    expect(out).toContain('2. ≈**乌鸦级海军型** ×1')
    expect(out).toContain('3. **三钛合金**† ×1')
    expect(out).toContain('† 标记的物品 联盟市场A 没有价格，已改用 Jita 4-4 出售价')
  })

  it('renders as plain text too', () => {
    const out = text(resultCards(env(), result, options())[0])
    expect(out).toContain('合计 524,400,000 ISK (524.40M)\n调整前 552.00M · 3 种 · 1,500,002 件')
    expect(out).toContain('1. 乌鸦级 ×2 · 513.00M\n· 单价 270.00M → 256.50M')
    expect(out).toContain('改用收购价：@我 发送「批量查价 #K7Q2 buy」')
  })
})

describe('longer lists', () => {
  it('11–40 types: one line each, by amount', () => {
    const cards = resultCards(env(), appraisal(jita, manyRows(12)), options())
    expect(cards).toHaveLength(1)
    const lines = md(cards[0]).split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(12)
    expect(lines[0]).toMatch(/^- .+ ×1 · 12\.00M · \*\*12\.00M\*\*$/)
    expect(lines[11]).toMatch(/· \*\*1\.00M\*\*$/)
  })

  it('41–120 types: the first message has totals and the top 30, the rest goes into「明细」; buttons only on the last', () => {
    const cards = resultCards(env(), appraisal(jita, manyRows(60)), options())
    expect(cards).toHaveLength(2)
    expect(md(cards[0]).split('\n').filter((l) => l.startsWith('- '))).toHaveLength(30)
    expect(md(cards[0])).toContain('估价 #K7Q2')
    expect(cards[0].actions).toEqual([])
    expect(md(cards[1]).startsWith('**批量估价 #K7Q2 明细 2/2**')).toBe(true)
    expect(md(cards[1]).split('\n').filter((l) => l.startsWith('- '))).toHaveLength(30)
    expect(cards[1].actions.length).toBeGreaterThan(0)
  })

  it('more than 120 types: only the top 120 are listed, the rest is summed, and「完整清单」asks for all', () => {
    const cards = resultCards(env(), appraisal(jita, manyRows(150)), options())
    const all = cards.map((c) => md(c)).join('\n')
    expect(all.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(120)
    // 金额最小的 30 种：1M … 30M，共 465M
    expect(all).toContain('…其余 30 种共 465.00M，已计入合计')
    expect(buttons(cards[cards.length - 1])[0]).toEqual(['完整清单=>批量查价 #K7Q2 全部'])
    expect(cards.length).toBeLessThanOrEqual(3)
    for (const card of cards) expect(md(card).length).toBeLessThanOrEqual(3500)
  })

  it('「全部」lists beyond 120 in as many messages as allowed, without asking again', () => {
    const cards = resultCards(env(), appraisal(jita, manyRows(150)), options({ all: true }))
    const all = cards.map((c) => md(c)).join('\n')
    const listed = all.split('\n').filter((l) => l.startsWith('- ')).length
    expect(listed).toBeGreaterThan(120)
    expect(all).not.toContain('完整清单')
    if (listed < 150) expect(all).toContain(`…其余 ${150 - listed} 种`)
  })

  it('with only one message left the details are summed up in the first one', () => {
    const cards = resultCards(env(), appraisal(jita, manyRows(60)), options({ maxParts: 1 }))
    expect(cards).toHaveLength(1)
    expect(md(cards[0])).toContain('…其余 30 种共 465.00M，已计入合计')
    expect(buttons(cards[0])[0]).toEqual(['完整清单=>批量查价 #K7Q2 全部'])
  })
})

describe('warnings', () => {
  const raven = item('Raven')
  const rows = [
    row(raven, 1, 258.4e6, { sourceLines: [1] }),
    row(item('Raven State Issue'), 1, null, { sourceLines: [12] }),
    row(item('Megathron'), 1, null, { sourceLines: [15] }),
  ]
  const result = appraisal(alliance, rows, {
    unresolved: [
      { lineNo: 7, raw: 'Raven Navvy', suggestion: item('Raven Navy Issue'), candidates: [item('Raven Navy Issue')], total: 1 },
      { lineNo: 9, raw: '护盾扩展', suggestion: item('Large Shield Extender II'), candidates: [item('Large Shield Extender II')], total: 52 },
    ],
    noPrice: [{ item: item('Raven State Issue'), reason: 'no-orders' }, { item: item('Megathron'), reason: 'timeout' }],
    skipped: [{ lineNo: 3, raw: 'Raven Blueprint (Copy)', reason: 'bpc' }, { lineNo: 4, raw: 'Raven*0.5', reason: 'quantity' }, { lineNo: 5, raw: '', reason: 'empty' }],
  })

  it('lists every line left out of the total, by line number', () => {
    expect(warningLines(result)).toEqual([
      '第 3 行「Raven Blueprint (Copy)」蓝图拷贝不能在市场交易',
      '第 4 行「Raven\\*0.5」数量要是正整数',
      '第 7 行「Raven Navvy」没有找到，是不是：Raven Navy Issue？',
      '第 9 行「护盾扩展」可能是 52 种物品，请写完整名称',
      '第 12 行 乌鸦级政府型：联盟市场A 无有效卖单',
      '第 15 行 万王宝座级：超时，暂时取不到价格',
    ])
  })

  it('puts the warnings after the rows and before the volume, with candidates for up to 3 unresolved lines', () => {
    const card = resultCards(env(), result, options())[0]
    const out = md(card)
    expect(out.indexOf('1. **乌鸦级**')).toBeLessThan(out.indexOf('⚠ 有 6 行没有计入合计：'))
    expect(out.indexOf('⚠ 有 6 行没有计入合计：')).toBeLessThan(out.indexOf('📦 打包体积'))
    expect(out).toContain('1 种 · 1 件 · 另有 1 种暂时取不到价格')
    expect(card.choices?.map((c) => `${c.label}=>${c.command.args}`)).toEqual([
      '第 7 行：Raven Navy Issue=>#K7Q2 7=#17636',
      '第 9 行：大型护盾扩展装置 II=>#K7Q2 9=#3841',
    ])
  })

  it('a line matching several items asks for the full name; a lone fuzzy guess asks「是不是」', () => {
    const extenders = ['Small Shield Extender II', 'Medium Shield Extender II', 'Large Shield Extender II'].map(item)
    const lines = warningLines(appraisal(jita, [], {
      unresolved: [
        { lineNo: 2, raw: '护盾扩展装置 II', suggestion: extenders[0], candidates: extenders, total: 3 },
        { lineNo: 3, raw: 'sthj', suggestion: item('Tritanium'), candidates: [item('Tritanium')], total: 1 },
        { lineNo: 4, raw: 'Ravn', suggestion: item('Raven'), candidates: [item('Raven')], total: 0 },
        { lineNo: 5, raw: 'zzzz', total: 0 },
      ],
    }))
    expect(lines).toEqual([
      '第 2 行「护盾扩展装置 II」可能是 3 种物品，请写完整名称',
      '第 3 行「sthj」没有找到，是不是：Tritanium？',
      '第 4 行「Ravn」没有找到，是不是：Raven？',
      '第 5 行「zzzz」没有找到',
    ])
  })

  it('no candidate buttons for more than 3 unresolved lines', () => {
    const many = { ...result, unresolved: [7, 8, 9, 10].map((lineNo) => ({ lineNo, raw: 'x', total: 0 })) }
    expect(resultCards(env(), many, options())[0].choices).toBeUndefined()
  })

  it('a long list was cut', () => {
    expect(md(resultCards(env(), { ...result, truncated: 5 }, options())[0])).toContain('⚠ 清单太长，只处理了前 200 行，剩下的请分开发')
  })
})

describe('nothing priced', () => {
  const rows = [row(item('Raven'), 2, null, { sourceLines: [1] }), row(item('Tritanium'), 10, null, { sourceLines: [2] })]
  const result = appraisal(alliance, rows, {
    modifierPct: -5,
    noPrice: [{ item: item('Raven'), reason: 'no-orders' }, { item: item('Tritanium'), reason: 'timeout' }],
    freight: [{ route: '前线', fee: 1_000_000, contracts: 1, landed: 1_000_000 }],
    vsBase: { marketKey: 'jita 4-4', side: 'sell', total: 540e6, diffPct: -100 },
    dataTime: null,
  })

  it.each(['full_and_compact', 'full_only', 'compact_only'] as const)('shows a dash for the total, never 0 ISK (%s)', (mode) => {
    const c = testCore({ markets: [...PRESET_MARKETS, ALLIANCE_ROW], freight: { routes: [] } }, { priceDisplayMode: mode })
    const cards = resultCards(env(c), result, options())
    const out = md(cards[0])
    expect(out).toContain('**批量估价 · 联盟市场A · 出售价 -5%**\n\n**合计 —**\n没有取到任何价格')
    expect(out).toContain('- 第 1 行 乌鸦级：联盟市场A 无有效卖单\n- 第 2 行 三钛合金：超时，暂时取不到价格')
    expect(out).not.toMatch(/0\.00|0 ISK|调整前|按 Jita|运到|到货成本/)
    expect(text(cards[0])).toContain('合计 —\n没有取到任何价格')
    // 清单已经存下：按钮照样可以换市场、换价格类型
    expect(buttons(cards[0]).flat()).toContain('改用 Jita=>批量查价 #K7Q2 Jita')
  })
})

describe('price display modes (§2.0.7)', () => {
  const rows = [
    adjusted(row(item('Raven'), 2, 270e6, { sourceLines: [1] }), -5),
    adjusted(row(item('Tritanium'), 1_000_000, 5.4, { sourceLines: [2] }), -5),
  ]
  const result = appraisal(alliance, rows, {
    modifierPct: -5,
    vsBase: { marketKey: 'jita 4-4', side: 'sell', total: 528.2e6, diffPct: 4.5 },
    freight: [{ route: '前线', fee: 44_055_521, contracts: 1, landed: 423_370_000 }],
  })
  // 合计这一类跟 priceDisplayMode（完整和简写都有时，一行里的小金额只写简写）；每一行跟 listPriceDisplayMode
  const cases = [
    ['full_and_compact', 'compact_only', '`518,130,000 ISK`（518.13M）', '545.40M', '528.20M', '423.37M', '`513.00M`', '270.00M → 256.50M'],
    ['full_only', 'compact_only', '`518,130,000 ISK`', '545,400,000 ISK', '528,200,000 ISK', '423,370,000 ISK', '`513.00M`', '270.00M → 256.50M'],
    ['compact_only', 'compact_only', '`518.13M`', '545.40M', '528.20M', '423.37M', '`513.00M`', '270.00M → 256.50M'],
    ['full_and_compact', 'inherit', '`518,130,000 ISK`（518.13M）', '545.40M', '528.20M', '423.37M', '`513,000,000 ISK`（513.00M）', '270.00M → 256.50M'],
    ['full_only', 'inherit', '`518,130,000 ISK`', '545,400,000 ISK', '528,200,000 ISK', '423,370,000 ISK', '`513,000,000 ISK`', '270,000,000 ISK → 256,500,000 ISK'],
  ] as const

  it.each(cases)('priceDisplayMode %s, listPriceDisplayMode %s', (mode, list, total, before, vs, landed, rowTotal, unit) => {
    const c = testCore({
      markets: [...PRESET_MARKETS, ALLIANCE_ROW],
      freight: { routes: [{ name: '前线', iskPerM3: 800, collateralPct: 1, maxVolume: 350_000, visibility: 'public', enabled: true }] },
    }, { priceDisplayMode: mode, listPriceDisplayMode: list })
    const out = md(resultCards(env(c), result, options())[0])
    expect(out).toContain(`**合计** ${total}\n调整前 ${before} · 2 种 · 1,000,002 件\n按 Jita 4-4 出售价合计 ${vs}（联盟市场A 高 4.5%）`)
    expect(out).toContain(`1. **乌鸦级** ×2 · ${rowTotal}\n    - 单价 ${unit}`)
    expect(out).toContain(`· 到货成本 ${landed}`)
  })

  it.each([
    ['compact_only', '- 乌鸦级 ×1 · 12.00M · **12.00M**'],
    ['inherit', '- 乌鸦级 ×1 · 12,000,000 ISK · **12,000,000 ISK**'],
  ] as const)('compact rows follow listPriceDisplayMode (%s, priceDisplayMode full_only)', (list, line) => {
    const c = testCore({ markets: [...PRESET_MARKETS, ALLIANCE_ROW] }, { priceDisplayMode: 'full_only', listPriceDisplayMode: list })
    const many = Array.from({ length: 12 }, (_, i) => row({ ...item('Raven'), typeId: 800_000 + i }, 1, (i + 1) * 1e6, { sourceLines: [i + 1] }))
    expect(md(resultCards(env(c), appraisal(jita, many), options())[0])).toContain(line)
  })
})

describe('fitting', () => {
  it('subtotals by hull, modules and drones/charges; rows by amount; loaded charges and freight from Jita', () => {
    const rows: AppraisalRow[] = [
      row(item('Raven'), 1, 258.4e6, { group: 'hull' }),
      row(item('Cruise Missile Launcher II'), 6, 2.1e6, { group: 'module' }),
      row(item('Large Shield Extender II'), 2, 2.8e6, { group: 'module' }),
      row(item('Hammerhead II'), 5, 450_000, { group: 'drone-charge' }),
      row(item('Scourge Cruise Missile'), 2162, 260, { group: 'drone-charge' }),
    ]
    const result = appraisal(jita, rows, {
      fitting: { ship: item('Raven'), name: '刷怪乌鸦', loadedCharges: [{ charge: item('Scourge Cruise Missile'), modules: 6, perModule: 27 }] },
      freight: [{ route: '前线', fee: 44_055_521, contracts: 1, landed: 423_370_000 }],
    })
    const out = md(resultCards(env(), result, options())[0])
    expect(out.split('\n\n').slice(0, 4)).toEqual([
      '**装配估价 · 乌鸦级「刷怪乌鸦」**\nJita 4-4 · 出售价',
      `**合计** \`${(258.4e6 + 12.6e6 + 5.6e6 + 2.25e6 + 562_120).toLocaleString('en-US')} ISK\`（279.41M）\n5 种 · 2,176 件`,
      '- 船体 乌鸦级 · `258.40M`\n- 装备 8 件 · `18.20M`\n- 无人机和弹药 · `2.81M`',
      [
        '1. 乌鸦级 ×1 · `258.40M`',
        '2. 巡航导弹发射器 II ×6 · `12.60M`',
        '3. 大型护盾扩展装置 II ×2 · `5.60M`',
        '4. 战锤 II ×5 · `2.25M`',
        '5. 鞭挞巡航导弹 ×2,162 · `562.12K`',
      ].join('\n'),
    ])
    expect(out).toContain('📦 打包体积')
    expect(out).toContain('装填弹药按满装计算（6 × 27 发）')
    expect(out).toContain('🚚 运到 前线 约 `44,055,521 ISK`（44.06M）· 800 ISK/m³ + 押金 1% · 到货成本 423.37M')
  })

  it('a route over the volume limit needs several contracts; missing collateral is mentioned', () => {
    const result = appraisal(jita, [row(item('Raven'), 10, 258.4e6, { group: 'hull' })], {
      fitting: { ship: item('Raven'), name: '' },
      freight: [{ route: '前线', fee: 1e9, contracts: 2, landed: 3.6e9 }],
      freightMissing: 1,
    })
    const out = md(resultCards(env(), result, options())[0])
    expect(out.split('\n')[0]).toBe('**装配估价 · 乌鸦级**')
    expect(out).toContain('· 超过 350,000 m³，需要拆成 2 单')
    expect(out).toContain('（1 种物品没有 Jita 4-4 出售价，押金没有算进去）')
  })
})

describe('other batch cards', () => {
  it('header only: asks for the list (no @ needed in direct chats)', () => {
    const card = headerCard(env(), { marketName: '联盟市场A', side: 'sell', modifierPct: -5 }, false)
    expect(md(card)).toBe([
      '**批量查价 · 联盟市场A · 出售价 -5%**',
      '请在 5 分钟内 @我 粘贴清单：一行一个，可以直接从游戏里复制，也可以粘贴装配。',
      '- 例：Raven*2\n- 例：Tritanium 1000000',
    ].join('\n\n'))
    expect(md(headerCard(env(), { marketName: 'Jita 4-4', side: 'buy', modifierPct: 0 }, true))).toContain('**批量查价 · Jita 4-4 · 收购价**\n\n请在 5 分钟内粘贴清单：')
  })

  it('nothing recognized: warnings and how to paste again, no total', () => {
    const result = appraisal(jita, [], { unresolved: [{ lineNo: 1, raw: 'abc', total: 0 }] })
    const out = md(nothingCard(env(), result, false))
    expect(out).toContain('⚠ 有 1 行没有计入合计：\n\n- 第 1 行「abc」没有找到')
    expect(out).toContain('请在 5 分钟内 @我 重新粘贴清单')
    expect(out).not.toContain('合计 `')
  })

  it('market unavailable: no total, the list is kept, buttons switch to the base market first', () => {
    const failure: Parameters<typeof unavailableCard>[1] = {
      ok: false, code: 'MARKET_UNAVAILABLE', marketKey: '联盟市场a', markets: ['amarr', 'jita 4-4', 'dodixie', 'rens', 'hek'], appraisalId: 'K7Q2',
    }
    const card = unavailableCard(env(), failure, { side: 'sell', modifierPct: -5 })
    expect(md(card)).toBe([
      '**批量估价 · 联盟市场A · 出售价 -5%**',
      '⚠ 联盟市场A 市场数据暂时不可用（ESI 授权或建筑访问权限异常）',
      '清单已保存为 #K7Q2（24 小时内有效），可以先改用其他市场估价。',
    ].join('\n\n'))
    expect(buttons(card)).toEqual([[
      '改用 Jita=>批量查价 #K7Q2 Jita', '改用 Amarr=>批量查价 #K7Q2 Amarr', '改用 Dodi…=>批量查价 #K7Q2 Dodixie', '改用 Rens=>批量查价 #K7Q2 Rens',
    ]])
    expect(md(unavailableCard(env(), { ...failure, quoteReason: 'sync_error' }, { side: 'sell', modifierPct: 0 }))).toContain('（同步异常）')
  })

  it('the result fits any order of the same rows (paste order kept for the detailed layout)', () => {
    const r: AppraisalResult = appraisal(jita, [row(item('Tritanium'), 10, 5), row(item('Raven'), 1, 2e8)])
    const out = md(resultCards(env(), r, options())[0])
    expect(out.indexOf('三钛合金')).toBeLessThan(out.indexOf('乌鸦级'))
  })
})
