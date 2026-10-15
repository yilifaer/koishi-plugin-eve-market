import { describe, expect, it } from 'vitest'
import { Config } from '../../src/config/schema'
import {
  containsUrl, formatIssue, INVALID_ROW_KEY, nameKey, normalizeConfig, parseBeijingTime, parseMeTeChoices,
} from '../../src/config/normalize'
import { PRESET_MARKETS } from '../../src/config/presets'
import type { Settings } from '../../src/core/types'

// 所有 ID 和名字都是编造的；Jita 等 NPC 交易中心是公共数据
const STRUCTURE = { name: '联盟市场A', aliases: '市场A', type: 'structure', location: '1000000000001', system: 'XX-1' }
const STRUCTURE_B = { name: '联盟市场B', type: 'structure', location: '1000000000002' }
const SSO = { clientId: 'fake-client-id', clientSecret: 'fake-secret' }

function run(raw: unknown) {
  const { settings, issues } = normalizeConfig(raw)
  return { settings, issues, lines: issues.map(formatIssue) }
}

/** 字段 → [写的, 本地认出的 key] */
function refs(settings: Settings) {
  return Object.fromEntries(Object.entries(settings.marketRefs).map(([field, r]) => [field, [r.ref, r.key]]))
}

describe('normalizeConfig: defaults', () => {
  it('an empty config and the schema defaults give the same clean settings', () => {
    for (const raw of [{}, undefined, null, 'x', 5, Config({} as any)]) {
      const { settings, issues } = run(raw)
      expect(issues).toEqual([])
      expect(settings.issues).toBe(issues)
      expect(settings.general).toEqual({ requireAt: true, allowSandbox: false, qqWatchdog: true })
      expect(settings.display).toEqual({
        output: 'markdown', numberStyle: 'code', priceDisplayMode: 'full_and_compact', listPriceDisplayMode: 'compact_only',
        compactDecimals: 2, thousandSeparator: true, showCurrency: true, clickable: 'buttons',
      })
      expect(settings.access).toEqual({ admins: [], allowedGroups: [], allowedUsers: [] })
      expect(settings.markets.map((m) => [m.key, m.inDefaultList, m.visibility, m.sortOrder])).toEqual([
        ['jita 4-4', true, 'public', 0],
        ['amarr', false, 'public', 10],
        ['dodixie', false, 'public', 11],
        ['rens', false, 'public', 12],
        ['hek', false, 'public', 13],
      ])
      expect(settings.markets[0]).toMatchObject({ row: 1, name: 'Jita 4-4', aliases: ['4-4'], type: 'npc-station', location: '60003760', authProfile: '', autoDefaultList: true })
      expect(refs(settings)).toEqual({
        'price.baseMarket': ['Jita 4-4', 'jita 4-4'],
        'appraisal.defaultMarket': ['Jita 4-4', 'jita 4-4'],
        'appraisal.fallbackMarket': ['', ''],
        'industry.materialMarket': ['Jita 4-4', 'jita 4-4'],
        'industry.productMarket': ['Jita 4-4', 'jita 4-4'],
        'industry.fallbackMarket': ['', ''],
      })
      expect(settings.marketRefs['appraisal.defaultMarket']).toEqual({
        section: 'appraisal', field: 'defaultMarket', label: '默认市场', ref: 'Jita 4-4', whenEmpty: 'base', key: 'jita 4-4',
      })
      expect(settings.marketRefs['price.baseMarket'].whenEmpty).toBe('none')
      expect(settings.price).toEqual({ defaultQuantities: [{ row: 1, item: 'PLEX', quantity: 500 }] })
      expect(settings.appraisal).toEqual({ defaultPriceType: 'sell' })
      expect(settings.freight.routes).toEqual([])
      expect(settings.notices.list).toEqual([])
      expect(settings.sso).toEqual({ clientId: '', clientSecret: '', callbackUrl: 'http://127.0.0.1:5140/eve-market/sso/callback', adminKey: '' })
      expect(settings.render.brAuto).toBe(true)
      expect(settings.advanced.manifestUrls).toEqual([
        'https://raw.githubusercontent.com/yilifaer/eve-cn-slang/main/official/data/manifest.json',
        'https://cdn.jsdelivr.net/gh/yilifaer/eve-cn-slang@main/official/data/manifest.json',
      ])
      expect(settings.advanced.glossaryUrls).toHaveLength(2)
      expect(settings.industry).toEqual({
        materialPriceType: 'sell', productPriceType: 'sell', meTeChoices: [{ me: 10, te: 20 }, { me: 5, te: 10 }, { me: 0, te: 0 }],
        sccSurchargePct: 4, npcFacilityTaxPct: 0.25, sellFeesPct: 0, multibuyLanguage: 'en', locations: [], structures: [],
        chain: {
          layers: { reaction1: 'build', reaction2: 'build', component: 'build', other: 'buy' },
          alchemy: 'auto', reactionLocation: '', reprocessLocation: '', scrapmetalLevel: 5,
        },
      })
    }
  })

  it('does not mutate the input or the presets', () => {
    const raw = Config({} as any)
    const snapshot = JSON.stringify(raw)
    normalizeConfig(raw)
    expect(JSON.stringify(raw)).toBe(snapshot)
    expect(PRESET_MARKETS[0].aliases).toBe('4-4')
  })
})

