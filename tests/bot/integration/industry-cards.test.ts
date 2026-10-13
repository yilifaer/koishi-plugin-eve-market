// 工业卡片的排版（§2.6.4、§2.6.5、§2.7）：用 §2.6.4 示例里的数字拼一份结果，看三种金额显示方式和纯文字。
// 地点、建筑名是编造的；价格数字都是示例值，只保证同一个例子里前后一致。

import { describe, expect, it } from 'vitest'
import { compareCard, materialsCard, resultCard } from '../../../src/bot/commands/industry-card'
import type { IndustryEnv } from '../../../src/bot/commands/industry-card'
import type { DisplaySettings, IndustryResult, ItemInfo, LocationComparison } from '../../../src/core/types'
import { item, md, testCore, text } from '../commands/helpers'

const RAVEN = item('Raven')
const RIG: ItemInfo = { ...item('Tritanium'), typeId: 37181, en: 'Standup XL-Set Ship Manufacturing Efficiency II', zh: '屹立超大型舰船制造效率 II' }

function env(display: Partial<DisplaySettings> = {}, sellFeesPct = 0, extra: Partial<IndustryEnv['industry']> = {}): IndustryEnv {
  const core = testCore({}, display)
  return { core, display: core.settings.display, industry: { sellFeesPct, ...extra } }
}

/** §2.6.4 的示例：00 的索迪约，ME 10 / TE 20，T2 改装件，星系成本指数 2.31%，设施税 1% */
function example(over: Partial<IndustryResult> = {}): IndustryResult {
  const materials: IndustryResult['materials'] = [
    { item: item('Pyerite'), baseQuantity: 2_600_000, quantity: 2_199_844, unit: 28, total: 61_595_632, manufacturable: false },
    { item: item('Tritanium'), baseQuantity: 5_200_000, quantity: 4_399_687, unit: 4.1, total: 18_038_716.7, manufacturable: false },
  ]
  return {
    product: RAVEN,
    blueprint: item('Raven Blueprint'),
    runs: 1,
    jobs: [1],
    outputQuantity: 1,
    applied: {
      location: 'XX-1', systemId: 30000900, secClass: 'null', structure: '索迪约',
      rigs: [{ item: RIG, me: -5.04, te: -50.4, cost: 0 }],
      structureBonus: { me: -1, te: -30, cost: -5 },
      me: 10, te: 20, sci: 0.0231, facilityTaxPct: 1, sccPct: 4, defaulted: [],
    },
    materials,
    materialCost: 155_129_544,
    missingPrices: 0,
    jobCost: { eiv: 175_000_000, grossSci: 4_042_500, bonuses: -202_500, facility: 1_750_000, scc: 7_000_000, extra: 0, total: 12_590_000, missingAdjusted: 0 },
    timeSeconds: 5000,
    timeSecondsMaxSkill: 3400,
    productValue: { marketKey: 'jita 4-4', side: 'sell', unit: 258_400_000, total: 258_400_000 },
    profit: { value: 90_680_456, marginPct: 35.09 },
    formulaRevision: '2',
    warnings: [],
    materialPrices: { marketKey: 'jita 4-4', side: 'sell' },
    pricesAt: Date.UTC(2026, 9, 7, 6, 20),
    indicesAt: Date.UTC(2026, 9, 7, 5, 0),
    ...over,
  }
}

