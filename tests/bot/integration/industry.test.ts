// 制造（§2.6）走完整个插件：真实的 Koishi、前置中间件、命令、core（小数据集 + 本机假 ESI 上的报价、星系成本指数和调整价）。
// 地点、建筑、税率、价格、指数都是编造的（XX-1、联盟工业点A、大厂……），星系和物品是公共数据。

import { afterEach, describe, expect, it } from 'vitest'
import { GROUP2, USER } from '../../harness'
import { DOMAIN, MARKETS_WITH_ALLIANCE, addOrders, buttonRows, buttons, card, jitaOrders } from './plugin-env'
import type { PluginEnv } from './plugin-env'
import { INDUSTRY, LOCATIONS, RAVEN_SELL, STRUCTURES, startIndustry } from './industry-env'
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

const CLOCK = String.raw`\d\d:\d\d`

const BASE_CARD = [
  '**乌鸦级 Raven · 制造 · 基础参考**',
  '',
  '蓝图 ME 0 / TE 0 · 无建筑、无改装件 · 未计星系成本指数和税',
  '',
  '- 材料成本 `161,417,000 ISK`（161.42M）',
  '- 制造时间 5 小时（未计技能；满技能约 3 小时 24 分）',
  '- 每流程产出 1 艘 · 材料按 Jita 4-4 出售价',
  '',
  '主要材料：类晶体胶矿 ×2,600,000 · 类银超金属 ×390,000 · 同位聚合体 ×130,000 · 三钛合金 ×5,200,000 · 超新星诺克石 ×15,600',
  '共 10 种，点「查看材料」看全部',
  '',
  '成品 Jita 4-4 出售 `258,400,000 ISK`（258.40M）',
  '',
  '> 仅供参考：没有计算星系的星系成本指数、建筑、改装件和税费。',
  '',
  '***',
].join('\n')

const RESULT_HEAD = [
  '**乌鸦级 Raven · 高级制造计算**',
  '',
  'XX-1 · 大厂 · 00',
  '蓝图 ME 10 / TE 20 · 1 流程（1 艘）',
  '改装件 屹立超大型舰船制造效率 I（材料 -4.2%，时间 -42%）',
  '',
  '- 材料成本 `138,298,834 ISK`（138.30M）',
  '- 基础物品成本 `138,275,000 ISK`（138.28M）',
  '- 星系成本指数 2.31% `3,034,445 ISK`（3.03M）',
  '- 设施税 1.00% `1,382,750 ISK`（1.38M）',
  '- SCC 附加费 4% `5,531,000 ISK`（5.53M）',
  '- **预计总成本** `148,247,029 ISK`（148.25M）',
  '- 制造时间 1 小时 37 分（未计技能）',
  '    - 蓝图 TE 20 -20%',
  '    - 技能和植入体（按技能全 5 级，不算植入体）-32%',
  '    - 已安装的改装件 -42%',
  '    - 建筑持有加成 -30%',
  '    - 满技能约 1 小时 6 分',
  '',
  '成品 Jita 4-4 出售 `258,400,000 ISK`（258.40M）',
  '**预计利润 110.15M · 利润率 42.6%**（未计销售税和经纪费）',
  '',
  '***',
].join('\n')

