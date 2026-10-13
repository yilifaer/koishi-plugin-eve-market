// 高保真：整个插件 + 真实的 @satorijs/adapter-qq 4.14.0，接本机的假 QQ 开放平台，检查真正发出去的请求：
// Markdown 是 msg_type 2、msg_seq 递增、被动回复带 msg_id、按钮行没有空行且不超过 5 行、Markdown 被拒后改发纯文字。

import { afterEach, describe, expect, it } from 'vitest'
import type { QQMessageBody, QQSentMessage } from '../../fakes/fake-qq-openapi'
import { REAL_GROUP, REAL_MEMBER, REAL_USER } from '../../harness'
import { RAVEN, THE_FORGE, addOrders, jitaOrders, startRealPlugin } from './plugin-env'
import type { RealEnv } from './plugin-env'

let env: RealEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

async function start(): Promise<RealEnv> {
  env = await startRealPlugin({ esi: (fake) => addOrders(fake, THE_FORGE, jitaOrders(RAVEN, 258_400_000, 249_000_000)) })
  return env
}

const rows = (body: QQMessageBody) => body.keyboard?.content.rows.map((r) => r.buttons.map((b) => b.render_data.label)) ?? []
const seqs = (messages: QQSentMessage[]) => messages.map((m) => m.body.msg_seq)

describe('the whole plugin on the real QQ adapter', () => {
  it('a price card is one Markdown message (msg_type 2) replying to the message, with its buttons', async () => {
    const { qq } = await start()
    const sent = await qq.group('查价 乌鸦级', { messageId: 'REAL-PRICE-1' })
    expect(sent).toHaveLength(1)
    const [msg] = sent
    expect(msg.scope).toBe('group')
    expect(msg.openid).toBe(REAL_GROUP)
    expect(msg.body.msg_type).toBe(2)
    expect(msg.body.msg_id).toBe('REAL-PRICE-1')
    expect(msg.body.msg_seq).toBe(1)
    expect(msg.body.content).toBeUndefined()
    // 群里第一张 Markdown 卡片：引用收到的消息，开头 @ 提问的人
    expect((msg.body as { message_reference?: unknown }).message_reference).toEqual({ message_id: 'REAL-PRICE-1' })
    expect(msg.body.markdown?.content).toMatch(new RegExp(`^<qqbot-at-user id="${REAL_MEMBER}" /> \\*\\*乌鸦级`))
    expect(msg.body.markdown?.content).toMatch(/\*\*乌鸦级 Raven · 战列舰\*\*\n\n\*\*Jita 4-4\*\*\n\n- 出售 `258,400,000 ISK`（258\.40M）/)
    const row = msg.body.keyboard!.content.rows[0].buttons
    expect(row.map((b) => b.render_data.label)).toEqual(['月度走势', '季度走势', '相关物品', '制造成本'])
    expect(row[0].action).toMatchObject({ type: 2, permission: { type: 2 }, data: '走势 乌鸦级 月' })
    expect(row[2].action).toMatchObject({ type: 2, permission: { type: 2 }, data: '搜索 乌鸦级' })
  })

  it('本群ID: three passive replies with increasing msg_seq — Markdown, then each ID as plain text', async () => {
    const { qq } = await start()
    const sent = await qq.group('本群ID', { unionId: 'UNION-REAL-1' })
    expect(sent.map((m) => m.body.msg_type)).toEqual([2, 0, 0])
    expect(seqs(sent)).toEqual([1, 2, 3])
    expect(new Set(sent.map((m) => m.body.msg_id)).size).toBe(1)
    expect(sent[0].body.markdown?.content).toContain('你的跨群 ID：UNION-REAL-1')
    expect(sent.slice(1).map((m) => m.body.content)).toEqual([REAL_GROUP, REAL_MEMBER])
  })

  it('in a direct chat 本群ID answers twice to the user', async () => {
    const { qq } = await start()
    const sent = await qq.direct('本群ID')
    expect(sent.map((m) => [m.scope, m.openid, m.body.msg_type])).toEqual([['user', REAL_USER, 2], ['user', REAL_USER, 0]])
    expect(sent[1].body.content).toBe(REAL_USER)
  })

  it('number buttons fill rows of 5, action buttons follow, no blank rows', async () => {
    const { qq } = await start()
    const [msg] = await qq.group('搜索 护盾')
    const labels = rows(msg.body)
    expect(labels.length).toBeLessThanOrEqual(5)
    expect(labels.every((r) => r.length > 0 && r.length <= 5)).toBe(true)
    expect(labels.slice(0, 2)).toEqual([['1', '2', '3', '4', '5'], ['6', '7', '8', '9', '10']])
    expect(labels[2]).toContain('下一页')
  })

  it('a message older than 290 seconds gets no reply at all (never a proactive message)', async () => {
    const { qq } = await start()
    expect(await qq.group('查价 乌鸦级', { ageSec: 295 })).toEqual([])
    expect(qq.api.sends).toEqual([])
  })

  it('when Markdown is rejected the same card goes out once as plain text', async () => {
    const { qq } = await start()
    qq.api.fault(/^\/v2\/groups\/[^/]+\/messages$/, { status: 400, code: 40054007, message: 'markdown 长度超限' }, { times: 1, when: (req) => req.json?.msg_type === 2 })
    const sent = await qq.group('查价 乌鸦级')
    expect(sent).toHaveLength(1)
    expect(sent[0].body.msg_type).toBe(0)
    expect(sent[0].body.content).toMatch(/^乌鸦级 Raven · 战列舰\n【Jita 4-4】\n出售 258,400,000 ISK \(258\.40M\)/)
    // 超长和引用 / @ 无关，不重发，直接改发纯文字
    expect(qq.api.sends.map((r) => r.json?.msg_type)).toEqual([2, 0])
  })
})
