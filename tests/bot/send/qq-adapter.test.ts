// 高保真：真实的 Koishi + @satorijs/adapter-qq 4.14.0，接本机的假 QQ 开放平台，检查真正发出去的请求。

import { Bot, Context, h } from 'koishi'
import type { Session } from 'koishi'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReplier, createSendState, replyBudget } from '../../../src/bot/send/replier'
import type { ReplierOptions } from '../../../src/bot/send/replier'
import type { Card } from '../../../src/bot/view/card'
import { toQQMarkdown } from '../../../src/bot/view/markdown'
import { toText } from '../../../src/bot/view/text'
import { QQ_ERROR } from '../../../src/constants'
import type { QQMessageBody } from '../../fakes/fake-qq-openapi'
import { candidateCard, longCard, priceCard, renderOptions } from '../view/cards'
import { GROUP_OPENID, MEMBER_OPENID, USER_OPENID, startQQ } from './qq-harness'
import type { QQHarness } from './qq-harness'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function replierFor(session: Session, options: Partial<ReplierOptions> = {}) {
  return createReplier(session, {
    budget: replyBudget(4, session.isDirect),
    mode: 'markdown',
    render: renderOptions(),
    state: createSendState(),
    logger: silent,
    ...options,
  })
}

const action = (label: string, primary = false) => ({ label, command: { id: 'trend' as const, args: `乌鸦级 ${label}` }, ...primary ? { primary } : {} })

/** 8 个候选（2 行编号）+ 3 行动作 = 5 行 */
function fullKeyboardCard(): Card {
  const card = candidateCard(8)
  card.actions = [[action('月', true), action('季')], [action('年')], [action('周')]]
  return card
}

const rowsOf = (body: QQMessageBody) => body.keyboard!.content.rows.map((r) => r.buttons.map((b) => b.render_data.label))

