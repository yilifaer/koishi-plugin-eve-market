// 拆到原料的总览卡走完整个插件：猎犬级（T2）从组件、高级反应、低级反应一路拆到月矿元素。
// 只发 1 张总览卡；按钮、层设置的开关、炼金、高级逐步选择、慢提示、出错。地点、建筑名是编造的，数字是假报价算出来的。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOW_HINT_MS } from '../../../src/constants'
import { FakeTime } from '../../fakes/fake-time'
import { USER } from '../../harness'
import { TEST_START, buttonRows, buttons, card } from './plugin-env'
import type { PluginEnv } from './plugin-env'
import { INDUSTRY, LOCATIONS, STRUCTURES } from './industry-env'
import type { IndustryEnvOptions } from './industry-env'
import { HOUND, expectLimits, startChain } from './industry-chain-env'

let env: PluginEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

async function start(options: IndustryEnvOptions = {}): Promise<PluginEnv> {
  env = await startChain(options)
  return env
}

/** 去掉金额以后的总览卡（金额由假报价算出，另有地方核对） */
const OVERVIEW = [
  '**猎犬级 Hound · 拆到原料**',
  '',
  'XX-1 · 00 · 蓝图 ME 2 / TE 4（T2 常见值） · 1 流程（1 艘）',
  '反应 造 · 组件 造 · 其他 买 · 炼金 自动',
  '',
  '成品 自动选择：大厂 · 安装费和税 3,066 ISK',
  '组件 7 种 · 自己造 2.51M（直接买约 68.50K） · 小厂',
  '高级反应 9 种 · 自己造 327.69K（直接买约 2.42M） · 反应塔',
  '低级反应 16 种 · 自己造 438.06K（直接买约 309.40K） · 反应塔',
  '· 炼金 0 种：都是正常路线更划算',
  '直接买：原料 19 种 · 半成品 6 种（氢燃料块、氧燃料块、氦燃料块等）',
  '**预计总成本** `561,045 ISK`（561.05K）',
  '',
]

