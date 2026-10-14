import { describe, expect, it } from 'vitest'
import { itemListBlocks, itemListLines, priceCopyText } from '../../../src/core/janice'
import type { JaniceItem, JaniceView } from '../../../src/core/types'

const item = (en: string, amount: number): JaniceItem => ({ typeId: 1, en, zh: null, amount, prices: { sell: 0, buy: 0, split: 0 } })

describe('priceCopyText', () => {
  it('writes sell, buy, split as labelled integers without separators, one per line', () => {
    const text = priceCopyText({ totals: { sell: 7381035675, buy: 6500000000, split: 6940517837 } } as Pick<JaniceView, 'totals'>)
    expect(text).toBe('出售 7381035675\n收购 6500000000\n中间 6940517837')
    expect(text).not.toMatch(/[,，.]/)
  })
})

describe('item list', () => {
  it('is one "English name<Tab>amount" line per item, in order', () => {
    expect(itemListLines({ items: [item('Tritanium', 1000), item('Pyerite', 250)] })).toEqual(['Tritanium\t1000', 'Pyerite\t250'])
  })

  it('keeps a stray tab or newline in a name from breaking the line', () => {
    expect(itemListLines({ items: [item('A\tB\nC', 5)] })).toEqual(['A B C\t5'])
  })

  it('splits by length without cutting a line and reports nothing omitted when all fit', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`Item${i}`, 100))
    const { blocks, omitted } = itemListBlocks({ items }, { maxChars: 30 })
    expect(blocks.length).toBeGreaterThan(1)
    expect(blocks.every((b) => b.length <= 30)).toBe(true)
    expect(blocks.join('\n').split('\n')).toEqual(itemListLines({ items }))
    expect(omitted).toBe(0)
  })

  it('drops whole blocks over the budget and counts the omitted lines', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`Item${i}`, 100))
    const full = itemListBlocks({ items }, { maxChars: 30 })
    const cut = itemListBlocks({ items }, { maxChars: 30, maxBlocks: 1 })
    expect(cut.blocks).toEqual([full.blocks[0]])
    expect(cut.omitted).toBe(10 - full.blocks[0].split('\n').length)
    expect(itemListBlocks({ items }, { maxBlocks: 0 })).toEqual({ blocks: [], omitted: 10 })
  })
})
