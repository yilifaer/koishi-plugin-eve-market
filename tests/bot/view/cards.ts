// 测试用的卡片：查价、批量查价、候选列表和长清单（数字都是示例值）。

import { COMMAND_NAMES } from '../../../src/constants'
import type { FormattedPrice } from '../../../src/core/types'
import type { Card, CardRenderOptions, Choice } from '../../../src/bot/view/card'

export const price = (full: string, compact?: string): FormattedPrice => ({ na: false, full, ...compact ? { compact } : {} })
export const compact = (value: string): FormattedPrice => ({ na: false, compact: value })

export function renderOptions(overrides: Partial<CardRenderOptions> = {}): CardRenderOptions {
  return {
    numberStyle: 'code',
    clickable: 'buttons',
    cmdInputInLists: false,
    commandName: (id) => COMMAND_NAMES[id],
    ...overrides,
  }
}

/** 查价：默认市场 */
export function priceCard(): Card {
  return {
    title: '**乌鸦级** Raven · 战列舰',
    meta: [],
    sections: [
      {
        heading: 'Jita',
        lines: [
          { label: '出售', price: price('258,400,000 ISK', '258.40M') },
          { label: '中间', price: price('253,700,000 ISK', '253.70M') },
          { label: '收购', price: price('249,000,000 ISK', '249.00M') },
        ],
      },
      {
        heading: '联盟市场A',
        lines: [
          { label: '出售', price: price('270,000,000 ISK', '270.00M'), extra: '▲4.5%' },
          { label: '中间', price: price('255,000,000 ISK', '255.00M') },
          { label: '收购', price: price('240,000,000 ISK', '240.00M'), extra: '▼3.6%' },
        ],
      },
      {
        heading: '联盟市场B',
        badge: '18 分钟前',
        lines: [
          { label: '出售', price: price('275,000,000 ISK', '275.00M'), extra: '▲6.4%' },
          { label: '中间', price: { na: true } },
          { label: '收购 暂无买单' },
        ],
      },
    ],
    warnings: [],
    footer: '欧服 · 更新于 14:20 · ▲▼ 与 Jita 比较',
    notices: ['联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告'],
    actions: [[
      { label: '月度走势', command: { id: 'trend', args: '乌鸦级 月' }, primary: true },
      { label: '季度走势', command: { id: 'trend', args: '乌鸦级 季' } },
      { label: '相关物品', command: { id: 'search', args: '乌鸦级' } },
    ]],
  }
}

export const PRICE_MARKDOWN = [
  '**乌鸦级** Raven · 战列舰',
  '',
  '**Jita**',
  '',
  '- 出售 `258,400,000 ISK`（258.40M）',
  '- 中间 `253,700,000 ISK`（253.70M）',
  '- 收购 `249,000,000 ISK`（249.00M）',
  '',
  '**联盟市场A**',
  '',
  '- 出售 `270,000,000 ISK`（270.00M）▲4.5%',
  '- 中间 `255,000,000 ISK`（255.00M）',
  '- 收购 `240,000,000 ISK`（240.00M）▼3.6%',
  '',
  '**联盟市场B** · 18 分钟前',
  '',
  '- 出售 `275,000,000 ISK`（275.00M）▲6.4%',
  '- 中间 —',
  '- 收购 暂无买单',
  '',
  '***',
  '欧服 · 更新于 14:20 · ▲▼ 与 Jita 比较',
  '> 📢 联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告',
].join('\n')

/** 批量查价：详细排版 */
export function batchCard(): Card {
  return {
    title: '**批量估价** · 联盟市场A · 出售价 -5%',
    meta: [],
    sections: [
      {
        style: 'plain',
        lines: [
          { label: '**合计**', price: price('524,400,000 ISK', '524.40M') },
          { text: '调整前 552.00M · 3 种 · 1,500,002 件' },
        ],
      },
      {
        style: 'ordered',
        lines: [
          { label: '**乌鸦级** ×2 ·', price: compact('513.00M') },
          { text: '单价 270.00M → 256.50M', indent: 1 },
          { label: '**三钛合金** ×1,000,000 ·', price: compact('5.13M') },
          { text: '单价 5.40 → 5.13', indent: 1 },
          { label: '**类晶体胶矿** ×500,000 ·', price: compact('6.27M') },
          { text: '单价 13.20 → 12.54', indent: 1 },
        ],
      },
      { style: 'plain', lines: [{ text: '📦 打包体积 115,000 m³' }] },
    ],
    warnings: [],
    footer: '欧服 · 联盟市场A 更新于 14:16 · 估价 #K7Q2',
    notices: ['联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告'],
    actions: [[
      { label: '改用收购价', command: { id: 'batch', args: '#K7Q2 buy' } },
      { label: '改用中间价', command: { id: 'batch', args: '#K7Q2 mid' } },
      { label: '改用 Jita', command: { id: 'batch', args: '#K7Q2 Jita' } },
    ]],
  }
}

