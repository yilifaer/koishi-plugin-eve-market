// 认不出唯一物品时的卡片（§2.0.4、§2.2.6、§2.2.7）和按钮里的物品写法。

import { describe, expect, it } from 'vitest'
import { itemArgs, itemTitle } from '../../../src/bot/commands/names'
import {
  candidatesCard, notFoundCard, notTradableText, setsCard, unknownMarketCard,
} from '../../../src/bot/commands/resolution'
import type { ChoiceOptions } from '../../../src/bot/commands/resolution'
import { PRESET_MARKETS } from '../../../src/config/presets'
import type { ItemInfo } from '../../../src/core/types'
import { ALLIANCE_ROW, ALLOWED, PUBLIC, buttons, item, md, renderOptions, testCore, text } from './helpers'

const core = testCore({ markets: [...PRESET_MARKETS, ALLIANCE_ROW], access: { allowedGroups: [{ groupId: 'g-allowed', enabled: true }] } })

function options(extra: Partial<ChoiceOptions> = {}): ChoiceOptions {
  return {
    query: '护盾扩展装置 II',
    command: (it: ItemInfo) => ({ id: 'price', args: `Jita ${core.items.commandName(it)}*4` }),
    search: { id: 'search', args: '护盾扩展装置 II' },
    searchName: '搜索',
    ...extra,
  }
}

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...item('Large Shield Extender II'), typeId: 800_000 + i, zh: `护盾 ${i + 1}`, en: `Shield ${i + 1}` }))

describe('candidatesCard', () => {
  it('lists the names in the text and puts only the numbers on the buttons, keeping market and quantity (§2.2.6)', () => {
    const res = core.items.resolve('护盾扩展装置 II', { scope: 'market' })
    if (res.kind !== 'ambiguous' && res.kind !== 'confirm') throw new Error(`unexpected ${res.kind}`)
    const card = candidatesCard(core, res, options())
    expect(md(card)).toBe([
      '**「护盾扩展装置 II」可能是以下物品，请选择：**',
      '1. 小型护盾扩展装置 II · Small Shield Extender II\n2. 中型护盾扩展装置 II · Medium Shield Extender II\n3. 大型护盾扩展装置 II · Large Shield Extender II\n\n点下面的编号，或者 @我 回复编号（5 分钟内有效）',
    ].join('\n\n'))
    expect(buttons(card)).toEqual([['1=>查价 Jita 小型护盾扩展装置 II*4', '2=>查价 Jita 中型护盾扩展装置 II*4', '3=>查价 Jita 大型护盾扩展装置 II*4']])
  })

  it('more than 8: the first 8 and how to see the rest', () => {
    const card = candidatesCard(core, { kind: 'ambiguous', tier: 'exact', candidates: many(8), total: 22 }, options())
    expect(card.choices).toHaveLength(8)
    expect(card.meta).toEqual(['还有 14 个，发送「搜索 护盾扩展装置 II」看全部'])
    // 新物品（索引里没有）按英文名写命令
    expect(buttons(card)).toEqual([
      ['1=>查价 Jita Shield 1*4', '2=>查价 Jita Shield 2*4', '3=>查价 Jita Shield 3*4', '4=>查价 Jita Shield 4*4', '5=>查价 Jita Shield 5*4'],
      ['6=>查价 Jita Shield 6*4', '7=>查价 Jita Shield 7*4', '8=>查价 Jita Shield 8*4'],
      ['全部结果=>搜索 护盾扩展装置 II'],
    ])
  })

  it('more than 50: says so with 5 examples', () => {
    const card = candidatesCard(core, { kind: 'confirm', tier: 'contains', candidates: many(8), total: 63 }, options({ query: '护盾' }))
    expect(card.title).toBe('**「护盾」匹配太多（63 个），例如：**')
    expect(card.choices).toHaveLength(5)
    expect(card.meta).toEqual(['还有 58 个，发送「搜索 护盾扩展装置 II」看全部'])
  })

  it('slang group names list the group, never pick one', () => {
    const card = candidatesCard(core, { kind: 'group', groupName: '无畏', candidates: [item('Revelation'), item('Naglfar')], total: 2 }, options({ query: '无畏' }))
    expect(card.title).toBe('**「无畏」包括以下物品，请选择：**')
    expect(card.choices?.map((c) => c.label)).toEqual(['神示级', '纳迦法级'])
  })

  it('items with the same name are told apart by category', () => {
    const card = candidatesCard(core, { kind: 'ambiguous', tier: 'exact', candidates: [item('Absolution'), item('Salvation')], total: 2 }, options({ query: '救赎级' }))
    expect(card.choices?.map((c) => c.detail)).toEqual(['Absolution · 舰船', 'Salvation · 舰船'])
  })

  it('without a search command the hint does not mention it', () => {
    const card = candidatesCard(core, { kind: 'ambiguous', tier: 'exact', candidates: many(8), total: 9 }, options({ search: undefined, searchName: undefined }))
    expect(card.meta).toEqual(['还有 1 个，请把名字写完整一点'])
    expect(card.actions).toEqual([])
  })

  it('in plain text every choice says how to reply', () => {
    const card = candidatesCard(core, { kind: 'ambiguous', tier: 'exact', candidates: [item('Raven'), item('Raven Navy Issue')], total: 2 }, options({ query: '乌鸦' }))
    expect(text(card)).toBe([
      '「乌鸦」可能是以下物品，请选择：',
      '回复 @我 1：乌鸦级 · Raven',
      '回复 @我 2：乌鸦级海军型 · Raven Navy Issue',
      '编号 5 分钟内有效，也可以直接发送「查价 Jita 乌鸦级*4」',
    ].join('\n'))
  })
})

