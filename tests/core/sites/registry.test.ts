import { describe, expect, it } from 'vitest'
import { createSiteRegistry } from '../../../src/core/sites'
import type { SiteSettingInput } from '../../../src/core/sites'
import { findBrLink, parseBrLink } from '../../../src/core/universe/br-link'

const builtin = (id: string, host: string, extra: Partial<SiteSettingInput> = {}): SiteSettingInput => ({
  id, name: id, builtin: true, host, pathPrefix: '', auto: true, maxImages: 2, ...extra,
})
const BR = builtin('br', 'br.evetools.org')
const WB = builtin('warbeacon', 'warbeacon.net')
const JA = builtin('janice', 'janice.e-351.com')
const DL = builtin('dotlan', 'evemaps.dotlan.net', { maxImages: 1 })
const custom = (row: number, host: string, pathPrefix = '', extra: Partial<SiteSettingInput> = {}): SiteSettingInput => ({
  id: `custom-${row}`, name: `自定义${row}`, builtin: false, host, pathPrefix, auto: true, maxImages: 1, ...extra,
})
const all = (...more: SiteSettingInput[]) => createSiteRegistry({ sites: [BR, WB, JA, DL, ...more] })
const only = (...sites: SiteSettingInput[]) => createSiteRegistry({ sites })

// 编造的编号
const ID = '64f0a1b2c3d4e5f60718293a'
const ID2 = '0123456789abcdef01234567'
const BRURL = `https://br.evetools.org/br/${ID}`
const RELATED = 'https://br.evetools.org/related/30000142/202610071200'

describe('BR equivalence with findBrLink / parseBrLink', () => {
  const inputs = [
    BRURL, RELATED, ID, '', 'br.evetools.org', 'https://br.evetools.org/',
    `看看这个${BRURL}打得不错`, `战报 ${BRURL}`, `${BRURL}，昨晚的`, `「${BRURL}」`, `(${BRURL})`, `${BRURL}。`,
    `@机器人\n${BRURL}\n`, `<${BRURL}>`, `[${BRURL}]`, `"${BRURL}"`, `${BRURL}.`, `${BRURL}!!!`,
    `http://br.evetools.org/br/${ID}`, `HTTPS://BR.EVETOOLS.ORG/BR/${ID.toUpperCase()}`,
    `https://www.br.evetools.org/br/${ID}`, 'http://Br.EveTools.org/Related/30000142/202610071200',
    `${BRURL}/`, `${BRURL}?tab=summary#teams`, `${RELATED}/extra`, `${BRURL}/ `, `${BRURL}?a=1 x`,
    `${BRURL} https://br.evetools.org/br/${ID2}`, `https://br.evetools.org/br/123 https://br.evetools.org/br/${ID2}`,
    `https://example.com/?u=${BRURL}`, `https://example.com/?u=${encodeURIComponent(BRURL)}`, `x ${BRURL} y ${RELATED}`,
    `https://evetools.org/br/${ID}`, `https://xbr.evetools.org/br/${ID}`, `https://br.evetools.org.example.com/br/${ID}`,
    `https://example.com/br.evetools.org/br/${ID}`, `https://example.com@br.evetools.org/br/${ID}`,
    `https://example.com#.br.evetools.org/br/${ID}`, `https://example.com?.br.evetools.org/br/${ID}`,
    `https://-x.br.evetools.org/br/${ID}`, `https://中文br.evetools.org/br/${ID}`, `ftp://br.evetools.org/br/${ID}`,
    `br.evetools.org/br/${ID}`, `https://br.evetools.org:8443/br/${ID}`, `https://br.evetools.org./br/${ID}`,
    `https://br.evetools.org\\@x/br/${ID}`, `https://br%2eevetools.org/br/${ID}`,
    'https://br.evetools.org/br/64f0a1b2c3d4e5f60718293', `https://br.evetools.org/br/${ID}0`,
    'https://br.evetools.org/br/64f0a1b2c3d4e5f60718293g', 'https://br.evetools.org/related/3000014/202610071200',
    'https://br.evetools.org/related/30000142/2026100712000', 'https://br.evetools.org/kill/12345',
    `https://https://br.evetools.org/br/${ID}`, `http://http://${BRURL}`, `${BRURL}${BRURL}`, `${BRURL}http://x`,
    `${BRURL}\thttp://a.com`, `${BRURL}　`, `${BRURL}）`, `看${BRURL}看${RELATED}`,
  ]

  it('find returns the same url as findBrLink for every input', () => {
    const reg = only(BR)
    for (const text of inputs) {
      const expected = findBrLink(text)
      const got = reg.find(text)
      expect(got?.url, text).toBe(expected?.url)
      expect(got?.host, text).toBe(expected?.host)
      if (got) expect(got.site.id).toBe('br')
    }
  })

  it('parse returns the same url as parseBrLink for every input', () => {
    const reg = only(BR)
    for (const text of inputs) {
      expect(reg.parse(text)?.url, text).toBe(parseBrLink(text)?.url)
    }
  })

  it('gives the same answer with the other built-in sites enabled', () => {
    const reg = all()
    for (const text of inputs) {
      expect(reg.find(text)?.url, text).toBe(findBrLink(text)?.url)
      expect(reg.parse(text)?.url, text).toBe(parseBrLink(text)?.url)
    }
  })

  it('reports where the link starts', () => {
    expect(only(BR).find(`看看 ${BRURL}`)?.start).toBe(3)
  })
})

