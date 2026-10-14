import { describe, expect, it } from 'vitest'
import { findKillLink, parseKillArg } from '../../../src/core/killmail'

// 编造的击杀编号和 hash
const HASH = '0123456789abcdef0123456789abcdef01234567'
const Z = { killId: 131234567, hash: null, source: 'zkill' }

describe('findKillLink: zKill links', () => {
  it.each([
    'https://zkillboard.com/kill/131234567/',
    'https://zkillboard.com/kill/131234567',
    'http://zkillboard.com/kill/131234567/',
    'https://www.zkillboard.com/kill/131234567/',
    'HTTPS://ZKillboard.COM/Kill/131234567/',
    'https://zkillboard.com/kill/131234567/?foo=1#bar',
    'https://zkillboard.com/kill/131234567/related/',
    'zkillboard.com/kill/131234567',
    'www.zkillboard.com/kill/131234567/',
  ])('recognises %s', (text) => {
    expect(findKillLink(text)).toEqual(Z)
  })

  it('finds the link inside a message and stops at Chinese text and punctuation', () => {
    for (const text of [
      '看看这个https://zkillboard.com/kill/131234567/打得不错',
      '击杀 https://zkillboard.com/kill/131234567/',
      '「https://zkillboard.com/kill/131234567/」',
      '(https://zkillboard.com/kill/131234567/)',
      'https://zkillboard.com/kill/131234567/，昨晚的',
      'https://zkillboard.com/kill/131234567。',
      '@机器人\nhttps://zkillboard.com/kill/131234567/\n',
      '<https://zkillboard.com/kill/131234567/>',
    ]) {
      expect(findKillLink(text)?.killId, text).toBe(131234567)
    }
  })

  it('takes the first link in the message', () => {
    const text = 'https://zkillboard.com/kill/111/ 还有 https://zkillboard.com/kill/222/'
    expect(findKillLink(text)?.killId).toBe(111)
  })

  it.each([
    'https://zkillboard.com.evil.cn/kill/131234567/',
    'https://evilzkillboard.com/kill/131234567/',
    'https://evil.com/zkillboard.com/kill/131234567/',
    'https://zkillboard.com@evil.com/kill/131234567/',
    'https://user@zkillboard.com/kill/131234567/',
    'https://zkillboard.com:8080/kill/131234567/',
    'https://fakezkillboard.com/kill/131234567',
    'https://zkillboard.org/kill/131234567/',
    'https://sub.zkillboard.com/kill/131234567/',
    'zkillboard.com.evil.cn/kill/131234567',
    'xzkillboard.com/kill/131234567',
  ])('rejects spoofed host %s', (text) => {
    expect(findKillLink(text)).toBeNull()
  })

  it.each([
    'https://zkillboard.com/character/2112345678/',
    'https://zkillboard.com/corporation/98000001/',
    'https://zkillboard.com/alliance/99000001/',
    'https://zkillboard.com/kill/abc/',
    'https://zkillboard.com/kill/',
    'https://zkillboard.com/kill/0/',
    'https://zkillboard.com/kill/000/',
    'https://zkillboard.com/kill/1234567890123/',
    'https://zkillboard.com/kill/12345678901234567890/',
    'https://zkillboard.com/system/30000142/',
    '',
    '击杀 131234567',
  ])('rejects %s', (text) => {
    expect(findKillLink(text)).toBeNull()
  })

  it('accepts the longest allowed id (12 digits)', () => {
    expect(findKillLink('https://zkillboard.com/kill/999999999999/')?.killId).toBe(999999999999)
  })
})

describe('findKillLink: ESI killmail links with hash', () => {
  it.each([
    `https://esi.evetech.net/killmails/131234567/${HASH}/`,
    `https://esi.evetech.net/killmails/131234567/${HASH}`,
    `https://esi.evetech.net/latest/killmails/131234567/${HASH}/`,
    `https://esi.evetech.net/v1/killmails/131234567/${HASH}/?datasource=tranquility`,
    `https://esi.evetech.net/killmails/131234567/${HASH.toUpperCase()}/`,
    `esi.evetech.net/killmails/131234567/${HASH}`,
  ])('recognises %s', (text) => {
    expect(findKillLink(text)).toEqual({ killId: 131234567, hash: HASH, source: 'esi' })
  })

  it.each([
    `https://esi.evetech.net.evil.cn/killmails/131234567/${HASH}/`,
    `https://evil.com/esi.evetech.net/killmails/131234567/${HASH}/`,
    `https://myesi.evetech.net/killmails/131234567/${HASH}/`,
    `https://esi.evetech.net/killmails/131234567/${HASH.slice(1)}/`,
    `https://esi.evetech.net/killmails/131234567/${HASH}0/`,
    `https://esi.evetech.net/killmails/131234567/${'z'.repeat(40)}/`,
    'https://esi.evetech.net/killmails/131234567/',
    `https://esi.evetech.net/characters/2112345678/killmails/recent/`,
  ])('rejects %s', (text) => {
    expect(findKillLink(text)).toBeNull()
  })

  it('prefers whichever link comes first in the message', () => {
    const esi = `https://esi.evetech.net/killmails/222/${HASH}/`
    expect(findKillLink(`${esi} https://zkillboard.com/kill/111/`)?.source).toBe('esi')
    expect(findKillLink(`https://zkillboard.com/kill/111/ ${esi}`)?.source).toBe('zkill')
  })
})

describe('parseKillArg', () => {
  it('accepts a plain number of 1 to 12 digits', () => {
    expect(parseKillArg('131234567')).toEqual({ killId: 131234567, hash: null, source: 'id' })
    expect(parseKillArg('  131234567 ')).toEqual({ killId: 131234567, hash: null, source: 'id' })
    expect(parseKillArg('1')?.killId).toBe(1)
    expect(parseKillArg('999999999999')?.killId).toBe(999999999999)
  })

  it('accepts a link that is the whole argument', () => {
    expect(parseKillArg('https://zkillboard.com/kill/131234567/')).toEqual(Z)
    expect(parseKillArg(' https://zkillboard.com/kill/131234567/?a=1 ')).toEqual(Z)
    expect(parseKillArg(`https://esi.evetech.net/killmails/131234567/${HASH}/`)).toEqual({ killId: 131234567, hash: HASH, source: 'esi' })
  })

  it.each([
    '', '0', '000', '-5', '1.5', '1e9', '1234567890123', 'abc', '12 34',
    '击杀 131234567',
    'https://zkillboard.com/kill/131234567/ 多余的字',
    'https://zkillboard.com.evil.cn/kill/131234567/',
    '看 https://zkillboard.com/kill/131234567/',
    'https://zkillboard.com/character/2112345678/',
  ])('rejects %j', (text) => {
    expect(parseKillArg(text)).toBeNull()
  })
})
