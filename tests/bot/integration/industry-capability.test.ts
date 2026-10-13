// 自动挑建筑和按产品筛地点的 bot 部分：结果卡的「自动选择」、按钮带建筑、比价行和详情、高级第 3 步的推荐、造不了的说明和快速计算按钮。
// 地点、建筑都是编造的（CC-1 ……），星系是公共数据；绝念级（航母）的蓝图在这里补进小数据集。

import { afterEach, describe, expect, it } from 'vitest'
import { USER } from '../../harness'
import { buttonRows, buttons, card } from './plugin-env'
import type { PluginEnv } from './plugin-env'
import { INDUSTRY, startIndustry } from './industry-env'
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

/** 补一个绝念级（航母，分组 547）的制造蓝图：每艘 1000 三钛合金 + 500 类晶体胶矿 */
const withCarrier = (json: Record<string, any>) => {
  const types: unknown[][] = json['types.json'].types
  const raven = types.find((row) => row[0] === 688)!
  types.push([91000, 'Thanatos Blueprint', '绝念级蓝图', ...raven.slice(3, 12), 'junianjilantu jnjlt'])
  types.sort((a, b) => (a[0] as number) - (b[0] as number))
  json['industry.json'].blueprints.push([91000, 'm', 36_000, 10, [[23911, 1]], [[34, 1000], [35, 500]]])
}

const LOCATIONS = [
  { name: 'CC-1', system: 'NIH-02', visibility: 'allowed' },
  { name: 'CC-2', system: 'Tama', visibility: 'allowed' },
  { name: 'CC-3', system: 'Jita', visibility: 'allowed', isDefault: true },
]
const STRUCTURES = [
  { location: 'CC-1', name: '甲阿兹贝尔', structureType: 'Azbel', facilityTaxPct: 0.5 },
  { location: 'CC-1', name: '甲索迪约', structureType: 'Sotiyo', facilityTaxPct: 1 },
  { location: 'CC-1', name: '甲莱塔卢', structureType: 'Raitaru' },
  { location: 'CC-2', name: '乙阿兹贝尔', structureType: 'Azbel' },
  { location: 'CC-3', name: '丙莱塔卢', structureType: 'Raitaru' },
]

const CARRIER = { industry: { locations: LOCATIONS, structures: STRUCTURES }, data: withCarrier }
const NEED = '旗舰级船坞 / 超级旗舰级船坞'

describe('自动选择', () => {
  it('the result card says which structure was picked; the follow-up buttons keep it, 换地点 does not, 换建筑 asks again', async () => {
    const e = await start()
    const sent = await e.h.group('制造 乌鸦级 XX-1')
    expect(card(sent)).toContain('XX-1 · 自动选择：大厂 · 00')
    const rows = buttonRows(sent)
    expect(rows[0]).toContain('查看材料=>制造 乌鸦级 XX-1 建筑:大厂 材料')
    expect(rows[1]).toContain('更换地点=>制造 乌鸦级 高级')
    expect(rows[2]).toContain('改建筑/改装件=>制造 乌鸦级 XX-1 ME10 TE20 建筑:? 高级')
    // 改装开关后要重新挑建筑：自动选的不钉住
    expect(rows[2]).toContain('不用改装件=>制造 乌鸦级 XX-1 改装:无')
    expect(rows[3]).toContain('改税率=>制造 乌鸦级 XX-1 ME10 TE20 建筑:大厂 税:')
    // 材料清单回来的「成本明细」也是同一座
    const materials = await e.h.group('制造 乌鸦级 XX-1 建筑:大厂 材料')
    expect(buttonRows(materials)).toEqual([['成本明细=>制造 乌鸦级 XX-1 建筑:大厂']])
  })

  it('a location with one structure says so and the buttons carry no structure', async () => {
    const e = await start()
    const sent = await e.h.group('制造 乌鸦级 XX-3')
    expect(card(sent)).toContain('XX-3 · 高安厂（该地点唯一） · 高安')
    expect(card(sent)).not.toContain('自动选择')
    expect(buttons(sent).filter((b) => b.includes('建筑:')).every((b) => b.includes('建筑:?') || b.includes('建筑:高安厂'))).toBe(true)
    expect(buttons(sent).some((b) => b.startsWith('查看材料=>制造 乌鸦级 XX-3 材料'))).toBe(true)
  })

  it('compare: one line per location with the picked structure; the detail button carries it', async () => {
    const e = await start()
    const sent = await e.h.group('制造比价 乌鸦级')
    expect(card(sent)).toContain('1. **XX-1 · 大厂（自动选择） 💰最低 ⚡最快**')
    expect(card(sent)).toContain('2. **XX-3 · 高安厂（改装件对它不生效）**')
    expect(buttons(sent)[0]).toBe('XX-1 详情=>制造 乌鸦级 XX-1 ME10 TE20 建筑:大厂')
    expect(buttons(sent)[1]).toBe('XX-3 详情=>制造 乌鸦级 XX-3 ME10 TE20')
    // 点详情（或回复编号）得到的就是比价那一行的建筑
    const detail = card(await e.h.group('1'))
    expect(detail).toContain('XX-1 · 大厂 · 00')
    expect(detail).toContain('- **预计总成本** `148,247,029 ISK`（148.25M）')
  })

  it('advanced step 3: the cheapest first and marked, every option shows its cost, button labels stay the structure names', async () => {
    const e = await start()
    await e.h.group('制造 乌鸦级 高级')
    await e.h.group('1')
    const third = await e.h.group('ME7 TE14')
    const text = card(third)
    expect(text).toContain('1. 大厂（推荐） · 预计总成本 152.74M')
    expect(text).toMatch(/\n2\. 小厂 · 预计总成本 158\.24M/)
    expect(text.match(/（推荐）/g)).toHaveLength(1)
    expect(buttonRows(third)[0]).toEqual(['大厂=>制造 乌鸦级 XX-1 ME7 TE14 建筑:大厂', '小厂=>制造 乌鸦级 XX-1 ME7 TE14 建筑:小厂'])
  })
})