describe('制造: base reference', () => {
  it('without a location: ME 0 / TE 0, no structure, no index or tax, the top 5 materials and four buttons', async () => {
    const e = await start()
    const sent = await e.h.group('制造 乌鸦级')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toMatch(new RegExp(`^${escapeRe(BASE_CARD)}\\n欧服 · 价格更新于 ${CLOCK}$`))
    expect(buttonRows(sent)).toEqual([[
      '快速计算=>制造 乌鸦级 XX-1', '高级计算=>制造 乌鸦级 高级', '查看材料=>制造 乌鸦级 材料', '制造比价=>制造比价 乌鸦级',
    ]])
    expect(sent[0].rows[0][0].primary).toBe(true)
  })

  it('written ME/TE and quantity are used and carried by every button; no index, tax or profit', async () => {
    const e = await start()
    const out = await e.h.group('制造 乌鸦级*10 ME10 TE20')
    expect(card(out)).toContain('蓝图 ME 10 / TE 20 · 无建筑、无改装件 · 未计星系成本指数和税')
    expect(card(out)).toContain('- 10 流程（10 艘） · 材料按 Jita 4-4 出售价')
    expect(card(out)).toContain('- 制造时间 1 天 16 小时（未计技能；满技能约 1 天 3 小时） · 一条生产线连续生产')
    expect(card(out)).toContain('成品 Jita 4-4 出售 `2,584,000,000 ISK`（2.58B）（10 艘，单价 258.40M）')
    expect(card(out)).not.toContain('预计利润')
    expect(buttons(out)).toEqual([
      '快速计算=>制造 乌鸦级*10 XX-1 ME10 TE20', '高级计算=>制造 乌鸦级*10 ME10 TE20 高级',
      '查看材料=>制造 乌鸦级*10 ME10 TE20 材料', '制造比价=>制造比价 乌鸦级*10 ME10 TE20',
    ])
  })

  it('another group sees only the public locations: quick calculation only with a default it can see', async () => {
    const e = await start()
    const sent = await e.h.group('制造 乌鸦级', { channelId: GROUP2 })
    expect(buttons(sent)).toEqual(['高级计算=>制造 乌鸦级 高级', '查看材料=>制造 乌鸦级 材料', '制造比价=>制造比价 乌鸦级'])
  })

  it('no industry location at all: the base reference still works, without quick calculation or comparison', async () => {
    const e = await start({ industry: {} })
    const sent = await e.h.group('制造 乌鸦级')
    expect(card(sent)).toContain('- 材料成本 `161,417,000 ISK`（161.42M）')
    expect(buttons(sent)).toEqual(['高级计算=>制造 乌鸦级 高级', '查看材料=>制造 乌鸦级 材料'])
    // 「高级」要先有地点
    expect(card(await e.h.group('制造 乌鸦级 高级'))).toBe('本群还没有可以制造的工业地点。')
  })

  it('a blueprint name means its product; a T2 product says how its blueprint is obtained', async () => {
    const e = await start()
    expect(card(await e.h.group('制造 乌鸦级蓝图'))).toMatch(/^\*\*乌鸦级 Raven · 制造 · 基础参考\*\*/)
    const t2 = card(await e.h.group('制造 损伤控制 II'))
    expect(t2).toContain('⚠ T2 蓝图一般来自发明（常见 ME 2 / TE 4），发明成本暂不计入')
  })
})