describe('拆到原料：总览卡', () => {
  it('one overview card: place, modes, a line per layer (build vs buy), buy line, total, time, notes, three button rows', async () => {
    const e = await start()
    const sent = await e.h.group(`制造 ${HOUND} XX-1 拆到原料`)
    expect(sent).toHaveLength(1)
    const out = card(sent)
    expect(out.startsWith(OVERVIEW.join('\n'))).toBe(true)
    expect(out).toContain('时间（未计技能，每层一条线）：成品 13 小时 · 组件 8 小时 24 分 · 高级反应 1 天 2 小时 · 低级反应 1 天 20 小时 · 合计 3 天 20 小时')
    expect(out).toContain('⚠ T2 发明成本不计入 · 炼金按废料 55% 规则计算')
    expect(out).toMatch(/\n\*\*\*\n欧服 · 价格更新于 \d\d:\d\d · 星系成本指数更新于 \d\d:\d\d$/)
    expect(buttonRows(sent)).toEqual([
      [`分层明细=>制造 ${HOUND} XX-1 建筑:大厂 拆到原料 明细`, `原料清单=>制造 ${HOUND} XX-1 建筑:大厂 拆到原料 材料`, `继续拆=>制造 ${HOUND} XX-1 建筑:大厂 其他:造`],
      [`反应:买=>制造 ${HOUND} XX-1 建筑:大厂 反应:买`, `组件:买=>制造 ${HOUND} XX-1 建筑:大厂 组件:买`],
      [`换地点=>制造 ${HOUND} 拆到原料 高级`, `只算成品=>制造 ${HOUND} XX-1 建筑:大厂`],
    ])
    expectLimits(sent)
  })

  it('product value, profit and margin sit under the total; the profit follows the sell fees setting', async () => {
    const e = await start({ industry: { ...INDUSTRY, sellFeesPct: 3 } })
    const out = card(await e.h.group(`制造 ${HOUND} XX-1 拆到原料`))
    expect(out).toContain('成品 Jita 4-4 出售 `115.00 ISK`')
    expect(out).toMatch(/\*\*预计利润 -[\d.]+K · 利润率 -[\d.]+%\*\*（已扣销售税和经纪费 3%）/)
  })

  it('any layer word counts as 拆到原料; the 全角 colon works too', async () => {
    const e = await start()
    const out = card(await e.h.group(`制造 ${HOUND} XX-1 其他：造`))
    expect(out).toContain('反应 造 · 组件 造 · 其他 造 · 炼金 自动')
    expect(out).toContain('其他 6 种 · 自己造')
  })

  it('反应:炼金 forces alchemy where there is a recipe and says how many; the button carries it', async () => {
    const e = await start()
    const sent = await e.h.group(`制造 ${HOUND} XX-1 反应:炼金`)
    const out = card(sent)
    expect(out).toContain('反应 造 · 组件 造 · 其他 买 · 炼金 能用就用')
    expect(out).toContain('· 炼金 1 种：比正常贵 13.13K，多 11 小时 42 分')
    expect(out).toContain('⚠ T2 发明成本不计入 · 炼金按废料 55% 规则计算')
    expect(out).toContain('⚠ 炼金只适用于 1 种低级反应，其余 15 种没有炼金配方，按正常路线算')
    expect(buttons(sent)).toContain(`分层明细=>制造 ${HOUND} XX-1 建筑:大厂 低级反应:炼金 明细`)
    expectLimits(sent)
  })

  it('反应:正常 turns alchemy off: no alchemy line and no scrap-rule note', async () => {
    const e = await start()
    const out = card(await e.h.group(`制造 ${HOUND} XX-1 反应:正常`))
    expect(out).toContain('炼金 不用')
    expect(out).not.toContain('炼金 0 种')
    expect(out).not.toContain('废料')
  })

  it('the scrap note uses the console level (level 3 = 53%)', async () => {
    const e = await start({ industry: { ...INDUSTRY, scrapmetalLevel: 3 } })
    expect(card(await e.h.group(`制造 ${HOUND} XX-1 拆到原料`))).toContain('炼金按废料 53% 规则计算')
  })

  it('组件:买: the layers below are listed as unused, the button offers 组件:造', async () => {
    const e = await start()
    const sent = await e.h.group(`制造 ${HOUND} XX-1 组件:买`)
    const out = card(sent)
    expect(out).toContain('反应 造 · 组件 买 · 其他 买 · 炼金 自动')
    expect(out).toContain('高级反应（组件直接买，没有用到）')
    expect(out).toContain('低级反应（组件直接买，没有用到）')
    expect(out).not.toContain('组件 7 种')
    expect(out).toContain('直接买：原料 2 种 · 半成品 9 种')
    expect(out).toContain('时间（未计技能，每层一条线）：成品 13 小时\n')
    // 反应层没用到：不给「反应:买」
    expect(buttonRows(sent)[1]).toEqual([`组件:造=>制造 ${HOUND} XX-1 建筑:大厂 拆到原料`])
  })

  it('继续拆 turns the bought layers into built ones: the button command gives the deeper result', async () => {
    const e = await start()
    const first = await e.h.group(`制造 ${HOUND} XX-1 拆到原料`)
    expect(card(first)).toContain('直接买：原料 19 种 · 半成品 6 种')
    const command = buttons(first).find((b) => b.startsWith('继续拆='))!.split('=>')[1]
    const out = card(await e.h.group(command))
    expect(out).toContain('其他 6 种 · 自己造')
    expect(out).toContain('反应 造 · 组件 造 · 其他 造 · 炼金 自动')
    expect(out).toContain('直接买：原料 36 种\n')
    expect(out).not.toContain('半成品')
    // 全部都造了：没有可以继续拆的
    expect(buttons(await e.h.group(command)).join()).not.toContain('继续拆')
  })

  it('继续拆 flips only the bought layers that still have buildable items, not every bought layer', async () => {
    const e = await start()
    // 组件、反应都是买，但反应层在组件下面，根本没有东西停在那里；只有组件和其他有可造的
    const sent = await e.h.group(`制造 ${HOUND} XX-1 组件:买 反应:买 其他:造`)
    const more = buttons(sent).find((b) => b.startsWith('继续拆='))!.split('=>')[1]
    // 组件改回造（默认，不写），反应还是买
    expect(more).not.toContain('组件:买')
    expect(more).toContain('反应:买')
  })

  it('反应:买 shows the other option 反应:造; reaction layers are bought as 半成品', async () => {
    const e = await start()
    const sent = await e.h.group(`制造 ${HOUND} XX-1 反应:买`)
    expect(card(sent)).toContain('反应 买 · 组件 造 · 其他 买 · 炼金 自动')
    expect(card(sent)).not.toContain('高级反应 9 种')
    expect(buttonRows(sent)[1][0]).toBe(`反应:造=>制造 ${HOUND} XX-1 建筑:大厂 拆到原料`)
  })

  it('只算成品 goes back to the ordinary result card; the 税 argument is kept', async () => {
    const e = await start()
    const first = await e.h.group(`制造 ${HOUND} XX-1 拆到原料 税:2%`)
    const command = buttons(first).find((b) => b.startsWith('只算成品='))!.split('=>')[1]
    expect(command).toBe(`制造 ${HOUND} XX-1 建筑:大厂 税:2%`)
    const out = card(await e.h.group(command))
    expect(out).toContain('**猎犬级 Hound · 高级制造计算**')
    expect(out).not.toContain('拆到原料')
  })

  it('the 税 argument only changes the final product: its fee line differs, the layer lines stay the same', async () => {
    const e = await start()
    const plain = card(await e.h.group(`制造 ${HOUND} XX-1 拆到原料`))
    const taxed = card(await e.h.group(`制造 ${HOUND} XX-1 拆到原料 税:10%`))
    expect(taxed).not.toContain('安装费和税 3,066 ISK')
    expect(taxed.split('\n').filter((l) => /^(组件|高级反应|低级反应) \d+ 种/.test(l))).toEqual(plain.split('\n').filter((l) => /^(组件|高级反应|低级反应) \d+ 种/.test(l)))
  })

  it('no location: said plainly, no default mark on ME/TE, the final product has no structure', async () => {
    const e = await start()
    const out = card(await e.h.group('制造 乌鸦级 组件:买'))
    expect(out).toContain('没写地点，不计建筑加成和安装费 · 蓝图 ME 0 / TE 0 · 1 流程（1 艘）')
    expect(out).toContain('成品 无建筑加成 · 未计安装费用')
  })

  it('a reaction as the product: only reaction layers, no 组件 button', async () => {
    const e = await start()
    const sent = await e.h.group('反应 铁磁胶体 XX-1 拆到原料')
    const out = card(sent)
    expect(out).toContain('低级反应')
    expect(out).not.toMatch(/^组件 \d+ 种/m)
    expect(buttons(sent).join()).not.toContain('组件:')
    expect(buttonRows(sent)[0][0]).toMatch(/^分层明细=>反应 铁磁胶体 XX-1 .*拆到原料 明细$/)
    expectLimits(sent)
  })
})