export const BATCH_MARKDOWN = [
  '**批量估价** · 联盟市场A · 出售价 -5%',
  '',
  '**合计** `524,400,000 ISK`（524.40M）',
  '调整前 552.00M · 3 种 · 1,500,002 件',
  '',
  '1. **乌鸦级** ×2 · `513.00M`',
  '    - 单价 270.00M → 256.50M',
  '2. **三钛合金** ×1,000,000 · `5.13M`',
  '    - 单价 5.40 → 5.13',
  '3. **类晶体胶矿** ×500,000 · `6.27M`',
  '    - 单价 13.20 → 12.54',
  '',
  '📦 打包体积 115,000 m³',
  '',
  '***',
  '欧服 · 联盟市场A 更新于 14:16 · 估价 #K7Q2',
  '> 📢 联盟市场A 矿石收购按 Jita 收购价 92%，详见群公告',
].join('\n')

const SHIELDS: Array<[string, string]> = [
  ['大型护盾扩展装置 II', 'Large Shield Extender II'],
  ['中型护盾扩展装置 II', 'Medium Shield Extender II'],
  ['小型护盾扩展装置 II', 'Small Shield Extender II'],
  ['旗舰级护盾扩展装置 II', 'Capital Shield Extender II'],
  ['微型护盾扩展装置 II', 'Micro Shield Extender II'],
  ['大型护盾扩展装置 I', 'Large Shield Extender I'],
  ['中型护盾扩展装置 I', 'Medium Shield Extender I'],
  ['小型护盾扩展装置 I', 'Small Shield Extender I'],
]

/** 候选列表（n ≤ 8） */
export function candidateCard(n = 4): Card {
  const choices: Choice[] = SHIELDS.slice(0, n).map(([zh, en], i) => ({
    no: i + 1,
    label: zh,
    detail: en,
    command: { id: 'price', args: `Jita ${zh}*4` },
  }))
  return {
    title: '**「护盾扩展装置 II」可能是以下物品，请选择：**',
    meta: [],
    sections: [],
    warnings: [],
    footer: '',
    notices: [],
    choices,
    actions: [],
  }
}

export const CANDIDATE_MARKDOWN = [
  '**「护盾扩展装置 II」可能是以下物品，请选择：**',
  '',
  '1. 大型护盾扩展装置 II · Large Shield Extender II',
  '2. 中型护盾扩展装置 II · Medium Shield Extender II',
  '3. 小型护盾扩展装置 II · Small Shield Extender II',
  '4. 旗舰级护盾扩展装置 II · Capital Shield Extender II',
  '',
  '点下面的编号，或者 @我 回复编号（5 分钟内有效）',
].join('\n')

/** 很长的清单：rows 行数据，每行约 width 字 */
export function longCard(rows: number, width = 40): Card {
  return {
    title: '**批量估价** · Jita · 出售价',
    meta: ['共 ' + rows + ' 种'],
    sections: [
      { style: 'plain', lines: [{ label: '**合计**', price: price('1,234,567,890 ISK', '1.23B') }] },
      {
        heading: '明细',
        lines: Array.from({ length: rows }, (_, i) => ({ label: `第 ${i + 1} 种物品 ${'x'.repeat(Math.max(0, width - 12))} ·`, price: compact(`${i + 1}.00M`) })),
      },
    ],
    warnings: ['有 1 行没有计入合计'],
    footer: '欧服 · Jita 更新于 14:20 · 估价 #K7Q2',
    notices: [],
    actions: [[{ label: '改用收购价', command: { id: 'batch', args: '#K7Q2 buy' } }]],
  }
}