describe('制造: result with a location', () => {
  it('everything written: the job cost breakdown, profit, both update times and the buttons', async () => {
    const e = await start()
    const sent = await e.h.group('制造 乌鸦级 XX-1 ME10 TE20 建筑:大厂 改装:默认 税:1%')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toMatch(new RegExp(`^${escapeRe(RESULT_HEAD)}\\n欧服 · 价格更新于 ${CLOCK} · 星系成本指数更新于 ${CLOCK}$`))
    expect(buttonRows(sent)).toEqual([
      [
        '查看材料=>制造 乌鸦级 XX-1 ME10 TE20 建筑:大厂 改装:默认 税:1% 材料',
        '修改ME/TE=>制造 乌鸦级 XX-1 建筑:大厂 改装:默认 税:1% 高级',
      ],
      [
        '更换地点=>制造 乌鸦级 ME10 TE20 高级',
        '比较地点=>制造比价 乌鸦级 ME10 TE20',
      ],
      [
        '改建筑/改装件=>制造 乌鸦级 XX-1 ME10 TE20 建筑:? 改装:默认 税:1% 高级',
        '不用改装件=>制造 乌鸦级 XX-1 ME10 TE20 建筑:大厂 改装:无 税:1%',
      ],
      ['改税率=>制造 乌鸦级 XX-1 ME10 TE20 建筑:大厂 改装:默认 税:'],
    ])
  })

  it('only the location (or its alias): defaults are filled in and marked, the same numbers as writing them out', async () => {
    const e = await start()
    const out = card(await e.h.group('制造 乌鸦级 联盟工业点A'))
    expect(out).toContain('XX-1 · 自动选择：大厂 · 00\n蓝图 ME 10 / TE 20（地点默认） · 1 流程（1 艘）')
    expect(out).toContain('- **预计总成本** `148,247,029 ISK`（148.25M）')
    // 写在物品前面也认
    expect(card(await e.h.group('制造 XX-1 乌鸦级'))).toContain('- **预计总成本** `148,247,029 ISK`（148.25M）')
  })

  it('the buttons change one thing at a time: no rigs, back to rigs, another tax', async () => {
    const e = await start()
    const off = await e.h.group('制造 乌鸦级 XX-1 改装:无')
    expect(card(off)).toContain('改装件 不用（改装:无）')
    expect(card(off)).toContain('- 材料成本 `144,182,700 ISK`（144.18M）')
    expect(buttons(off)).toContain('用改装件=>制造 乌鸦级 XX-1 改装:默认')
    const taxed = card(await e.h.group('制造 乌鸦级 XX-1 税:2.5%'))
    expect(taxed).toContain('- 星系成本指数 2.31% ')
    expect(taxed).toContain('- 设施税 2.50% `3,456,875 ISK`（3.46M）')
  })

  it('no structure: NPC facility tax, no structure or rig bonus', async () => {
    const e = await start()
    const out = card(await e.h.group('制造 乌鸦级 XX-1 建筑:无'))
    expect(out).toContain('XX-1 · 无建筑加成 · 00\n蓝图 ME 10 / TE 20（地点默认）')
    expect(out).toContain('- 设施税 0.25% ')
    expect(out).toContain('- SCC 附加费 4% ')
    expect(out).not.toContain('改装件')
    expect(out).not.toContain('建筑持有加成')
  })

  it('an NPC station row: the NPC facility tax, no rig line', async () => {
    const e = await start({
      industry: { locations: [{ name: 'XX-4', system: 'Jita', visibility: 'public' }], structures: [{ location: 'XX-4', name: 'NPC站', structureType: 'NPC' }] },
    })
    const out = card(await e.h.group('制造 乌鸦级 XX-4'))
    expect(out).toContain('XX-4 · NPC站（该地点唯一） · 高安\n蓝图 ME 10 / TE 20（地点默认） · 1 流程（1 艘）\n\n- 材料成本')
    expect(out).toContain('⚠ 吉他 不在星系成本指数列表里，安装费用按指数 0 计算')
  })

  it('an installed rig that does not apply to this product, and a structure with no rigs, are told apart', async () => {
    const e = await start()
    expect(card(await e.h.group('制造 乌鸦级 XX-3'))).toContain('改装件：无适用（该建筑没有对乌鸦级生效的改装件）')
    expect(card(await e.h.group('制造 乌鸦级 XX-2'))).toContain('改装件 未装')
  })

  it('the other fee of the structure is its own line and part of the total', async () => {
    const e = await start()
    const out = card(await e.h.group('制造 乌鸦级 XX-2'))
    expect(out).toContain('蓝图 ME 8 / TE 16（地点默认）')
    expect(out).toMatch(/- SCC 附加费 4% `[\d,]+ ISK`（[\d.]+M）\n- 联盟管理费 `1,382,750 ISK`（1\.38M）\n- \*\*预计总成本\*\*/)
  })

  it('T2: ME 2 / TE 4 by default, split into jobs over the copy limit, a missing price makes the cost incomplete', async () => {
    const e = await start()
    const out = card(await e.h.group('制造 损伤控制 II XX-2 *25'))
    expect(out).toContain('蓝图 ME 2 / TE 4（T2 常见值） · 25 流程（25 个）')
    expect(out).toContain('- 材料成本 `5,235,100 ISK`（5.24M）（不完整，缺 1 种材料价格）')
    expect(out).toContain('- **预计总成本** `5,235,100 ISK`（5.24M）（不完整，缺 1 种材料价格）（未计安装费用）')
    expect(out).toContain('（未计销售税和经纪费）（成本不完整）')
    expect(out).toContain('⚠ 单张蓝图最多 10 流程，按 3 个工作计算')
    expect(out).toContain('⚠ 以下材料没有价格：莫尔石，总成本不完整')
    expect(out).not.toMatch(/`0(\.00)? ISK`/)
  })

  it('the system index list is unavailable: the result still comes, with the reason', async () => {
    const e = await start({ esi: (fake) => fake.fault('GET', /^\/industry\/systems$/, { status: 503 }, 10) })
    const out = card(await e.h.group('制造 乌鸦级 XX-1'))
    expect(out).toContain('星系成本指数暂时取不到，安装费用没有计入星系成本指数（偏低）')
    expect(out).toContain('- 设施税 1.00% ')
    expect(out).not.toContain('- 星系成本指数')
    expect(out).not.toContain('星系成本指数更新于')
  })

  it('the material market is unavailable: says so, uses the fallback market and marks it †', async () => {
    const markets = MARKETS_WITH_ALLIANCE.map((m) => (m.name === '联盟市场A' ? { ...m, authProfile: 'default' } : m))
    const e = await start({
      config: { markets, industry: { ...INDUSTRY, materialMarket: '联盟市场A', fallbackMarket: 'Amarr' } },
      esi: (fake) => {
        for (const [id, price] of Object.entries(RAVEN_SELL)) addOrders(fake, DOMAIN, jitaOrders(Number(id), price * 1.1, null, { location_id: 60008494, volume_remain: 1e9 }))
      },
    })
    const out = card(await e.h.group('制造 乌鸦级 XX-1'))
    expect(out).toContain('⚠ 材料市场 联盟市场A 暂时不可用，改用 Amarr（标 †）')
    expect(out).toContain('† 部分材料按 Amarr 出售价')
    // 别的群看不到联盟市场：悄悄改用基准市场，不提它
    const other = card(await e.h.group('制造 乌鸦级', { channelId: GROUP2 }))
    expect(other).toContain('材料按 Jita 4-4 出售价')
    expect(other).not.toContain('联盟市场A')
  })
})

