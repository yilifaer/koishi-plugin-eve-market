import { describe, expect, it } from 'vitest'
import { checkConfigHost, hostMatches, isPrivateNetworkHost } from '../../../src/core/sites'

describe('checkConfigHost', () => {
  it('accepts normal domains and lowercases them', () => {
    expect(checkConfigHost('warbeacon.net')).toEqual({ ok: true, host: 'warbeacon.net' })
    expect(checkConfigHost('Sub.Example.COM')).toEqual({ ok: true, host: 'sub.example.com' })
    expect(checkConfigHost('  kb.example.com  ')).toEqual({ ok: true, host: 'kb.example.com' })
    expect(checkConfigHost('xn--fiq228c.example')).toMatchObject({ ok: true, host: 'xn--fiq228c.example' })
  })

  it('takes only the domain from a pasted URL and says so', () => {
    expect(checkConfigHost('https://kb.example.com/x?y=1')).toEqual({ ok: true, host: 'kb.example.com', note: '已只取域名' })
    expect(checkConfigHost('kb.example.com/kill/')).toMatchObject({ ok: true, host: 'kb.example.com', note: '已只取域名' })
  })

  it('rejects IPs, local names, ports, users, trailing dots and empty input', () => {
    for (const input of [
      '127.0.0.1', '8.8.8.8', '2130706433', '0x7f.1', '[::1]', '::1', 'localhost', 'a.localhost',
      'intranet', 'x.local', 'x.internal', 'x.lan', 'x.home.arpa', 'x.localdomain',
      'a@b.com', 'b.com:8443', 'b.com.', '', '   ', 'https://', 'a b.com', 'zkillboard.com', 'www.zkillboard.com',
      'https://127.0.0.1/x', '-a.example.com', 'a..example.com', 'a_b.example.com',
    ]) {
      expect(checkConfigHost(input), input).toMatchObject({ ok: false })
    }
  })

  it('gives a Chinese reason', () => {
    const r = checkConfigHost('localhost')
    expect(r.ok ? '' : r.reason).toMatch(/本机/)
    const z = checkConfigHost('zkillboard.com')
    expect(z.ok ? '' : z.reason).toMatch(/zKillboard/)
  })
})

describe('hostMatches', () => {
  it('matches the domain and its subdomains only', () => {
    expect(hostMatches('a.com', 'a.com')).toBe(true)
    expect(hostMatches('x.a.com', 'a.com')).toBe(true)
    expect(hostMatches('xa.com', 'a.com')).toBe(false)
    expect(hostMatches('a.com.evil.com', 'a.com')).toBe(false)
  })
})

describe('isPrivateNetworkHost', () => {
  it('flags local and private addresses', () => {
    for (const host of [
      'localhost', 'LOCALHOST', 'a.localhost', 'localhost.', 'intranet', 'printer.local', 'x.internal', 'x.home.arpa',
      '127.0.0.1', '127.8.8.8', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3',
      '::1', '[::1]', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:10.0.0.1]',
      '::ffff:a00:1', '64:ff9b::7f00:1',
      '2130706433', '0x7f.1', '', 'bad host', 'zz::zz',
    ]) {
      expect(isPrivateNetworkHost(host), host).toBe(true)
    }
  })

  it('lets public addresses and names through', () => {
    for (const host of [
      'example.com', 'br.evetools.org', '8.8.8.8', '1.1.1.1', '198.18.0.1', '198.19.255.255', '172.15.0.1', '172.32.0.1',
      '100.63.0.1', '100.128.0.1', '169.253.0.1', '2606:4700::1111', '::ffff:8.8.8.8', 'fec0::1', 'fe00::1',
    ]) {
      expect(isPrivateNetworkHost(host), host).toBe(false)
    }
  })
})