describe('normalizeConfig: markets', () => {
  it('structure markets: shown only in allowed groups, listed by default, profile default', () => {
    const { settings, lines } = run({ markets: [...PRESET_MARKETS, STRUCTURE, { ...STRUCTURE_B, inDefaultList: 'no', authProfile: '', system: 'YY-2' }], sso: SSO })
    const a = settings.markets.find((m) => m.name === '联盟市场A')!
    expect(a).toMatchObject({ row: 6, key: '联盟市场a', type: 'structure', location: '1000000000001', system: 'XX-1', inDefaultList: true, visibility: 'allowed', authProfile: 'default', aliases: ['市场A'] })
    const b = settings.markets.find((m) => m.name === '联盟市场B')!
    expect(b).toMatchObject({ inDefaultList: false, autoDefaultList: false, visibility: 'allowed', authProfile: '', system: 'YY-2' })
    expect(lines).toEqual([])
  })

  it('a structure read without auth needs its system', () => {
    const { settings, lines } = run({ markets: [...PRESET_MARKETS, { ...STRUCTURE_B, authProfile: '' }], sso: SSO })
    expect(settings.markets.map((m) => m.name)).not.toContain('联盟市场B')
    expect(lines).toEqual(['市场第 6 行「授权档案」留空时要填「建筑所在星系」，已跳过'])
  })

  it('explicit choices win over auto', () => {
    const { settings } = run({
      markets: [
        { name: 'Jita 4-4', location: '60003760', inDefaultList: 'no', visibility: 'allowed' },
        { name: 'Amarr', location: '60008494', inDefaultList: 'yes' },
        { ...STRUCTURE, visibility: 'public', inDefaultList: 'no' },
        { name: '伏尔戈', type: 'region', location: 'The Forge', inDefaultList: true },
      ],
      sso: SSO,
    })
    expect(settings.markets.map((m) => [m.name, m.inDefaultList, m.visibility])).toEqual([
      ['Jita 4-4', false, 'allowed'],
      ['Amarr', true, 'public'],
      ['联盟市场A', false, 'public'],
      ['伏尔戈', true, 'public'],
    ])
  })

  it('reports a bad location the way 市场状态 shows it', () => {
    const rows = [...PRESET_MARKETS, { name: '坏位置', type: 'npc-station', location: 'Jita IV - Moon 4' }]
    const { settings, lines } = run({ markets: rows })
    expect(settings.markets).toHaveLength(5)
    expect(lines).toEqual(['市场第 6 行「位置」不是数字（NPC 空间站填空间站 ID），已跳过'])
    expect(run({ markets: [{ ...STRUCTURE, location: 'abc' }], sso: SSO }).lines[0]).toBe('市场第 1 行「位置」不是数字（玩家建筑填建筑 ID），已跳过')
    expect(run({ markets: [{ name: '星系', type: 'system', location: '' }] }).lines[0]).toBe('市场第 1 行「位置」为空，已跳过')
    // 星系、星域可以写名字，要等数据加载后再检查
    expect(run({ markets: [{ name: '吉他星系', type: 'system', location: '吉他' }] }).settings.markets[0].location).toBe('吉他')
  })

  it('skips empty, duplicate, reserved and unknown-type rows', () => {
    const { settings, lines } = run({
      markets: [
        { name: 'Jita 4-4', location: '60003760' },
        { name: '', location: '60008494' },
        { name: 'ＪＩＴＡ  4－4', location: '60008494' },
        { name: 'sell', location: '60008494' },
        { name: '出售', location: '60008494' },
        { name: '500', location: '60008494' },
        { name: '-5%', location: '60008494' },
        { name: '95折', location: '60008494' },
        { name: '#638', location: '60008494' },
        { name: 'Amarr', type: 'station', location: '60008494' },
        { name: 'Amarr', location: '60008494', enabled: false },
        { name: 'Amarr', location: '60008494' },
        { [INVALID_ROW_KEY]: true },
        { name: '从81', location: '60008494' },
      ],
    })
    expect(settings.markets.map((m) => m.name)).toEqual(['Jita 4-4', 'Amarr'])
    expect(settings.markets[1].row).toBe(12)
    expect(lines).toEqual([
      '市场第 2 行「名称」为空，已跳过',
      '市场第 3 行「名称」ＪＩＴＡ 4－4 和第 1 行重复，已跳过',
      '市场第 4 行「名称」sell 和命令的参数冲突，已跳过',
      '市场第 5 行「名称」出售 和命令的参数冲突，已跳过',
      '市场第 6 行「名称」500 是纯数字，会被当成数量，已跳过',
      '市场第 7 行「名称」-5% 会被当成价格调整，已跳过',
      '市场第 8 行「名称」95折 会被当成价格调整，已跳过',
      '市场第 9 行「名称」#638 不能以 # 开头，已跳过',
      '市场第 10 行「类型」写的「station」不认识，已跳过',
      '市场第 13 行有写错的字段（例如类型、启用写成了别的值），已跳过',
      '市场第 14 行「名称」从81 会被当成「全部 从N」的页码，已跳过',
    ])
  })

  it('checks aliases after all names are known', () => {
    const { settings, lines } = run({
      markets: [
        { name: 'Jita 4-4', location: '60003760', aliases: '吉他, jita 4-4，Amarr、4-4；4-4' },
        { name: 'Amarr', location: '60008494', aliases: '吉他,阿马,买' },
        { ...STRUCTURE, aliases: '阿马, 市场A ,  测试点 ' },
      ],
      sso: SSO,
    })
    expect(settings.markets.map((m) => m.aliases)).toEqual([['吉他', '4-4'], ['阿马'], ['市场A', '测试点']])
    expect(lines).toEqual([
      '市场第 1 行别名「Amarr」和第 2 行市场的名称相同，这一行的不生效',
      '市场第 2 行别名「吉他」已经被第 1 行的市场使用，这一行的不生效',
      '市场第 2 行别名「买」和命令的参数冲突，已忽略',
      '市场第 3 行别名「阿马」已经被第 2 行的市场使用，这一行的不生效',
    ])
  })

  it('a public market keeps an alias that only a market for allowed groups listed earlier uses', () => {
    const { settings, lines } = run({
      markets: [
        { ...STRUCTURE, aliases: '大市场' },
        { name: 'Jita 4-4', location: '60003760', aliases: '大市场, 联盟市场A' },
        { name: 'Amarr', location: '60008494', aliases: '大市场' },
        { ...STRUCTURE_B, aliases: '大市场, 联盟市场A' },
      ],
      sso: SSO,
    })
    // 其他群里由 core 认作 Jita 4-4；两个公开市场之间、两个只在授权群的市场之间照旧先到先得
    expect(settings.markets.map((m) => m.aliases)).toEqual([['大市场'], ['大市场', '联盟市场A'], [], []])
    expect(lines).toEqual([
      '市场第 3 行别名「大市场」已经被第 2 行的市场使用，这一行的不生效',
      '市场第 4 行别名「大市场」已经被第 1 行的市场使用，这一行的不生效',
      '市场第 4 行别名「联盟市场A」和第 1 行市场的名称相同，这一行的不生效',
    ])
  })

  it('validates the auth profile name of structure rows', () => {
    const { settings, lines } = run({ markets: [...PRESET_MARKETS, { ...STRUCTURE, authProfile: 'bad profile!' }, { ...STRUCTURE_B, authProfile: '主号_2' }], sso: SSO })
    expect(settings.markets.filter((m) => m.type === 'structure').map((m) => m.authProfile)).toEqual(['主号_2'])
    expect(lines).toEqual(['市场第 6 行「授权档案」bad profile! 只能用文字、数字、- 和 _（最多 32 个字），已跳过'])
    // 非建筑行的授权档案和所在星系没有意义，直接清空
    const npc = run({ markets: [{ name: 'Jita 4-4', location: '60003760', authProfile: 'default', system: 'Jita' }] }).settings.markets[0]
    expect(npc).toMatchObject({ authProfile: '', system: '' })
  })

  it('reports structure markets while the EVE app is not filled in', () => {
    const { lines } = run({ markets: [...PRESET_MARKETS, STRUCTURE, { ...STRUCTURE_B, authProfile: '', system: 'YY-2' }] })
    expect(lines).toEqual(['市场第 6 行「联盟市场A」使用的授权档案 default 还没有授权（「EVE 授权」里还没填 Client ID）'])
    expect(run({ markets: [STRUCTURE], sso: { clientId: 'fake-client-id' } }).lines).toContain('EVE 授权：填了 Client ID，但还没填 Secret Key')
  })

  it('warns when no restricted market is in the default list', () => {
    const { lines } = run({ markets: [...PRESET_MARKETS, { ...STRUCTURE, inDefaultList: 'no' }], sso: SSO })
    expect(lines).toEqual(['市场：没有任何「只在授权群」的市场列入默认查价：授权群里不写市场时只会看到公开市场'])
  })

  it('warns when nothing or nothing public is enabled', () => {
    const none = run({ markets: [] })
    expect(none.lines).toContain('市场：没有启用的市场，查价用不了')
    expect(none.settings.marketRefs['price.baseMarket'].key).toBe('')
    const onlyStructures = run({ markets: [STRUCTURE], sso: SSO })
    expect(onlyStructures.lines).toEqual(['市场：没有启用的公开市场，没有授权的群查不到任何价格'])
    expect(onlyStructures.settings.marketRefs['appraisal.defaultMarket'].key).toBe('')
  })

  it('warns when no public market is in the default list', () => {
    const { lines } = run({ markets: PRESET_MARKETS.map((m) => ({ ...m, inDefaultList: 'no' })) })
    expect(lines).toEqual(['市场：没有任何公开市场列入默认查价：没有授权的群不写市场时查不到价格'])
  })

  it('a market list that is not a list falls back to the presets', () => {
    const { settings, lines } = run({ markets: 'oops' })
    expect(settings.markets).toHaveLength(5)
    expect(lines).toEqual(['市场：格式不对，已改用默认值'])
  })

  it('clamps sortOrder', () => {
    const { settings, lines } = run({ markets: [{ name: 'Jita 4-4', location: '60003760', sortOrder: 1e9 }, { name: 'Amarr', location: '60008494', sortOrder: '3' }] })
    expect(settings.markets.map((m) => m.sortOrder)).toEqual([1e6, 3])
    expect(lines).toEqual(['市场第 1 行「排序」应该在 -1000000–1000000 之间，已按 1000000 处理'])
  })
})