describe('制造: advanced steps', () => {
  it('location → ME/TE → structure, by numbered replies, ME7 TE14 and buttons with complete commands', async () => {
    const e = await start()
    const first = await e.h.group('制造 乌鸦级 高级')
    expect(card(first)).toBe([
      '**乌鸦级 · 高级制造计算**',
      '进度：**地点 → ME/TE → 建筑**',
      '',
      '请选择制造地点：',
      '',
      '1. XX-1 · 00 · 2 座可选，自动挑 · 星系成本指数 2.31%',
      '2. XX-2 · 低安 · 中厂 · 星系成本指数 1.20%',
      '3. XX-3 · 高安 · 高安厂 · 星系成本指数 3.02%',
      '',
      '点按钮后再按发送，或者 @我 回复编号（5 分钟内有效）',
    ].join('\n'))
    // 按钮上写选项本身（§2.6.3）
    expect(buttonRows(first)).toEqual([
      ['XX-1=>制造 乌鸦级 XX-1 高级', 'XX-2=>制造 乌鸦级 XX-2 高级', 'XX-3=>制造 乌鸦级 XX-3 高级'],
      ['默认直接出结果=>制造 乌鸦级 XX-1'],
    ])

    const second = await e.h.group('1')
    expect(card(second)).toContain('进度：地点 ✓ → **ME/TE → 建筑**\n已选：XX-1')
    expect(card(second)).toContain('1. ME10/TE20\n2. ME5/TE10\n3. ME0/TE0')
    expect(buttonRows(second)).toEqual([
      ['10/20=>制造 乌鸦级 XX-1 ME10 TE20 高级', '5/10=>制造 乌鸦级 XX-1 ME5 TE10 高级', '0/0=>制造 乌鸦级 XX-1 ME0 TE0 高级'],
      ['自定义=>制造 乌鸦级 XX-1 高级 ME', '其余默认=>制造 乌鸦级 XX-1'],
    ])

    const third = await e.h.group('ME7 TE14')
    expect(card(third)).toContain('进度：地点 ✓ → ME/TE ✓ → **建筑**\n已选：XX-1 · ME 7 · TE 14')
    expect(card(third)).toContain('1. 大厂（推荐） · 预计总成本 152.74M · 材料 -1%，时间 -30%，费用 -5% · 改装件 屹立超大型舰船制造效率 I\n2. 小厂 · 预计总成本 158.24M · 材料 -1%，时间 -15%，费用 -3% · 没有装改装件')
    expect(buttonRows(third)[0]).toEqual(['大厂=>制造 乌鸦级 XX-1 ME7 TE14 建筑:大厂', '小厂=>制造 乌鸦级 XX-1 ME7 TE14 建筑:小厂'])

    const result = card(await e.h.group('2'))
    expect(result).toContain('XX-1 · 小厂 · 00\n蓝图 ME 7 / TE 14 · 1 流程（1 艘）\n改装件 未装\n\n- 材料成本')
    expect(result).toContain('- 设施税 0.50% ')
  })

  it('a bare 「ME」 or 「TE」 asks the ME/TE step again with a notice, also outside 高级', async () => {
    const e = await start()
    const again = card(await e.h.group('制造 乌鸦级 XX-1 高级 ME'))
    expect(again).toContain('进度：地点 ✓ → **ME/TE → 建筑**')
    expect(again).toContain('⚠ ME 后面要写数字，例如 ME7 TE14')
    const plain = card(await e.h.group('制造 乌鸦级 XX-1 TE'))
    expect(plain).toContain('进度：地点 ✓ → **ME/TE → 建筑**')
    expect(plain).toContain('⚠ TE 后面要写数字，例如 ME7 TE14')
  })

  it('a bare 「ME」 survives the location step and the notice shows on the ME/TE step', async () => {
    const e = await start()
    const first = await e.h.group('制造 乌鸦级 ME')
    expect(card(first)).toContain('进度：**地点 → ME/TE → 建筑**')
    expect(buttonRows(first)[0]).toEqual(['XX-1=>制造 乌鸦级 XX-1 ME 高级', 'XX-2=>制造 乌鸦级 XX-2 ME 高级', 'XX-3=>制造 乌鸦级 XX-3 ME 高级'])
    const second = await e.h.group('1')
    expect(card(second)).toContain('进度：地点 ✓ → **ME/TE → 建筑**')
    expect(card(second)).toContain('⚠ ME 后面要写数字，例如 ME7 TE14')
  })

  it('industry words without the command name suggest 制造 with a button', async () => {
    const e = await start()
    const sent = await e.h.group('乌鸦级 高级')
    expect(card(sent)).toBe('没看懂「乌鸦级 高级」。是不是想用「制造 乌鸦级 高级」？')
    expect(buttons(sent)).toEqual(['制造 乌鸦级 高级=>制造 乌鸦级 高级', '帮助=>帮助'])
    expect(card(await e.h.group('乌鸦级 你好'))).toBe('没看懂「乌鸦级 你好」。你是想查价吗？')
  })

  it('a location with one structure skips the structure step; one visible location skips the location step', async () => {
    const e = await start({ industry: { locations: [LOCATIONS[1]], structures: [STRUCTURES[3]] } })
    const step = await e.h.group('制造 乌鸦级 高级', { channelId: GROUP2 })
    expect(card(step)).toContain('进度：地点 ✓ → **ME/TE → 建筑**\n已选：XX-2（本群唯一的地点）')
    const result = card(await e.h.group('1', { channelId: GROUP2 }))
    expect(result).toContain('XX-2 · 中厂（该地点唯一） · 低安\n蓝图 ME 10 / TE 20 · 1 流程（1 艘）')
  })

  it('「建筑:?」 and a structure that does not exist list every structure, plus no structure bonus', async () => {
    const e = await start()
    const listed = await e.h.group('制造 乌鸦级 XX-1 ME10 TE20 建筑:? 高级')
    expect(card(listed)).toContain('3. 无建筑加成 · 预计总成本 154.69M · 按 NPC 空间站算 · 设施税 0.25%')
    expect(buttonRows(listed)[0][2]).toBe('无建筑加成=>制造 乌鸦级 XX-1 ME10 TE20 建筑:无')
    const wrong = card(await e.h.group('制造 乌鸦级 XX-1 建筑:不存在'))
    expect(wrong).toContain('⚠ XX-1 没有叫「不存在」的建筑，请重新选择\n请选择制造建筑：')
  })

  it('writing a structure or tax without a location starts from the location step', async () => {
    const e = await start()
    const out = await e.h.group('制造 乌鸦级 税:2%')
    expect(card(out)).toContain('进度：**地点 → ME/TE → 建筑**\n已选：设施税 2%')
    expect(buttons(out)[0]).toBe('XX-1=>制造 乌鸦级 XX-1 税:2% 高级')
    // 写了的建筑也带着：选了地点以后用它，这个地点没有它时再问
    const named = await e.h.group('制造 乌鸦级 建筑:小厂')
    expect(card(named)).toContain('已选：建筑 小厂')
    expect(buttons(named).slice(0, 2)).toEqual(['XX-1=>制造 乌鸦级 XX-1 建筑:小厂 高级', 'XX-2=>制造 乌鸦级 XX-2 建筑:小厂 高级'])
    expect(card(await e.h.group('1'))).toContain('进度：地点 ✓ → **ME/TE → 建筑**\n已选：XX-1 · 建筑 小厂')
    expect(card(await e.h.group('1'))).toContain('XX-1 · 小厂 · 00\n蓝图 ME 10 / TE 20 · 1 流程（1 艘）\n改装件 未装')
    expect(card(await e.h.group('制造 乌鸦级 XX-2 ME10 TE20 建筑:小厂'))).toContain('⚠ XX-2 没有叫「小厂」的建筑，请重新选择')
  })

  it('a renamed command that makes a step button too long uses #typeID for the item', async () => {
    const e = await start()
    // 所有者在「指令管理」里改了一个很长的名字（54 字）：「名字 + 参数」超过 100 字
    const long = '制造'.repeat(27)
    const command = (e.h.app as any).$commander.get('制造')
    command.displayName = long
    const out = await e.h.group('制造 大型护盾扩展装置 II*1000 ME4 TE8 改装:无 税:1.25% 高级 材料')
    const rows = buttonRows(out)
    expect(rows[0]).toHaveLength(3)
    for (const b of rows.flat()) expect(b.length - b.indexOf('=>') - 2).toBeLessThanOrEqual(100)
    expect(rows[0][0]).toMatch(new RegExp(`^XX-1=>${long} #\\d+\\*1000 XX-1 ME4 TE8 改装:无 税:1\\.25% 高级 材料$`))
  })

  it('plain text output: options as 「回复 @我 1：…」 with a complete command to send', async () => {
    const e = await start({ config: { display: { output: 'text' } } })
    const out = await e.h.group('制造 乌鸦级 高级')
    expect(out[0].markdown).toBeUndefined()
    expect(out[0].text).toContain('回复 @我 1：XX-1 · 00 · 2 座可选，自动挑 · 星系成本指数 2.31%')
    expect(out[0].text).toContain('编号 5 分钟内有效，也可以直接发送「制造 乌鸦级 XX-1 高级」')
    expect(out[0].text).toContain('默认直接出结果：@我 发送「制造 乌鸦级 XX-1」')
    expect(card(await e.h.group('2'))).toContain('已选：XX-2')
  })
})