describe('QQ adapter (high fidelity)', () => {
  let qq: QQHarness

  beforeEach(async () => {
    qq = await startQQ()
  })

  afterEach(async () => {
    await qq.stop()
  })

  it('sends one markdown message (msg_type 2) with a keyboard of 5 rows and no blank rows', async () => {
    const session = await qq.group('查价 护盾扩展装置 II')
    const card = fullKeyboardCard()
    expect(await replierFor(session).card(card)).toBe(true)
    expect(qq.api.messages).toHaveLength(1)
    const [sent] = qq.api.messages
    expect(sent.scope).toBe('group')
    expect(sent.openid).toBe(GROUP_OPENID)
    const body = sent.body
    expect(body.msg_type).toBe(2)
    expect(body.content).toBeUndefined()
    expect(body.msg_id).toBe(session.messageId)
    expect(body.msg_seq).toBe(1)
    // 群里的第一张 Markdown 卡片：引用用户的消息，开头 @ 提问的人
    expect(body.markdown!.content).toBe(`<qqbot-at-user id="${MEMBER_OPENID}" /> ${toQQMarkdown(card, renderOptions()).md}`)
    expect((body as { message_reference?: unknown }).message_reference).toEqual({ message_id: session.messageId })
    expect(rowsOf(body)).toEqual([['1', '2', '3', '4', '5'], ['6', '7', '8'], ['月', '季'], ['年'], ['周']])
    const buttons = body.keyboard!.content.rows.flatMap((r) => r.buttons)
    for (const button of buttons) {
      expect(button.action.type).toBe(2)
      expect(button.action.permission.type).toBe(2)
      expect(button.id).toBeTruthy()
    }
    expect(buttons[0].action.data).toBe('查价 Jita 大型护盾扩展装置 II*4')
    expect(buttons.find((b) => b.render_data.label === '月')!.render_data.style).toBe(1)
    expect(buttons.find((b) => b.render_data.label === '季')!.render_data.style).toBe(0)
  })

  it('keyboard rows stay compact for 2, 3 and 4 rows too', async () => {
    for (const rows of [2, 3, 4]) {
      const session = await qq.group('查价 乌鸦级')
      const card = priceCard()
      card.actions = Array.from({ length: rows }, (_, i) => [action(`r${i}a`), action(`r${i}b`)])
      await replierFor(session).card(card)
      const body = qq.api.messages.at(-1)!.body
      expect(rowsOf(body)).toEqual(Array.from({ length: rows }, (_, i) => [`r${i}a`, `r${i}b`]))
    }
  })

  it('wrapping every row in a button-group leaves blank rows: 3 rows become 5 (why rows alternate)', async () => {
    const session = await qq.group('查价 乌鸦级')
    const group = (label: string) => h('button-group', {}, [h('button', { type: 'input', text: label }, label)])
    await session.bot.sendMessage(session.channelId!, [h('qq:markdown', {}, 'x'), group('a'), group('b'), group('c')], undefined, { session })
    expect(rowsOf(qq.api.messages[0].body)).toEqual([['a'], [], ['b'], [], ['c']])
  })

  it('keeps <qqbot-cmd-input> intact inside the markdown', async () => {
    const session = await qq.group('查价 护盾扩展装置 II')
    await replierFor(session, { render: renderOptions({ cmdInputInLists: true }) }).card(candidateCard(2))
    expect(qq.api.messages[0].body.markdown!.content).toContain('1. <qqbot-cmd-input text="查价 Jita 大型护盾扩展装置 II*4" show="大型护盾扩展装置 II" reference="false" />')
  })

  it('increments msg_seq for every message replying to the same msg_id; buttons only on the last part', async () => {
    const session = await qq.group('批量查价')
    const replier = replierFor(session)
    expect(await replier.hint('⏳ 正在查询 300 种物品的价格…')).toBe(true)
    expect(await replier.card(longCard(300))).toBe(true)
    const bodies = qq.api.messages.map((m) => m.body)
    expect(bodies).toHaveLength(4)
    expect(bodies.map((b) => b.msg_seq)).toEqual([1, 2, 3, 4])
    expect(new Set(bodies.map((b) => b.msg_id))).toEqual(new Set([session.messageId]))
    expect(bodies.map((b) => b.msg_type)).toEqual([0, 2, 2, 2])
    expect(bodies.map((b) => !!b.keyboard)).toEqual([false, false, false, true])
    expect(bodies[0].content).toBe('⏳ 正在查询 300 种物品的价格…')
    expect(replier.remaining()).toBe(0)
  })

  it('uploads images (file_type 1, exact bytes) and sends them with the caption as msg_type 7', async () => {
    const session = await qq.group('势力图')
    const backing = new Uint8Array([7, 7, 0x89, 0x50, 0x4e, 0x47, 7])
    const png = backing.subarray(2, 6) as Buffer
    expect(await replierFor(session).image(png, 'image/png', '势力图 · 更新于 14:20')).toBe(true)
    expect(qq.api.uploads).toHaveLength(1)
    const [upload] = qq.api.uploads
    expect(upload.scope).toBe('group')
    expect(upload.fileType).toBe(1)
    expect([...upload.data]).toEqual([0x89, 0x50, 0x4e, 0x47])
    const [message] = qq.api.messages
    expect(message.body.msg_type).toBe(7)
    expect(message.body.media).toEqual({ file_uuid: `uuid-${upload.fileInfo}`, file_info: upload.fileInfo, ttl: 3600 })
    expect(message.body.content).toBe('势力图 · 更新于 14:20')
    expect(message.body.msg_seq).toBe(1)
  })

  it('falls back to plain text when the platform rejects the markdown', async () => {
    // 去掉引用和提醒重发一次也被拒绝：Markdown 本身有问题，才降级
    qq.api.fault(/\/messages$/, { status: 400, code: 40054099, message: 'markdown 格式不对' }, { times: 2, when: (req) => req.json?.msg_type === 2 })
    const session = await qq.group('查价 乌鸦级')
    const state = createSendState()
    expect(await replierFor(session, { state }).card(priceCard())).toBe(true)
    expect(qq.api.sends.map((r) => [r.json?.msg_type, r.json?.msg_seq])).toEqual([[2, 1], [2, 2], [0, 3]])
    expect(state.rejected.size).toBe(0)
    expect(qq.api.messages).toHaveLength(1)
    expect(qq.api.messages[0].body.content).toBe(toText(priceCard(), renderOptions()))
    expect(state.breaker.status(Date.now()).recentFailures).toBe(1)
  })

  it('drops the keyboard when the platform rejects the buttons', async () => {
    qq.api.fault(/\/messages$/, { status: 400, code: 40054098, message: 'keyboard 不合法' }, { times: 2, when: (req) => !!req.json?.keyboard })
    const session = await qq.group('查价 乌鸦级')
    expect(await replierFor(session).card(priceCard())).toBe(true)
    const [message] = qq.api.messages
    expect(message.body.msg_type).toBe(2)
    expect(message.body.keyboard).toBeUndefined()
    expect(message.body.markdown!.content).toContain('月度走势：@我 发送「走势 乌鸦级 月」')
  })

  it('removes link-like text when the platform refuses links', async () => {
    qq.api.fault(/\/messages$/, { status: 400, code: QQ_ERROR.URL_NOT_ALLOWED, message: '不允许发送URL' })
    const session = await qq.group('查价 乌鸦级')
    const card = priceCard()
    card.notices = ['详见 example.com']
    expect(await replierFor(session).card(card)).toBe(true)
    expect(qq.api.messages[0].body.markdown!.content).toContain('> 📢 详见 [链接]')
  })

  it('stops at the budget: 4 replies in a group, 3 in a direct chat', async () => {
    const group = await qq.group('查价 乌鸦级')
    const replier = replierFor(group)
    const results = []
    for (let i = 0; i < 6; i++) results.push(await replier.text(`第 ${i + 1} 条`))
    expect(results).toEqual([true, true, true, true, false, false])
    expect(qq.api.sends).toHaveLength(4)

    const direct = await qq.direct('查价 乌鸦级')
    expect(direct.isDirect).toBe(true)
    const dm = replierFor(direct)
    for (let i = 0; i < 4; i++) await dm.text(`单聊 ${i + 1}`)
    const dms = qq.api.messages.filter((m) => m.scope === 'user')
    expect(dms).toHaveLength(3)
    expect(dms[0].openid).toBe(USER_OPENID)
    expect(dms.map((m) => m.body.msg_seq)).toEqual([1, 2, 3])
  })

  it('stops when the platform refuses with the reply limit', async () => {
    const session = await qq.group('查价 乌鸦级')
    const replier = replierFor(session, { budget: 10 })
    const results = []
    for (let i = 0; i < 7; i++) results.push(await replier.text(`第 ${i + 1} 条`))
    expect(results).toEqual([true, true, true, true, true, false, false])
    // 第 6 条被拒（40034128）以后不再尝试
    expect(qq.api.sends).toHaveLength(6)
  })

  it('does not send at all once the message is older than 290 seconds', async () => {
    const old = await qq.group('查价 乌鸦级', { ageSec: 295 })
    expect(await replierFor(old).card(priceCard())).toBe(false)
    expect(await replierFor(old).image(Buffer.from([1]), 'image/png')).toBe(false)
    expect(qq.api.requests.filter((r) => r.method === 'POST')).toEqual([])
    const recent = await qq.group('查价 乌鸦级', { ageSec: 280 })
    expect(await replierFor(recent).text('还来得及')).toBe(true)
    expect(qq.api.messages[0].body.msg_id).toBe(recent.messageId)
  })

  it('uploads to the user endpoint in direct chats', async () => {
    const session = await qq.direct('势力图')
    expect(await replierFor(session).image(Buffer.from([1, 2]), 'image/jpeg')).toBe(true)
    expect(qq.api.uploads[0].scope).toBe('user')
    expect(qq.api.uploads[0].openid).toBe(USER_OPENID)
    expect(qq.api.messages[0].scope).toBe('user')
  })

  it('survives a dropped connection without throwing', async () => {
    qq.api.fault(/\/messages$/, { destroy: true })
    const session = await qq.group('查价 乌鸦级')
    const replier = replierFor(session)
    expect(await replier.card(priceCard())).toBe(false)
    expect(await replier.text('x')).toBe(false)
    expect(qq.api.sends).toHaveLength(1)
  })
})