describe('造不了的地点和建筑', () => {
  it('a location that cannot build the product: says what is needed and offers the locations that can', async () => {
    const e = await start(CARRIER)
    const sent = await e.h.group('制造 绝念级 CC-3')
    expect(card(sent)).toContain(`CC-3 造不了绝念级：需要${NEED}`)
    expect(card(sent)).toContain('本群可以制造的地点：CC-1 · CC-2')
    expect(buttonRows(sent)).toEqual([['CC-1=>制造 绝念级 CC-1', 'CC-2=>制造 绝念级 CC-2']])
    // 按钮点下去能出结果
    expect(card(await e.h.group('制造 绝念级 CC-2'))).toContain('CC-2 · ')
  })

  it('no location can build it: says what is needed', async () => {
    const e = await start({ ...CARRIER, industry: { locations: LOCATIONS.slice(2), structures: STRUCTURES.slice(4) } })
    const sent = await e.h.group('制造 绝念级 高级')
    expect(card(sent)).toContain(`本群没有能造绝念级的工业地点：需要${NEED}`)
  })

  it('a private chat says 私聊里 where the group says 本群 (capability texts)', async () => {
    // 私聊里只看得到公开的地点
    const open = (list: typeof LOCATIONS) => list.map((l) => ({ ...l, visibility: 'public' }))
    const e = await start({ ...CARRIER, industry: { locations: open(LOCATIONS.slice(2)), structures: STRUCTURES.slice(4) } })
    expect(card(await e.h.direct('制造 绝念级 高级', { userId: USER }))).toContain(`私聊里没有能造绝念级的工业地点：需要${NEED}`)
    expect(card(await e.h.direct('制造比价 绝念级', { userId: USER }))).toContain(`私聊里没有能造绝念级的工业地点：需要${NEED}`)
    await e.stop()
    env = await startIndustry({ ...CARRIER, industry: { locations: open(LOCATIONS.slice(1)), structures: STRUCTURES.slice(3) } })
    expect(card(await env.h.direct('制造比价 绝念级', { userId: USER }))).toContain(`私聊里可比较的工业地点不足 2 个（其余地点造不了：需要${NEED}）`)
  })

  it('no capable location: no dead basic button, compare says what is needed, an unbuildable written location too', async () => {
    const e = await start({ ...CARRIER, industry: { locations: LOCATIONS.slice(2), structures: STRUCTURES.slice(4) } })
    const compare = await e.h.group('制造比价 绝念级')
    expect(card(compare)).toContain(`本群没有能造绝念级的工业地点：需要${NEED}`)
    expect(buttonRows(compare)).toEqual([])
    // 只有一个地点造得了：比价不了，也说明其余的缺什么
    await e.stop()
    env = await startIndustry({ ...CARRIER, industry: { locations: LOCATIONS.slice(1), structures: STRUCTURES.slice(3) } })
    expect(card(await env.h.group('制造比价 绝念级'))).toContain(`本群可比较的工业地点不足 2 个（其余地点造不了：需要${NEED}）`)
    await env.stop()
    env = await startIndustry({ ...CARRIER, industry: { locations: LOCATIONS.slice(2), structures: STRUCTURES.slice(4) } })
    const e2 = env
    const advanced = await e2.h.group('制造 绝念级 高级')
    expect(buttons(advanced).some((b) => b.startsWith('基础计算'))).toBe(false)
    const written = card(await e2.h.group('制造 绝念级 CC-3'))
    expect(written).toContain(`CC-3 造不了绝念级：需要${NEED}`)
    expect(written).toContain(`本群没有能造绝念级的工业地点：需要${NEED}`)
  })

  it('the location step lists only the locations that can build, with a note for the rest', async () => {
    const e = await start(CARRIER)
    const sent = await e.h.group('制造 绝念级 高级')
    const text = card(sent)
    expect(text).toContain('1. CC-1')
    expect(text).toContain('2. CC-2')
    expect(text).not.toContain('CC-3')
    expect(text).toContain(`另有 1 个地点造不了（需要${NEED}）`)
  })

  it('compare: only the locations that can build, and a footer for the rest; the picked structure is in the detail button', async () => {
    const e = await start(CARRIER)
    const sent = await e.h.group('制造比价 绝念级')
    const text = card(sent)
    expect(text).toContain('2. **CC-1 · 甲阿兹贝尔（自动选择）（未装改装件）**')
    expect(text).toContain('1. **CC-2 · 乙阿兹贝尔（未装改装件） 💰最低 ⚡最快**')
    expect(text).not.toContain('CC-3')
    expect(text).toContain(`另有 1 个地点造不了（需要${NEED}）`)
    expect(buttons(sent)).toEqual(['CC-2 详情=>制造 绝念级 CC-2 ME10 TE20', 'CC-1 详情=>制造 绝念级 CC-1 ME10 TE20 建筑:甲阿兹贝尔'])
  })

  it('advanced step 3: structures that cannot build are not listed; a note counts them', async () => {
    const e = await start(CARRIER)
    await e.h.group('制造 绝念级 高级')
    await e.h.group('1')
    const third = await e.h.group('ME7 TE14')
    expect(card(third)).toContain('1. ')
    expect(card(third)).not.toContain('甲莱塔卢 ·')
    expect(card(third)).toContain(`另有 1 座造不了（需要${NEED}）`)
    expect(buttonRows(third)[0]).toHaveLength(2)
  })

  it('quick calculation never points at a location that cannot build the product', async () => {
    // 默认地点 CC-3 造不了：只剩 CC-1 能造，快速计算用 CC-1
    const e = await start({ ...CARRIER, industry: { locations: [LOCATIONS[0], LOCATIONS[2]], structures: [STRUCTURES[0], STRUCTURES[4]] } })
    expect(buttons(await e.h.group('制造 绝念级'))).toContain('快速计算=>制造 绝念级 CC-1')
    // 能造的地点有两个、又没有默认：不给
    await e.stop()
    env = await startIndustry(CARRIER)
    expect(buttons(await env.h.group('制造 绝念级')).some((b) => b.startsWith('快速计算'))).toBe(false)
    // 一个能造的都没有：不给
    await env.stop()
    env = await startIndustry({ ...CARRIER, industry: { locations: LOCATIONS.slice(2), structures: STRUCTURES.slice(4) } })
    expect(buttons(await env.h.group('制造 绝念级')).some((b) => b.startsWith('快速计算'))).toBe(false)
    // 乌鸦级谁都能造：默认地点照旧
    expect(buttons(await env.h.group('制造 乌鸦级')).some((b) => b.startsWith('快速计算=>制造 乌鸦级 CC-3'))).toBe(true)
  })
})
