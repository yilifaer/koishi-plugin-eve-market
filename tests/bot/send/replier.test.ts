import type { Session } from 'koishi'
import { describe, expect, it } from 'vitest'
import { Replier, createSendState, recoveryFor, replyBudget } from '../../../src/bot/send/replier'
import type { ReplierOptions, SendState } from '../../../src/bot/send/replier'
import type { ImageMime, SendResult, Sender } from '../../../src/bot/send/qq-sender'
import type { KeyboardRow } from '../../../src/bot/view/card'
import { toQQMarkdown } from '../../../src/bot/view/markdown'
import { toText } from '../../../src/bot/view/text'
import { COMMAND_BUDGET, MATERIALS_BUDGET, MAX_MESSAGE_CHARS, QQ_ERROR } from '../../../src/constants'
import { candidateCard, longCard, priceCard, renderOptions } from '../view/cards'

const NOW = Date.UTC(2026, 9, 7, 6, 20)

interface Call {
  kind: 'markdown' | 'text' | 'image'
  content: string
  rows?: KeyboardRow[]
  quote?: string
}

const MENTION = '<qqbot-at-user id="U1" /> '

class FakeSender implements Sender {
  calls: Call[] = []
  results: SendResult[] = []

  constructor(readonly rich = true) {}

  failNext(...results: Array<Partial<SendResult> & { ok: false }>) {
    this.results.push(...results.map((r) => ({ sent: 0, message: 'error', ...r })))
  }

  async markdown(_: Session, content: string, rows: KeyboardRow[], quote?: string) {
    this.calls.push({ kind: 'markdown', content, rows, ...quote ? { quote } : {} })
    return this.next()
  }

  async text(_: Session, content: string, quote?: string) {
    this.calls.push({ kind: 'text', content, ...quote ? { quote } : {} })
    return this.next()
  }

  async image(_: Session, data: Buffer, mime: ImageMime, caption?: string) {
    this.calls.push({ kind: 'image', content: `${mime} ${data.length} ${caption ?? ''}` })
    return this.next()
  }

  private next(): SendResult {
    return this.results.shift() ?? { ok: true, sent: 1 }
  }
}

class Logs {
  lines: string[] = []
  debug() {}
  info() {}
  warn(...a: unknown[]) { this.lines.push(a.join(' ')) }
  error(...a: unknown[]) { this.lines.push(a.join(' ')) }
}

interface Setup {
  replier: Replier
  sender: FakeSender
  state: SendState
  logs: Logs
  clock: { now: number }
}

function setup(options: Partial<ReplierOptions> & { ageSec?: number; rich?: boolean; state?: SendState; clock?: { now: number }; session?: Record<string, unknown> } = {}): Setup {
  const clock = options.clock ?? { now: NOW }
  const session = { platform: 'qq', channelId: 'G1', timestamp: clock.now - (options.ageSec ?? 1) * 1000, ...options.session } as unknown as Session
  const sender = new FakeSender(options.rich ?? true)
  const state = options.state ?? createSendState()
  const logs = new Logs()
  const replier = new Replier(session, sender, {
    budget: options.budget ?? 4,
    mode: options.mode ?? 'markdown',
    render: options.render ?? renderOptions(),
    state,
    logger: logs,
    now: () => clock.now,
  })
  return { replier, sender, state, logs, clock }
}

const rejected = { ok: false as const, sent: 0, status: 400, code: 40054099, message: 'markdown 格式不对' }

describe('replyBudget', () => {
  it('keeps one reply spare: group 4, direct 3, and one less in direct chats', () => {
    expect(replyBudget(COMMAND_BUDGET.price.max, false)).toBe(2)
    expect(replyBudget(COMMAND_BUDGET.price.max, true)).toBe(1)
    expect(replyBudget(COMMAND_BUDGET.groupId.max, true)).toBe(2)
    expect(replyBudget(MATERIALS_BUDGET.max, false)).toBe(4)
    expect(replyBudget(MATERIALS_BUDGET.max, true)).toBe(3)
    expect(replyBudget(5, false)).toBe(4)
    expect(replyBudget(1, true)).toBe(1)
  })
})

