// 拆到原料的分层明细卡和原料清单卡：走完整个插件（群里、单聊的条数），再用编出来的结果核对炼金副产品、缺价格和超长时的截断。
// 地点、建筑名是编造的，数字是假报价算出来的或写死的示例值。

import { afterEach, describe, expect, it } from 'vitest'
import { MAX_MESSAGE_CHARS, MAX_SPLIT_PARTS } from '../../../src/constants'
import { detailsCard, materialsChainCard, overviewCard } from '../../../src/bot/commands/industry-chain-card'
import type { IndustryEnv } from '../../../src/bot/commands/industry-card'
import { markdownLayout } from '../../../src/bot/view/markdown'
import { planSplit, renderPart } from '../../../src/bot/view/split'
import { textLayout } from '../../../src/bot/view/text'
import type { ChainLeaf, ChainNode, ChainResult } from '../../../src/core/types'
import { USER } from '../../harness'
import { buttons as cardButtons, item, md, renderOptions, testCore, text } from '../commands/helpers'
import { buttonRows, card } from './plugin-env'
import type { PluginEnv } from './plugin-env'
import { HOUND, expectLimits, startChain } from './industry-chain-env'

let env: PluginEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

async function start(): Promise<PluginEnv> {
  env = await startChain()
  return env
}

