import { describe, expect, it } from 'vitest'
import { cleanTitle } from '../../../src/core/pilot'

describe('cleanTitle', () => {
  it('strips html and colour tags', () => {
    expect(cleanTitle('<color=0xffff0000><b>Quartermaster</b></color>')).toBe('Quartermaster')
    expect(cleanTitle('<font size="12" color="#ffffffff">Line Member</font>')).toBe('Line Member')
  })

  it('keeps in-game titles with a leading hash and hyphen', () => {
    expect(cleanTitle('#Test-Alpha')).toBe('#Test-Alpha')
    expect(cleanTitle('<b>#Night-Shift</b>')).toBe('#Night-Shift')
  })

  it('removes links and domains', () => {
    expect(cleanTitle('Recruiter https://join.example/now')).toBe('Recruiter')
    expect(cleanTitle('visit spam.net today')).toBe('visit today')
    expect(cleanTitle('<a href="http://x.example">click</a>')).toBe('click')
  })

  it('removes fullwidth and ideographic-dot domains too', () => {
    expect(cleanTitle('visit ｅｖｉｌ．ｃｏｍ today')).toBe('visit today')
    expect(cleanTitle('visit evil。com today')).toBe('visit today')
    expect(cleanTitle('visit evil｡com today')).toBe('visit today')
  })

  it('keeps dotted titles that are not domains, still scrubs bare domains and www', () => {
    expect(cleanTitle('Mr.Bob')).toBe('Mr.Bob')
    expect(cleanTitle('Dr.Strange')).toBe('Dr.Strange')
    expect(cleanTitle('Lt.Commander')).toBe('Lt.Commander')
    expect(cleanTitle('visit evil.com now')).toBe('visit now')
    expect(cleanTitle('x.co')).toBeNull()
    expect(cleanTitle('go www.fake-site.zz now')).toBe('go now')
  })

  it('decodes entities but never lets them form a tag', () => {
    expect(cleanTitle('Ops &amp; Logistics')).toBe('Ops & Logistics')
    expect(cleanTitle('&lt;b&gt;hi&lt;/b&gt;')).toBe('bhi/b')
  })

  it('drops control, zero-width and bidi characters and collapses whitespace', () => {
    expect(cleanTitle('A\u0000B​C‮D\n\n  E')).toBe('A B C D E')
  })

  it('caps at 20 characters with an ellipsis', () => {
    const t = cleanTitle('x'.repeat(40))!
    expect([...t]).toHaveLength(20)
    expect(t.endsWith('…')).toBe(true)
    expect(cleanTitle('x'.repeat(20))).toBe('x'.repeat(20))
    expect([...cleanTitle('日'.repeat(30))!]).toHaveLength(20)
  })

  it('returns null for empty, missing or tag-only titles', () => {
    for (const raw of [null, undefined, '', '   ', '<b></b>', '<color=0xff000000>', 42 as unknown as string]) expect(cleanTitle(raw)).toBeNull()
  })
})
