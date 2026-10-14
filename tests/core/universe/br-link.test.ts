import { describe, expect, it } from 'vitest'
import { BR_HOST, findBrLink, mentionsBrHost, parseBrLink, relatedBrUrl } from '../../../src/core/universe/br-link'

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

describe('relatedBrUrl', () => {
  const at = (iso: string) => Date.parse(iso)

  it('builds the related address from the UTC hour, floored', () => {
    expect(relatedBrUrl(30000142, at('2026-10-14T12:34:56Z'), 'floor')).toBe('https://br.evetools.org/related/30000142/202610141200')
    expect(relatedBrUrl(30000142, at('2026-10-14T12:00:00Z'), 'floor')).toBe('https://br.evetools.org/related/30000142/202610141200')
    expect(relatedBrUrl(30000142, at('2026-10-14T23:59:59.999Z'), 'floor')).toBe('https://br.evetools.org/related/30000142/202610142300')
  })

  it('works in UTC across days, months and years', () => {
    expect(relatedBrUrl(30000142, at('2026-10-14T00:00:01Z'), 'floor')).toBe('https://br.evetools.org/related/30000142/202610140000')
    expect(relatedBrUrl(30000142, at('2026-12-31T23:59:00Z'), 'nearest')).toBe('https://br.evetools.org/related/30000142/202701010000')
    expect(relatedBrUrl(30000142, at('2026-02-28T23:40:00Z'), 'nearest')).toBe('https://br.evetools.org/related/30000142/202603010000')
    // 本机时区不影响结果：带时区偏移的时间照 UTC 算
    expect(relatedBrUrl(30000142, at('2026-10-14T20:34:00+08:00'), 'floor')).toBe('https://br.evetools.org/related/30000142/202610141200')
  })

  it('rounds to the nearest hour in nearest mode', () => {
    expect(relatedBrUrl(30000142, at('2026-10-14T12:29:59Z'), 'nearest')).toBe('https://br.evetools.org/related/30000142/202610141200')
    expect(relatedBrUrl(30000142, at('2026-10-14T12:30:00Z'), 'nearest')).toBe('https://br.evetools.org/related/30000142/202610141300')
    expect(relatedBrUrl(30000142, at('2026-10-14T12:40:00Z'), 'nearest')).toBe('https://br.evetools.org/related/30000142/202610141300')
  })

  it('uses the configured rounding by default (floor)', () => {
    expect(relatedBrUrl(30000142, at('2026-10-14T12:40:00Z'))).toBe('https://br.evetools.org/related/30000142/202610141200')
  })

  it('returns null unless the system id has exactly 8 digits', () => {
    const t = at('2026-10-14T12:00:00Z')
    for (const id of [0, -30000142, 3000014, 300001420, 30000142.5, NaN, Infinity]) {
      expect(relatedBrUrl(id, t, 'floor'), String(id)).toBeNull()
    }
    expect(relatedBrUrl(31000005, t, 'floor')).toBe('https://br.evetools.org/related/31000005/202610141200')
  })

  it('returns null for times that cannot be formatted as 4-digit years', () => {
    for (const t of [NaN, Infinity, Date.UTC(10000, 0, 1), Date.UTC(999, 0, 1)]) {
      expect(relatedBrUrl(30000142, t, 'floor'), String(t)).toBeNull()
    }
  })

  it('always produces an address that parseBrLink accepts unchanged', () => {
    const url = relatedBrUrl(30000142, at('2026-10-14T12:34:56Z'), 'floor')!
    expect(parseBrLink(url)).toEqual({ kind: 'related', url, host: BR_HOST, id: '30000142/202610141200' })
  })
})