/** 控制台沙盒那样的平台：只能经 session.send 发 */
class SandboxBot extends Bot<Context> {
  sent: h[][] = []

  constructor(ctx: Context) {
    super(ctx, {}, 'sandbox')
    this.platform = 'sandbox:test'
    this.user = { id: 'sandbox-bot' }
  }

  async sendMessage(_channelId: string, content: h.Fragment) {
    this.sent.push(h.normalize(content))
    return [`m${this.sent.length}`]
  }
}

describe('sandbox path', () => {
  it('sends plain text and images through session.send with the same budget', async () => {
    const ctx = new Context()
    ctx.plugin(SandboxBot)
    await ctx.start()
    const bot = ctx.bots.find((b) => b.platform === 'sandbox:test') as unknown as SandboxBot
    const received = new Promise<Session>((resolve) => ctx.middleware((session) => resolve(session)))
    bot.dispatch(bot.session({
      type: 'message',
      channel: { id: 'c1', type: 0 },
      user: { id: 'u1' },
      message: { id: 'm1', content: '查价 乌鸦级', elements: [h.text('查价 乌鸦级')] },
    }) as never)
    const session = await received
    const replier = replierFor(session, { budget: 3 })
    expect(await replier.card(priceCard())).toBe(true)
    expect(await replier.image(Buffer.from([1, 2, 3]), 'image/png', '图')).toBe(true)
    expect(await replier.text('第三条')).toBe(true)
    expect(await replier.text('超出预算')).toBe(false)
    expect(bot.sent).toHaveLength(3)
    // 沙盒上 Markdown 退回纯文字，没有 @ 提醒；第一条引用收到的消息
    expect(bot.sent[0].map((e) => e.type)).toEqual(['quote', 'text'])
    expect(bot.sent[0][0].attrs.id).toBe('m1')
    expect(bot.sent[0][1].attrs.content).toBe(toText(priceCard(), renderOptions()))
    expect(bot.sent[1].map((e) => e.type)).toEqual(['img', 'text'])
    expect(bot.sent[1][0].attrs.src).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)
    bot.ctx.scope.dispose()
    await ctx.stop()
  })
})