describe('Warbeacon', () => {
  const reg = all()
  const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  it('accepts related (single time and time range) and report paths', () => {
    expect(reg.find('https://warbeacon.net/br/related/30000142/202610061900')).toMatchObject({ url: 'https://warbeacon.net/br/related/30000142/202610061900/', site: { id: 'warbeacon', kind: 'battle-report' } })
    expect(reg.find('http://WARBEACON.NET/br/related/30000142/202610061900/?x=1#y')?.url).toBe('https://warbeacon.net/br/related/30000142/202610061900/')
    expect(reg.find('https://warbeacon.net/br/related/30000142/202610061900/202610062100')?.url).toBe('https://warbeacon.net/br/related/30000142/202610061900/202610062100/')
    expect(reg.find('https://www.warbeacon.net/br/related/30000142/202610061900/202610062100/')?.url).toBe('https://www.warbeacon.net/br/related/30000142/202610061900/202610062100/')
    expect(reg.find(`https://warbeacon.net/br/report/${UUID}`)?.url).toBe(`https://warbeacon.net/br/report/${UUID}`)
    expect(reg.find(`看 https://warbeacon.net/br/report/${UUID.toUpperCase()}/，好`)?.url).toBe(`https://warbeacon.net/br/report/${UUID}`)
  })
  it('rejects look-alikes and other paths', () => {
    const path = '/br/related/30000142/202610061900'
    for (const text of [
      `https://evilwarbeacon.net${path}`, `https://warbeacon.net.evil.com${path}`, `https://warbeacon.net@evil.com${path}`,
      `https://warbeacon.net:444${path}`, `https://warbeacon.net\\@x${path}`, `https://warbeacon%2enet${path}`,
      `https://warbeacon.net.${path}`, `https://evil.com/?u=warbeacon.net${path}`, `ftp://warbeacon.net${path}`,
      `warbeacon.net${path}`,
      'https://warbeacon.net/', 'https://warbeacon.net/br/', 'https://warbeacon.net/br/abc', 'https://warbeacon.net/br/recent',
      'https://warbeacon.net/br/create', 'https://warbeacon.net/other', 'https://warbeacon.net/brx/related/30000142/202610061900',
      'https://warbeacon.net/br/related/3000014/202610061900', 'https://warbeacon.net/br/related/300001422/202610061900',
      'https://warbeacon.net/br/related/30000142/20261006190', 'https://warbeacon.net/br/related/30000142/2026100619000',
      'https://warbeacon.net/br/related/30000142/202610061900/20261006210', 'https://warbeacon.net/br/related/30000142/202610061900/202610062100/1',
      'https://warbeacon.net/br/related/30000142', 'https://warbeacon.net/br/report/', 'https://warbeacon.net/br/report/0a1b2c3d-4e5f-4a6b-8c7d',
      `https://warbeacon.net/br/report/${UUID}0`, 'https://warbeacon.net/br/report/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4g',
      `https://warbeacon.net/br/report/${UUID}/x`,
    ]) {
      expect(reg.find(text), text).toBeNull()
    }
  })
})

