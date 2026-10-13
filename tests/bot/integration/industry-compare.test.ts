// 制造比价（§2.7）走完整个插件：按总成本排序、标出最低和最快、详情按钮和编号回复、本群可见范围、地点不足 2 个、慢提示。
// 地点、建筑、税率、价格、指数都是编造的，星系和物品是公共数据。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOW_HINT_MS } from '../../../src/constants'
import { FakeTime } from '../../fakes/fake-time'
import { GROUP2 } from '../../harness'
import { TEST_START, buttonRows, buttons, card } from './plugin-env'
import type { PluginEnv } from './plugin-env'
import { LOCATIONS, STRUCTURES, startIndustry } from './industry-env'
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

const RAVEN_COMPARE = [
  '**乌鸦级 · 制造地点比价**',
  'ME 10 / TE 20 · 1 流程 · 材料按 Jita 4-4 出售价',
  '',
  '1. **XX-1 · 大厂 💰最低 ⚡最快**',
  '    - 成本 `148.25M` · 1 小时 37 分 · 利润 110.15M（42.6%）',
  '2. **XX-3 · 高安厂（改装件对它不生效）**',
  '    - 成本 `155.15M` · 3 小时 24 分 · 利润 103.25M（40%）',
  '3. **XX-2 · 中厂（未装改装件）**',
  '    - 成本 `155.45M` · 3 小时 12 分 · 利润 102.95M（39.8%）',
  '',
  '成品参考 Jita 4-4 出售 258.40M · 利润未计销售税和经纪费',
  '点按钮后再按发送看完整明细，或者 @我 回复编号（5 分钟内有效）',
  '',
  '***',
].join('\n')