describe('recoveryFor', () => {
  const md = { markdown: true, buttons: true }
  it('maps platform errors to the next step', () => {
    expect(recoveryFor({ ...rejected, code: QQ_ERROR.REPLY_LIMIT }, md)).toBe('stop')
    expect(recoveryFor({ ...rejected, code: QQ_ERROR.URL_NOT_ALLOWED }, md)).toBe('scrub')
    expect(recoveryFor({ ...rejected, code: QQ_ERROR.MARKDOWN_TOO_LONG }, md)).toBe('text')
    expect(recoveryFor({ ...rejected, message: 'keyboard 参数错误' }, md)).toBe('no-buttons')
    expect(recoveryFor({ ...rejected, message: 'keyboard 参数错误' }, { markdown: true, buttons: false })).toBe('text')
    expect(recoveryFor({ ok: false, sent: 0, status: 403, message: 'Forbidden' }, md)).toBe('text')
    expect(recoveryFor({ ok: false, sent: 0, status: 500, code: 22009, message: 'busy' }, md)).toBe('stop')
    expect(recoveryFor({ ok: false, sent: 0, message: 'fetch failed' }, md)).toBe('stop')
    expect(recoveryFor(rejected, { markdown: false, buttons: false })).toBe('stop')
  })
})

/** 有收到的消息 ID 和提问的人：第一条消息引用，群里第一张 Markdown 卡片 @ 提问的人 */
const asked = { messageId: 'M1', userId: 'U1', isDirect: false }
const clientError = { ok: false as const, sent: 0, status: 400, code: 40054099, message: '参数不对' }