describe('分层明细（走完整个插件）', () => {
  it('one line per node grouped by layer: need, batches, left over, cost; one card, buttons back to the overview', async () => {
    const e = await start()
    const sent = await e.h.group(`制造 ${HOUND} XX-1 拆到原料 明细`)
    expect(sent).toHaveLength(1)
    const out = card(sent)
    expect(out.startsWith('**猎犬级 Hound · 分层明细**\nXX-1 · 1 流程（1 艘） · 大厂\n\n**组件 · XX-1 小厂 · ME10 TE20**\n\n1. 核反应堆机组 需 6 · 6 流程 · 7.01K\n')).toBe(true)
    expect(out).toContain('**高级反应 · XX-1 反应塔**\n\n1. 费米子冷凝物 需 11 · 1 批 · 多出 189 · 44.58K\n')
    expect(out).toContain('**低级反应 · XX-1 反应塔**')
    expect(out).toContain('9. 铁磁流体 需 100 · 正常 1 批 · 多出 100 · 22.65K（炼金贵 13.13K）')
    expect(out).toContain('都是整批生产，多出的不抵成本。')
    expect(buttonRows(sent)).toEqual([[
      `返回总览=>制造 ${HOUND} XX-1 建筑:大厂 拆到原料`,
      `原料清单=>制造 ${HOUND} XX-1 建筑:大厂 拆到原料 材料`,
    ]])
    expectLimits(sent)
  })

  it('反应:炼金: the alchemy node says how many batches and how it compares, indented under its line', async () => {
    const e = await start()
    const out = card(await e.h.group(`制造 ${HOUND} XX-1 反应:炼金 明细`))
    expect(out).toContain('9. 铁磁流体 需 100 · 炼金 3 批 · 多出 20 · 35.78K\n    - 比正常贵 13.13K，多 11 小时 42 分\n10. 超氟化物')
  })

  it('其他:造 adds the 其他 layer between the components and the reactions', async () => {
    const e = await start()
    const out = card(await e.h.group(`制造 ${HOUND} XX-1 其他:造 明细`))
    expect(out.indexOf('**组件 ·')).toBeLessThan(out.indexOf('**其他 ·'))
    expect(out.indexOf('**其他 ·')).toBeLessThan(out.indexOf('**高级反应 ·'))
  })

  it('the group and direct chats both get the card within the budget', async () => {
    const e = await start()
    expect(await e.h.group(`制造 ${HOUND} XX-1 其他:造 明细`)).toHaveLength(1)
    // 单聊看不到 XX-1（联盟地点），用公共的 XX-2
    const direct = await e.h.direct(`制造 ${HOUND} XX-2 其他:造 明细`, { userId: USER })
    expect(direct).toHaveLength(1)
    expect(card(direct)).toContain('**猎犬级 Hound · 分层明细**\nXX-2 · 1 流程（1 艘） · 中厂')
    expectLimits(direct)
  })

  it('reactions made elsewhere say where and why in the layer heading', async () => {
    env = await startChain({
      industry: {
        locations: [{ name: 'XX-1', system: 'NIH-02', visibility: 'allowed', isDefault: true }, { name: 'XX-2', system: 'Tama', visibility: 'public' }],
        structures: [
          { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', facilityTaxPct: 1 },
          { location: 'XX-2', name: '反应厂', structureType: 'Athanor', activities: 'reaction', facilityTaxPct: 1 },
        ],
      },
    })
    const out = card(await env.h.group(`制造 ${HOUND} XX-1 拆到原料 明细`))
    expect(out).toContain('**高级反应 · 反应在 XX-2 反应厂（XX-1 没有精炼厂）**')
  })
})

describe('原料清单（走完整个插件）', () => {
  it('the materials layout, then the paste list; the group gets 2 messages, a direct chat too', async () => {
    const e = await start()
    const sent = await e.h.group(`制造 ${HOUND} XX-1 拆到原料 材料`)
    expect(sent).toHaveLength(2)
    expect(sent[0].markdown).toContain('**猎犬级 · 原料清单**\nXX-1 · 大厂 · 1 流程 · Jita 4-4 出售价\n\n1. 钒 ×400 · `46.40K`')
    expect(sent[0].markdown).toContain('25. 分裂者级 ×1 · `103.00`')
    expect(sent[0].markdown).toContain('**材料合计** `435,090 ISK`（435.09K）· 3,461 m³\n下一条消息可以直接粘贴到游戏的「多重购买」窗口。')
    expect(sent[1].text).toMatch(/^Vanadium\t400\nSilicates\t400\n/)
    expect(sent[1].text.split('\n')).toHaveLength(25)
    expect(buttonRows(sent)).toEqual([[
      `返回总览=>制造 ${HOUND} XX-1 建筑:大厂 拆到原料`,
      `分层明细=>制造 ${HOUND} XX-1 建筑:大厂 拆到原料 明细`,
    ]])
    const direct = await e.h.direct(`制造 ${HOUND} XX-2 拆到原料 材料`, { userId: USER })
    expect(direct).toHaveLength(2)
    expect(direct[0].markdown).toContain('**猎犬级 · 原料清单**\nXX-2 · 中厂 · 1 流程')
    expect(direct[1].text.split('\n')).toHaveLength(25)
    expectLimits([...sent, ...direct])
  })

  it('alchemy by-products first offset the same raw material to buy; the paste list has the net quantities', async () => {
    const e = await start()
    const sent = await e.h.group(`制造 ${HOUND} XX-1 反应:炼金 材料`)
    expect(sent[0].markdown).toContain('12. 铪 ×115 · `12.08K`\n    - 铪 −285（炼金副产品）\n13. 铥')
    expect(sent[1].text).toContain('\nHafnium\t115\n')
    expect(sent[1].text).not.toContain('Hafnium\t400')
  })

  it('the net list is what costs money: the total is the sum of the listed rows, never more', async () => {
    const e = await start()
    const plain = card(await e.h.group(`制造 ${HOUND} XX-1 拆到原料 材料`))
    const alchemy = card(await e.h.group(`制造 ${HOUND} XX-1 反应:炼金 材料`))
    expect(plain).toContain('**材料合计** `435,090 ISK`')
    expect(alchemy).toContain('**材料合计** `446,595 ISK`')
  })

  it('材料 and 明细 together: the details card first', async () => {
    const e = await start()
    expect(card(await e.h.group(`制造 ${HOUND} XX-1 拆到原料 明细 材料`))).toContain('分层明细')
  })
})

// ------------------------------------------------------------------ 编出来的结果

const core = testCore()
const env0: IndustryEnv = { core, display: core.settings.display, industry: { sellFeesPct: 0 } }
const HULL = item('Raven')
const PYERITE = item('Pyerite')
const TRIT = item('Tritanium')

function node(over: Partial<ChainNode> = {}): ChainNode {
  return {
    item: PYERITE, layer: 'reaction1', activity: 'reaction', demand: 100, runs: 1, output: 100, surplus: 0, location: 'XX-1', structure: '反应塔',
    autoPicked: false, me: 0, te: 0, inputs: [], jobCost: null, buildCost: 1000, buyCost: 2000, timeSeconds: 3600, timeSecondsMaxSkill: 3000, ...over,
  }
}

function result(over: Partial<ChainResult> = {}): ChainResult {
  const nodes = [node({ item: HULL, layer: 'product', activity: 'manufacturing', demand: 1, output: 1, structure: '大厂', me: 10, te: 20 }), node()]
  return {
    product: HULL, runs: 1, outputQuantity: 1, location: 'XX-1', inventionExcluded: false,
    options: { layers: { reaction1: 'build', reaction2: 'build', component: 'build', other: 'buy' }, alchemy: 'auto' },
    nodes,
    layers: [
      { layer: 'product', mode: 'build', used: true, build: 5000, buy: null, timeSeconds: 7200 },
      { layer: 'component', mode: 'build', used: false, build: null, buy: null, timeSeconds: 0 },
      { layer: 'other', mode: 'buy', used: false, build: null, buy: null, timeSeconds: 0 },
      { layer: 'reaction2', mode: 'build', used: false, build: null, buy: null, timeSeconds: 0 },
      { layer: 'reaction1', mode: 'build', used: true, build: 1000, buy: 2000, timeSeconds: 3600, where: '反应塔' },
    ],
    leaves: [{ item: TRIT, quantity: 500, offset: 0, unit: 4, total: 2000, kind: 'raw' }],
    surplusByproducts: [],
    totals: { leaves: 2000, jobs: 0, reprocessTax: 0, total: 3000, missingPrices: 0 },
    warnings: [], pricesAt: Date.UTC(2026, 9, 7, 6, 20), indicesAt: null, formulaRevision: '2',
    ...over,
  }
}

describe('编出来的结果', () => {
  it('a missing price is written as 缺价格, never 0, and the total says it is incomplete', () => {
    const leaf: ChainLeaf = { item: TRIT, quantity: 500, offset: 0, unit: null, total: null, kind: 'raw' }
    const r = result({ leaves: [leaf], totals: { leaves: 0, jobs: 0, reprocessTax: 0, total: 0, missingPrices: 1 } })
    const overview = md(overviewCard(env0, r, [], false))
    expect(overview).toContain('**预计总成本 — （不完整，缺 1 种材料价格）**')
    expect(overview).not.toContain(' 0 ISK')
    const materials = md(materialsChainCard(env0, r, [], []))
    expect(materials).toContain(`1. ${TRIT.zh || TRIT.en} ×500 · 缺价格`)
    expect(materials).toContain('**材料合计 — （不完整，缺 1 种材料价格）· ')
  })

  it('with missing prices the overview says the profit is not calculated, never a figure', () => {
    const leaf: ChainLeaf = { item: TRIT, quantity: 500, offset: 0, unit: null, total: null, kind: 'raw' }
    const complete = result({
      productValue: { marketKey: 'jita', side: 'sell', unit: 9000, total: 9000 }, profit: { value: 500, marginPct: 5.5 },
    })
    expect(md(overviewCard(env0, complete, [], false))).toContain('预计利润')
    const r = result({
      leaves: [leaf], totals: { leaves: 0, jobs: 0, reprocessTax: 0, total: 0, missingPrices: 1 },
      productValue: { marketKey: 'jita', side: 'sell', unit: 9000, total: 9000 }, profit: { value: 500, marginPct: 5.5 },
    })
    const out = md(overviewCard(env0, r, [], false))
    expect(out).toContain('价格不全，利润不计算')
    expect(out).not.toContain('预计利润')
    expect(out).not.toContain('利润率')
  })

  it('the head line shows the security class of the location; none without a location', () => {
    expect(md(overviewCard(env0, result({ secClass: 'null' }), [], false))).toContain('XX-1 · 00 · 蓝图 ME 10 / TE 20')
    expect(md(overviewCard(env0, result({ secClass: 'low' }), [], false))).toContain('XX-1 · 低安 · ')
    const base = result()
    delete base.location
    expect(md(overviewCard(env0, base, [], false))).toContain('没写地点，不计建筑加成和安装费 · 蓝图')
  })

  it('the T2 invention note follows the result flag, not the item', () => {
    expect(md(overviewCard(env0, result({ inventionExcluded: true }), [], false))).toContain('T2 发明成本不计入')
    expect(md(overviewCard(env0, result(), [], false))).not.toContain('T2 发明成本不计入')
  })

  it('a fully offset material is listed as not to buy; left-over by-products are listed unpriced', () => {
    const r = result({
      leaves: [
        { item: TRIT, quantity: 500, offset: 500, unit: 4, total: 0, kind: 'raw' },
        { item: PYERITE, quantity: 300, offset: 100, unit: 5, total: 1000, kind: 'raw' },
      ],
      surplusByproducts: [{ item: HULL, quantity: 42 }],
    })
    const out = md(materialsChainCard(env0, r, ['x\t1'], []))
    expect(out).toContain(`${TRIT.zh || TRIT.en} −500（炼金副产品，不用买）`)
    expect(out).toContain(`2. ${PYERITE.zh || PYERITE.en} ×200 · \`1.00K\`\n    - ${PYERITE.zh || PYERITE.en} −100（炼金副产品）`)
    expect(out).toContain(`炼金多出（不计价）：${HULL.zh || HULL.en} 42`)
    expect(text(materialsChainCard(env0, r, [], []))).not.toContain('下一条消息')
  })

  it('the fallback-market note names the real price side', () => {
    const leaves: ChainLeaf[] = [{ item: TRIT, quantity: 500, offset: 0, unit: 4, total: 2000, kind: 'raw', fallback: true }]
    const note = (side: 'sell' | 'mid' | 'buy') =>
      md(materialsChainCard(env0, result({ leaves, materialPrices: { marketKey: 'jita', side } }), [], []))
    expect(note('buy')).toContain('† 部分材料按备用市场收购价')
    expect(note('mid')).toContain('† 部分材料按备用市场中间价')
    expect(note('sell')).toContain('† 部分材料按备用市场出售价')
  })

  it('a built layer costing more than 3x its buy estimate gets a hint naming the layer word; unknown numbers or 3x exactly do not', () => {
    const layers = (reaction1: { build: number | null; buy: number | null }) =>
      result().layers.map((l) => (l.layer === 'reaction1' ? { ...l, ...reaction1 } : l))
    const hint = (o: { build: number | null; buy: number | null }) => md(overviewCard(env0, result({ layers: layers(o) }), [], false))
    expect(hint({ build: 3001, buy: 1000 })).toContain('低级反应 1 种 · 自己造（材料按市价）3.00K（直接买约 1.00K） · 反应塔\n⚠ 量太少，整批造不划算，可以点「反应:买」')
    expect(hint({ build: 3000, buy: 1000 })).not.toContain('量太少')
    expect(hint({ build: 5000, buy: null })).not.toContain('量太少')
    expect(hint({ build: null, buy: 1000 })).not.toContain('量太少')
    // 组件、其他层写各自的层词
    const comp = result({
      layers: result().layers.map((l) => (l.layer === 'component' ? { ...l, used: true, build: 9000, buy: 1000, where: '小厂' } : l)),
      nodes: [...result().nodes, node({ layer: 'component', item: TRIT })],
    })
    expect(md(overviewCard(env0, comp, [], false))).toContain('可以点「组件:买」')
  })

  it('the alchemy line says where the reprocessing is done and the tax; nothing extra without a refinery', () => {
    const alchemy = (over: object) => ({
      unrefined: PYERITE, units: 25, runs: 25, yieldPct: 55, perUnit: 40, byproducts: [], reprocessTax: 100,
      other: { route: 'normal' as const, cost: 900, timeSeconds: 1800 }, ...over,
    })
    const withNode = (a: object) => result({ nodes: [...result().nodes.slice(0, 1), node({ route: 'alchemy', alchemy: alchemy(a) })] })
    const out = md(overviewCard(env0, withNode({ reprocessAt: '甲提炼厂', reprocessLocation: 'XX-1', reprocessPct: 1.5 }), [], false))
    expect(out).toContain('炼金 1 种：比正常贵 100.00 ISK，多 30 分\n· 提炼：甲提炼厂（XX-1）税 1.5%')
    expect(md(overviewCard(env0, withNode({}), [], false))).not.toContain('提炼：')
  })

  it('no alchemy chosen: the normal route is only called cheaper when both routes have prices', () => {
    const alchemy = (cost: number | null) => ({
      unrefined: PYERITE, units: 25, runs: 25, yieldPct: 55, perUnit: 40, byproducts: [], reprocessTax: null,
      other: { route: 'alchemy' as const, cost, timeSeconds: 1800 },
    })
    const line = (...nodes: ChainNode[]) => md(overviewCard(env0, result({ nodes: [result().nodes[0], ...nodes] }), [], false))
    const priced = node({ route: 'normal', alchemy: alchemy(5000) })
    expect(line(priced)).toContain('炼金 0 种：都是正常路线更划算')
    // 炼金路线缺价格
    const noAlchemyPrice = node({ route: 'normal', alchemy: alchemy(null) })
    expect(line(noAlchemyPrice)).toContain('炼金 0 种：炼金缺价格，没法比')
    expect(line(noAlchemyPrice)).not.toContain('都是正常路线更划算')
    // 正常路线缺价格
    expect(line(node({ route: 'normal', buildCost: null, alchemy: alchemy(5000) }))).toContain('炼金 0 种：炼金缺价格，没法比')
    // 一部分缺
    const mixed = line(priced, noAlchemyPrice)
    expect(mixed).toContain('炼金 0 种：1 种是正常路线更划算，1 种炼金缺价格，没法比')
  })

  it('the scrap-rule note appears only when some node had an alchemy candidate', () => {
    const none = result({ inventionExcluded: true })
    expect(md(overviewCard(env0, none, [], false))).toContain('⚠ T2 发明成本不计入\n')
    expect(md(overviewCard(env0, none, [], false))).not.toContain('废料')
    expect(md(detailsCard(env0, none, []))).not.toContain('废料')
    const candidate = node({
      route: 'normal',
      alchemy: { unrefined: PYERITE, units: 1, runs: 1, yieldPct: 53, perUnit: 40, byproducts: [], reprocessTax: 1, other: { route: 'alchemy', cost: 5000, timeSeconds: 1 } },
    })
    const some = result({ inventionExcluded: true, nodes: [result().nodes[0], candidate] })
    expect(md(overviewCard(env0, some, [], false))).toContain('⚠ T2 发明成本不计入 · 炼金按废料 53% 规则计算')
    expect(md(detailsCard(env0, some, []))).toContain('炼金按废料 53% 规则计算')
    // 只有废料规则可写、没有发明提示时也单独成行
    expect(md(overviewCard(env0, result({ nodes: some.nodes }), [], false))).toContain('⚠ 炼金按废料 53% 规则计算')
  })

  it('the unused layer is explained by the bought layer above it', () => {
    const r = result({
      options: { layers: { reaction1: 'build', reaction2: 'build', component: 'buy', other: 'buy' }, alchemy: 'auto' },
      layers: result().layers.map((l) => (l.layer === 'component' ? { ...l, mode: 'buy' as const } : l.layer === 'reaction1' ? { ...l, used: false, build: null, buy: null, timeSeconds: 0 } : l)),
      nodes: result().nodes.slice(0, 1),
    })
    const out = md(overviewCard(env0, r, [], false))
    expect(out).toContain('高级反应（组件直接买，没有用到）')
    expect(out).toContain('低级反应（组件直接买，没有用到）')
  })

  it('a long list is cut to 3 messages, each within the limit, with the 另有 N 行未显示 note', () => {
    const many = Array.from({ length: 400 }, (_, i) => node({ item: { ...PYERITE, typeId: 900000 + i, zh: `测试物品${i}号`, en: `Test ${i}` }, demand: 100 + i }))
    const r = result({ nodes: [result().nodes[0], ...many] })
    const card0 = detailsCard(env0, r, [])
    const opts = renderOptions()
    const layouts = [markdownLayout(card0, opts), textLayout(card0, opts)]
    const plan = planSplit(layouts, MAX_MESSAGE_CHARS, MAX_SPLIT_PARTS)
    expect(plan.parts).toHaveLength(MAX_SPLIT_PARTS)
    expect(plan.dropped).toBeGreaterThan(0)
    expect(plan.note).toMatch(/^另有 \d+ 行未显示/)
    for (let i = 0; i < plan.parts.length; i++) {
      for (const layout of layouts) expect(renderPart(layout, plan, i).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    }
    const last = renderPart(layouts[0], plan, plan.parts.length - 1)
    expect(last).toContain(plan.note)
  })

  it('the overview buttons keep the three-row layout even with every option', () => {
    const r = result()
    const rows = cardButtons(overviewCard(env0, r, [
      [{ label: '分层明细', command: { id: 'manufacture', args: 'a' } }, { label: '原料清单', command: { id: 'manufacture', args: 'b' } }, { label: '继续拆', command: { id: 'manufacture', args: 'c' } }],
      [{ label: '反应:买', command: { id: 'manufacture', args: 'd' } }, { label: '组件:买', command: { id: 'manufacture', args: 'e' } }],
      [{ label: '换地点', command: { id: 'manufacture', args: 'f' } }, { label: '只算成品', command: { id: 'manufacture', args: 'g' } }],
    ], false))
    expect(rows).toHaveLength(3)
  })
})