describe('制造比价', () => {
  it('every location of this group, sorted by total cost, the cheapest and the fastest marked, detail buttons', async () => {
    const e = await start()
    const sent = await e.h.group('制造比价 乌鸦级')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown?.startsWith(RAVEN_COMPARE)).toBe(true)
    expect(sent[0].markdown).toMatch(/\n欧服 · 价格更新于 \d\d:\d\d · 星系成本指数更新于 \d\d:\d\d$/)
    expect(buttonRows(sent)).toEqual([['XX-1 详情=>制造 乌鸦级 XX-1 ME10 TE20', 'XX-3 详情=>制造 乌鸦级 XX-3 ME10 TE20', 'XX-2 详情=>制造 乌鸦级 XX-2 ME10 TE20']])
    // 编号回复也行：第 2 行是 XX-3
    expect(card(await e.h.group('2'))).toMatch(/^\*\*乌鸦级 Raven · 高级制造计算\*\*\n\nXX-3 · 高安厂（该地点唯一） · 高安\n蓝图 ME 10 \/ TE 20 · 1 流程/)
    // 星系成本指数和调整价只取了一次
    expect(e.fake.count(/^\/industry\/systems$/)).toBe(1)
    expect(e.fake.count(/^\/markets\/prices$/)).toBe(1)
  })

  it('another group compares only the public locations; the quantity and ME/TE are carried', async () => {
    const e = await start()
    const sent = await e.h.group('制造比价 乌鸦级*2 ME8 TE16', { channelId: GROUP2 })
    expect(card(sent)).toContain('ME 8 / TE 16 · 2 流程 · 材料按 Jita 4-4 出售价')
    expect(card(sent)).not.toContain('XX-1')
    expect(buttons(sent)).toEqual(['XX-3 详情=>制造 乌鸦级*2 XX-3 ME8 TE16', 'XX-2 详情=>制造 乌鸦级*2 XX-2 ME8 TE16'])
  })

  it('T2: ME 2 / TE 4 by default; a location written by mistake is ignored', async () => {
    const e = await start()
    expect(card(await e.h.group('制造比价 损伤控制 II'))).toContain('**损伤控制 II · 制造地点比价**\nME 2 / TE 4 · 1 流程')
    expect(card(await e.h.group('制造比价 乌鸦级 XX-1'))).toContain('1. **XX-1 · 大厂 💰最低 ⚡最快**')
    expect(card(await e.h.group('制造比价 乌鸦级 XX-9'))).toContain('1. **XX-1 · 大厂 💰最低 ⚡最快**')
  })

  it('改装:无 and 税: apply to every location, are shown once, and are carried by the details (the same total as the row)', async () => {
    const e = await start()
    const taxed = await e.h.group('制造比价 乌鸦级 税:3%')
    expect(card(taxed)).toContain('ME 10 / TE 20 · 1 流程 · 设施税 3.00% · 材料按 Jita 4-4 出售价')
    expect(card(taxed)).toContain('1. **XX-1 · 大厂 💰最低 ⚡最快**\n    - 成本 `151.01M`')
    expect(buttons(taxed)[0]).toBe('XX-1 详情=>制造 乌鸦级 XX-1 ME10 TE20 税:3%')
    // 148,247,029 + EIV 138,275,000 × (3% − 1%)
    expect(card(await e.h.group('1'))).toContain('- **预计总成本** `151,012,529 ISK`（151.01M）')

    const off = await e.h.group('制造比价 乌鸦级 改装:无')
    expect(card(off)).toContain('ME 10 / TE 20 · 1 流程 · 不用改装件 · 材料按 Jita 4-4 出售价')
    // 改装件是用户关掉的：不写「未装」「不生效」
    expect(card(off)).toContain('1. **XX-1 · 大厂 💰最低 ⚡最快**\n    - 成本 `154.13M`')
    expect(card(off)).not.toMatch(/未装改装件|改装件对它不生效/)
    expect(buttons(off)[0]).toBe('XX-1 详情=>制造 乌鸦级 XX-1 ME10 TE20 改装:无')
    const detail = card(await e.h.group('1'))
    expect(detail).toContain('改装件 不用（改装:无）')
    expect(detail).toContain('（154.13M）')
  })

  it('an NPC station has no rig note; a rig of the wrong size counts as not installed', async () => {
    const e = await start({
      industry: {
        locations: [...LOCATIONS, { name: 'XX-4', system: 'Jita', visibility: 'public' }],
        structures: [
          ...STRUCTURES.filter((s) => s.location !== 'XX-2'),
          // XL 改装件装不上阿兹贝尔（L）：配置检查已经去掉，算「未装」
          { location: 'XX-2', name: '中厂', structureType: 'Azbel', rigs: '37180' },
          { location: 'XX-4', name: '空间站', structureType: 'ＮＰＣ' },
        ],
      },
    })
    const out = card(await e.h.group('制造比价 乌鸦级'))
    expect(out).toMatch(/\*\*XX-4 · 空间站( 💰最低)?\*\*\n/)
    expect(out).toContain('**XX-2 · 中厂（未装改装件）')
    expect(card(await e.h.group('制造 乌鸦级 XX-2'))).toContain('改装件 未装')
    expect(card(await e.h.group('制造 乌鸦级 XX-4'))).not.toContain('改装件')
  })

  it('fewer than 2 locations: says so, with a button for the base reference', async () => {
    const e = await start({ industry: { locations: [LOCATIONS[1]], structures: [STRUCTURES[3]] } })
    const sent = await e.h.group('制造比价 乌鸦级*2')
    expect(card(sent)).toBe('本群可比较的工业地点不足 2 个。\n\n本群可以制造的地点：XX-2')
    expect(buttons(sent)).toEqual(['基础参考=>制造 乌鸦级*2'])
    // 基础卡片上也就没有「制造比价」按钮
    expect(buttons(await e.h.group('制造 乌鸦级')).join()).not.toContain('制造比价')
  })

  it('a reaction product is not compared', async () => {
    const e = await start()
    expect(card(await e.h.group('制造比价 碳化钨'))).toBe('碳化钨 是反应产物，请用：反应 碳化钨')
  })

  it('a cold start that takes over 3 seconds sends one hint, then the card', async () => {
    const time = new FakeTime(TEST_START)
    const e = await start({ clock: time, scheduler: time })
    const release = e.fake.hold(/^\/industry\/systems$/)
    try {
      const pending = e.h.group('制造比价 乌鸦级')
      await vi.waitFor(() => expect(e.fake.count(/^\/industry\/systems$/)).toBe(1))
      await time.advance(SLOW_HINT_MS - 1)
      expect(e.h.qq.sent).toEqual([])
      await time.advance(1)
      await vi.waitFor(() => expect(e.h.qq.sent.map((s) => s.text)).toEqual(['⏳ 正在比较各个地点…']))
      release()
      const sent = await pending
      expect(sent).toHaveLength(2)
      expect(sent[1].markdown).toContain('**乌鸦级 · 制造地点比价')
    } finally {
      release()
    }
  })

  it('a quick answer sends no hint; neither does a direct chat (only one reply there)', async () => {
    const e = await start()
    expect(await e.h.group('制造比价 乌鸦级')).toHaveLength(1)
    expect(await e.h.direct('制造比价 乌鸦级')).toHaveLength(1)
  })
})