describe('Replier quote and mention', () => {
  it('quotes only the first text or markdown message, and mentions only on the first markdown card', async () => {
    const { replier, sender } = setup({ session: asked })
    await replier.card(priceCard())
    await replier.card(priceCard())
    await replier.text('后面')
    const md = toQQMarkdown(priceCard(), renderOptions()).md
    expect(sender.calls).toEqual([
      { kind: 'markdown', content: MENTION + md, rows: expect.any(Array), quote: 'M1' },
      { kind: 'markdown', content: md, rows: expect.any(Array) },
      { kind: 'text', content: '后面' },
    ])
  })

  it('once a message carried a quote (explicit or automatic), later messages get none', async () => {
    const { replier, sender } = setup({ session: asked, mode: 'text' })
    await replier.text('甲', { quote: 'M1' })
    await replier.text('乙')
    await replier.card(priceCard())
    expect(sender.calls.map((c) => c.quote)).toEqual(['M1', undefined, undefined])
  })

  it('attach none: that card carries nothing and leaves quote and @ for the next one', async () => {
    const { replier, sender } = setup({ session: asked })
    await replier.card(priceCard(), { attach: 'none' })
    await replier.card(priceCard())
    await replier.card(priceCard())
    expect(sender.calls.map((c) => [c.quote, c.content.startsWith(MENTION)])).toEqual([[undefined, false], ['M1', true], [undefined, false]])
  })

  it('attach always: quote and @ ignore the platform-refused record, and a success clears it', async () => {
    const { replier, sender, state } = setup({ session: asked })
    for (const key of ['markdown:quote', 'markdown:mention', 'text:quote']) state.rejected.add(key)
    await replier.card(priceCard(), { attach: 'always' })
    const md = toQQMarkdown(priceCard(), renderOptions()).md
    expect(sender.calls).toEqual([{ kind: 'markdown', content: MENTION + md, rows: expect.any(Array), quote: 'M1' }])
    expect([...state.rejected]).toEqual(['text:quote'])
  })

  it('attach always after an explicit quote still quotes again, and a refusal keeps the record', async () => {
    const { replier, sender, state } = setup({ session: asked })
    await replier.text('引用', { quote: 'M1' })
    sender.failNext(clientError)
    await replier.card(priceCard(), { attach: 'always' })
    expect(sender.calls.map((c) => c.quote)).toEqual(['M1', 'M1', undefined])
    expect([...state.rejected].sort()).toEqual(['markdown:mention', 'markdown:quote'])
  })

  it('never quotes an image; the first text after it carries the quote', async () => {
    const { replier, sender } = setup({ session: asked })
    await replier.image(Buffer.from([1]), 'image/png', '图')
    await replier.text('说明')
    expect(sender.calls.map((c) => c.quote)).toEqual([undefined, 'M1'])
  })

  it('the slow hint carries the quote when it goes first, and the card then does not', async () => {
    const { replier, sender } = setup({ session: asked })
    await replier.hint('⏳ 慢')
    await replier.card(priceCard())
    expect(sender.calls.map((c) => [c.kind, c.quote, c.content.startsWith(MENTION)])).toEqual([['text', 'M1', false], ['markdown', undefined, true]])
  })

  it('mentions only in groups on QQ: not in a direct chat, not on the sandbox, not as plain text', async () => {
    const direct = setup({ session: { ...asked, isDirect: true } })
    await direct.replier.card(priceCard())
    expect(direct.sender.calls[0].content.startsWith(MENTION)).toBe(false)
    expect(direct.sender.calls[0].quote).toBe('M1')
    const sandbox = setup({ rich: false, session: asked })
    await sandbox.replier.card(priceCard())
    expect(sandbox.sender.calls).toEqual([{ kind: 'text', content: toText(priceCard(), renderOptions()), quote: 'M1' }])
    const text = setup({ mode: 'text', session: asked })
    await text.replier.card(priceCard())
    await text.replier.card(priceCard())
    expect(text.sender.calls.map((c) => c.quote)).toEqual(['M1', undefined])
    expect(text.sender.calls.some((c) => c.content.includes('qqbot-at-user'))).toBe(false)
  })

  it('records the text without the mention for self-echo detection', async () => {
    const { replier, state } = setup({ session: asked })
    await replier.card(priceCard())
    expect(state.echo.seen('qq:G1', toQQMarkdown(priceCard(), renderOptions()).md, NOW + 1000)).toBe(true)
  })

  it('resends once without quote and mention when the platform refuses them, and remembers it', async () => {
    const { replier, sender, state, logs } = setup({ session: asked })
    sender.failNext(clientError)
    expect(await replier.card(priceCard())).toBe(true)
    const md = toQQMarkdown(priceCard(), renderOptions()).md
    expect(sender.calls.map((c) => [c.content, c.quote])).toEqual([[MENTION + md, 'M1'], [md, undefined]])
    expect([...state.rejected].sort()).toEqual(['markdown:mention', 'markdown:quote'])
    expect(state.breaker.status(NOW).recentFailures).toBe(0)
    expect(replier.remaining()).toBe(3)
    expect(logs.lines).toHaveLength(1)
    // 之后的回复不再带
    const next = setup({ state, session: asked })
    await next.replier.card(priceCard())
    expect(next.sender.calls).toEqual([{ kind: 'markdown', content: md, rows: expect.any(Array) }])
    // 纯文字消息没有被拒绝过，照样引用
    const plain = setup({ state, session: asked })
    await plain.replier.text('x')
    expect(plain.sender.calls[0].quote).toBe('M1')
  })

  it('remembers a refused quote on plain text per kind', async () => {
    const { replier, sender, state } = setup({ session: asked, mode: 'text' })
    sender.failNext(clientError)
    expect(await replier.text('你好')).toBe(true)
    expect(sender.calls.map((c) => c.quote)).toEqual(['M1', undefined])
    expect([...state.rejected]).toEqual(['text:quote'])
  })

  it.each([
    ['reply limit', { ...clientError, code: QQ_ERROR.REPLY_LIMIT }],
    ['markdown too long', { ...clientError, code: QQ_ERROR.MARKDOWN_TOO_LONG }],
    ['server error', { ...clientError, status: 500 }],
    ['network error', { ok: false as const, sent: 0, message: 'fetch failed' }],
  ])('does not retry without them on %s', async (_, failure) => {
    const { replier, sender, state } = setup({ session: asked, mode: 'text' })
    sender.failNext(failure)
    expect(await replier.text('你好')).toBe(false)
    expect(sender.calls).toHaveLength(1)
    expect(state.rejected.size).toBe(0)
  })

  it('a card that fails even without them still takes the normal degrade chain, counted once for the breaker', async () => {
    const { replier, sender, state } = setup({ session: asked })
    sender.failNext(rejected, rejected)
    expect(await replier.card(priceCard())).toBe(true)
    expect(sender.calls.map((c) => [c.kind, c.quote])).toEqual([['markdown', 'M1'], ['markdown', undefined], ['text', 'M1']])
    expect(state.breaker.status(NOW).recentFailures).toBe(1)
    expect(state.rejected.size).toBe(0)
  })
})