describe('normalizeConfig: market references', () => {
  const markets = [...PRESET_MARKETS, STRUCTURE]

  it('accept names and aliases, case-insensitively', () => {
    const { settings, lines } = run({
      markets,
      sso: SSO,
      price: { baseMarket: '4-4' },
      appraisal: { defaultMarket: '市场a', fallbackMarket: 'AMARR' },
    })
    expect(refs(settings)).toMatchObject({
      'price.baseMarket': ['4-4', 'jita 4-4'],
      'appraisal.defaultMarket': ['市场a', '联盟市场a'],
      'appraisal.fallbackMarket': ['AMARR', 'amarr'],
    })
    expect(lines).toEqual([])
  })

  it('other references wait for the data: they may be system names', () => {
    // 「Jita」「艾玛」是 Jita 4-4、Amarr 自动加的星系名别名，要等数据加载后由 core 认
    const { settings, lines } = run({
      markets: [{ name: 'Amarr', location: '60008494' }, ...PRESET_MARKETS.slice(0, 1)],
      price: { baseMarket: 'Jita' },
      appraisal: { defaultMarket: '艾玛', fallbackMarket: '不存在' },
    })
    expect(refs(settings)).toMatchObject({
      'price.baseMarket': ['Jita', ''],
      'appraisal.defaultMarket': ['艾玛', ''],
      'appraisal.fallbackMarket': ['不存在', ''],
    })
    expect(lines).toEqual([])
    // 自动列入默认的先按第一个公开市场算，数据加载后按认出的基准市场重算
    expect(settings.markets.map((m) => [m.name, m.inDefaultList, m.autoDefaultList])).toEqual([['Amarr', true, true], ['Jita 4-4', false, true]])
  })

  it('an empty base market means no comparison, but one public market stays in the default list', () => {
    const { settings, lines } = run({ price: { baseMarket: '' } })
    expect(settings.marketRefs['price.baseMarket']).toMatchObject({ ref: '', key: '' })
    expect(settings.markets.map((m) => [m.name, m.inDefaultList])).toEqual([
      ['Jita 4-4', true], ['Amarr', false], ['Dodixie', false], ['Rens', false], ['Hek', false],
    ])
    expect(settings.marketRefs['appraisal.defaultMarket'].key).toBe('jita 4-4')
    expect(lines).toEqual([])
  })

  it('a disabled market is not found locally', () => {
    const { settings, lines } = run({ markets: [{ ...PRESET_MARKETS[0], enabled: false }, ...PRESET_MARKETS.slice(1)] })
    expect(settings.marketRefs['price.baseMarket']).toMatchObject({ ref: 'Jita 4-4', key: '' })
    // 预置的其他 NPC 市场都写了「不列」，这时默认查价是空的，要报告
    expect(settings.markets.every((m) => !m.inDefaultList)).toBe(true)
    expect(lines).toEqual(['市场：没有任何公开市场列入默认查价：没有授权的群不写市场时查不到价格'])
  })

  it('the hidden industry group stays quiet until it is configured', () => {
    // 0.1.0 的控制台里还没有「工业」分组：Jita 改了名也不应该报工业的问题
    const quiet = run({ markets: [{ name: 'Jita', location: '60003760' }], price: { baseMarket: 'Jita' }, appraisal: { defaultMarket: 'Jita' } })
    expect(quiet.lines).toEqual([])
    expect(quiet.settings.marketRefs['industry.materialMarket']).toMatchObject({ ref: 'Jita 4-4', key: '', quiet: true })
    expect(quiet.settings.marketRefs['appraisal.defaultMarket'].quiet).toBeUndefined()
    const loud = run({ markets: [{ name: 'Jita', location: '60003760' }], industry: { materialMarket: 'jita' } })
    expect(loud.settings.marketRefs['industry.materialMarket']).toEqual({
      section: 'industry', field: 'materialMarket', label: '材料市场', ref: 'jita', whenEmpty: 'base', key: 'jita',
    })
    expect(loud.settings.marketRefs['industry.productMarket'].quiet).toBeUndefined()
  })
})