describe('制造: materials', () => {
  it('a card and a plain multibuy block that pastes into the game', async () => {
    const e = await start()
    const sent = await e.h.group('制造 乌鸦级 XX-1 材料')
    expect(sent).toHaveLength(2)
    expect(sent[0].markdown).toMatch(new RegExp(`^${escapeRe([
      '**乌鸦级 · 材料清单**',
      'XX-1 · 大厂 · ME 10 · 1 流程 · Jita 4-4 出售价',
      '',
      '1. 类晶体胶矿 ×2,219,303 · `44.39M`',
      '2. 类银超金属 ×332,896 · `31.63M`',
    ].join('\n'))}`))
    expect(sent[0].markdown).toContain('10. 自动修复储藏装置密封 ×129 · `838.50K`\n\n**材料合计** `138,298,834 ISK`（138.30M）· 76,370 m³\n下一条消息可以直接粘贴到游戏的「多重购买」窗口。')
    expect(sent[1].markdown).toBeUndefined()
    expect(sent[1].text.split('\n')).toEqual([
      'Pyerite\t2219303', 'Mexallon\t332896', 'Isogen\t110966', 'Tritanium\t4438606', 'Nocxium\t13316', 'Zydrine\t3329',
      'Megacyte\t1665', 'Core Temperature Regulator\t1', 'Life Support Backup Unit\t65', 'Auto-Integrity Preservation Seal\t129',
    ])
    // 按钮挂在卡片上，回到成本明细
    expect(buttonRows(sent)).toEqual([['成本明细=>制造 乌鸦级 XX-1 建筑:大厂']])
  })

  it('base materials in a direct chat; Chinese names when the console says so', async () => {
    const e = await start({ industry: { ...INDUSTRY, multibuyLanguage: 'zh' } })
    const sent = await e.h.direct('制造 乌鸦级 材料', { userId: USER })
    expect(sent).toHaveLength(2)
    expect(sent[0].markdown).toContain('ME 0 · 1 流程 · Jita 4-4 出售价')
    expect(sent[1].text.split('\n')[0]).toBe('类晶体胶矿\t2600000')
  })
})

