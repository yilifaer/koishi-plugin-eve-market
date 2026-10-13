import { h } from 'koishi'
import type { Session } from 'koishi'
import { describe, expect, it, vi } from 'vitest'
import {
  QQSender, SessionSender, describeFailure, markdownElements, qqErrorCode, sendErrors, senderFor, toBuffer,
} from '../../../src/bot/send/qq-sender'
import type { KeyboardRow } from '../../../src/bot/view/card'

const row = (...labels: string[]): KeyboardRow => labels.map((label) => ({ label, text: `查价 ${label}` }))

function fakeSession(platform = 'qq', sendMessage: (...args: unknown[]) => Promise<string[]> = async () => ['m1']) {
  const bot = { sendMessage: vi.fn(sendMessage) }
  const send = vi.fn(async () => ['m1'])
  const session = { platform, channelId: 'G1', bot, send } as unknown as Session
  return { session, bot, send }
}

/** 适配器失败时抛出的错误：errors 里每个是一次失败的 HTTP 请求 */
function aggregate(...failures: Array<{ url: string; status: number; code?: number; message?: string }>) {
  const error = new Error('') as Error & { errors: unknown[] }
  error.errors = failures.map((f) => Object.assign(new Error('Bad Request'), {
    response: { url: f.url, status: f.status, data: { code: f.code, message: f.message } },
  }))
  return error
}

describe('markdownElements', () => {
  it('puts the whole markdown into one qq:markdown element', () => {
    const md = '1. <qqbot-cmd-input text="查价 Raven" show="Raven" reference="false" />'
    const [el] = markdownElements(md, [])
    expect(el.type).toBe('qq:markdown')
    expect(el.children).toHaveLength(1)
    expect(el.children[0].type).toBe('text')
    expect(el.children[0].attrs.content).toBe(md)
  })

  it('puts the quote element in front when quoting a message', () => {
    const els = markdownElements('x', [row('a')], 'MSG-1')
    expect(els.map((e) => e.type)).toEqual(['quote', 'qq:markdown', 'button'])
    expect(els[0].attrs.id).toBe('MSG-1')
  })

  it('alternates bare rows and button-groups, at most 5 rows of 5', () => {
    const els = markdownElements('x', [row('a', 'b'), row('c'), row('d'), row('e'), row('1', '2', '3', '4', '5', '6'), row('dropped')])
    expect(els.map((e) => e.type)).toEqual(['qq:markdown', 'button', 'button', 'button-group', 'button', 'button-group', ...Array(5).fill('button')])
    expect(els[3].children.map((c) => c.children[0].attrs.content)).toEqual(['c'])
    expect(els.at(-1)!.children[0].attrs.content).toBe('5')
  })

  it('makes input buttons, blue only when primary', () => {
    const [, plain, blue] = markdownElements('x', [[{ label: '月度走势', text: '走势 乌鸦级 月' }, { label: '快速', text: '制造 乌鸦级', primary: true }]])
    expect(plain.attrs).toEqual({ type: 'input', text: '走势 乌鸦级 月' })
    expect(blue.attrs).toEqual({ type: 'input', text: '制造 乌鸦级', class: 'primary' })
  })
})

describe('send errors', () => {
  it('reads the platform code from the aggregated errors', () => {
    const error = aggregate({ url: 'https://api.example.test/v2/groups/G1/messages', status: 400, code: 40054010, message: '不允许发送URL' })
    expect(sendErrors(error)).toHaveLength(1)
    expect(qqErrorCode(sendErrors(error)[0])).toBe(40054010)
    expect(describeFailure(error)).toEqual({ ok: false, sent: 0, code: 40054010, status: 400, message: '不允许发送URL' })
  })

  it('accepts codes written as strings and plain errors without a code', () => {
    expect(qqErrorCode({ response: { data: { code: '40034128' } } })).toBe(40034128)
    const failure = describeFailure(new TypeError("Cannot read properties of undefined (reading 'data')"))
    expect(failure.code).toBeUndefined()
    expect(failure.status).toBeUndefined()
    expect(failure.message).toContain('Cannot read properties')
  })
})

describe('toBuffer', () => {
  it('keeps only the bytes of a view, and passes Buffers through', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9])
    const view = backing.subarray(2, 5)
    const buf = toBuffer(view)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect([...buf]).toEqual([1, 2, 3])
    expect(buf.toString('base64')).toBe(Buffer.from([1, 2, 3]).toString('base64'))
    const real = Buffer.from([4, 5])
    expect(toBuffer(real)).toBe(real)
  })
})