describe('normalizeConfig: access', () => {
  it('cleans admin IDs', () => {
    const { settings, lines } = run({ access: { admins: [' qq:ABCDEF0123 ', 'ABCDEF0123', 'QQ:FEDCBA', 'sandbox:tester', '', 'has space', 42] } })
    expect(settings.access.admins).toEqual(['ABCDEF0123', 'FEDCBA', 'sandbox:tester', '42'])
    expect(lines).toEqual(['权限：管理员「has space」里有空格，已跳过'])
    expect(run({ access: { admins: 'qq:A1, B2，C3' } }).settings.access.admins).toEqual(['A1', 'B2', 'C3'])
  })

  it('allowed groups and users skip bad rows', () => {
    const { settings, lines } = run({
      access: {
        allowedGroups: [
          { groupId: 'GROUP0001', note: '测试群', enabled: true },
          { groupId: '', note: '', enabled: true },
          { groupId: 'qq:GROUP0002' },
          { groupId: 'GROUP0003', enabled: false },
          { groupId: 'GROUP 4' },
          { groupId: 'GROUP0001' },
          { [INVALID_ROW_KEY]: true },
        ],
        allowedUsers: [{ userId: 'USER0001' }, { userId: '  ' }],
      },
    })
    expect(settings.access.allowedGroups).toEqual(['GROUP0001', 'GROUP0002'])
    expect(settings.access.allowedUsers).toEqual(['USER0001'])
    expect(lines).toEqual([
      '授权群第 2 行「群 ID」为空，已跳过',
      '授权群第 5 行「群 ID」里有空格，已跳过',
      '授权群第 7 行有写错的字段（例如类型、启用写成了别的值），已跳过',
      '授权私聊用户第 2 行「用户 ID」为空，已跳过',
    ])
  })
})

describe('normalizeConfig: display', () => {
  it('clamps decimals and reports unknown choices', () => {
    const { settings, lines } = run({ display: { compactDecimals: 9, output: 'html', numberStyle: 'bold', clickable: 'none', showCurrency: false } })
    expect(settings.display).toMatchObject({ compactDecimals: 4, output: 'markdown', numberStyle: 'bold', clickable: 'none', showCurrency: false })
    expect(lines).toEqual([
      '显示：「输出方式」写的「html」不认识，已改用默认值',
      '显示：「简写的小数位数」应该在 0–4 之间，已按 4 处理',
    ])
    expect(run({ display: { compactDecimals: 1.6 } }).settings.display.compactDecimals).toBe(2)
    expect(run({ display: { compactDecimals: 'x' } }).lines).toEqual(['显示：「简写的小数位数」不是数字，已改用默认值 2'])
  })
})

describe('normalizeConfig: item aliases and default quantities', () => {
  it('item aliases', () => {
    const { settings, lines } = run({
      aliases: [
        { alias: '大鸟', target: 'Raven', enabled: true },
        { alias: ' 大 鸟 ', target: '乌鸦级' },
        { alias: '海万王', target: '' },
        { alias: '', target: 'Raven' },
        { alias: '乌鸦', target: '#638', enabled: false },
        { alias: 'BS', target: '638' },
      ],
    })
    expect(settings.aliases).toEqual([{ row: 1, alias: '大鸟', target: 'Raven' }, { row: 6, alias: 'BS', target: '638' }])
    expect(lines).toEqual([
      '物品别名第 2 行别名「大 鸟」和第 1 行重复，已跳过',
      '物品别名第 3 行别名「海万王」没有写目标物品，已跳过',
      '物品别名第 4 行「别名」为空，已跳过',
    ])
  })

  it('default quantities', () => {
    const { settings, lines } = run({
      price: {
        defaultQuantities: [
          { item: 'PLEX', quantity: 500 },
          { item: 'plex', quantity: 100 },
          { item: '三钛合金', quantity: 0 },
          { item: '类晶体胶矿', quantity: 1.5 },
          { item: '同位聚合体', quantity: 1e13 },
          { item: '', quantity: 3 },
          { item: '超新星诺克石', quantity: '1000' },
        ],
      },
    })
    expect(settings.price.defaultQuantities).toEqual([{ row: 1, item: 'PLEX', quantity: 500 }, { row: 7, item: '超新星诺克石', quantity: 1000 }])
    expect(lines).toEqual([
      '默认数量第 2 行plex 和第 1 行重复，已跳过',
      '默认数量第 3 行三钛合金 的数量要是 1 到 10¹² 之间的整数，已跳过',
      '默认数量第 4 行类晶体胶矿 的数量要是 1 到 10¹² 之间的整数，已跳过',
      '默认数量第 5 行同位聚合体 的数量要是 1 到 10¹² 之间的整数，已跳过',
      '默认数量第 6 行「物品」为空，已跳过',
    ])
    expect(run({ price: { defaultQuantities: [] } }).settings.price.defaultQuantities).toEqual([])
  })
})