describe('制造: errors', () => {
  it('an item without a manufacturing blueprint; a reaction product points to 反应', async () => {
    const e = await start()
    expect(card(await e.h.group('制造 乌鸦级海军型'))).toBe('乌鸦级海军型 没有可用的制造蓝图。')
    const reaction = await e.h.group('制造 碳化钨*1000 XX-1')
    expect(card(reaction)).toBe('碳化钨 是反应产物，请用：反应 碳化钨')
    expect(buttons(reaction)).toEqual(['反应 碳化钨=>反应 碳化钨*1000 XX-1'])
    // 写的是反应配方：提示和按钮里是它的产物
    const formula = await e.h.group('制造 碳化钨反应配方*20000 XX-1')
    expect(card(formula)).toBe('碳化钨 是反应产物，请用：反应 碳化钨')
    expect(buttons(formula)).toEqual(['反应 碳化钨=>反应 碳化钨*20000 XX-1'])
    expect(card(await e.h.group('制造比价 碳化钨反应配方'))).toBe('碳化钨 是反应产物，请用：反应 碳化钨')
  })

  it('an unknown location, or one this group cannot see, lists the usable ones with buttons keeping the rest', async () => {
    const e = await start()
    const unknown = await e.h.group('制造 乌鸦级*2 XX-9 ME9')
    expect(card(unknown)).toBe('XX-9 尚未配置为工业地点。\n\n本群可以制造的地点：XX-1 · XX-2 · XX-3')
    expect(buttons(unknown)).toEqual(['XX-1=>制造 乌鸦级*2 ME9 XX-1', 'XX-2=>制造 乌鸦级*2 ME9 XX-2', 'XX-3=>制造 乌鸦级*2 ME9 XX-3'])
    // 授权群才看得到的地点：在别的群里和不存在一样（别名也一样）
    const hidden = await e.h.group('制造 乌鸦级 XX-1', { channelId: GROUP2 })
    const alias = await e.h.group('制造 乌鸦级 联盟工业点A', { channelId: GROUP2 })
    const missing = await e.h.group('制造 乌鸦级 XX-9', { channelId: GROUP2 })
    expect(card(hidden).replace('XX-1', 'XX-9')).toBe(card(missing))
    expect(card(alias).replace('联盟工业点A', 'XX-9')).toBe(card(missing))
    expect(card(missing)).toBe('XX-9 尚未配置为工业地点。\n\n本群可以制造的地点：XX-2 · XX-3')
    // 建筑名只属于写错的那个地点，按钮里不带；「改装:」「税:」「高级」「材料」照样带着
    const all = await e.h.group('制造 乌鸦级*2 XX-9 ME4 TE8 建筑:大工厂 改装:无 税:1.25% 高级 材料')
    expect(buttons(all)[0]).toBe('XX-1=>制造 乌鸦级*2 ME4 TE8 改装:无 税:1.25% 高级 材料 XX-1')
    expect(buttons(await e.h.group('制造 乌鸦级 XX-9 建筑:无'))[0]).toBe('XX-1=>制造 乌鸦级 建筑:无 XX-1')
  })

  it('wrong parameters say what is allowed', async () => {
    const e = await start()
    expect(card(await e.h.group('制造 乌鸦级 ME11'))).toBe('ME 只能是 0–10')
    expect(card(await e.h.group('制造 乌鸦级 TE21'))).toBe('TE 只能是 0–20')
    expect(card(await e.h.group('制造 乌鸦级 XX-1 税:'))).toBe('税率要写成「税:1.5%」（0–100）')
    expect(card(await e.h.group('制造 乌鸦级 改装:随便'))).toBe('改装件只能写「改装:默认」或「改装:无」')
    expect(card(await e.h.group('制造 乌鸦级 20000流程'))).toBe('流程数只能是 1–10000')
  })

  it('an ambiguous name lists only manufacturable candidates whose commands keep the parameters', async () => {
    const e = await start()
    const sent = await e.h.group('制造 II XX-1 ME8')
    expect(card(sent)).toBe([
      '**「II」可能是以下物品，请选择：**',
      '',
      '1. 武士 II · Warrior II',
      '2. 损伤控制 II · Damage Control II',
      '3. 大型护盾扩展装置 II · Large Shield Extender II',
      '4. 巡航导弹发射器 II · Cruise Missile Launcher II',
      '',
      '点下面的编号后再按发送，或者 @我 回复编号（5 分钟内有效）',
    ].join('\n'))
    expect(buttons(sent)[1]).toBe('2=>制造 损伤控制 II XX-1 ME8')
    expect(card(await e.h.group('2'))).toMatch(/^\*\*损伤控制 II Damage Control II · 高级制造计算\*\*\n\nXX-1 · 自动选择：大厂 · 00\n蓝图 ME 8 \/ TE 4/)
    // 拼音、包含这类模糊命中也要确认
    expect(buttons(await e.h.group('制造 wuya XX-1'))).toEqual(['1=>制造 乌鸦级 XX-1'])
  })

  it('no material has a price: the costs are 「—」, never 0 ISK', async () => {
    const e = await start()
    const out = card(await e.h.group('制造 大型护盾扩展装置 II XX-1'))
    expect(out).toContain('- 材料成本 — （不完整，缺 5 种材料价格）')
    expect(out).toContain('- **预计总成本 — （不完整，缺 5 种材料价格）（未计安装费用）**')
    expect(out).toContain('成品 Jita 4-4 暂无卖单')
    expect(out).not.toContain('预计利润')
    expect(out).not.toMatch(/0(\.00)? ISK/)
  })

  it('nothing after the command: usage with the locations of this group', async () => {
    const e = await start()
    const sent = await e.h.group('制造')
    expect(sent[0].markdown?.split('\n')[0]).toBe('**制造用法**')
    expect(card(sent)).toContain('本群可以制造的地点：XX-1 · XX-2 · XX-3')
    expect(buttons(sent)).toEqual(['制造 乌鸦级=>制造 乌鸦级', '输入物品=>制造 '])
  })
})

