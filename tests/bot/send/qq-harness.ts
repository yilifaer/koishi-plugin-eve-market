// 高保真测试的环境：真实的 Koishi 4.18 + 真实的 @satorijs/adapter-qq 4.14.0，接本机的假 QQ 开放平台。
// 不连网关：预置 access token，用 adaptSession 把事件变成会话，再经 bot.dispatch 走一遍 Koishi 的中间件。

import { Context } from 'koishi'
import type { Session } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import { QQBot, adaptSession } from '@satorijs/adapter-qq'
import { ACCESS_TOKEN, APP_ID, BOT_USER_ID, FakeQQOpenApi } from '../../fakes/fake-qq-openapi'

export const GROUP_OPENID = 'C0FFEE00000000000000000000000001'
export const MEMBER_OPENID = 'BEEF0000000000000000000000000001'
export const USER_OPENID = 'BEEF0000000000000000000000000002'

export interface QQHarness {
  ctx: Context
  bot: QQBot<Context>
  api: FakeQQOpenApi
  /** 群里 @机器人 的一条消息；ageSec：这条消息是多少秒之前发的 */
  group(content: string, options?: { ageSec?: number }): Promise<Session>
  /** 单聊消息 */
  direct(content: string, options?: { ageSec?: number }): Promise<Session>
  stop(): Promise<void>
}

export async function startQQ(): Promise<QQHarness> {
  const api = new FakeQQOpenApi()
  await api.start()
  const ctx = new Context()
  // 这两个包的类型声明对不上 koishi 的 Context（依赖的是另一份 cordis 类型），运行时没有问题
  ctx.plugin(HTTP as never)
  ctx.plugin(QQBot as never, { id: APP_ID, secret: 'unused', type: 'private', endpoint: `${api.base}/`, protocol: 'webhook', path: '/qq' })
  await ctx.start()
  const bot = ctx.bots.find((b) => b.platform === 'qq') as unknown as QQBot<Context>
  // 预置 token：不去请求 bots.qq.com
  const seeded = bot as unknown as { _token: string }
  seeded._token = ACCESS_TOKEN
  bot.http.config.headers!.Authorization = `QQBot ${ACCESS_TOKEN}`
  bot.user = { id: BOT_USER_ID, name: 'eve-market-test' }

  let seq = 0
  let waiting: ((session: Session) => void) | null = null
  ctx.middleware((session, next) => {
    if (waiting) {
      waiting(session)
      waiting = null
      return
    }
    return next()
  })

  async function inject(type: 'GROUP_AT_MESSAGE_CREATE' | 'C2C_MESSAGE_CREATE', content: string, ageSec = 0): Promise<Session> {
    seq++
    const author = type === 'GROUP_AT_MESSAGE_CREATE'
      ? { id: MEMBER_OPENID, member_openid: MEMBER_OPENID }
      : { id: USER_OPENID, user_openid: USER_OPENID }
    const d = {
      id: `MSG-${seq}`,
      content: ` ${content}`,
      timestamp: new Date(Date.now() - ageSec * 1000).toISOString(),
      author,
      ...type === 'GROUP_AT_MESSAGE_CREATE' ? { group_id: GROUP_OPENID, group_openid: GROUP_OPENID } : {},
    }
    const session = await adaptSession(bot, { op: 0, s: seq, t: type, id: `EVT-${seq}`, d } as never)
    if (!session) throw new Error('adapter ignored the event')
    const received = new Promise<Session>((resolve) => { waiting = resolve })
    bot.dispatch(session as never)
    return received
  }

  return {
    ctx,
    bot,
    api,
    group: (content, options) => inject('GROUP_AT_MESSAGE_CREATE', content, options?.ageSec),
    direct: (content, options) => inject('C2C_MESSAGE_CREATE', content, options?.ageSec),
    async stop() {
      bot.ctx.scope.dispose()
      await ctx.stop()
      await api.stop()
    },
  }
}