describe('normalizeConfig: freight and notices', () => {
  it('freight routes', () => {
    const { settings, lines } = run({
      freight: {
        routes: [
          { name: '联盟市场A', iskPerM3: 800, collateralPct: 1, maxVolume: 350000, visibility: 'allowed', enabled: true },
          { name: '联盟市场B', iskPerM3: -5, collateralPct: 150 },
          { name: '联盟市场a', iskPerM3: 1 },
          { name: '公开路线', visibility: 'public', enabled: true },
          { name: '停用', enabled: false },
        ],
      },
    })
    expect(settings.freight.routes).toEqual([
      { row: 1, name: '联盟市场A', iskPerM3: 800, collateralPct: 1, maxVolume: 350000, visibility: 'allowed' },
      { row: 2, name: '联盟市场B', iskPerM3: 0, collateralPct: 100, maxVolume: 0, visibility: 'allowed' },
      { row: 4, name: '公开路线', iskPerM3: 0, collateralPct: 0, maxVolume: 0, visibility: 'public' },
    ])
    expect(lines).toEqual([
      '运费第 2 行「ISK/m³」应该在 0–1000000000 之间，已按 0 处理',
      '运费第 2 行「押金费率」应该在 0–100 之间，已按 100 处理',
      '运费第 3 行「名称」联盟市场a 和第 1 行重复，已跳过',
    ])
  })

  it('notices: length, URLs, deadline and visibility', () => {
    const long = '告'.repeat(81)
    const { settings, lines } = run({
      notices: {
        list: [
          { text: '矿石收购按 Jita 收购价 92%，\n详见群公告', visibility: 'allowed', until: '2026-12-31 23:59', enabled: true },
          { text: '所有群都能看到', visibility: 'all', until: '' },
          { text: long },
          { text: '详见 example.com/notice' },
          { text: '看这里 https://x.y' },
          { text: '截止时间写错', until: '明天' },
          { text: '', enabled: true },
          { text: '停用的', enabled: false },
          { text: '只写日期', until: '2026/10/8' },
        ],
      },
    })
    expect(settings.notices.list).toEqual([
      { row: 1, text: '矿石收购按 Jita 收购价 92%， 详见群公告', visibility: 'allowed', until: Date.UTC(2026, 11, 31, 15, 59) },
      { row: 2, text: '所有群都能看到', visibility: 'all', until: null },
      { row: 9, text: '只写日期', visibility: 'allowed', until: Date.UTC(2026, 9, 8, 15, 59) },
    ])
    expect(lines).toEqual([
      '查价告示第 3 行「内容」超过 80 字，已跳过',
      '查价告示第 4 行「内容」里有网址（QQ 群里不允许发网址），已跳过',
      '查价告示第 5 行「内容」里有网址（QQ 群里不允许发网址），已跳过',
      '查价告示第 6 行「截止时间」明天 看不懂（应该写成 2026-12-31 23:59），已跳过',
      '查价告示第 7 行「内容」为空，已跳过',
    ])
    expect(run({ notices: { list: [{ text: '告'.repeat(80) }] } }).settings.notices.list).toHaveLength(1)
  })
})

describe('normalizeConfig: sso, render, advanced', () => {
  it('callback URL', () => {
    expect(run({ sso: { callbackUrl: 'http://localhost:12345/eve-market/sso/callback' } }).settings.sso.callbackUrl).toBe('http://localhost:12345/eve-market/sso/callback')
    const wrongPath = run({ sso: { callbackUrl: 'http://127.0.0.1:12345/callback' } })
    expect(wrongPath.settings.sso.callbackUrl).toBe('http://127.0.0.1:12345/callback')
    expect(wrongPath.lines).toEqual(['EVE 授权：「回调地址」的路径应该是 /eve-market/sso/callback，现在写的地址授权后回不到插件'])
    const notUrl = run({ sso: { callbackUrl: '127.0.0.1:5140' } })
    expect(notUrl.settings.sso.callbackUrl).toBe('http://127.0.0.1:5140/eve-market/sso/callback')
    expect(notUrl.lines).toHaveLength(1)
    expect(run({ sso: { callbackUrl: '' } }).settings.sso.callbackUrl).toBe('http://127.0.0.1:5140/eve-market/sso/callback')
  })

  it('Client ID and Secret Key go together', () => {
    expect(run({ sso: { clientSecret: 'fake-secret' } }).lines).toEqual(['EVE 授权：填了 Secret Key，但还没填 Client ID'])
    expect(run({ sso: { clientId: ' fake-client-id ', clientSecret: ' fake-secret\n' } }).settings.sso).toMatchObject({ clientId: 'fake-client-id', clientSecret: 'fake-secret' })
  })

  it('map URLs', () => {
    const { settings, lines } = run({ render: { influenceMapUrl: 'ftp://x', coalitionMapUrl: '', brAuto: false } })
    expect(settings.render).toEqual({ influenceMapUrl: 'https://www.verite.space/maps/influence/influence.png', coalitionMapUrl: '', brAuto: false })
    expect(lines).toEqual(['图片与截图：「势力图地址」不是 http:// 或 https:// 开头的网址，已改用默认地址'])
  })

  it('URL lists and the ESI contact', () => {
    const { settings, lines } = run({
      advanced: { manifestUrl: 'https://a.example/m.json ||not a url|| https://a.example/m.json', glossaryUrl: '', esiContact: '角色 Fake Pilot\n<fake@example.com>' },
    })
    expect(settings.advanced).toEqual({ manifestUrls: ['https://a.example/m.json'], glossaryUrls: [], esiContact: 'Fake Pilot <fake@example.com>' })
    expect(lines).toEqual([
      '高级：「ESI 联系方式」只能用英文字母、数字和常见符号，其他字符已去掉',
      '高级：「物品数据网址」里的「not a url」不是 http:// 或 https:// 开头的网址，已忽略',
    ])
    expect(run({ advanced: { esiContact: 'x'.repeat(300) } }).settings.advanced.esiContact).toHaveLength(100)
  })
})

