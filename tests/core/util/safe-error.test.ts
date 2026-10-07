import { describe, expect, it } from 'vitest'
import { NetworkError } from '../../../src/core/ports'
import { describeError, redact, safeError } from '../../../src/core/util'

// 编造的令牌，不是真实值
const REFRESH = 'FAKErefreshTOKEN0123456789abcd=='
const CLIENT_SECRET = 'fakeClientSecretValue42'
const ACCESS = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJDSEFSQUNURVI6RVZFOjkwMDAwMDAxIn0.c2lnbmF0dXJlLWZha2U'
const BASIC = Buffer.from(`fake-client-id:${CLIENT_SECRET}`).toString('base64')

/** ctx.http 抛出的错误的样子：带着整份请求配置 */
function httpError(status: number, data: unknown, auth: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    name: 'HTTPError',
    response: { status, data, headers: { 'content-type': 'application/json' } },
    config: {
      url: 'https://login.example.test/v2/oauth/token',
      headers: { Authorization: auth },
      data: `grant_type=refresh_token&refresh_token=${encodeURIComponent(REFRESH)}`,
    },
    request: { headers: { authorization: auth } },
  })
}

function leaks(text: string) {
  return [REFRESH, CLIENT_SECRET, ACCESS, BASIC].filter((s) => text.includes(s))
}

describe('safeError', () => {
  it('keeps route, status, code and message from an SSO failure and nothing else', () => {
    const err = httpError(400, { error: 'invalid_grant', error_description: 'Invalid refresh token. Token missing/expired.' }, `Basic ${BASIC}`)
    const info = safeError(err, 'POST /v2/oauth/token')
    expect(info).toEqual({
      route: 'POST /v2/oauth/token',
      status: 400,
      code: 'invalid_grant',
      message: 'Invalid refresh token. Token missing/expired.',
    })
    expect(leaks(JSON.stringify(info))).toEqual([])
  })

  it('never leaks a bearer token from an ESI structure request', () => {
    const err = httpError(403, Buffer.from(JSON.stringify({ error: 'Forbidden' })), `Bearer ${ACCESS}`)
    const info = safeError(err, 'GET /markets/structures/1000000000001')
    expect(info.status).toBe(403)
    expect(info.code).toBe('Forbidden')
    const line = describeError(err, 'GET /markets/structures/1000000000001')
    expect(line).toBe('GET /markets/structures/1000000000001 HTTP 403 Forbidden')
    expect(leaks(line)).toEqual([])
  })

  it('redacts tokens that end up inside messages', () => {
    const err = new Error(`fetch failed: Authorization: Bearer ${ACCESS} refresh_token=${REFRESH}&x=1 {"client_secret":"${CLIENT_SECRET}"}`)
    const info = safeError(err)
    expect(leaks(JSON.stringify(info))).toEqual([])
    expect(info.message).toContain('Bearer ***')
    expect(info.message).toContain('refresh_token=***')
    expect(info.message).toContain('"client_secret":"***"')
  })

  it('redacts known secret values anywhere', () => {
    const err = new Error(`token ${REFRESH} rejected`)
    expect(safeError(err).message).toContain(REFRESH) // 没有前缀的令牌认不出来……
    expect(safeError(err, undefined, [REFRESH]).message).toBe('token *** rejected') // ……所以调用方把当前的值传进来
    expect(redact('abc short', ['abc'])).toBe('abc short') // 太短的值不处理
  })

  it('handles network errors, node error codes, aborts and non-errors', () => {
    expect(safeError(new NetworkError('timeout', 'ESI 请求超时'), 'GET /status')).toEqual({ route: 'GET /status', code: 'timeout', message: 'ESI 请求超时' })
    const reset = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
    expect(safeError(reset)).toEqual({ code: 'ECONNRESET', message: 'fetch failed' })
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    expect(safeError(abort).code).toBe('aborted')
    expect(safeError('plain string')).toEqual({ message: 'plain string' })
    expect(safeError(undefined)).toEqual({ message: 'undefined' })
    expect(safeError({ status: 502 })).toEqual({ status: 502, message: 'HTTP 502' })
  })

  it('reads QQ style error bodies', () => {
    const err = Object.assign(new Error('Request failed'), { response: { status: 400, data: { code: 40054010, message: '不允许发送URL' } } })
    expect(safeError(err)).toEqual({ status: 400, code: '40054010', message: '不允许发送URL' })
  })

  it('caps long messages', () => {
    expect(safeError(new Error('x'.repeat(1000))).message.length).toBe(200)
  })
})

describe('describeError', () => {
  it('formats a single log line', () => {
    expect(describeError(new NetworkError('network', 'socket hang up'), 'GET /markets/10000002/orders')).toBe('GET /markets/10000002/orders network: socket hang up')
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError({ response: { status: 503, data: '' } }, 'GET /status')).toBe('GET /status HTTP 503')
  })

  it('a logger fed through describeError never prints the fake tokens', () => {
    const lines: string[] = []
    const log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
    log('刷新失败', describeError(httpError(400, { error: 'invalid_grant' }, `Basic ${BASIC}`), 'POST /v2/oauth/token', [REFRESH, CLIENT_SECRET]))
    log('同步失败', describeError(httpError(401, '', `Bearer ${ACCESS}`), 'GET /markets/structures/1000000000001'))
    expect(lines.join('\n')).not.toMatch(new RegExp([REFRESH, CLIENT_SECRET, ACCESS, BASIC].map((s) => s.replace(/[.*+?^${}()|[\]\\=]/g, '\\$&')).join('|')))
    expect(lines[0]).toBe('刷新失败 POST /v2/oauth/token HTTP 400 invalid_grant')
  })
})
