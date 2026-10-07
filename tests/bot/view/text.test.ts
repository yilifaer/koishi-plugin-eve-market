import { describe, expect, it } from 'vitest'
import type { Card } from '../../../src/bot/view/card'
import { markdownLayout } from '../../../src/bot/view/markdown'
import { textLayout, toText } from '../../../src/bot/view/text'
import { batchCard, candidateCard, priceCard, renderOptions } from './cards'

const bare = (over: Partial<Card> = {}): Card => ({ title: '', meta: [], sections: [], warnings: [], footer: '', notices: [], actions: [], ...over })

describe('toText', () => {
  it('renders the price card like the plain-text example', () => {
    const card = priceCard()
    card.sections.pop()
    card.footer = '欧服 · 更新于 14:20'
    card.actions = [[{ label: '看走势', command: { id: 'trend', args: '乌鸦级 月' } }]]
    expect(toText(card, renderOptions())).toBe([
      '乌鸦级 Raven · 战列舰',
      '【Jita】',
      '出售 258,400,000 ISK (258.40M)',
      '中间 253,700,000 ISK (253.70M)',
      '收购 249,000,000 ISK (249.00M)',
      '【联盟市场A】',
      '出售 270,000,000 ISK (270.00M) ▲4.5%',
      '中间 255,000,000 ISK (255.00M)',
      '收购 240,000,000 ISK (240.00M) ▼3.6%',
      '———',
      '欧服 · 更新于 14:20',
      '📢 联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告',
      '看走势：@我 发送「走势 乌鸦级 月」',
    ].join('\n'))
  })

  it('writes badges after the heading and — for missing prices', () => {
    const text = toText(priceCard(), renderOptions())
    expect(text).toContain('【联盟市场B】 · 18 分钟前\n出售 275,000,000 ISK (275.00M) ▲6.4%\n中间 —\n收购 暂无买单')
  })

  it('drops list markers, keeps numbers, and marks nested lines with ·', () => {
    expect(toText(batchCard(), renderOptions())).toBe([
      '批量估价 · 联盟市场A · 出售价 -5%',
      '合计 524,400,000 ISK (524.40M)',
      '调整前 552.00M · 3 种 · 1,500,002 件',
      '1. 乌鸦级 ×2 · 513.00M',
      '· 单价 270.00M → 256.50M',
      '2. 三钛合金 ×1,000,000 · 5.13M',
      '· 单价 5.40 → 5.13',
      '3. 类晶体胶矿 ×500,000 · 6.27M',
      '· 单价 13.20 → 12.54',
      '📦 打包体积 115,000 m³',
      '———',
      '欧服 · 联盟市场A 更新于 14:16 · 估价 #K7Q2',
      '📢 联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告',
      '改用收购价：@我 发送「批量查价 #K7Q2 buy」',
      '改用中间价：@我 发送「批量查价 #K7Q2 mid」',
    ].join('\n'))
  })

  it('writes choices as 回复 @我 N with one full command as an example', () => {
    expect(toText(candidateCard(2), renderOptions())).toBe([
      '「护盾扩展装置 II」可能是以下物品，请选择：',
      '回复 @我 1：大型护盾扩展装置 II · Large Shield Extender II',
      '回复 @我 2：中型护盾扩展装置 II · Medium Shield Extender II',
      '编号 5 分钟内有效，也可以直接发送「查价 Jita 大型护盾扩展装置 II*4」',
    ].join('\n'))
  })

  it('lists primary actions first, at most two, and skips fill-only ones', () => {
    const card = bare({
      actions: [
        [{ label: '输入物品', command: { id: 'price' }, fillOnly: true }, { label: '查价 PLEX', command: { id: 'price', args: 'PLEX' } }],
        [{ label: '快速计算', command: { id: 'manufacture', args: '乌鸦级 联盟市场A' }, primary: true }, { label: '高级计算', command: { id: 'manufacture', args: '乌鸦级 高级' } }],
      ],
    })
    expect(toText(card, renderOptions())).toBe('快速计算：@我 发送「制造 乌鸦级 联盟市场A」\n查价 PLEX：@我 发送「查价 PLEX」')
  })

  it('removes markdown markers but keeps escaped characters', () => {
    const card = bare({ title: '**没有找到「a\\*b\\_c」**', warnings: ['第 7 行「x\\[1\\]」没有找到'] })
    expect(toText(card, renderOptions())).toBe('没有找到「a*b_c」\n⚠ 第 7 行「x[1]」没有找到')
  })

  it('has the same structure as the markdown layout', () => {
    for (const card of [priceCard(), batchCard(), candidateCard(8)]) {
      const md = markdownLayout(card, renderOptions())
      const text = textLayout(card, renderOptions())
      expect(text.blocks.map((b) => [b.items.length, b.counted])).toEqual(md.blocks.map((b) => [b.items.length, b.counted]))
    }
  })
})
