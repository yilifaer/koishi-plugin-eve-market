// 反应（§2.8）走完整个插件：基础参考、结果、逐步选择（地点 → 建筑）、材料清单、高安不能反应、不是反应产物。
// 地点、建筑、税率、价格、指数都是编造的，星系和物品是公共数据。

import { afterEach, describe, expect, it } from 'vitest'
import { GROUP2 } from '../../harness'
import { buttonRows, buttons, card } from './plugin-env'
import type { PluginEnv } from './plugin-env'
import { startIndustry } from './industry-env'
import type { IndustryEnvOptions } from './industry-env'

let env: PluginEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

async function start(options: IndustryEnvOptions = {}): Promise<PluginEnv> {
  env = await startIndustry(options)
  return env
}

describe('反应', () => {
  it('base reference: the formula, per-run materials and output value; three buttons', async () => {
    const e = await start()
    const sent = await e.h.group('反应 碳化钨')
    expect(sent[0].markdown).toMatch(new RegExp([
      '^\\*\\*碳化钨 Tungsten Carbide · 反应 · 基础参考\\*\\*',
      '',
      '配方 碳化钨反应配方 · 每流程 3 小时，产出 10,000 个',
      '无建筑、无改装件 · 未计系统指数和税 · 材料按 Jita 4-4 出售价',
      '',
      '- 每流程材料 `455,000 ISK`（455\\.00K）',
      '    - 轧制钨合金 ×100 · 300\\.00K',
      '    - 氮燃料块 ×5 · 90\\.00K',
      '    - 硫酸 ×100 · 65\\.00K',
      '- 每流程产出价值 `520,000 ISK`（520\\.00K）· Jita 4-4 出售 52\\.00/个',
      '',
      '\\*\\*\\*',
      '欧服 · 价格更新于 \\d\\d:\\d\\d$',
    ].join('\n')))
    expect(buttonRows(sent)).toEqual([['快速计算=>反应 碳化钨 XX-1', '高级计算=>反应 碳化钨 高级', '查看材料=>反应 碳化钨 材料']])
  })

  it('a result: runs, the reaction rig in 00, index, tax, cost and time per run and in total', async () => {
    const e = await start()
    const sent = await e.h.group('反应 碳化钨 XX-1 20流程')
    expect(card(sent)).toContain([
      '**碳化钨 Tungsten Carbide · 反应计算**',
      '',
      'XX-1 · 反应塔（该地点唯一） · 00 · 20 流程（200,000 个）',
      '改装件 屹立中型复合反应堆时间效率 I（时间 -22%）',
      '系统指数 1.85% · 设施税 1.50% · SCC 附加费 4%',
      '',
      '- 材料成本 `9,100,000 ISK`（9.10M）',
      '- 安装费用和税 `565,950 ISK`（565.95K）',
      '- **预计总成本** `9,665,950 ISK`（9.67M）',
      '- 反应时间 每流程 2 小时 20 分 · 共 1 天 23 小时（未计技能）',
      '',
      '产出 200,000 个 · Jita 4-4 出售 `10,400,000 ISK`（10.40M）',
      '**预计利润 734.05K · 利润率 7.1%**（未计销售税和经纪费）',
    ].join('\n'))
    // 没有 ME/TE、没有比价
    expect(buttonRows(sent)).toEqual([
      ['查看材料=>反应 碳化钨 20流程 XX-1 材料', '更换地点=>反应 碳化钨 20流程 高级'],
      ['改建筑/改装件=>反应 碳化钨 20流程 XX-1 建筑:? 高级', '不用改装件=>反应 碳化钨 20流程 XX-1 改装:无'],
      ['改税率=>反应 碳化钨 20流程 XX-1 建筑:反应塔 税:'],
    ])
  })

  it('written ME/TE are ignored (formulas cannot be researched); the quantity is products', async () => {
    const e = await start()
    const out = card(await e.h.group('反应 碳化钨*30000 XX-1 ME10'))
    expect(out).toContain('XX-1 · 反应塔（该地点唯一） · 00 · 3 流程（30,000 个）')
    expect(out).not.toContain('ME')
  })

  it('steps: only locations that can react (no highsec), then the result when there is one structure', async () => {
    const e = await start()
    const first = await e.h.group('反应 碳化钨 高级')
    expect(card(first)).toContain('**碳化钨 · 高级反应计算**\n进度：**地点 → 建筑**\n\n请选择反应地点：\n\n1. XX-1 · 00 · 反应塔 · 系统指数 1.85%\n2. XX-2 · 低安 · 反应厂 · 系统指数 1.00%')
    expect(buttonRows(first)).toEqual([['XX-1=>反应 碳化钨 XX-1 高级', 'XX-2=>反应 碳化钨 XX-2 高级'], ['默认直接出结果=>反应 碳化钨 XX-1']])
    expect(card(await e.h.group('2'))).toContain('XX-2 · 反应厂（该地点唯一） · 低安 · 1 流程（10,000 个）\n改装件 未装')
    const listed = await e.h.group('反应 碳化钨 XX-1 建筑:? 高级')
    expect(card(listed)).toContain('进度：地点 ✓ → **建筑**\n已选：XX-1')
    // 反应只能在精炼厂做：不列「无建筑加成」
    expect(card(listed)).not.toContain('无建筑加成')
  })

  it('建筑:无 is not possible for a reaction: asks for a refinery instead', async () => {
    const e = await start()
    const sent = await e.h.group('反应 碳化钨 XX-1 建筑:无')
    expect(card(sent)).toContain('进度：地点 ✓ → **建筑**\n已选：XX-1\n\n⚠ 反应只能在精炼厂里进行（不能用「建筑:无」），请选择建筑\n请选择反应建筑：')
    expect(buttonRows(sent)).toEqual([['反应塔=>反应 碳化钨 XX-1 建筑:反应塔'], ['其余默认=>反应 碳化钨 XX-1']])
    // 没写地点时也一样：先问地点，「建筑:无」带着，选了地点再说明
    const first = await e.h.group('反应 碳化钨 建筑:无')
    expect(card(first)).toContain('已选：无建筑加成')
    expect(card(await e.h.group('1'))).toContain('⚠ 反应只能在精炼厂里进行')
  })

  it('a quantity in products: the base card says how many the rounded-up runs make', async () => {
    const e = await start()
    const out = card(await e.h.group('反应 碳化钨*25000'))
    expect(out).toContain('配方 碳化钨反应配方 · 每流程 3 小时，产出 10,000 个 · 3 流程（30,000 个）')
    expect(card(await e.h.group('反应 碳化钨'))).toContain('配方 碳化钨反应配方 · 每流程 3 小时，产出 10,000 个\n')
  })

  it('one visible location with one refinery: every step is skipped', async () => {
    const e = await start()
    const out = card(await e.h.group('反应 碳化钨 高级', { channelId: GROUP2 }))
    expect(out).toContain('XX-2（本群唯一的地点） · 反应厂（该地点唯一） · 低安')
  })

  it('highsec cannot react: says so and offers the locations that can', async () => {
    const e = await start()
    const sent = await e.h.group('反应 碳化钨*20000 XX-3')
    expect(card(sent)).toBe('高安不能进行反应（XX-3 在高安）。\n\n本群可以反应的地点：XX-1 · XX-2')
    expect(buttons(sent)).toEqual(['XX-1=>反应 碳化钨*20000 XX-1', 'XX-2=>反应 碳化钨*20000 XX-2'])
  })

  it('a location without a refinery, and a product that is not a reaction product', async () => {
    const e = await start({ industry: { locations: [{ name: 'XX-2', system: 'Tama', visibility: 'public' }], structures: [{ location: 'XX-2', name: '中厂', structureType: 'Azbel' }] } })
    const none = await e.h.group('反应 碳化钨 XX-2')
    expect(card(none)).toBe('XX-2 没有可以反应的建筑。\n\n本群还没有可以反应的工业地点。')
    expect(buttons(none)).toEqual(['基础参考=>反应 碳化钨'])
    const manufactured = await e.h.group('反应 乌鸦级*2')
    expect(card(manufactured)).toBe('乌鸦级 不是反应产物，请用：制造 乌鸦级')
    expect(buttons(manufactured)).toEqual(['制造 乌鸦级=>制造 乌鸦级*2'])
    expect(card(await e.h.group('反应 乌鸦级海军型'))).toBe('乌鸦级海军型 没有可用的反应配方。')
    // 写的是蓝图：提示和按钮里是它的产品
    const blueprint = await e.h.group('反应 乌鸦级蓝图*2')
    expect(card(blueprint)).toBe('乌鸦级 不是反应产物，请用：制造 乌鸦级')
    expect(buttons(blueprint)).toEqual(['制造 乌鸦级=>制造 乌鸦级*2'])
  })

  it('materials: a card and a multibuy block', async () => {
    const e = await start()
    const sent = await e.h.group('反应 碳化钨 XX-1 材料')
    expect(sent).toHaveLength(2)
    expect(sent[0].markdown).toContain('**碳化钨 · 材料清单**\nXX-1 · 反应塔 · 1 流程 · Jita 4-4 出售价\n\n1. 轧制钨合金 ×100 · `300.00K`')
    expect(sent[1].text).toBe('Rolled Tungsten Alloy\t100\nNitrogen Fuel Block\t5\nSulfuric Acid\t100')
  })
})
