import { describe, expect, it } from 'vitest'
import { escapeAttr, escapeMarkdown, hasUrl, safeEcho, scrubUrls, stripMarkdown, truncate, unbold } from '../../../src/bot/view/escape'

describe('escape', () => {
  it('escapes the markdown characters found in item names and user text', () => {
    expect(escapeMarkdown('a*b_c~d[e]f<g>h`i\\j')).toBe('a\\*b\\_c\\~d\\[e\\]f\\<g\\>h\\`i\\\\j')
    expect(escapeMarkdown('Jita 4-4 乌鸦级 (x) #1')).toBe('Jita 4-4 乌鸦级 (x) #1')
  })

  it('stripMarkdown undoes escapeMarkdown and removes bold markers', () => {
    const raw = 'a*b_c~d[e]f<g>h`i\\j'
    expect(stripMarkdown(escapeMarkdown(raw))).toBe(raw)
    expect(stripMarkdown('**乌鸦级** Raven')).toBe('乌鸦级 Raven')
    expect(stripMarkdown('\\*\\*不是粗体\\*\\*')).toBe('**不是粗体**')
  })

  it('unbold keeps escaped asterisks', () => {
    expect(unbold('**Jita** \\*')).toBe('Jita \\*')
  })

  it('scrubs things that look like links but leaves prices and names alone', () => {
    expect(scrubUrls('看 https://example.com/a?b=1 和 www.example.org 还有 evil.cn')).toBe('看 [链接] 和 [链接] 还有 [链接]')
    for (const ok of ['258,400,000 ISK', '258.40M', '1.5m', 'Jita 4-4', 'ME10/TE20', '12,345.67 ISK', '×1,000,000']) {
      expect(scrubUrls(ok)).toBe(ok)
      expect(hasUrl(ok)).toBe(false)
    }
    expect(hasUrl('a.example.com')).toBe(true)
    expect(hasUrl('ftp://x')).toBe(true)
  })

  it('safeEcho: one line, no links, about 30 characters, escaped', () => {
    expect(safeEcho('乌鸦*机\n看 evil.example.com')).toBe('乌鸦\\*机 看 \\[链接\\]')
    const long = safeEcho('一'.repeat(40))
    expect(long).toBe('一'.repeat(29) + '…')
    expect(safeEcho('  空白  ')).toBe('空白')
  })

  it('truncate counts code points', () => {
    expect(truncate('🙂🙂🙂', 2)).toBe('🙂…')
    expect(truncate('abc', 3)).toBe('abc')
  })

  it('escapeAttr makes attribute values safe', () => {
    expect(escapeAttr('查价 "Raven" <1> & 2\n3')).toBe('查价 &quot;Raven&quot; &lt;1&gt; &amp; 2 3')
  })
})
