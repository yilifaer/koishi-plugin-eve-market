import { describe, expect, it } from 'vitest'
import { BR_HOST, findBrLink, mentionsBrHost, parseBrLink } from '../../../src/core/universe/br-link'

// 编造的战报编号
const ID = '64f0a1b2c3d4e5f60718293a'
const ID2 = '0123456789abcdef01234567'
const BR = `https://br.evetools.org/br/${ID}`
const RELATED = 'https://br.evetools.org/related/30000142/202610071200'

describe('findBrLink', () => {
  it('finds /br/<24 hex> and /related/<8 digits>/<12 digits>', () => {
    expect(findBrLink(BR)).toEqual({ kind: 'br', url: BR, host: BR_HOST, id: ID })
    expect(findBrLink(RELATED)).toEqual({ kind: 'related', url: RELATED, host: BR_HOST, id: '30000142/202610071200' })
  })

  it('finds the link inside a message and stops at Chinese text, whitespace and punctuation', () => {
    for (const text of [
      `看看这个${BR}打得不错`,
      `战报 ${BR}`,
      `${BR}，昨晚的`,
      `「${BR}」`,
      `(${BR})`,
      `${BR}。`,
      `@机器人\n${BR}\n`,
      `<${BR}>`,
    ]) {
      expect(findBrLink(text)?.url, text).toBe(BR)
    }
  })

  it('accepts http, any letter case and any subdomain, and normalizes to https with a lowercase host and id', () => {
    expect(findBrLink(`http://br.evetools.org/br/${ID}`)?.url).toBe(BR)
    expect(findBrLink(`HTTPS://BR.EVETOOLS.ORG/BR/${ID.toUpperCase()}`)?.url).toBe(BR)
    expect(findBrLink(`https://www.br.evetools.org/br/${ID}`)).toMatchObject({ host: 'www.br.evetools.org', url: `https://www.br.evetools.org/br/${ID}` })
    expect(findBrLink('http://Br.EveTools.org/Related/30000142/202610071200')?.url).toBe(RELATED)
  })

  it('drops whatever follows the id: path, query, fragment', () => {
    expect(findBrLink(`${BR}/`)?.url).toBe(BR)
    expect(findBrLink(`${BR}?tab=summary#teams`)?.url).toBe(BR)
    expect(findBrLink(`${RELATED}/extra`)?.url).toBe(RELATED)
  })

  it('takes only the first valid link', () => {
    const second = `https://br.evetools.org/br/${ID2}`
    expect(findBrLink(`${BR} ${second}`)?.id).toBe(ID)
    // 前一个无效时取后一个
    expect(findBrLink(`https://br.evetools.org/br/123 ${second}`)?.id).toBe(ID2)
  })

  it('rejects other hosts and look-alikes', () => {
    for (const text of [
      `https://evetools.org/br/${ID}`,
      `https://xbr.evetools.org/br/${ID}`,
      `https://br.evetools.org.example.com/br/${ID}`,
      `https://example.com/br.evetools.org/br/${ID}`,
      `https://example.com@br.evetools.org/br/${ID}`,
      `https://example.com#.br.evetools.org/br/${ID}`,
      `https://example.com?.br.evetools.org/br/${ID}`,
      `https://-x.br.evetools.org/br/${ID}`,
      `https://中文br.evetools.org/br/${ID}`,
      `ftp://br.evetools.org/br/${ID}`,
      `br.evetools.org/br/${ID}`,
    ]) {
      expect(findBrLink(text), text).toBeNull()
    }
  })

  it('rejects malformed ids', () => {
    for (const text of [
      'https://br.evetools.org/br/64f0a1b2c3d4e5f60718293',
      `https://br.evetools.org/br/${ID}0`,
      'https://br.evetools.org/br/64f0a1b2c3d4e5f60718293g',
      'https://br.evetools.org/related/3000014/202610071200',
      'https://br.evetools.org/related/30000142/2026100712',
      'https://br.evetools.org/related/30000142/2026100712000',
      'https://br.evetools.org/kill/12345',
      'https://br.evetools.org/',
      '',
    ]) {
      expect(findBrLink(text), text).toBeNull()
    }
  })

  it('stays fast on long hostile input', () => {
    const text = `https://${'a'.repeat(20000)} `.repeat(3) + 'http://'.repeat(2000)
    const started = performance.now()
    expect(findBrLink(text)).toBeNull()
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('parseBrLink', () => {
  it('accepts a string that is exactly one link', () => {
    expect(parseBrLink(BR)?.url).toBe(BR)
    expect(parseBrLink(`  ${BR}/  `)?.url).toBe(BR)
    expect(parseBrLink(`${BR}?a=1#b`)?.url).toBe(BR)
    expect(parseBrLink(`http://br.evetools.org/related/30000142/202610071200`)?.url).toBe(RELATED)
  })

  it('rejects anything around the link', () => {
    for (const text of [`看 ${BR}`, `${BR} 看`, `${BR}x`, `${BR}/ 看`, `https://example.com/?u=${BR}`]) {
      expect(parseBrLink(text), text).toBeNull()
    }
  })

  it('applies the same host checks', () => {
    expect(parseBrLink(`https://example.com@br.evetools.org/br/${ID}`)).toBeNull()
    expect(parseBrLink(`https://br.evetools.org.example.com/br/${ID}`)).toBeNull()
  })
})

describe('mentionsBrHost', () => {
  it('tells whether the site is mentioned at all', () => {
    expect(mentionsBrHost('https://BR.evetools.org/br/123')).toBe(true)
    expect(mentionsBrHost('https://example.com/')).toBe(false)
  })
})