describe('result card (§2.6.4)', () => {
  it('matches the example in the default display mode', () => {
    expect(md(resultCard(env(), example(), 'manufacturing', []))).toBe([
      '**乌鸦级 Raven · 高级制造计算**',
      '',
      'XX-1 · 索迪约 · 00',
      '蓝图 ME 10 / TE 20 · 1 流程（1 艘）',
      '改装件 屹立超大型舰船制造效率 II（材料 -5.04%，时间 -50.4%）',
      '',
      '- 材料成本 `155,129,544 ISK`（155.13M）',
      '- 基础物品成本 `175,000,000 ISK`（175.00M）',
      '- 星系成本指数 2.31% `3,840,000 ISK`（3.84M）',
      '- 设施税 1.00% `1,750,000 ISK`（1.75M）',
      '- SCC 附加费 4% `7,000,000 ISK`（7.00M）',
      '- **预计总成本** `167,719,544 ISK`（167.72M）',
      '- 制造时间 1 小时 23 分（未计技能）',
      '    - 蓝图 TE 20 -20%',
      '    - 技能和植入体（按技能全 5 级，不算植入体）-32%',
      '    - 已安装的改装件 -50.4%',
      '    - 建筑持有加成 -30%',
      '    - 满技能约 57 分',
      '',
      '成品 Jita 4-4 出售 `258,400,000 ISK`（258.40M）',
      '**预计利润 90.68M · 利润率 35.1%**（未计销售税和经纪费）',
      '',
      '***',
      '欧服 · 价格更新于 14:20 · 星系成本指数更新于 13:00',
    ].join('\n'))
  })

  it('full_only and compact_only change every main amount', () => {
    const full = md(resultCard(env({ priceDisplayMode: 'full_only' }), example(), 'manufacturing', []))
    expect(full).toContain('- 星系成本指数 2.31% `3,840,000 ISK`\n')
    expect(full).toContain('- 基础物品成本 `175,000,000 ISK`\n')
    expect(full).toContain('**预计利润 90,680,456 ISK · 利润率 35.1%')
    const compact = md(resultCard(env({ priceDisplayMode: 'compact_only' }), example(), 'manufacturing', []))
    expect(compact).toContain('- 材料成本 `155.13M`\n- 基础物品成本 `175.00M`\n- 星系成本指数 2.31% `3.84M`\n')
    expect(compact).toContain('**预计利润 90.68M · 利润率 35.1%')
  })

  it('plain text: no Markdown, the same lines', () => {
    const out = text(resultCard(env(), example(), 'manufacturing', [[{ label: '查看材料', command: { id: 'manufacture', args: '乌鸦级 XX-1 材料' }, primary: true }]]))
    expect(out).toContain('材料成本 155,129,544 ISK (155.13M)\n基础物品成本 175,000,000 ISK (175.00M)\n星系成本指数 2.31% 3,840,000 ISK (3.84M)')
    expect(out).toContain('预计利润 90.68M · 利润率 35.1%（未计销售税和经纪费）')
    expect(out).toContain('查看材料：@我 发送「制造 乌鸦级 XX-1 材料」')
    expect(out).not.toMatch(/\*\*|`/)
  })

  it('other fee, deducted sell fees, defaults, a product without sell orders', () => {
    const r = example({
      jobCost: { ...example().jobCost!, extra: 1_750_000, extraLabel: '联盟管理费', total: 14_340_000 },
      applied: { ...example().applied, defaulted: ['me', 'te', 'structure'] },
      productValue: { marketKey: 'jita 4-4', side: 'sell', unit: null, total: null },
      profit: null,
    })
    const out = md(resultCard(env({}, 2), r, 'manufacturing', []))
    expect(out).toContain('XX-1 · 索迪约（默认建筑） · 00\n蓝图 ME 10 / TE 20（地点默认）')
    expect(out).toContain('- SCC 附加费 4% `7,000,000 ISK`（7.00M）\n- 联盟管理费 `1,750,000 ISK`（1.75M）\n- **预计总成本** `169,469,544 ISK`（169.47M）')
    expect(out).toContain('成品 Jita 4-4 暂无卖单')
    expect(out).not.toContain('预计利润')
    expect(md(resultCard(env({}, 2), example(), 'manufacturing', []))).toContain('（已扣销售税和经纪费 2%）')
  })
})

describe('result card: time modifiers and cost lines', () => {
  it('whole ISK in the cost lines, no .00 under 100,000', () => {
    const job = { ...example().jobCost!, eiv: 99_999, grossSci: 2_310, bonuses: 0, facility: 1_000, scc: 4_000, total: 7_310 }
    const out = md(resultCard(env({ priceDisplayMode: 'full_only' }), example({ jobCost: job }), 'manufacturing', []))
    expect(out).toContain('- 基础物品成本 `99,999 ISK`\n- 星系成本指数 2.31% `2,310 ISK`\n- 设施税 1.00% `1,000 ISK`\n- SCC 附加费 4% `4,000 ISK`\n')
  })

  it('no system cost index: the line is left out, not written as 0', () => {
    const base = example()
    const out = md(resultCard(env(), example({ applied: { ...base.applied, sci: undefined } }), 'manufacturing', []))
    expect(out).not.toContain('星系成本指数 0')
    expect(out).toContain('- 设施税 1.00%')
  })

  it('a reaction card lists the skill and rig modifiers and the max-skill time, and splits the costs', () => {
    const r = example({
      applied: { ...example().applied, structureBonus: { me: 0, te: -25, cost: 0 }, rigs: [{ item: RIG, me: 0, te: -22, cost: 0 }], te: 0 },
      timeSeconds: 8400, timeSecondsMaxSkill: 6720,
    })
    const out = md(resultCard(env(), r, 'reaction', []))
    expect(out).toContain('- 反应时间 每流程 2 小时 20 分 · 共 2 小时 20 分（未计技能）\n    - 技能和植入体（按技能全 5 级，不算植入体）-20%\n    - 已安装的改装件 -22%\n    - 建筑持有加成 -25%\n    - 满技能约 1 小时 52 分')
    expect(out).not.toContain('蓝图 TE')
    expect(out).toContain('- 基础物品成本 ')
    expect(out).not.toContain('安装费用和税')
  })

  it('no structure bonus and no rigs: only the skill line and the max-skill time', () => {
    const r = example({ applied: { ...example().applied, rigs: [], structureBonus: undefined, te: 0 } })
    const out = md(resultCard(env(), r, 'manufacturing', []))
    expect(out).toContain('- 制造时间 1 小时 23 分（未计技能）\n    - 技能和植入体（按技能全 5 级，不算植入体）-32%\n    - 满技能约 57 分\n')
    expect(out).not.toContain('建筑持有加成')
  })

  it('no max-skill time: the skill modifier line stays, the max-skill line is left out', () => {
    const r = example({ timeSecondsMaxSkill: undefined })
    const out = md(resultCard(env(), r, 'manufacturing', []))
    expect(out).toContain('技能和植入体（按技能全 5 级，不算植入体）-32%')
    expect(out).not.toContain('满技能约')
  })
})

describe('result card: rigs and data age', () => {
  const rigsOf = (over: Partial<IndustryResult['applied']>) =>
    md(resultCard(env(), example({ applied: { ...example().applied, rigs: [], ...over } }), 'manufacturing', []))

  it('the rig line follows what core worked out', () => {
    expect(rigsOf({ rigState: 'disabled' })).toContain('\n改装件 不用（改装:无）\n')
    expect(rigsOf({ rigState: 'not-installed' })).toContain('\n改装件 未装\n')
    expect(rigsOf({ rigState: 'not-applicable' })).toContain('\n改装件：无适用（该建筑没有对乌鸦级生效的改装件）\n')
    // 「建筑:无」、NPC 空间站：本来就装不了，不写这一行
    expect(rigsOf({ rigState: 'impossible' })).not.toContain('改装件')
  })

  it('the only structure of the location is marked as such, a default among several as the default', () => {
    const only = md(resultCard(env(), example({ applied: { ...example().applied, defaulted: ['structure'], structureOnly: true } }), 'manufacturing', []))
    expect(only).toContain('XX-1 · 索迪约（该地点唯一） · 00')
    const first = md(resultCard(env(), example({ applied: { ...example().applied, defaulted: ['structure'] } }), 'manufacturing', []))
    expect(first).toContain('XX-1 · 索迪约（默认建筑） · 00')
  })

  it('old system indices or adjusted prices (ESI unavailable) are marked in the footer', () => {
    const stale = example({ indicesStale: true, adjustedStale: true, adjustedPricesAt: Date.UTC(2026, 9, 7, 2, 5) })
    expect(md(resultCard(env(), stale, 'manufacturing', []))).toMatch(/欧服 · 价格更新于 14:20 · 星系成本指数更新于 13:00（缓存） · 调整价更新于 10:05（缓存）$/)
    // 调整价是新的：不写它的时间
    const fresh = example({ adjustedPricesAt: Date.UTC(2026, 9, 7, 5, 5) })
    expect(md(resultCard(env(), fresh, 'manufacturing', []))).toMatch(/欧服 · 价格更新于 14:20 · 星系成本指数更新于 13:00$/)
  })
})

describe('materials card (§2.6.5)', () => {
  it('rows follow listPriceDisplayMode, the total follows priceDisplayMode; the copy blocks go out after the card', () => {
    const c = materialsCard(env(), example(), 'manufacturing', ['Pyerite\t2199844'], [])
    expect(md(c)).toContain('1. 类晶体胶矿 ×2,199,844 · `61.60M`\n2. 三钛合金 ×4,399,687 · `18.04M`\n\n**材料合计** `155,129,544 ISK`（155.13M）· 65,995 m³')
    expect(c.copyBlocks).toEqual(['Pyerite\t2199844'])
    const inherit = md(materialsCard(env({ listPriceDisplayMode: 'inherit' }), example(), 'manufacturing', [], []))
    expect(inherit).toContain('1. 类晶体胶矿 ×2,199,844 · `61,595,632 ISK`（61.60M）')
    expect(inherit).not.toContain('多重购买')
  })

  it('a material without a price says so; a fallback price is marked †', () => {
    const r = example({
      materials: [
        { ...example().materials[0], fallback: true },
        { ...example().materials[1], unit: null, total: null },
      ],
      missingPrices: 1,
      materialPrices: { marketKey: 'jita 4-4', side: 'sell', fallbackKey: 'amarr' },
    })
    const out = md(materialsCard(env(), r, 'manufacturing', [], []))
    expect(out).toContain('1. 类晶体胶矿 ×2,199,844 · `61.60M` †\n2. 三钛合金 ×4,399,687 · 缺价格')
    expect(out).toContain('**材料合计** `155,129,544 ISK`（155.13M）（不完整，缺 1 种材料价格）· 65,995 m³\n† 部分材料按 Amarr 出售价')
    expect(out).toContain('⚠ 以下材料没有价格：三钛合金，总成本不完整')
  })
})

describe('compare card (§2.7)', () => {
  const comparison = (): LocationComparison => ({
    product: RAVEN, runs: 1, me: 10, te: 20, materialMarketKey: 'jita 4-4', materialSide: 'sell',
    rows: [
      { location: 'XX-2', structure: '阿兹贝尔', noRigs: false, result: example({ materialCost: 152_429_544 }), cheapest: true, fastest: false },
      { location: 'XX-1', structure: '索迪约', noRigs: false, result: example({ timeSeconds: 4000 }), cheapest: false, fastest: true },
    ],
  })

  it('rig notes come from core: not installed, not applicable; nothing for no structure bonus or rigs turned off', () => {
    const row = (location: string, rigState: IndustryResult['applied']['rigState']) => ({
      location, structure: `${location}厂`, noRigs: rigState !== 'applied', cheapest: false, fastest: false,
      result: example({ applied: { ...example().applied, rigs: [], rigState } }),
    })
    const c: LocationComparison = {
      ...comparison(),
      rows: [row('XX-1', 'not-installed'), row('XX-2', 'not-applicable'), row('XX-3', 'impossible'), row('XX-4', 'disabled')],
    }
    const out = md(compareCard(env(), c, []))
    expect(out).toContain('1. **XX-1 · XX-1厂（未装改装件）**\n')
    expect(out).toContain('2. **XX-2 · XX-2厂（改装件对它不生效）**\n')
    expect(out).toContain('3. **XX-3 · XX-3厂**\n')
    expect(out).toContain('4. **XX-4 · XX-4厂**\n')
    // 命令里写的「改装:无」「税:」写在元信息里
    expect(md(compareCard(env(), { ...c, rigsOff: true, facilityTaxPct: 3 }, []))).toContain('ME 10 / TE 20 · 1 流程 · 不用改装件 · 设施税 3.00% · 材料按 Jita 4-4 出售价')
  })

  it('every row follows listPriceDisplayMode', () => {
    expect(md(compareCard(env(), comparison(), []))).toContain([
      '1. **XX-2 · 阿兹贝尔 💰最低**',
      '    - 成本 `165.02M` · 1 小时 23 分 · 利润 90.68M（35.1%）',
      '2. **XX-1 · 索迪约 ⚡最快**',
      '    - 成本 `167.72M` · 1 小时 7 分 · 利润 90.68M（35.1%）',
    ].join('\n'))
    expect(md(compareCard(env({ listPriceDisplayMode: 'inherit', priceDisplayMode: 'full_only' }), comparison(), []))).toContain('- 成本 `165,019,544 ISK` · 1 小时 23 分 · 利润 90,680,456 ISK（35.1%）')
  })
})