describe('Janice', () => {
  const reg = all()
  it('accepts /a/<id> and keeps the id case', () => {
    expect(reg.find('https://janice.e-351.com/a/AbCdEf')).toMatchObject({ url: 'https://janice.e-351.com/a/AbCdEf', site: { id: 'janice', kind: 'appraisal' } })
    expect(reg.find('http://Janice.E-351.com/a/AbCdEf/?x=1#y')?.url).toBe('https://janice.e-351.com/a/AbCdEf')
    expect(reg.find('估价 https://janice.e-351.com/a/Zz9Yx8。')?.url).toBe('https://janice.e-351.com/a/Zz9Yx8')
  })
  it('keeps one lowercase subpage', () => {
    expect(reg.find('https://janice.e-351.com/a/AbC123/reprocess')?.url).toBe('https://janice.e-351.com/a/AbC123/reprocess')
    expect(reg.find('https://janice.e-351.com/a/AbC123/reprocess/?x=1')?.url).toBe('https://janice.e-351.com/a/AbC123/reprocess')
  })
  it('rejects other pages and look-alikes', () => {
    for (const text of [
      'https://janice.e-351.com/', 'https://janice.e-351.com/a/', 'https://janice.e-351.com/a/abc', 'https://janice.e-351.com/a/' + 'a'.repeat(17),
      'https://janice.e-351.com/a/abcdef/extra/more', 'https://janice.e-351.com/a/abcdef/Extra', 'https://janice.e-351.com/a/abcdef/ex1',
      'https://janice.e-351.com/a/abcdef/' + 'x'.repeat(21), 'https://janice.e-351.com/b/abcdef', 'https://janice.e-351.com/a/ab_cdef',
      'https://xjanice.e-351.com.evil.com/a/abcdef', 'https://janice.e-351.com.evil.com/a/abcdef', 'https://janice.e-351.com@evil.com/a/abcdef',
      'https://janice.e-351.com:8443/a/abcdef', 'https://e-351.com/a/abcdef',
    ]) {
      expect(reg.find(text), text).toBeNull()
    }
  })
})

describe('DOTLAN', () => {
  const reg = all()
  it('accepts the five page kinds, lowercases the first segment and keeps the rest', () => {
    expect(reg.find('https://evemaps.dotlan.net/map/The_Forge')).toMatchObject({ url: 'https://evemaps.dotlan.net/map/The_Forge', site: { id: 'dotlan', kind: 'map' } })
    expect(reg.find('https://evemaps.dotlan.net/MAP/Delve/1DQ1-A')?.url).toBe('https://evemaps.dotlan.net/map/Delve/1DQ1-A')
    expect(reg.find('https://evemaps.dotlan.net/system/Jita?x=1#y')?.url).toBe('https://evemaps.dotlan.net/system/Jita')
    expect(reg.find('https://evemaps.dotlan.net/Region/Delve/')?.url).toBe('https://evemaps.dotlan.net/region/Delve')
    expect(reg.find('https://evemaps.dotlan.net/alliance/Some_Name')?.url).toBe('https://evemaps.dotlan.net/alliance/Some_Name')
    expect(reg.find('https://evemaps.dotlan.net/corp/ABC')?.url).toBe('https://evemaps.dotlan.net/corp/ABC')
    expect(reg.find('https://evemaps.dotlan.net/system/Jita/kills')?.url).toBe('https://evemaps.dotlan.net/system/Jita/kills')
  })
  it('handles brackets around the link', () => {
    expect(reg.find('(https://evemaps.dotlan.net/map/Delve)')?.url).toBe('https://evemaps.dotlan.net/map/Delve')
    expect(reg.find('看 https://evemaps.dotlan.net/map/Delve。')?.url).toBe('https://evemaps.dotlan.net/map/Delve')
  })
  it('rejects other pages, dot segments and look-alikes', () => {
    for (const text of [
      'https://evemaps.dotlan.net/route/Jita:Amarr', 'https://evemaps.dotlan.net/jump/x', 'https://evemaps.dotlan.net/range/x',
      'https://evemaps.dotlan.net/', 'https://evemaps.dotlan.net/map', 'https://evemaps.dotlan.net/map/', 'https://evemaps.dotlan.net/map/..',
      'https://evemaps.dotlan.net/map/Delve/../x', 'https://evemaps.dotlan.net/map/a/b/c/d', 'https://evemaps.dotlan.net/maps/Delve',
      'https://dotlan.net/map/Delve', 'https://evemaps.dotlan.net.evil.com/map/Delve', 'https://evemaps.dotlan.net@evil.com/map/Delve',
      'https://evemaps.dotlan.net:8443/map/Delve', 'https://evilevemaps.dotlan.net.x/map/Delve',
    ]) {
      expect(reg.find(text), text).toBeNull()
    }
  })
})

