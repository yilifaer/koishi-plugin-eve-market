// 测试环境自己的测试：FakeBot 记录的东西对不对；真实适配器那一套能跑通整条链路（范围 → 前置中间件 → 命令 → 发送）。

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { h as el } from 'koishi'
import type { Context } from 'koishi'
import { afterEach, describe, expect, it } from 'vitest'
import { createReplier, createSendState, replyBudget } from '../../../src/bot/send/replier'
import { markdownElements } from '../../../src/bot/send/qq-sender'
import { QQ_ERROR } from '../../../src/constants'
import { GROUP, MEMBER, QQ_SELF, REAL_GROUP, REAL_MEMBER, REAL_USER, startHarness, startRealQQ } from '../../harness'
import type { Harness, RealQQ } from '../../harness'
import { wirePlugin } from './wiring'
import type { Wiring, WiringOptions } from './wiring'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const render = { numberStyle: 'code' as const, clickable: 'buttons' as const, cmdInputInLists: false, commandName: () => '查价' }

describe('startHarness', () => {
  let h: Harness

  afterEach(async () => {
    await h?.stop()
  })

  it('records markdown, buttons in rows (bare / button-group alternating) and plain text', async () => {
    h = await startHarness({
      setup: (app: Context) => {
        app.platform('qq').command('card').action(async ({ session }) => {
          const rows = [
            [{ label: '1', text: '查价 a' }, { label: '2', text: '查价 b' }],
            [{ label: '月', text: '走势 a 月', primary: true }],
            [{ label: '季', text: '走势 a 季' }],
          ]
          await session!.bot.sendMessage(session!.channelId!, markdownElements('**标题**\n- 一行', rows), undefined, { session })
          await session!.send(el.text('纯文字 <不是标签>'))
        })
      },
    })
    const [card, plain] = await h.group('card')
    expect(card.markdown).toBe('**标题**\n- 一行')
    expect(card.rows).toEqual([
      [{ label: '1', text: '查价 a', primary: false }, { label: '2', text: '查价 b', primary: false }],
      [{ label: '月', text: '走势 a 月', primary: true }],
      [{ label: '季', text: '走势 a 季', primary: false }],
    ])
    expect(card.channelId).toBe(GROUP)
    expect(card.session?.userId).toBe(MEMBER)
    expect(plain.markdown).toBeUndefined()
    expect(plain.text).toBe('纯文字 <不是标签>')
    expect(h.qq.sent).toHaveLength(2)
  })

  it('renders Koishi components like a real adapter (i18n texts)', async () => {
    h = await startHarness({
      setup: (app) => {
        app.platform('qq').command('boom').action(() => {
          throw new Error('boom')
        })
      },
    })
    const [reply] = await h.group('boom')
    expect(reply.text).toBe('发生未知错误。')
  })

  it('injects send failures shaped like the adapter\'s, which the Replier understands', async () => {
    h = await startHarness({
      setup: (app) => {
        app.platform('qq').command('limited').action(async ({ session }) => {
          const replier = createReplier(session!, { budget: replyBudget(4, false), mode: 'text', render, state: createSendState(), logger: silent })
          expect(await replier.text('第一条')).toBe(false)
          expect(await replier.text('第二条')).toBe(false)
        })
      },
    })
    h.qq.fail({ code: QQ_ERROR.REPLY_LIMIT, message: '超过被动回复次数' })
    expect(await h.group('limited')).toEqual([])
  })

  it('sets Koishi authority', async () => {
    h = await startHarness({
      setup: (app) => {
        app.platform('qq').command('who').userFields(['authority']).action(async ({ session }) => {
          await session!.send(`authority ${session!.user!.authority}`)
        })
      },
    })
    expect((await h.group('who')).map((s) => s.text)).toEqual(['authority 1'])
    await h.authority(MEMBER, 4)
    expect((await h.group('who')).map((s) => s.text)).toEqual(['authority 4'])
  })

  it('uses a temporary instance directory and removes it on stop', async () => {
    h = await startHarness()
    const dir = h.app.baseDir
    expect(path.relative(os.tmpdir(), dir).startsWith('..')).toBe(false)
    await fs.writeFile(path.join(dir, 'probe'), 'x')
    await h.stop()
    await expect(fs.stat(dir)).rejects.toThrow()
    h = await startHarness()
  })

  it('the bot\'s own messages are dropped by Koishi without hanging', async () => {
    h = await startHarness()
    expect(await h.self('anything')).toEqual([])
    expect(QQ_SELF).toBe(h.qq.selfId)
  })
})

describe('startRealQQ (real adapter-qq + fake OpenAPI)', () => {
  let qq: RealQQ
  let w: Wiring

  async function start(options: WiringOptions = {}) {
    let ref: { current: Wiring | null } = { current: null }
    qq = await startRealQQ({ help: true, setup: (app) => { ref = wirePlugin(app, options) } })
    w = ref.current!
  }

  afterEach(async () => {
    await qq?.stop()
  })

  const contents = (sent: Array<{ body: { content?: string } }>) => sent.map((m) => m.body.content)

  it('a group @ message goes through scope, prefix and command, and is answered as a passive reply', async () => {
    await start()
    const sent = await qq.group('/查价乌鸦级', { messageId: 'REAL-A' })
    expect(contents(sent)).toEqual(['price:乌鸦级'])
    expect(sent[0]).toMatchObject({ scope: 'group', openid: REAL_GROUP, body: { msg_type: 0, msg_id: 'REAL-A', msg_seq: 1 } })
    expect(w.calls[0].access).toMatchObject({ userId: REAL_MEMBER, channelId: REAL_GROUP, isDirect: false })
  })

  it('direct messages are answered to the user', async () => {
    await start()
    const sent = await qq.direct('入侵')
    expect(sent).toMatchObject([{ scope: 'user', openid: REAL_USER, body: { content: 'incursion:' } }])
  })

  it('全量消息: without @ nothing happens under requireAt; the same message via both events is answered once', async () => {
    await start({ general: { requireAt: false } })
    expect(contents(await qq.group('入侵', { messageId: 'SAME-1' }))).toEqual(['incursion:'])
    expect(await qq.groupAll('入侵', { messageId: 'SAME-1' })).toEqual([])
    expect(w.calls).toHaveLength(1)
    await qq.stop()
    await start()
    expect(await qq.groupAll('入侵')).toEqual([])
    expect(w.calls).toEqual([])
  })

  it('our own text coming back through the all-message event is ignored', async () => {
    await start({ general: { requireAt: false } })
    expect(contents(await qq.groupAll('查价 乌鸦级'))).toEqual(['price:乌鸦级'])
    // 机器人自己的消息在群里的作者 ID 不是 selfId，Koishi 不会过滤
    expect(await qq.groupAll('price:乌鸦级', { authorId: 'BOT-AS-MEMBER' })).toEqual([])
    expect(w.calls).toHaveLength(1)
  })

  it('union_openid from the event reaches Access', async () => {
    await start({ access: { admins: ['UNION-ADMIN'] } })
    await qq.group('入侵', { unionId: 'UNION-ADMIN' })
    expect(w.calls[0].access).toMatchObject({ unionId: 'UNION-ADMIN', isAdmin: true })
  })

  it('plugin-help is installed and 帮助 still gets exactly one reply from us', async () => {
    await start()
    expect(contents(await qq.group('帮助查价'))).toEqual(['help:查价'])
  })
})