describe('Replier', () => {
  it('sends a card as one markdown message with its buttons and remembers the text', async () => {
    const { replier, sender, state } = setup()
    expect(await replier.card(priceCard())).toBe(true)
    const expected = toQQMarkdown(priceCard(), renderOptions())
    expect(sender.calls).toEqual([{ kind: 'markdown', content: expected.md, rows: expected.rows }])
    expect(replier.remaining()).toBe(3)
    expect(state.echo.seen('qq:G1', expected.md, NOW + 30_000)).toBe(true)
  })

  it('splits long cards within the budget, with buttons only on the last part', async () => {
    const { replier, sender } = setup({ budget: 4 })
    expect(await replier.card(longCard(300))).toBe(true)
    expect(sender.calls).toHaveLength(3)
    expect(sender.calls.map((c) => c.rows?.length)).toEqual([0, 0, 1])
    for (const call of sender.calls) expect(call.content.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(sender.calls[2].content).toMatch(/另有 \d+ 行未显示，合计已包含/)
  })

  it('leaves room for copy blocks', async () => {
    const { replier, sender } = setup({ budget: 3 })
    const card = longCard(300)
    card.copyBlocks = ['Tritanium\t100', 'Pyerite\t50']
    expect(await replier.card(card)).toBe(true)
    expect(sender.calls.map((c) => c.kind)).toEqual(['markdown', 'text', 'text'])
    expect(sender.calls.slice(1).map((c) => c.content)).toEqual(['Tritanium\t100', 'Pyerite\t50'])
  })

  it('sends nothing for an empty card', async () => {
    const { replier, sender } = setup()
    expect(await replier.card({ title: '', meta: [], sections: [], warnings: [], footer: '', notices: [], actions: [] })).toBe(true)
    expect(sender.calls).toEqual([])
    expect(replier.remaining()).toBe(4)
  })

  it('stops at the budget and logs it once', async () => {
    const { replier, sender, logs } = setup({ budget: 2 })
    expect(await replier.text('1')).toBe(true)
    expect(await replier.text('2')).toBe(true)
    expect(await replier.text('3')).toBe(false)
    expect(await replier.card(priceCard())).toBe(false)
    expect(sender.calls).toHaveLength(2)
    expect(replier.remaining()).toBe(0)
    expect(logs.lines.filter((l) => l.includes('预算'))).toHaveLength(1)
  })

  it('does not reply to messages older than 290 seconds', async () => {
    const late = setup({ ageSec: 291 })
    expect(await late.replier.card(priceCard())).toBe(false)
    expect(await late.replier.image(Buffer.from([1]), 'image/png')).toBe(false)
    expect(late.sender.calls).toEqual([])
    expect(late.logs.lines.some((l) => l.includes('290'))).toBe(true)
    const inTime = setup({ ageSec: 289 })
    expect(await inTime.replier.text('ok')).toBe(true)
  })

  it('stops in the middle of a long reply when the time runs out', async () => {
    const clock = { now: NOW }
    const { replier, sender } = setup({ clock, ageSec: 280 })
    expect(await replier.text('第一条')).toBe(true)
    clock.now += 11_000
    expect(await replier.text('第二条')).toBe(false)
    expect(sender.calls).toHaveLength(1)
  })

  it('falls back to plain text when markdown is rejected, and keeps using text', async () => {
    const { replier, sender, state } = setup()
    sender.failNext(rejected)
    expect(await replier.card(priceCard())).toBe(true)
    expect(sender.calls.map((c) => c.kind)).toEqual(['markdown', 'text'])
    expect(sender.calls[1].content).toBe(toText(priceCard(), renderOptions()))
    expect(state.breaker.status(NOW).recentFailures).toBe(1)
    expect(await replier.card(candidateCard())).toBe(true)
    expect(sender.calls[2].kind).toBe('text')
    expect(replier.remaining()).toBe(2)
  })

  it('drops the buttons when the keyboard is rejected and writes the actions as text', async () => {
    const { replier, sender } = setup()
    sender.failNext({ ...rejected, message: 'keyboard 不合法' })
    expect(await replier.card(priceCard())).toBe(true)
    expect(sender.calls.map((c) => [c.kind, c.rows?.length])).toEqual([['markdown', 1], ['markdown', 0]])
    expect(sender.calls[1].content).toBe(toQQMarkdown(priceCard(), renderOptions({ clickable: 'none' })).md)
    expect(sender.calls[1].content).toContain('月度走势：@我 发送「走势 乌鸦级 月」')
  })

  it('removes link-like text and sends again when the platform refuses links', async () => {
    const { replier, sender } = setup()
    const card = priceCard()
    card.notices = ['详见 example.com']
    sender.failNext({ ...rejected, code: QQ_ERROR.URL_NOT_ALLOWED })
    expect(await replier.card(card)).toBe(true)
    expect(sender.calls).toHaveLength(2)
    expect(sender.calls[0].content).toContain('example.com')
    expect(sender.calls[1].content).toContain('> 📢 详见 [链接]')
    expect(sender.calls[1].rows).toEqual(sender.calls[0].rows)
    await replier.text('再看 example.com')
    expect(sender.calls[2].content).toBe('再看 [链接]')
  })

  it('stops when the platform says the reply limit is reached', async () => {
    const { replier, sender } = setup()
    sender.failNext({ ...rejected, code: QQ_ERROR.REPLY_LIMIT })
    expect(await replier.card(priceCard())).toBe(false)
    expect(await replier.text('还想发')).toBe(false)
    expect(sender.calls).toHaveLength(1)
    expect(replier.remaining()).toBe(0)
  })

  it('degrades only once per user message', async () => {
    const { replier, sender, logs } = setup()
    sender.failNext(rejected, { ...rejected, code: 40054098, message: 'text 也不行' })
    expect(await replier.card(priceCard())).toBe(false)
    expect(await replier.text('还想发')).toBe(false)
    expect(sender.calls.map((c) => c.kind)).toEqual(['markdown', 'text'])
    // 只记错误码和长度，不记内容
    expect(logs.lines.join('\n')).not.toContain('乌鸦级')
    expect(logs.lines.some((l) => l.includes('40054099'))).toBe(true)
  })

  it('does not retry network errors or server errors', async () => {
    const network = setup()
    network.sender.failNext({ ok: false, message: 'fetch failed' })
    expect(await network.replier.card(priceCard())).toBe(false)
    expect(network.sender.calls).toHaveLength(1)
    const server = setup()
    server.sender.failNext({ ok: false, status: 502, message: 'Bad Gateway' })
    expect(await server.replier.text('x')).toBe(false)
    expect(server.sender.calls).toHaveLength(1)
  })

  it('opens the breaker after 3 markdown failures in 10 minutes and sends text for 30 minutes', async () => {
    const state = createSendState()
    const clock = { now: NOW }
    for (let i = 0; i < 3; i++) {
      const { sender, replier } = setup({ state, clock })
      sender.failNext(rejected)
      expect(await replier.card(priceCard())).toBe(true)
      clock.now += 60_000
    }
    expect(state.breaker.status(clock.now).open).toBe(true)
    const during = setup({ state, clock })
    await during.replier.card(priceCard())
    expect(during.sender.calls.map((c) => c.kind)).toEqual(['text'])
    clock.now += 30 * 60_000
    const after = setup({ state, clock })
    await after.replier.card(priceCard())
    expect(after.sender.calls.map((c) => c.kind)).toEqual(['markdown'])
  })

  it('logs the same error code at most once an hour', async () => {
    const state = createSendState()
    const clock = { now: NOW }
    const lines: string[] = []
    for (let i = 0; i < 3; i++) {
      const { sender, replier, logs } = setup({ state, clock })
      sender.failNext({ ...rejected, code: QQ_ERROR.REPLY_LIMIT })
      await replier.text('x')
      lines.push(...logs.lines)
      clock.now += 10 * 60_000
    }
    expect(lines.filter((l) => l.includes('40034128'))).toHaveLength(1)
  })

  it('uses plain text in text mode and on senders that cannot send markdown', async () => {
    const textMode = setup({ mode: 'text' })
    await textMode.replier.card(priceCard())
    expect(textMode.sender.calls).toEqual([{ kind: 'text', content: toText(priceCard(), renderOptions()) }])
    const sandbox = setup({ rich: false })
    await sandbox.replier.card(candidateCard())
    expect(sandbox.sender.calls.map((c) => c.kind)).toEqual(['text'])
    expect(sandbox.sender.calls[0].content).toContain('回复 @我 1：大型护盾扩展装置 II')
  })

  it('sends at most one slow hint', async () => {
    const { replier, sender } = setup()
    expect(await replier.hint('⏳ 正在截取战报，一般要 10–30 秒…')).toBe(true)
    expect(await replier.hint('⏳ 还在截图')).toBe(false)
    expect(sender.calls).toHaveLength(1)
    expect(replier.remaining()).toBe(3)
  })

  it('sends images and counts a caption that went out without its image', async () => {
    const { replier, sender, state } = setup()
    expect(await replier.image(Buffer.from([1, 2, 3]), 'image/png', '势力图')).toBe(true)
    expect(sender.calls[0]).toEqual({ kind: 'image', content: 'image/png 3 势力图' })
    expect(state.echo.seen('qq:G1', '势力图', NOW)).toBe(true)
    sender.failNext({ ok: false, sent: 1, code: 850012, message: 'upload failed' })
    expect(await replier.image(Buffer.from([1]), 'image/jpeg', '战报')).toBe(false)
    expect(replier.remaining()).toBe(2)
    // 图片失败不影响后面的文字
    expect(await replier.text('图片发不出去，改发文字')).toBe(true)
  })

  it('splits long text into at most the remaining budget', async () => {
    const { replier, sender } = setup({ budget: 2 })
    const long = Array.from({ length: 400 }, (_, i) => `第 ${i} 行：${'内容'.repeat(10)}`).join('\n')
    expect(await replier.text(long)).toBe(true)
    expect(sender.calls).toHaveLength(2)
    expect(sender.calls[1].content).toMatch(/另有 \d+ 行未显示$/)
  })

  it('a quoted text quotes only its first part; maxChars allows one longer message up to the hard limit', async () => {
    const { replier, sender } = setup()
    const long = Array.from({ length: 500 }, (_, i) => `第 ${i} 行：内容`).join('\n')
    expect(long.length).toBeGreaterThan(MAX_MESSAGE_CHARS)
    expect(await replier.text(long, { quote: 'MSG-9' })).toBe(true)
    expect(sender.calls.map((c) => c.quote)).toEqual(['MSG-9', undefined])
    const { replier: one, sender: single } = setup()
    const text = '字'.repeat(3900)
    expect(await one.text(text, { maxChars: 3900 })).toBe(true)
    expect(single.calls.map((c) => c.content.length)).toEqual([3900])
    // 不会超过硬上限
    const { replier: capped, sender: cut } = setup()
    expect(await capped.text('字'.repeat(4100), { maxChars: 9999 })).toBe(true)
    expect(cut.calls.every((c) => c.content.length <= 4000)).toBe(true)
  })

  it('a card can be allowed one longer message (up to the hard limit)', async () => {
    let rows = 40
    while (toQQMarkdown(longCard(rows), renderOptions()).md.length <= MAX_MESSAGE_CHARS) rows++
    const card = longCard(rows)
    const length = toQQMarkdown(card, renderOptions()).md.length
    expect(length).toBeLessThanOrEqual(4000)
    const normal = setup()
    await normal.replier.card(card)
    expect(normal.sender.calls).toHaveLength(2)
    // 按钮写成文字的那种版式也要放得下，所以给到硬上限
    const longer = setup()
    expect(await longer.replier.card(card, { maxChars: 4000 })).toBe(true)
    expect(longer.sender.calls.map((c) => c.content.length)).toEqual([length])
  })
})