describe('custom sites', () => {
  it('matches the domain and subdomains, keeps the query, drops the fragment and upgrades http', () => {
    const reg = only(custom(1, 'kb.example.com'))
    expect(reg.find('http://KB.Example.com/kill/123?a=1&b=2#top')).toMatchObject({
      url: 'https://kb.example.com/kill/123?a=1&b=2', site: { id: 'custom-1', kind: 'custom', name: '自定义1', legacyText: false },
    })
    expect(reg.find('https://x.kb.example.com/')?.url).toBe('https://x.kb.example.com/')
    expect(reg.find('https://kb.example.com')?.url).toBe('https://kb.example.com/')
    expect(reg.find('https://example.com/kill/1')).toBeNull()
    expect(reg.find('https://xkb.example.com/kill/1')).toBeNull()
    expect(reg.find('https://kb.example.com.evil.com/kill/1')).toBeNull()
    expect(reg.find('https://kb.example.com@evil.com/kill/1')).toBeNull()
    expect(reg.find('https://kb.example.com:8443/kill/1')).toBeNull()
  })
  it('respects the path prefix on segment boundaries', () => {
    const reg = only(custom(1, 'kb.example.com', '/kb'))
    expect(reg.find('https://kb.example.com/kb')?.url).toBe('https://kb.example.com/kb')
    expect(reg.find('https://kb.example.com/kb/a/b')?.url).toBe('https://kb.example.com/kb/a/b')
    expect(reg.find('https://kb.example.com/kbx')).toBeNull()
    expect(reg.find('https://kb.example.com/other/kb')).toBeNull()
    const slash = only(custom(1, 'kb.example.com', '/kill/'))
    expect(slash.find('https://kb.example.com/kill/9')?.url).toBe('https://kb.example.com/kill/9')
    expect(slash.find('https://kb.example.com/kill')).toBeNull()
  })
  it('rejects odd paths, odd queries and over-long urls', () => {
    const reg = only(custom(1, 'kb.example.com'))
    expect(reg.find('https://kb.example.com/a/../b')).toBeNull()
    expect(reg.find('https://kb.example.com/a|b')).toBeNull()
    expect(reg.find('https://kb.example.com/a?x=a|b')).toBeNull()
    expect(reg.find(`https://kb.example.com/${'a'.repeat(477)}`)?.url.length).toBe(500)
    expect(reg.find(`https://kb.example.com/${'a'.repeat(478)}`)).toBeNull()
  })
  it('tries custom rows in order', () => {
    const reg = only(custom(1, 'a.example.com', '/x'), custom(2, 'a.example.com'))
    expect(reg.find('https://a.example.com/x/1')?.site.id).toBe('custom-1')
    expect(reg.find('https://a.example.com/y')?.site.id).toBe('custom-2')
  })
  it('builtin domains never fall through to custom rows', () => {
    const reg = all(custom(1, 'warbeacon.net'), custom(2, 'br.evetools.org'))
    expect(reg.find('https://warbeacon.net/other')).toBeNull()
    expect(reg.find('https://br.evetools.org/kill/1')).toBeNull()
    const off = only(JA, custom(1, 'warbeacon.net'))
    expect(off.find('https://warbeacon.net/br/related/30000142/202610061900')).toBeNull()
    expect(off.find('https://warbeacon.net/other')).toBeNull()
  })
})

