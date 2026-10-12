import { describe, expect, it } from 'vitest'
import type { Card } from '../../../src/bot/view/card'
import { keyboardRows, textActions } from '../../../src/bot/view/clickable'
import { keepBoldSpacing, priceMarkdown, toQQMarkdown } from '../../../src/bot/view/markdown'
import {
  BATCH_MARKDOWN, CANDIDATE_MARKDOWN, PRICE_MARKDOWN, batchCard, candidateCard, compact, price, priceCard, renderOptions,
} from './cards'

const bare = (over: Partial<Card> = {}): Card => ({ title: '', meta: [], sections: [], warnings: [], footer: '', notices: [], actions: [], ...over })

/** 只用官方支持的语法：没有 # 标题、没有表格；列表前面一定是空行或另一条列表项 */
function checkSyntax(md: string) {
  expect(md).not.toMatch(/^#/m)
  expect(md).not.toMatch(/^\|/m)
  const lines = md.split('\n')
  lines.forEach((line, i) => {
    if (!/^(- |\d+\. )/.test(line) || i === 0) return
    expect(lines[i - 1] === '' || /^(- |\d+\. | {4}- )/.test(lines[i - 1]), `line ${i}: ${line}`).toBe(true)
  })
}

describe('toQQMarkdown', () => {
  it('renders the price card exactly like the design', () => {
    const { md, rows } = toQQMarkdown(priceCard(), renderOptions())
    expect(md).toBe(PRICE_MARKDOWN)
    checkSyntax(md)
    expect(rows).toEqual([[
      { label: '月度走势', text: '走势 乌鸦级 月', primary: true },
      { label: '季度走势', text: '走势 乌鸦级 季' },
      { label: '相关物品', text: '搜索 乌鸦级' },
    ]])
  })

  it('renders the batch card with a plain block, an ordered list and nested lines', () => {
    const { md } = toQQMarkdown(batchCard(), renderOptions())
    expect(md).toBe(BATCH_MARKDOWN)
    checkSyntax(md)
  })

  it('renders choices as a numbered list with a hint, and number buttons before action buttons', () => {
    const { md, rows } = toQQMarkdown(candidateCard(4), renderOptions())
    expect(md).toBe(CANDIDATE_MARKDOWN)
    checkSyntax(md)
    expect(rows).toEqual([[1, 2, 3, 4].map((n) => ({
      label: String(n),
      text: `查价 Jita ${['大型', '中型', '小型', '旗舰级'][n - 1]}护盾扩展装置 II*4`,
    }))])
  })

  it('numberStyle decides how full prices look', () => {
    const p = price('258,400,000 ISK', '258.40M')
    expect(priceMarkdown(p, 'code')).toBe('`258,400,000 ISK`（258.40M）')
    expect(priceMarkdown(p, 'bold')).toBe('**258,400,000 ISK**（258.40M）')
    expect(priceMarkdown(p, 'plain')).toBe('258,400,000 ISK（258.40M）')
    expect(priceMarkdown(price('5.40 ISK'), 'code')).toBe('`5.40 ISK`')
    expect(priceMarkdown(compact('513.00M'), 'bold')).toBe('**513.00M**')
    expect(priceMarkdown({ na: true }, 'code')).toBe('—')
    const { md } = toQQMarkdown(priceCard(), renderOptions({ numberStyle: 'bold' }))
    expect(md).toContain('- 出售 **270,000,000 ISK**（270.00M）▲4.5%')
    expect(md).not.toContain('`')
  })

  it('puts a space before extra text unless the price ends with a full-width bracket', () => {
    const card = bare({ sections: [{ lines: [
      { label: '出售', price: price('5.40 ISK'), extra: '▲4.5%' },
      { label: '收购', price: price('5,000 ISK', '5.00K'), extra: '· 合计 50.00K' },
      { label: '阿尔法型', extra: '· 出售 31.50M' },
    ] }] })
    expect(toQQMarkdown(card, renderOptions()).md).toBe('- 出售 `5.40 ISK` ▲4.5%\n- 收购 `5,000 ISK`（5.00K）· 合计 50.00K\n- 阿尔法型 · 出售 31.50M')
  })

  it('writes meta under the title, warnings after the data, and no rule without a footer', () => {
    const card = bare({
      title: '**乌鸦级 Raven ×10 · 战列舰**',
      meta: ['多行内容已按批量查价处理', '按「乌鸦」查询'],
      sections: [{ heading: '联盟市场A', lines: [{ text: '⚠ 市场数据暂时不可用（同步异常）' }], style: 'plain' }],
      warnings: ['有 2 行没有计入合计'],
      notices: ['只有告示'],
    })
    expect(toQQMarkdown(card, renderOptions()).md).toBe([
      '**乌鸦级 Raven ×10 · 战列舰**',
      '多行内容已按批量查价处理',
      '按「乌鸦」查询',
      '',
      '**联盟市场A**',
      '⚠ 市场数据暂时不可用（同步异常）',
      '',
      '⚠ 有 2 行没有计入合计',
      '',
      '> 📢 只有告示',
    ].join('\n'))
  })

  it('shows at most two notices and skips empty sections', () => {
    const card = bare({ footer: '欧服', notices: ['一', '二', '三'], sections: [{ lines: [] }, { heading: ' ', lines: [] }] })
    expect(toQQMarkdown(card, renderOptions()).md).toBe('***\n欧服\n> 📢 一\n> 📢 二')
  })

  it('does not double the bold when a heading already has it', () => {
    const card = bare({ sections: [{ heading: '**Jita**', lines: [{ text: 'x' }] }, { heading: 'R\\*ARKN', lines: [] }] })
    expect(toQQMarkdown(card, renderOptions()).md).toBe('**Jita**\n\n- x\n\n**R\\*ARKN**')
  })

  it('writes list items as <qqbot-cmd-input> when enabled, escaping the attributes', () => {
    const card = candidateCard(2)
    card.choices![1].label = '中型 "护盾" II'
    const { md } = toQQMarkdown(card, renderOptions({ cmdInputInLists: true }))
    expect(md).toContain('1. <qqbot-cmd-input text="查价 Jita 大型护盾扩展装置 II*4" show="大型护盾扩展装置 II" reference="false" /> · Large Shield Extender II')
    expect(md).toContain('show="中型 &quot;护盾&quot; II"')
    // 不发按钮时也不写可点文字
    expect(toQQMarkdown(card, renderOptions({ cmdInputInLists: true, clickable: 'none' })).md).not.toContain('qqbot-cmd-input')
  })

  it('clickable none: no buttons, actions as text lines, choices with the full command', () => {
    const { md, rows } = toQQMarkdown(priceCard(), renderOptions({ clickable: 'none' }))
    expect(rows).toEqual([])
    expect(md.endsWith('> 📢 联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告\n\n月度走势：@我 发送「走势 乌鸦级 月」\n季度走势：@我 发送「走势 乌鸦级 季」')).toBe(true)
    const choices = toQQMarkdown(candidateCard(2), renderOptions({ clickable: 'none' }))
    expect(choices.md.endsWith('\n\n@我 回复编号（5 分钟内有效），也可以直接发送「查价 Jita 大型护盾扩展装置 II\\*4」')).toBe(true)
  })

  it('takes command names from the registered commands', () => {
    const renamed = renderOptions({ commandName: (id) => id === 'trend' ? '价格走势' : '查' })
    const rows = keyboardRows(priceCard(), renamed)
    expect(rows[0].map((b) => b.text)).toEqual(['价格走势 乌鸦级 月', '价格走势 乌鸦级 季', '查 乌鸦级'])
  })
})

describe('keyboardRows', () => {
  const action = (label: string, args = label) => ({ label, command: { id: 'price' as const, args } })

  it('8 choices take two rows of 5 + 3, then the action rows, never more than 5 rows', () => {
    const card = candidateCard(8)
    card.actions = [[action('a')], [action('b')], [action('c')], [action('d')]]
    const rows = keyboardRows(card, renderOptions())
    expect(rows.map((r) => r.map((b) => b.label))).toEqual([['1', '2', '3', '4', '5'], ['6', '7', '8'], ['a'], ['b'], ['c']])
  })

  it('choices with their own button text are labeled with it, 4 to a row, and the hint says so', () => {
    const card = candidateCard(5)
    card.choices = card.choices!.map((c) => ({ ...c, button: `地点${c.no}号很长的名字` }))
    const rows = keyboardRows(card, renderOptions())
    // 标签 8 个字宽，一行只放 2 个，不会被 QQ 截断
    expect(rows.map((r) => r.map((b) => b.label))).toEqual([['地点1号很长的…', '地点2号很长的…'], ['地点3号很长的…', '地点4号很长的…'], ['地点5号很长的…']])
    expect(toQQMarkdown(card, renderOptions()).md).toContain('点按钮，或者 @我 回复编号（5 分钟内有效）')
    // 只要有一项没写，全部用编号
    card.choices![2] = { ...card.choices![2], button: undefined }
    expect(keyboardRows(card, renderOptions())[0].map((b) => b.label)).toEqual(['1', '2', '3', '4', '5'])
    expect(toQQMarkdown(card, renderOptions()).md).toContain('点下面的编号，或者 @我 回复编号（5 分钟内有效）')
  })

  it('wraps rows wider than 4 actions evenly and keeps at most 5 rows', () => {
    const card = bare({ actions: [[1, 2, 3, 4, 5, 6].map((n) => action(`动作${n}`)), [action('x')], [action('y')], [action('z')], [action('w')]] })
    const rows = keyboardRows(card, renderOptions())
    expect(rows.map((r) => r.length)).toEqual([3, 3, 1, 1, 1])
    expect(rows.flat().map((b) => b.label)).not.toContain('w')
  })

  it('fillOnly fills the command name and a space', () => {
    const card = bare({ actions: [[{ label: '输入物品', command: { id: 'price', args: '忽略' }, fillOnly: true }]] })
    expect(keyboardRows(card, renderOptions())).toEqual([[{ label: '输入物品', text: '查价 ' }]])
  })

  it('cuts labels wider than 8 Chinese characters and makes them safe for the adapter', () => {
    const card = bare({ actions: [[action('第7行：乌鸦级海军型', 'x'), action('R&D <1>', 'y'), action('**粗体**', 'z')]] })
    expect(keyboardRows(card, renderOptions()).flat().map((b) => b.label)).toEqual(['第7行：乌鸦级…', 'R＆D ＜1＞', '粗体'])
    // 英文数字算半个字宽
    const latin = bare({ actions: [[action('改用 Dodixie', 'a'), action('Raven Navy Issue', 'b'), action('Large Shield Extender II', 'c')]] })
    expect(keyboardRows(latin, renderOptions()).flat().map((b) => b.label)).toEqual(['改用 Dodixie', 'Raven Navy Issue', 'Large Shield E…'])
  })

  it('drops buttons whose command is longer than 100 characters', () => {
    const card = bare({ actions: [[action('长', '乌'.repeat(100)), action('短')]] })
    expect(keyboardRows(card, renderOptions())).toEqual([[{ label: '短', text: '查价 短' }]])
  })

  it('replaces newlines in arguments', () => {
    const card = bare({ actions: [[action('多行', 'Jita\nRaven')]] })
    expect(keyboardRows(card, renderOptions())[0][0].text).toBe('查价 Jita Raven')
  })

  it('never sends a button whose command or label looks like a link', () => {
    const card = candidateCard(1)
    card.actions = [[action('全部结果', 'evil.com'), action('看 x.cn', '乌鸦级'), action('下一页', '护盾 第2页')]]
    expect(keyboardRows(card, renderOptions()).flat().map((b) => b.text)).toEqual([expect.stringMatching(/^查价 /), '查价 护盾 第2页'])
    expect(textActions(card, renderOptions()).map((a) => a.command)).toEqual(['查价 护盾 第2页'])
  })
})

// QQ 会吃掉粗体结束标记后面的空格，所以粗体后面紧跟的普通文字一起放进粗体
describe('keepBoldSpacing', () => {
  it('moves plain text after the last bold into it', () => {
    expect(keepBoldSpacing('**乌鸦级** Raven · 战列舰')).toBe('**乌鸦级 Raven · 战列舰**')
    expect(keepBoldSpacing('「乌鸦级」**相关物品** · Jita 4-4 · 共 82 个')).toBe('「乌鸦级」**相关物品 · Jita 4-4 · 共 82 个**')
  })

  it('leaves lines alone when the rest has code, markup or nothing after the bold', () => {
    for (const line of ['1. **乌鸦级** ×2 · `513.00M`', '**合计** `524,400,000 ISK`（524.40M）', '**Jita**', '***', '- 出售 `258,400,000 ISK`', '**a** <qqbot-cmd-input text="x" />']) {
      expect(keepBoldSpacing(line)).toBe(line)
    }
  })
})