describe('normalizeConfig: industry (0.2.0)', () => {
  const industry = {
    materialMarket: 'Jita 4-4',
    meTeChoices: '10/20, 5/10，2/4, 11/20, abc',
    sccSurchargePct: 4,
    npcFacilityTaxPct: 0.25,
    sellFeesPct: 120,
    locations: [
      { name: 'XX-1', aliases: 'X1, 高级', system: 'XX-1', visibility: 'allowed', isDefault: true, defaultME: 10, defaultTE: 20 },
      { name: 'YY-2', aliases: 'x1', system: '30000002', isDefault: true, defaultME: 12, defaultTE: -1 },
      { name: '没星系', system: '' },
      { name: 'xx-1', system: 'XX-1' },
      { name: '材料', system: 'XX-1' },
    ],
    structures: [
      { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', structureId: '1000000000011', activities: 'manufacturing', rigs: '屹立超大型舰船制造效率 I, 37180', facilityTaxPct: 1, isDefault: true },
      { location: 'xx-1', name: '反应塔', structureType: 'Tatara', activities: 'both', isDefault: true },
      { location: 'XX-1', name: '大厂', structureType: 'Azbel' },
      { location: '不存在', name: '某建筑', structureType: 'Raitaru' },
      { location: 'YY-2', name: '空站', structureType: '无', structureId: 'abc', extraFeePct: 1, extraFeeIsk: 1000000, extraFeeLabel: '' },
    ],
  }

  it('a non-numeric reprocessing tax says only that it is not a number, not also that it is blank', () => {
    const { lines } = run({ industry: {
      locations: [{ name: 'XX-1', system: 'NIH-02' }],
      structures: [{ location: 'XX-1', name: '炼厂', structureType: 'Athanor', activities: 'reprocessing', reprocessingTaxPct: 'abc' }],
    } })
    expect(lines).toEqual(['工业建筑第 1 行「提炼税」不是数字，已改用默认值 0'])
  })

  it('parses locations and structures and keeps one default of each', () => {
    const { settings, lines } = run({ industry })
    const ind = settings.industry
    expect(ind.meTeChoices).toEqual([{ me: 10, te: 20 }, { me: 5, te: 10 }, { me: 2, te: 4 }])
    expect(ind.sellFeesPct).toBe(100)
    expect(ind.locations.map((l) => [l.name, l.aliases, l.isDefault, l.defaultME, l.defaultTE, l.visibility])).toEqual([
      ['XX-1', ['X1'], true, 10, 20, 'allowed'],
      ['YY-2', [], false, 10, 0, 'allowed'],
    ])
    expect(ind.structures.map((s) => [s.location, s.name, s.structureType, s.structureId, s.activities, s.rigs, s.isDefault, s.extraFeeLabel])).toEqual([
      ['XX-1', '大厂', 'Sotiyo', '1000000000011', ['manufacturing'], ['屹立超大型舰船制造效率 I', '37180'], true, '其他费用'],
      ['XX-1', '反应塔', 'Tatara', '', ['manufacturing', 'reaction'], [], false, '其他费用'],
      ['YY-2', '空站', '', '', ['manufacturing'], [], false, '其他费用'],
    ])
    expect(lines).toEqual([
      '工业：「ME/TE 选项」里的 11/20、abc 看不懂（应该写成 10/20），已忽略',
      '工业地点第 2 行「默认 ME」应该在 0–10 之间，已按 10 处理',
      '工业地点第 2 行「默认 TE」应该在 0–20 之间，已按 0 处理',
      '工业地点第 3 行没星系 没有填星系，已跳过',
      '工业地点第 4 行「名称」xx-1 和第 1 行重复，已跳过',
      '工业地点第 5 行「名称」材料 和命令的参数冲突，已跳过',
      '工业地点第 1 行别名「高级」和命令的参数冲突，这一行的不生效',
      '工业地点第 2 行别名「x1」和第 1 行冲突，这一行的不生效',
      '工业 · 工业地点：勾了多个默认地点，只有第一个（XX-1）生效',
      '工业建筑第 3 行XX-1 已经有一座叫「大厂」的建筑，已跳过',
      '工业建筑第 4 行地点「不存在」不在工业地点表里，已跳过',
      '工业建筑第 5 行「建筑 ID」不是数字，已忽略',
      '工业 · 工业建筑：XX-1 勾了多座默认建筑，只有第一座（大厂）生效',
      '工业：「销售税和经纪费」应该在 0–100 之间，已按 100 处理',
    ])
  })

  it('falls back to the default ME/TE choices when nothing is usable', () => {
    expect(run({ industry: { meTeChoices: 'x' } }).settings.industry.meTeChoices).toEqual([{ me: 10, te: 20 }, { me: 5, te: 10 }, { me: 0, te: 0 }])
  })
})

describe('helpers', () => {
  it('formatIssue', () => {
    expect(formatIssue({ section: 'markets', row: 6, message: '「位置」不是数字，已跳过' })).toBe('市场第 6 行「位置」不是数字，已跳过')
    expect(formatIssue({ section: 'access', table: '授权群', row: 2, message: 'x' })).toBe('授权群第 2 行x')
    expect(formatIssue({ section: 'price', message: 'x' })).toBe('查价：x')
    expect(formatIssue({ section: 'industry', table: '工业建筑', message: 'x' })).toBe('工业 · 工业建筑：x')
  })

  it('nameKey', () => {
    expect(nameKey('  ＪＩＴＡ　 4－4 ')).toBe('jita 4-4')
    expect(nameKey('Jita 4—4')).toBe('jita 4-4')
  })

  it('containsUrl', () => {
    for (const yes of ['https://x', 'www.example', '详见 verite.space', 'br.evetools.org/br/1', 'Example.COM']) expect(containsUrl(yes)).toBe(true)
    for (const no of ['XX-1 矿石收购按 Jita 收购价 92%', '1.5m', '下午3.30', 'e.g. 例子', 'No.1', 'v1.2']) expect(containsUrl(no)).toBe(false)
  })

  it('parseBeijingTime', () => {
    expect(parseBeijingTime('2026-12-31 23:59')).toBe(Date.UTC(2026, 11, 31, 15, 59))
    expect(parseBeijingTime('２０２６-01-01 00:00')).toBe(Date.UTC(2025, 11, 31, 16, 0))
    expect(parseBeijingTime('2026-1-2')).toBe(Date.UTC(2026, 0, 2, 15, 59))
    for (const bad of ['2026-02-30', '2026-13-01', '2026-01-01 24:00', '明天', '']) expect(parseBeijingTime(bad)).toBeUndefined()
  })

  it('parseMeTeChoices', () => {
    expect(parseMeTeChoices('10/20; 10/20、0 / 0')).toEqual({ choices: [{ me: 10, te: 20 }, { me: 0, te: 0 }], bad: [] })
    expect(parseMeTeChoices('10/21, 1/2/3').bad).toEqual(['10/21', '1/2/3'])
  })
})

describe('normalizeConfig: screenshot', () => {
  const ids = (raw: unknown) => run(raw).settings.screenshot.sites.map((x) => x.id)
  const custom = (...rows: unknown[]) => ({ screenshot: { custom: rows } })
  const row = (extra: Record<string, unknown> = {}) => ({ name: '示例站', host: 'kb.example.com', ...extra })

  it('defaults: four built-in sites on, auto on, 2/2/2/1 images, no issues', () => {
    for (const raw of [{}, Config({} as any)]) {
      const { settings, issues } = run(raw)
      expect(issues).toEqual([])
      expect(settings.screenshot.sites.map((x) => [x.id, x.host, x.builtin, x.auto, x.maxImages])).toEqual([
        ['br', 'br.evetools.org', true, true, 2],
        ['warbeacon', 'warbeacon.net', true, true, 2],
        ['janice', 'janice.e-351.com', true, true, 2],
        ['dotlan', 'evemaps.dotlan.net', true, true, 1],
      ])
      expect(settings.render.brAuto).toBe(true)
    }
  })

  it('max wait: defaults 60 / Warbeacon 120 / custom 60; old configs without the field are quiet', () => {
    const { settings, issues } = run(custom(row()))
    expect(issues).toEqual([])
    expect(settings.screenshot.sites.map((x) => [x.id, x.maxWaitSec])).toEqual([
      ['br', 60], ['warbeacon', 120], ['janice', 60], ['dotlan', 60], ['custom-1', 60],
    ])
  })

  it('max wait: set values are kept, out-of-range ones are clamped to 30-180 with a note, non-numbers fall back', () => {
    const { settings, issues } = run({
      screenshot: { warbeacon: { maxWaitSec: 150 }, br: { maxWaitSec: 5 }, janice: { maxWaitSec: 600 }, dotlan: { maxWaitSec: 'abc' }, custom: [row({ maxWaitSec: 200 })] },
    })
    expect(settings.screenshot.sites.map((x) => x.maxWaitSec)).toEqual([30, 150, 180, 60, 180])
    expect(issues.length).toBe(4)
    expect(run({ screenshot: { janice: { maxWaitSec: 600 } } }).lines.join('\n')).toContain('最长等待')
  })

  it('a missing screenshot group (old config) is quiet', () => {
    const { settings, issues } = run({ render: { brAuto: true } })
    expect(issues).toEqual([])
    expect(settings.screenshot.sites).toHaveLength(4)
  })

  it('legacy render.brAuto=false without a screenshot group stays quiet', () => {
    const { settings, issues } = run({ render: { brAuto: false } })
    expect(settings.render.brAuto).toBe(false)
    expect(issues).toEqual([])
  })

  it('legacy render.brAuto=false stops BR auto and reports once', () => {
    const { settings, lines } = run({ render: { brAuto: false }, screenshot: {} })
    expect(settings.render.brAuto).toBe(false)
    expect(settings.screenshot.sites.find((x) => x.id === 'br')?.auto).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('图片与截图')
    expect(lines[0]).toContain('旧设置')
  })

  it('screenshot.br.auto=false stops BR auto without a problem; a disabled BR too', () => {
    const a = run({ screenshot: { br: { auto: false } } })
    expect(a.settings.render.brAuto).toBe(false)
    expect(a.issues).toEqual([])
    const b = run({ screenshot: { br: { enabled: false } } })
    expect(b.settings.render.brAuto).toBe(false)
    expect(ids({ screenshot: { br: { enabled: false } } })).toEqual(['warbeacon', 'janice', 'dotlan'])
  })

  it('killAuto defaults to on, follows the switch, and a non-boolean falls back to on', () => {
    expect(run({}).settings.screenshot.killAuto).toBe(true)
    expect(run(Config({} as any)).settings.screenshot.killAuto).toBe(true)
    expect(run({ screenshot: { killAuto: false } }).settings.screenshot.killAuto).toBe(false)
    expect(run({ screenshot: { killAuto: 'x' } }).settings.screenshot.killAuto).toBe(true)
    // 和各网站的开关互不影响
    const { settings } = run({ screenshot: { killAuto: false, br: { enabled: false } } })
    expect(settings.screenshot.killAuto).toBe(false)
    expect(settings.screenshot.sites.map((x) => x.id)).toEqual(['warbeacon', 'janice', 'dotlan'])
  })

  it('disabled sites drop out; auto is kept per site', () => {
    const { settings } = run({ screenshot: { janice: { enabled: false }, dotlan: { auto: false } } })
    expect(settings.screenshot.sites.map((x) => [x.id, x.auto])).toEqual([['br', true], ['warbeacon', true], ['dotlan', false]])
  })

  it('maxImages is clamped to 1-3 and reported', () => {
    const { settings, lines } = run({ screenshot: { br: { maxImages: 9 }, janice: { maxImages: 0 }, dotlan: { maxImages: 2.4 }, warbeacon: { maxImages: 'x' } } })
    const by = (id: string) => settings.screenshot.sites.find((x) => x.id === id)?.maxImages
    expect([by('br'), by('janice'), by('dotlan'), by('warbeacon')]).toEqual([3, 1, 2, 2])
    expect(lines.filter((l) => l.startsWith('截图'))).toHaveLength(3)
  })

  it('custom rows: valid row, host cleaned, prefix gets a leading slash', () => {
    const { settings, lines } = run(custom(
      row({ host: 'HTTPS://KB.Example.com/kill/1?x=1', pathPrefix: ' kill/ ', auto: false, maxImages: 3 }),
      row({ name: '另一个', host: 'other.example.org' }),
    ))
    const sites = settings.screenshot.sites.filter((x) => !x.builtin)
    expect(sites).toEqual([
      { id: 'custom-1', name: '示例站', builtin: false, host: 'kb.example.com', pathPrefix: '/kill/', auto: false, maxImages: 3, maxWaitSec: 60, row: 1 },
      { id: 'custom-2', name: '另一个', builtin: false, host: 'other.example.org', pathPrefix: '', auto: true, maxImages: 1, maxWaitSec: 60, row: 2 },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('已只取域名')
  })

  it('custom rows: bad rows are skipped with a row number', () => {
    const bad: Array<[unknown, string]> = [
      [{ [INVALID_ROW_KEY]: true }, '有写错的字段'],
      [row({ name: '' }), '「名称」为空'],
      [row({ name: 'kb.example.com' }), '网址'],
      [row({ name: 'https://x' }), '网址'],
      [row({ host: '' }), '「域名」'],
      [row({ host: '127.0.0.1' }), 'IP'],
      [row({ host: 'localhost' }), '本机'],
      [row({ host: 'intranet' }), '「域名」'],
      [row({ host: 'x.local' }), '内网'],
      [row({ host: 'b.com:8443' }), '端口'],
      [row({ host: 'a@b.com' }), '用户名'],
      [row({ host: 'zkillboard.com' }), 'zKillboard'],
      [row({ host: 'br.evetools.org' }), '内置'],
      [row({ host: 'sub.warbeacon.net' }), '内置'],
      [row({ pathPrefix: '/a b' }), '「网址开头」'],
      [row({ pathPrefix: '/a?x=1' }), '「网址开头」'],
      [row({ pathPrefix: '/a#x' }), '「网址开头」'],
      [row({ pathPrefix: '/a/../b' }), '「网址开头」'],
      [row({ pathPrefix: `/${'a'.repeat(100)}` }), '「网址开头」'],
    ]
    for (const [r, word] of bad) {
      const { settings, lines } = run(custom(r))
      expect(settings.screenshot.sites.filter((x) => !x.builtin), JSON.stringify(r)).toEqual([])
      expect(lines.filter((l) => l.startsWith('自定义网站第 1 行')), JSON.stringify(r)).toHaveLength(1)
      expect(lines.join('\n')).toContain(word)
    }
  })

  it('custom rows: duplicates, over 10 rows, a table that is not an array', () => {
    const dup = run(custom(row(), row({ name: '又一个', host: 'KB.example.com' }), row({ pathPrefix: '/kill' })))
    expect(dup.settings.screenshot.sites.filter((x) => !x.builtin).map((x) => x.row)).toEqual([1, 3])
    expect(dup.lines).toHaveLength(1)
    expect(dup.lines[0]).toContain('自定义网站第 2 行')
    const many = Array.from({ length: 12 }, (_, i) => row({ name: `站${i}`, host: `s${i}.example.com` }))
    const over = run(custom(...many))
    expect(over.settings.screenshot.sites.filter((x) => !x.builtin)).toHaveLength(10)
    expect(over.lines).toHaveLength(2)
    expect(over.lines[0]).toContain('第 11 行')
    const notArray = run({ screenshot: { custom: 'x' } })
    expect(notArray.settings.screenshot.sites).toHaveLength(4)
    expect(notArray.lines).toHaveLength(1)
  })

  it('built-in sites come before custom rows, in a fixed order', () => {
    expect(ids(custom(row()))).toEqual(['br', 'warbeacon', 'janice', 'dotlan', 'custom-1'])
  })
})

describe('janice settings', () => {
  const KEY = 'test-janice-key-0000'

  it('defaults to no key and who = allowed', () => {
    expect(run({}).settings.janice).toEqual({ apiKey: '', who: 'allowed' })
  })

  it('keeps the key, trimmed, and a known who', () => {
    expect(run({ janice: { apiKey: `  ${KEY}\n`, who: 'admins' } }).settings.janice).toEqual({ apiKey: KEY, who: 'admins' })
    expect(run({ janice: { who: 'all' } }).settings.janice.who).toBe('all')
    expect(run({ janice: { who: 'everyone' } }).settings.janice.who).toBe('allowed')
  })

  it('drops characters a header cannot carry, and no message contains the key', () => {
    const { settings, issues } = run({ janice: { apiKey: `${KEY}中文 x` } })
    expect(settings.janice.apiKey).toBe(`${KEY}x`)
    expect(issues.filter((i) => i.section === 'janice')).toHaveLength(1)
    expect(JSON.stringify(issues)).not.toContain(KEY)
  })

  it('a non-string key is off', () => {
    expect(run({ janice: { apiKey: 12345 } }).settings.janice.apiKey).toBe('')
  })
})

describe('kb settings', () => {
  const row = (characterId: unknown, extra: Record<string, unknown> = {}) => ({ characterId, note: '', enabled: true, ...extra })

  it('defaults: everyone, recent and auto on, nobody hidden', () => {
    const { settings, issues } = run({})
    expect(settings.kb).toEqual({ scope: 'all', recent: true, auto: true, tone: 'mixed', hidden: [] })
    expect(issues).toEqual([])
  })

  it('keeps known scopes and switches', () => {
    expect(run({ kb: { scope: 'allowed', recent: false, auto: false } }).settings.kb).toMatchObject({ scope: 'allowed', recent: false, auto: false })
    expect(run({ kb: { scope: 'off' } }).settings.kb.scope).toBe('off')
    const bad = run({ kb: { scope: 'nobody' } })
    expect(bad.settings.kb.scope).toBe('all')
    expect(bad.issues.filter((i) => i.section === 'kb')).toHaveLength(1)
  })

  it('tone: snarky / gentle / mixed, default mixed, bad values fall back with an issue', () => {
    for (const tone of ['snarky', 'gentle', 'mixed']) expect(run({ kb: { tone } }).settings.kb.tone).toBe(tone)
    const bad = run({ kb: { tone: 'spicy' } })
    expect(bad.settings.kb.tone).toBe('mixed')
    expect(bad.issues.filter((i) => i.section === 'kb')).toHaveLength(1)
    expect(run({}).settings.kb.tone).toBe('mixed')
  })

  it('hidden rows: digits only, enabled only, duplicates merged', () => {
    const { settings, lines } = run({ kb: { hidden: [row('2119876543'), row(' 2112345678 '), row('2119876543'), row('2100000001', { enabled: false })] } })
    expect(settings.kb.hidden).toEqual([2119876543, 2112345678])
    expect(lines).toEqual([])
  })

  it('a hidden id that is not plain digits is a config issue and skipped', () => {
    const { settings, issues, lines } = run({ kb: { hidden: [row('Hanako Kisaragi'), row('21198x'), row(''), row('0'), row('12345678901'), row('2119876543')] } })
    expect(settings.kb.hidden).toEqual([2119876543])
    expect(issues.filter((i) => i.section === 'kb').map((i) => i.row)).toEqual([1, 2, 3, 4, 5])
    expect(lines[0]).toContain('不显示的人物第 1 行')
  })

  it('a broken row only costs that row', () => {
    const { settings, issues } = run({ kb: { hidden: [{ [INVALID_ROW_KEY]: true }, row('2119876543')] } })
    expect(settings.kb.hidden).toEqual([2119876543])
    expect(issues.filter((i) => i.section === 'kb')).toHaveLength(1)
  })
})