describe('查价 and 帮助 with industry', () => {
  it('a price card has 「制造成本」 for items with a blueprint or a reaction formula', async () => {
    const e = await start()
    expect(buttons(await e.h.group('查价 乌鸦级'))).toContain('制造成本=>制造 乌鸦级')
    expect(buttons(await e.h.group('查价 碳化钨*30000'))).toContain('制造成本=>反应 碳化钨*30000')
    expect(buttons(await e.h.group('查价 乌鸦级海军型')).join()).not.toContain('制造成本')
  })

  it('「帮助 制造」 explains ME/TE, quick and advanced calculation, and lists the locations', async () => {
    const e = await start()
    const sent = await e.h.group('帮助 制造')
    expect(card(sent)).toContain('- 制造 乌鸦级 XX-1：快速计算，按这个地点的建筑、改装件和税直接出结果')
    expect(card(sent)).toContain('本群可以制造的地点：XX-1 · XX-2 · XX-3\n想慢慢调参数可以私聊我，不刷群。')
    expect(buttons(sent)).toEqual(['制造=>制造 ', '全部帮助=>帮助'])
    expect(card(await e.h.group('帮助'))).toContain('- 制造比价 乌鸦级：比较各个制造地点')
    const compare = card(await e.h.group('帮助 制造比价'))
    expect(compare).toMatch(/^\*\*制造比价\*\*/)
    expect(compare).toContain('（不写时 ME 10 / TE 20，T2 产品按 ME 2 / TE 4）')
    expect(card(await e.h.group('制造比价'))).toContain('（不写时 ME 10 / TE 20，T2 产品按 ME 2 / TE 4）')
    expect(card(await e.h.group('帮助 反应'))).toContain('反应配方不能研究，没有 ME/TE；高安不能进行反应。')
  })
})

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('制造: 拆到原料的词跟着按钮走', () => {
  const buttonTexts = (sent: Parameters<typeof buttonRows>[0]) => buttonRows(sent).flat()

  it('keeps the chain words, leaves out layers equal to the console defaults', async () => {
    const e = await start()
    const sent = await e.h.group('制造 乌鸦级 拆到原料 组件:买 其他:买')
    const texts = buttonTexts(sent)
    expect(texts.length).toBeGreaterThan(0)
    for (const t of texts) {
      // 「组件:造」是把这一层改回去，「只算成品」是不拆了：这两个按钮本来就不带
      if (!t.includes('=>制造 ') || /^(组件:造|只算成品)=>/.test(t)) continue
      expect(t, t).toContain(' 组件:买')
      expect(t, t).not.toContain('其他:')
    }
  })

  it('falls back to #typeID when the chain words push the command over 100 chars', async () => {
    const e = await start()
    // 命令名改成 48 字：带上层词和明细后超过 100 字
    const long = '制造'.repeat(24)
    const command = (e.h.app as any).$commander.get('制造')
    command.displayName = long
    const sent = await e.h.group('制造 大型护盾扩展装置 II*1000 XX-1 拆到原料 低级反应:买 高级反应:买 组件:买 其他:造 明细 税:12.5%')
    const commands = buttonTexts(sent).map((t) => t.split('=>')[1] ?? '').filter((c) => c.startsWith(long))
    expect(commands.length).toBeGreaterThan(0)
    for (const c of commands) {
      expect(c.length, c).toBeLessThanOrEqual(100)
    }
    expect(commands.some((c) => / #\d+\*1000 /.test(c))).toBe(true)
  })
})