describe('QQSender', () => {
  const sender = new QQSender()

  it('sends through bot.sendMessage with the session, so the adapter handles msg_id and msg_seq', async () => {
    const { session, bot } = fakeSession()
    expect(await sender.markdown(session, '**x**', [row('a')])).toEqual({ ok: true, sent: 1 })
    const [channel, elements, referrer, options] = bot.sendMessage.mock.calls[0] as [string, h[], unknown, { session: Session }]
    expect(channel).toBe('G1')
    expect(elements.map((e) => e.type)).toEqual(['qq:markdown', 'button'])
    expect(referrer).toBeUndefined()
    expect(options.session).toBe(session)
  })

  it('wraps plain text in a text element so nothing is parsed as markup', async () => {
    const { session, bot } = fakeSession()
    await sender.text(session, 'a <b> & <qqbot-at-user id="x" />')
    const elements = bot.sendMessage.mock.calls[0][1] as h[]
    expect(elements).toHaveLength(1)
    expect(elements[0].type).toBe('text')
    expect(elements[0].attrs.content).toBe('a <b> & <qqbot-at-user id="x" />')
  })

  it('a quoted text reply puts a quote element in front (the adapter turns it into message_reference)', async () => {
    const { session, bot } = fakeSession()
    await sender.text(session, '引用测试', 'MSG-1')
    const elements = bot.sendMessage.mock.calls[0][1] as h[]
    expect(elements.map((e) => e.type)).toEqual(['quote', 'text'])
    expect(elements[0].attrs.id).toBe('MSG-1')
    expect(elements[1].attrs.content).toBe('引用测试')
  })

  it('sends images as data URLs with the MIME type and only the bytes of the view', async () => {
    const { session, bot } = fakeSession()
    const backing = new Uint8Array([0, 0xff, 0xd8, 0xff, 0])
    await sender.image(session, backing.subarray(1, 4) as Buffer, 'image/jpeg', '战报 1/2')
    const elements = bot.sendMessage.mock.calls[0][1] as h[]
    expect(elements.map((e) => e.type)).toEqual(['img', 'text'])
    expect(elements[0].attrs.src).toBe(`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`)
    expect(elements[1].attrs.content).toBe('战报 1/2')
  })

  it('reports a failed upload, counting the caption that went out on its own', async () => {
    const upload = aggregate({ url: 'https://api.example.test/v2/groups/G1/files', status: 400, code: 850012, message: 'upload failed' })
    const { session } = fakeSession('qq', async () => { throw upload })
    expect(await sender.image(session, Buffer.from([1]), 'image/png', '说明')).toMatchObject({ ok: false, sent: 1, code: 850012 })
    expect(await sender.image(session, Buffer.from([1]), 'image/png')).toMatchObject({ ok: false, sent: 0 })
    const both = aggregate(
      { url: 'https://api.example.test/v2/groups/G1/files', status: 400, code: 850012 },
      { url: 'https://api.example.test/v2/groups/G1/messages', status: 400, code: 40034128 },
    )
    const failing = fakeSession('qq', async () => { throw both })
    expect(await sender.image(failing.session, Buffer.from([1]), 'image/png', '说明')).toMatchObject({ ok: false, sent: 0 })
  })

  it('never throws', async () => {
    const { session } = fakeSession('qq', async () => { throw new TypeError('network') })
    expect(await sender.text(session, 'x')).toMatchObject({ ok: false, sent: 0, message: 'network' })
  })
})

describe('SessionSender (sandbox)', () => {
  it('uses session.send with elements', async () => {
    const sender = new SessionSender()
    const { session, send, bot } = fakeSession('sandbox:abc')
    expect(sender.rich).toBe(false)
    await sender.text(session, '<不是标签>')
    await sender.image(session, Buffer.from([1, 2]), 'image/png', '图')
    expect(bot.sendMessage).not.toHaveBeenCalled()
    const [[text], [image]] = send.mock.calls as unknown as Array<[h | h[]]>
    expect((text as h).type).toBe('text')
    expect((text as h).attrs.content).toBe('<不是标签>')
    expect((image as h[]).map((e) => e.type)).toEqual(['img', 'text'])
    expect((image as h[])[0].attrs.src).toMatch(/^data:image\/png;base64,/)
    await sender.text(session, '引用', 'MSG-2')
    const quoted = (send.mock.calls as unknown as Array<[h[]]>)[2][0]
    expect(quoted.map((e) => e.type)).toEqual(['quote', 'text'])
  })

  it('senderFor picks the adapter path only on qq', () => {
    expect(senderFor(fakeSession('qq').session)).toBeInstanceOf(QQSender)
    expect(senderFor(fakeSession('sandbox:abc').session)).toBeInstanceOf(SessionSender)
  })
})