describe('拆到原料：反应的地点', () => {
  const places = [
    ...LOCATIONS,
    { name: 'XX-4', system: 'Tama', visibility: 'public' },
  ]
  const noReactorHere = STRUCTURES.filter((s) => s.name !== '反应塔')

  it('the command location has no refinery: reactions move to another location, said in plain words', async () => {
    const e = await start({ industry: { locations: places, structures: noReactorHere } })
    const out = card(await e.h.group(`制造 ${HOUND} XX-1 拆到原料`))
    expect(out).toContain('反应在 XX-2（XX-1 没有精炼厂）')
    expect(out).not.toContain('命令里的地点没有能做这些反应的建筑')
    expect(out).toMatch(/高级反应 9 种 · 自己造 .*· 反应厂/)
  })

  it('nobody can react: the reactions are bought, the engine warning stays', async () => {
    const e = await start({ industry: { locations: places, structures: STRUCTURES.filter((s) => !/反应/.test(s.name)) } })
    const out = card(await e.h.group(`制造 ${HOUND} XX-1 拆到原料`))
    expect(out).not.toContain('高级反应 9 种')
    expect(out).toContain('没有能做')
    expect(out).toContain('改成直接买')
    expect(out).toContain('没地方造')
  })
})

describe('拆到原料：高级、出错、慢提示', () => {
  it('高级 asks for the location first; every option keeps the chain words', async () => {
    const e = await start()
    const sent = await e.h.group(`制造 ${HOUND} 反应:买 高级`)
    expect(card(sent)).toContain('请选择制造地点：')
    expect(buttons(sent).filter((b) => b.includes(`${HOUND} XX-`)).every((b) => b.includes('反应:买'))).toBe(true)
  })

  it('an unknown location is the same card as 制造, with the chain words kept in the buttons', async () => {
    const e = await start()
    const sent = await e.h.group(`制造 ${HOUND} 没有的地方 反应:买`)
    expect(card(sent)).toContain('没有的地方 尚未配置为工业地点。')
    expect(buttons(sent).some((b) => b.includes('反应:买'))).toBe(true)
  })

  it('a cold start over 3 seconds sends one hint, then the overview card', async () => {
    const time = new FakeTime(TEST_START)
    const e = await start({ clock: time, scheduler: time })
    const release = e.fake.hold(/^\/industry\/systems$/)
    try {
      const pending = e.h.group(`制造 ${HOUND} XX-1 拆到原料`)
      await vi.waitFor(() => expect(e.fake.count(/^\/industry\/systems$/)).toBe(1))
      await time.advance(SLOW_HINT_MS - 1)
      expect(e.h.qq.sent).toEqual([])
      await time.advance(1)
      await vi.waitFor(() => expect(e.h.qq.sent.map((s) => s.text)).toEqual(['⏳ 正在拆到原料…']))
      release()
      const sent = await pending
      expect(sent).toHaveLength(2)
      expect(sent[1].markdown).toContain('**猎犬级 Hound · 拆到原料**')
    } finally {
      release()
    }
  })

  it('a quick answer sends no hint; neither does a direct chat get more than its budget', async () => {
    const e = await start()
    expect(await e.h.group(`制造 ${HOUND} XX-1 拆到原料`)).toHaveLength(1)
    expect(await e.h.direct(`制造 ${HOUND} XX-1 拆到原料`)).toHaveLength(1)
  })

  it('a direct chat gets the overview in one message (XX-2 is public); the buttons stay within the limits', async () => {
    const e = await start()
    const sent = await e.h.direct(`制造 ${HOUND} XX-2 拆到原料`, { userId: USER })
    expect(sent).toHaveLength(1)
    expect(card(sent)).toContain('XX-2 · 低安 · 蓝图 ME 2 / TE 4（T2 常见值） · 1 流程（1 艘）')
    expect(buttons(sent)[0]).toBe(`分层明细=>制造 ${HOUND} XX-2 拆到原料 明细`)
    expectLimits(sent)
  })

  it('「帮助 制造」 lists the chain words', async () => {
    const e = await start()
    const out = card(await e.h.group('帮助 制造'))
    expect(out).toContain('制造 帕拉丁级 XX-1 拆到原料：从原料一路算到成品')
    expect(out).toContain('反应:买 / 反应:造、组件:买 / 组件:造、其他:造')
    expect(out).toContain('反应:炼金（都走炼金）、反应:正常、反应:自动')
    expect(out).toContain('加上 明细 直接出分层明细，加上 材料 直接出原料清单')
  })

  it('the chain does not touch the plain 制造 card', async () => {
    const e = await start()
    expect(card(await e.h.group(`制造 ${HOUND} XX-1`))).toContain('**猎犬级 Hound · 高级制造计算**')
  })
})
