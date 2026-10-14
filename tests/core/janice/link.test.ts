import { describe, expect, it } from 'vitest'
import { JANICE_CODE_RE } from '../../../src/constants'
import { findJaniceLink, janicePageUrl, parseJaniceArg } from '../../../src/core/janice'
import { checkBuiltinUrl } from '../../../src/core/sites'

// 编造的编号
const CODE = 'AbC123'
const URL = `https://janice.e-351.com/a/${CODE}`

describe('findJaniceLink', () => {
  it('finds the code in a message and keeps its case', () => {
    expect(findJaniceLink(`看看这个 ${URL} 怎么样`)).toEqual({ code: CODE, subpage: null })
    expect(findJaniceLink(`估价：${URL}。`)).toEqual({ code: CODE, subpage: null })
    expect(findJaniceLink(`${URL}/`)).toEqual({ code: CODE, subpage: null })
    expect(findJaniceLink(`http://janice.e-351.com/a/Zz9Yx8`)).toEqual({ code: 'Zz9Yx8', subpage: null })
  })

  it('takes a lowercase subpage and ignores query and anchor', () => {
    expect(findJaniceLink(`${URL}/reprocess`)).toEqual({ code: CODE, subpage: 'reprocess' })
    expect(findJaniceLink(`${URL}?x=1#top`)).toEqual({ code: CODE, subpage: null })
  })

  it('rejects an uppercase or odd subpage and bad codes', () => {
    expect(findJaniceLink(`${URL}/Reprocess`)).toBeNull()
    expect(findJaniceLink(`${URL}/a/b`)).toBeNull()
    expect(findJaniceLink('https://janice.e-351.com/a/abc')).toBeNull()
    expect(findJaniceLink(`https://janice.e-351.com/a/${'x'.repeat(17)}`)).toBeNull()
    expect(findJaniceLink('https://janice.e-351.com/a/ab_cd1')).toBeNull()
    expect(findJaniceLink('https://janice.e-351.com/')).toBeNull()
    expect(findJaniceLink('https://janice.e-351.com/appraisal/AbC123')).toBeNull()
  })

  it('needs the exact host: impostors, subdomains and tricks are not links', () => {
    for (const host of [
      'janice.e-351.com.evil.example', 'evil-janice.e-351.com', 'janice.e-351.cn', 'www.janice.e-351.com',
      'a.janice.e-351.com', 'user@janice.e-351.com', 'janice.e-351.com@evil.example', 'janice.e-351.com:8443',
      'janice.e-351.com%2eevil.example', 'janice.e-351.com.',
    ]) {
      expect(findJaniceLink(`https://${host}/a/${CODE}`), host).toBeNull()
    }
    expect(findJaniceLink(`janice.e-351.com/a/${CODE}`)).toBeNull()
    expect(findJaniceLink(`ftp://janice.e-351.com/a/${CODE}`)).toBeNull()
  })

  it('takes the host in any case', () => {
    expect(findJaniceLink(`HTTPS://JANICE.E-351.COM/a/${CODE}`)).toEqual({ code: CODE, subpage: null })
  })

  it('returns the first valid link', () => {
    expect(findJaniceLink(`https://evil.example/a/${CODE} ${URL} https://janice.e-351.com/a/Zz9Yx8`)).toEqual({ code: CODE, subpage: null })
  })

  it('returns null for text without links', () => {
    expect(findJaniceLink('')).toBeNull()
    expect(findJaniceLink('估价 AbC123')).toBeNull()
  })
})

describe('parseJaniceArg', () => {
  it('accepts a whole-text link, with surrounding blanks', () => {
    expect(parseJaniceArg(`  ${URL} `)).toEqual({ code: CODE, subpage: null })
    expect(parseJaniceArg(`${URL}/reprocess`)).toEqual({ code: CODE, subpage: 'reprocess' })
  })

  it('rejects text around the link, other hosts and plain words', () => {
    expect(parseJaniceArg(`看 ${URL}`)).toBeNull()
    expect(parseJaniceArg(`${URL} 谢谢`)).toBeNull()
    expect(parseJaniceArg('https://a.janice.e-351.com/a/AbC123')).toBeNull()
    expect(parseJaniceArg('AbC123')).toBeNull()
    expect(parseJaniceArg('#K7Q2')).toBeNull()
    expect(parseJaniceArg('')).toBeNull()
  })
})

describe('shared rule with core/sites', () => {
  it('uses one code pattern: the site check and JANICE_CODE_RE agree', () => {
    for (const code of ['AbC123', 'abcd', 'A'.repeat(16), 'abc', 'A'.repeat(17), 'ab-cd1', 'Zz9Yx8']) {
      const viaSites = checkBuiltinUrl('janice', `https://janice.e-351.com/a/${code}`) !== null
      expect(viaSites, code).toBe(JANICE_CODE_RE.test(code))
    }
  })

  it('rebuilds the page address from a code', () => {
    expect(janicePageUrl(CODE)).toBe(URL)
    expect(janicePageUrl(CODE, 'reprocess')).toBe(`${URL}/reprocess`)
    expect(checkBuiltinUrl('janice', janicePageUrl(CODE))).toBe(URL)
  })
})