describe('notFoundCard', () => {
  it('offers up to 3 suggestions and other ways to ask', () => {
    const card = notFoundCard(core, [item('Raven'), item('Raven Navy Issue')], options({ query: '乌鸦机', search: { id: 'search', args: '乌鸦机' } }))
    expect(md(card)).toBe([
      '没有找到「乌鸦机」对应的物品。\n也可以换成英文名、完整的中文名，或者发送「搜索 乌鸦机」。',
      '你是不是要找：',
      '1. 乌鸦级 · Raven\n2. 乌鸦级海军型 · Raven Navy Issue\n\n点下面的编号，或者 @我 回复编号（5 分钟内有效）',
    ].join('\n\n'))
  })

  it('without suggestions only the first and the last sentence', () => {
    const card = notFoundCard(core, [], options({ query: 'zzzz', search: { id: 'search', args: 'zzzz' } }))
    expect(md(card)).toBe('没有找到「zzzz」对应的物品。\n也可以换成英文名、完整的中文名，或者发送「搜索 zzzz」。')
  })

  it('echoes user text safely', () => {
    const card = notFoundCard(core, [], options({ query: '**看 example.com 这个**', search: undefined, searchName: undefined }))
    expect(card.title).toBe('没有找到「\\*\\*看 \\[链接\\] 这个\\*\\*」对应的物品。')
    expect(text(card)).toBe('没有找到「**看 [链接] 这个**」对应的物品。\n也可以换成英文名、完整的中文名。')
  })
})

describe('other resolution cards', () => {
  it('a set name without grade lists the grades', () => {
    const res = core.items.resolve('水晶', { scope: 'market' })
    if (res.kind !== 'sets') throw new Error(`unexpected ${res.kind}`)
    const card = setsCard(res.sets, '水晶', (set) => ({ id: 'price', args: `${set.name.zh}套装` }))
    expect(card.choices?.map((c) => `${c.label} · ${c.detail}`)).toEqual(['高级水晶套装 · High-grade Crystal', '中级水晶套装 · Mid-grade Crystal', '低级水晶套装 · Low-grade Crystal'])
  })

  it('unknown market: the same sentence for hidden and non-existent markets, buttons keep the item', () => {
    const command = (m: { shortAlias: string }) => ({ id: 'price' as const, args: `${m.shortAlias} 乌鸦级` })
    const hidden = unknownMarketCard(core, { ok: false, code: 'UNKNOWN_MARKET', token: '前线' }, PUBLIC, command)
    const fake = unknownMarketCard(core, { ok: false, code: 'UNKNOWN_MARKET', token: 'TEST' }, PUBLIC, command)
    expect(md(hidden).replace('前线', 'TEST')).toBe(md(fake))
    expect(md(fake)).toBe('未知市场：TEST\n\n当前可用市场：Jita 4-4 · Amarr · Dodixie · Rens · Hek')
    expect(buttons(fake)).toEqual([['Jita=>查价 Jita 乌鸦级', 'Amarr=>查价 Amarr 乌鸦级', 'Dodixie=>查价 Dodixie 乌鸦级', 'Rens=>查价 Rens 乌鸦级']])
    expect(md(unknownMarketCard(core, { ok: false, code: 'UNKNOWN_MARKET', token: 'TEST' }, ALLOWED, command))).toContain('联盟市场A')
  })

  it('items that cannot be traded', () => {
    expect(notTradableText(item('Warrior II Blueprint'))).toBe('武士蓝图 II 不能在市场上交易（T2 蓝图一般通过发明获得）。')
    expect(notTradableText(item('Capital Ships'))).toBe('旗舰级舰船操作 不能在市场上交易。')
  })
})

describe('names', () => {
  it('titles show both languages, the quantity and the group', () => {
    expect(itemTitle(core, item('Raven'), 10)).toBe('**乌鸦级** Raven ×10 · 战列舰')
    expect(itemTitle(core, item('Raven'), 1)).toBe('**乌鸦级** Raven · 战列舰')
    expect(itemTitle(core, item('PLEX'), 500)).toBe('**PLEX** ×500 · 伊甸币')
  })

  it('a command over 100 characters uses #typeID instead of the name', () => {
    const raven = item('Raven')
    expect(itemArgs(core, renderOptions(), 'price', raven, (n) => `Jita ${n}*4`)).toBe('Jita 乌鸦级*4')
    const long = 'x'.repeat(95)
    expect(itemArgs(core, renderOptions(), 'price', raven, (n) => `${long} ${n}`)).toBe(`${long} #638`)
  })
})