describe('registry', () => {
  it('lists enabled sites in built-in then custom order, with profiles', () => {
    const reg = createSiteRegistry({ sites: [custom(2, 'b.example.com', '', { maxImages: 3 }), DL, BR, custom(1, 'a.example.com')] })
    expect(reg.sites.map((s) => s.id)).toEqual(['br', 'dotlan', 'custom-2', 'custom-1'])
    const [br, dotlan, c2] = reg.sites
    expect(br).toMatchObject({ name: 'br', host: 'br.evetools.org', auto: true, legacyText: true, kind: 'battle-report' })
    expect(br.profile).toEqual({ viewportWidth: 1440, viewportHeight: 900, idleMs: 6000, settleMs: 8000, maxImages: 2, maxWaitSec: 60 })
    expect(dotlan.profile).toMatchObject({ viewportWidth: 1440, viewportHeight: 900, idleMs: 5000, settleMs: 5000, maxImages: 1 })
    expect(c2.profile).toMatchObject({ idleMs: 5000, settleMs: 5000, maxImages: 3 })
    expect(c2.profile.readySelector).toBeUndefined()
    expect(c2.profile.hideSelectors).toBeUndefined()
    expect(reg.hosts).toEqual(['br.evetools.org', 'evemaps.dotlan.net', 'b.example.com', 'a.example.com'])
  })
  it('max wait: defaults per site (Warbeacon 120, others 60), explicit values clamp into 30-180', () => {
    const reg = all(custom(1, 'a.example.com'))
    expect(reg.sites.map((s) => [s.id, s.profile.maxWaitSec])).toEqual([['br', 60], ['warbeacon', 120], ['janice', 60], ['dotlan', 60], ['custom-1', 60]])
    const set = only(
      builtin('warbeacon', 'warbeacon.net', { maxWaitSec: 90 }), builtin('janice', 'janice.e-351.com', { maxWaitSec: 999 }),
      builtin('dotlan', 'evemaps.dotlan.net', { maxWaitSec: 1 }), custom(1, 'a.example.com', '', { maxWaitSec: 150 }),
    )
    expect(set.sites.map((s) => s.profile.maxWaitSec)).toEqual([90, 180, 30, 150])
  })
  it('DOTLAN hides the ad column and the subscription bar; the map itself is not in any list', () => {
    const dotlan = all().sites.find((s) => s.id === 'dotlan')!
    expect(dotlan.profile.hideSelectors).toEqual(expect.arrayContaining(['ins.adsbygoogle', '.ad-block']))
    expect(dotlan.profile.hideFixedTexts).toEqual(['EveMaps subscription'])
    for (const sel of dotlan.profile.hideSelectors!) expect(sel).not.toMatch(/map|svg|canvas|body|#outer/i)
  })
  it('clamps maxImages into 1-3', () => {
    const reg = only(builtin('janice', 'janice.e-351.com', { maxImages: 9 }), custom(1, 'a.example.com', '', { maxImages: 0 }))
    expect(reg.sites.map((s) => s.profile.maxImages)).toEqual([3, 1])
  })
  it('only knows the enabled sites', () => {
    const reg = only(JA)
    expect(reg.find(BRURL)).toBeNull()
    expect(reg.find('https://warbeacon.net/br/related/30000142/202610061900')).toBeNull()
    expect(reg.find('https://janice.e-351.com/a/abcdef')?.site.id).toBe('janice')
    expect(only().find('https://janice.e-351.com/a/abcdef')).toBeNull()
    expect(only().parse('https://janice.e-351.com/a/abcdef')).toBeNull()
  })
  it('takes the first link by position and tries each scheme start', () => {
    const reg = all()
    const text = `https://janice.e-351.com/a/abcdef 和 ${BRURL}`
    expect(reg.find(text)).toMatchObject({ site: { id: 'janice' }, start: 0 })
    expect(reg.find(`${BRURL} https://janice.e-351.com/a/abcdef`)?.site.id).toBe('br')
    expect(reg.find('https://nope.example.com/x https://janice.e-351.com/a/abcdef')?.site.id).toBe('janice')
    expect(reg.find('https://evil.com/?u=https://janice.e-351.com/a/abcdef')?.url).toBe('https://janice.e-351.com/a/abcdef')
  })
  it('applies the filter', () => {
    const reg = all()
    const text = `https://janice.e-351.com/a/abcdef ${BRURL}`
    expect(reg.find(text, (s) => s.kind === 'battle-report')?.site.id).toBe('br')
    expect(reg.find(text, (s) => s.kind === 'map')).toBeNull()
    const noAuto = only(builtin('janice', 'janice.e-351.com', { auto: false }), BR)
    expect(noAuto.find(text, (s) => s.auto)?.site.id).toBe('br')
    expect(noAuto.find(text)?.site.id).toBe('janice')
  })
  it('parse accepts a string that is exactly one link', () => {
    const reg = all()
    expect(reg.parse('https://janice.e-351.com/a/abcdef')?.url).toBe('https://janice.e-351.com/a/abcdef')
    expect(reg.parse('  https://janice.e-351.com/a/abcdef/  ')?.url).toBe('https://janice.e-351.com/a/abcdef')
    expect(reg.parse('https://evemaps.dotlan.net/map/Delve?x=1#y')?.url).toBe('https://evemaps.dotlan.net/map/Delve')
    expect(reg.parse('看 https://janice.e-351.com/a/abcdef')).toBeNull()
    expect(reg.parse('https://janice.e-351.com/a/abcdef 看')).toBeNull()
    expect(reg.parse('https://janice.e-351.com/a/abcdef.')).toBeNull()
    expect(reg.parse('https://evil.com/?u=https://janice.e-351.com/a/abcdef')).toBeNull()
    expect(reg.parse('https://warbeacon.net@evil.com/br/abc')).toBeNull()
    expect(all(custom(1, 'kb.example.com')).parse('https://kb.example.com/x?a=1')?.url).toBe('https://kb.example.com/x?a=1')
  })
  it('mentioned finds an enabled site by domain', () => {
    const reg = all(custom(1, 'kb.example.com'))
    expect(reg.mentioned('看 https://JANICE.e-351.com/oops')?.id).toBe('janice')
    expect(reg.mentioned('kb.example.com')?.id).toBe('custom-1')
    expect(reg.mentioned('https://other.example.org/')).toBeNull()
    expect(only(BR).mentioned('https://warbeacon.net/x')).toBeNull()
  })
  it('isListedHost matches listed domains and subdomains', () => {
    const reg = all()
    expect(reg.isListedHost('janice.e-351.com')).toBe(true)
    expect(reg.isListedHost('WWW.Warbeacon.net')).toBe(true)
    expect(reg.isListedHost('evil.com')).toBe(false)
    expect(reg.isListedHost('warbeacon.net.evil.com')).toBe(false)
    expect(only(JA).isListedHost('warbeacon.net')).toBe(false)
  })
  it('stays fast on long hostile input', () => {
    const reg = all(custom(1, 'kb.example.com'))
    const inputs = [
      `https://${'a'.repeat(100000)}`,
      'http://'.repeat(14000),
      `https://${'a.'.repeat(50000)}`,
      `https://kb.example.com/${'a'.repeat(100000)}`,
      `https://janice.e-351.com/a/${'a'.repeat(100000)}`,
      'https://a.b/'.repeat(8000),
      `https://${'a'.repeat(20000)} `.repeat(5),
    ]
    for (const text of inputs) {
      const started = performance.now()
      expect(reg.find(text)).toBeNull()
      reg.parse(text)
      expect(performance.now() - started).toBeLessThan(500)
    }
    const started = performance.now()
    reg.find(inputs[1])
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('stays fast on long runs of scheme starts and closing brackets', () => {
    const reg = all()
    const text = ('http://'.repeat(70) + ')'.repeat(505) + ' ').repeat(Math.ceil(20000 / 582)).slice(0, 20000)
    const t0 = performance.now()
    reg.find(text)
    expect(performance.now() - t0).toBeLessThan(50)
  })
})
