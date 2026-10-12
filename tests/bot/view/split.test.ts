import { describe, expect, it } from 'vitest'
import { MAX_MESSAGE_CHARS } from '../../../src/constants'
import { markdownLayout } from '../../../src/bot/view/markdown'
import { hardCut, layoutOf, planSplit, renderPart, serialize, split } from '../../../src/bot/view/split'
import type { Layout } from '../../../src/bot/view/split'
import { textLayout } from '../../../src/bot/view/text'
import { longCard, priceCard, renderOptions } from './cards'

const parts = (layout: Layout, limit: number, maxParts?: number) => {
  const plan = planSplit([layout], limit, maxParts)
  return plan.parts.map((_, i) => renderPart(layout, plan, i))
}

describe('split', () => {
  it('keeps a short card in one part, identical to the whole rendering', () => {
    const layout = markdownLayout(priceCard(), renderOptions())
    expect(parts(layout, MAX_MESSAGE_CHARS)).toEqual([serialize(layout)])
  })

  it('cuts between sections, keeps every part under the limit and loses nothing', () => {
    const layout = markdownLayout(priceCard(), renderOptions())
    const out = parts(layout, 260)
    expect(out.length).toBeGreaterThan(1)
    for (const part of out) expect(part.length).toBeLessThanOrEqual(260)
    expect(out.join('\n\n')).toBe(serialize(layout))
    // 小标题不会落在一段的末尾
    for (const part of out.slice(0, -1)) expect(part).not.toMatch(/\*\*[^*\n]+\*\*(?: · [^\n]*)?$/)
    // 页脚和告示在最后一段
    expect(out.at(-1)).toMatch(/\*\*\*\n欧服 · 更新于 14:20[^]*📢/)
  })

  it('cuts inside a long section between items, never before a nested line', () => {
    const card = longCard(10)
    card.sections[1].lines = card.sections[1].lines.flatMap((line) => [line, { text: '单价 1.00M', indent: 1 as const }])
    const layout = markdownLayout(card, renderOptions())
    const out = parts(layout, 300, 10)
    expect(out.length).toBeGreaterThan(2)
    for (const part of out) {
      expect(part.length).toBeLessThanOrEqual(300)
      expect(part.startsWith(' ')).toBe(false)
    }
    expect(out.join('\n')).toContain('**明细**\n\n- 第 1 种物品')
  })

  it('drops the last data rows when the parts would exceed the budget, and says how many', () => {
    const layout = markdownLayout(longCard(300), renderOptions())
    const out = parts(layout, MAX_MESSAGE_CHARS, 3)
    expect(out).toHaveLength(3)
    for (const part of out) expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    const shown = out.join('\n').match(/^- 第 \d+ 种/gm)!.length
    const last = out[2]
    expect(last).toContain(`另有 ${300 - shown} 行未显示，合计已包含`)
    // 警告（不是数据行）、页脚都还在
    expect(last).toContain('⚠ 有 1 行没有计入合计')
    expect(last.endsWith('***\n欧服 · Jita 更新于 14:20 · 估价 #K7Q2')).toBe(true)
    expect(out[0]).toContain('**合计')
  })

  it('one plan works for several layouts of the same card', () => {
    const card = longCard(150)
    const layouts = [
      markdownLayout(card, renderOptions()),
      markdownLayout(card, renderOptions({ clickable: 'none' })),
      textLayout(card, renderOptions()),
    ]
    const plan = planSplit(layouts, 1500, 2)
    expect(plan.parts).toHaveLength(2)
    expect(plan.dropped).toBeGreaterThan(0)
    for (const layout of layouts) {
      for (let i = 0; i < plan.parts.length; i++) expect(renderPart(layout, plan, i).length).toBeLessThanOrEqual(1500)
    }
    expect(renderPart(layouts[2], plan, 1)).toContain('改用收购价：@我 发送「批量查价 #K7Q2 buy」')
  })

  it('refuses layouts with different structures', () => {
    const a = markdownLayout(priceCard(), renderOptions())
    const b = markdownLayout(longCard(3), renderOptions())
    expect(() => planSplit([a, b], 100)).toThrow()
  })

  it('splits plain strings by paragraph and line, and hard-cuts very long lines', () => {
    const text = ['第一段', 'a'.repeat(50), '', '第二段', '    缩进的行'].join('\n')
    const layout = layoutOf(text, 30)
    expect(layout.blocks.map((b) => b.items)).toEqual([
      ['第一段', 'a'.repeat(30), 'a'.repeat(20)],
      ['第二段\n    缩进的行'],
    ])
    expect(split('一行\n两行\n三行', 5)).toEqual(['一行\n两行', '三行'])
    expect(split('')).toEqual([])
    expect(split('abc')).toEqual(['abc'])
  })

  it('limits plain strings to maxParts with a custom note', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `第${i}行`)
    const out = split(lines.join('\n'), 20, 2, (n) => `还有 ${n} 行`)
    expect(out).toHaveLength(2)
    for (const part of out) expect(part.length).toBeLessThanOrEqual(20)
    expect(out[1]).toMatch(/还有 \d+ 行$/)
  })

  it('hardCut never splits a surrogate pair', () => {
    const pieces = hardCut('a🙂b🙂', 2)
    expect(pieces.join('')).toBe('a🙂b🙂')
    for (const p of pieces) expect(p).not.toMatch(/[\ud800-\udbff]$/)
  })
})

describe('split performance', () => {
  it('plans a 1000-row card for three layouts quickly', () => {
    const card = longCard(1000)
    const layouts = [
      markdownLayout(card, renderOptions()),
      markdownLayout(card, renderOptions({ clickable: 'none' })),
      textLayout(card, renderOptions()),
    ]
    const started = performance.now()
    const plan = planSplit(layouts, MAX_MESSAGE_CHARS, 3)
    expect(performance.now() - started).toBeLessThan(500)
    expect(plan.parts).toHaveLength(3)
    expect(plan.dropped).toBeGreaterThan(800)
  })
})
