// 集成测试的环境：真实的 Koishi 4.18 + 内存数据库 + @koishijs/plugin-http。
//
// - startHarness()：大部分用例用它。FakeBot（platform qq）记录发出去的元素，测试直接看 Markdown、按钮、纯文字和条数；
//   可选再加一个 onebot 平台的 FakeBot（检查不碰 LLBot 的消息）和 plugin-help。
// - startRealQQ()：少数高保真用例用真实的 @satorijs/adapter-qq 4.14.0，接 tests/fakes/fake-qq-openapi.ts 的本机假开放平台，
//   事件经 adaptSession + bot.dispatch 注入，检查真正发出去的请求。
//
// 两种环境都把 app.baseDir 设成一个临时目录（插件写的 data/eve-market 在那里），stop() 时删掉。
// 所有 ID 和名字都是编造的。

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Bot, Context, Universal, h } from 'koishi'
import type { Session } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import Memory from '@koishijs/plugin-database-memory'
import * as Help from '@koishijs/plugin-help'
import { QQBot, adaptSession } from '@satorijs/adapter-qq'
import { ACCESS_TOKEN, APP_ID, BOT_USER_ID, FakeQQOpenApi } from './fakes/fake-qq-openapi'
import type { QQSentMessage } from './fakes/fake-qq-openapi'

export const QQ_SELF = '9000000000000000001'
export const ONEBOT_SELF = '10000'
export const GROUP = 'C0FFEE00000000000000000000000001'
export const GROUP2 = 'C0FFEE00000000000000000000000002'
export const MEMBER = 'BEEF0000000000000000000000000001'
export const MEMBER2 = 'BEEF0000000000000000000000000003'
export const USER = 'BEEF0000000000000000000000000002'
export const ONEBOT_GROUP = '555000111'
export const ONEBOT_USER = '20001'

/** 等一条消息处理完的上限（超过说明中间件卡住了） */
const SETTLE_TIMEOUT_MS = 10_000

// ------------------------------------------------------------------ 发出去的消息

export interface SentButton {
  label: string
  /** 点了以后填进输入框的内容 */
  text: string
  primary: boolean
}

export interface Sent {
  platform: string
  channelId: string
  /** 回复的是哪条消息（经 session.send 或 bot.sendMessage(…, { session }) 发的才有） */
  session?: Session
  elements: h[]
  /** qq:markdown 元素里的原始 Markdown（开头的 @ 提醒已经去掉，见 mention）；不是 Markdown 消息时 undefined */
  markdown?: string
  /** 引用的消息 ID（开头的 quote 元素） */
  quote?: string
  /** 开头 <qqbot-at-user> 提醒的 ID */
  mention?: string
  /** 纯文字元素（markdown 以外的） */
  text: string
  /** 和适配器一样排行：连续的裸按钮每 5 个一行，每个 button-group 一行 */
  rows: SentButton[][]
  images: Array<{ src: string }>
}

/** 下一次 sendMessage 抛出和适配器一样形状的错误（errors[i].response.data = { code, message }） */
export interface SendFault {
  code?: number
  status?: number
  message?: string
}

const textOf = (elements: h[]): string => elements.map((el) => el.type === 'text' ? String(el.attrs.content ?? '') : textOf(el.children)).join('')

function button(el: h): SentButton {
  return { label: textOf(el.children), text: String(el.attrs.text ?? ''), primary: el.attrs.class === 'primary' }
}

function rowsOf(elements: h[]): SentButton[][] {
  const rows: SentButton[][] = []
  let open: SentButton[] | null = null
  for (const el of elements) {
    if (el.type === 'button') {
      if (!open || open.length >= 5) rows.push(open = [])
      open.push(button(el))
    } else if (el.type === 'button-group') {
      rows.push(el.children.filter((c) => c.type === 'button').map(button))
      open = null
    }
  }
  return rows.filter((row) => row.length)
}

/** 回复第一张 Markdown 卡片开头的 @ 提醒 */
const MENTION_PREFIX = /^<qqbot-at-user id="([^"]*)" \/> /

export function describeSent(platform: string, channelId: string, elements: h[], session?: Session): Sent {
  const markdown = elements.find((el) => el.type === 'qq:markdown')
  const quote = elements.find((el) => el.type === 'quote')
  const raw = markdown ? textOf(markdown.children) : undefined
  const at = raw === undefined ? null : MENTION_PREFIX.exec(raw)
  return {
    platform,
    channelId,
    session,
    elements,
    markdown: at ? raw!.slice(at[0].length) : raw,
    quote: quote ? String(quote.attrs.id) : undefined,
    mention: at?.[1],
    text: textOf(elements.filter((el) => el.type === 'text')),
    rows: rowsOf(elements),
    images: elements.filter((el) => el.type === 'img' || el.type === 'image').map((el) => ({ src: String(el.attrs.src ?? el.attrs.url ?? '') })),
  }
}

// ------------------------------------------------------------------ 假机器人

export interface FakeBotConfig {
  platform: string
  selfId: string
}

/** 不连任何服务的机器人：sendMessage 只记录 */
export class FakeBot extends Bot<Context, FakeBotConfig> {
  sent: Sent[] = []
  private faults: SendFault[] = []
  private nextId = 1

  constructor(ctx: Context, config: FakeBotConfig) {
    super(ctx, config, config.platform)
    this.platform = config.platform
    this.selfId = config.selfId
    this.user = { id: config.selfId, name: 'eve-market-test' }
  }

  async start() {
    this.online()
  }

  /** 接下来的 sendMessage 依次失败 */
  fail(...faults: SendFault[]) {
    this.faults.push(...faults)
  }

  async sendMessage(channelId: string, content: h.Fragment, referrer?: unknown, options?: Universal.SendOptions): Promise<string[]> {
    const fault = this.faults.shift()
    if (fault) throw adapterError(fault)
    // 和真实的适配器一样先渲染组件（<i18n> 等），Koishi 自己的提示和 plugin-help 的输出才是最终的文字
    const session = (options?.session ?? this.session({ type: 'send', channel: { id: channelId, type: Universal.Channel.Type.TEXT } })) as Session
    const elements = await session.transform(h.normalize(content))
    if (!elements.length) return []
    this.sent.push(describeSent(this.config.platform, channelId, elements, options?.session as Session | undefined))
    return [`${this.config.platform}-msg-${this.nextId++}`]
  }
}

/** 在一个单独的插件里建机器人：停用时先于 satori 服务清掉 */
export function fakeBot(app: Context, config: FakeBotConfig): FakeBot {
  let bot: FakeBot | undefined
  app.plugin({ name: `fake-bot-${config.platform}`, apply: (ctx: Context) => { bot = new FakeBot(ctx, config) } })
  if (!bot) throw new Error('fake bot was not created')
  return bot
}

function adapterError(fault: SendFault): Error {
  const inner = Object.assign(new Error(fault.message ?? 'error'), {
    response: { status: fault.status ?? 400, url: '/v2/groups/x/messages', data: { code: fault.code ?? 0, message: fault.message ?? 'error' } },
  })
  return Object.assign(new Error('send failed'), { errors: [inner] })
}

// ------------------------------------------------------------------ 注入消息

export interface MessageOptions {
  /** 群聊里默认 @机器人；false = 不带 @（全量消息模式） */
  at?: boolean
  userId?: string
  channelId?: string
  messageId?: string
  /** 这条消息是多少秒之前发的 */
  ageSec?: number
  /** 被引用的消息内容 */
  quote?: string
  /** 事件原文（session.event._data），例如 { d: { author: { union_openid } } } */
  raw?: unknown
}

let seq = 0

export function messageEvent(bot: FakeBot, content: string, direct: boolean, options: MessageOptions): Partial<Universal.Event> {
  seq++
  const userId = options.userId ?? (bot.config.platform === 'qq' ? (direct ? USER : MEMBER) : ONEBOT_USER)
  const channelId = direct ? userId : options.channelId ?? (bot.config.platform === 'qq' ? GROUP : ONEBOT_GROUP)
  const elements: h[] = !direct && options.at !== false ? [h.at(bot.config.selfId), h.text(` ${content}`)] : [h.text(content)]
  const event: Partial<Universal.Event> & { _data?: unknown } = {
    type: 'message',
    platform: bot.config.platform,
    selfId: bot.config.selfId,
    timestamp: Date.now() - (options.ageSec ?? 0) * 1000,
    user: { id: userId, name: `user-${userId.slice(-4)}` },
    channel: { id: channelId, type: direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
    message: { id: options.messageId ?? `MSG-${seq}`, elements },
  }
  if (!direct) event.guild = { id: channelId }
  if (options.quote !== undefined) event.message!.quote = { id: `QUOTE-${seq}`, content: options.quote, elements: [h.text(options.quote)] }
  if (options.raw !== undefined) event._data = options.raw
  return event
}

/** 派发一个会话，等 Koishi 的中间件链走完（middleware 事件）；返回这期间发出去的消息 */
export async function dispatch(app: Context, bot: FakeBot, session: Session, outbox: () => Sent[]): Promise<Sent[]> {
  const before = outbox().length
  if (session.userId === session.selfId) {
    // Koishi 直接忽略机器人自己的消息，不会有 middleware 事件
    bot.dispatch(session)
    await settle()
    return outbox().slice(before)
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error(`message was not handled within ${SETTLE_TIMEOUT_MS} ms`))
    }, SETTLE_TIMEOUT_MS)
    // 事件参数会被包一层代理，按会话编号比较
    const dispose = app.on('middleware', (handled) => {
      if (handled.id !== session.id) return
      clearTimeout(timer)
      dispose()
      resolve()
    })
    bot.dispatch(session)
  })
  return outbox().slice(before)
}

/** 让出几轮事件循环 */
export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

// ------------------------------------------------------------------ startHarness

/** 每个测试一个临时的实例目录：插件的 data/eve-market（secret.key、cache/）写在这里，不写进仓库 */
async function newContext(): Promise<{ app: Context; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-market-test-'))
  const app = new Context()
  app.baseDir = dir
  return { app, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

export interface HarnessOptions {
  /** 装上 plugin-help（测「帮助」冲突） */
  help?: boolean
  /** 再加一个 onebot 平台的机器人 */
  onebot?: boolean
  /** app.start() 之前调用：装被测的插件、注册测试用的中间件 */
  setup?: (app: Context) => void | Promise<void>
  /** app.stop() 以后、删临时目录以前等它（被测插件异步的停用：缓存还在写） */
  beforeCleanup?: () => Promise<unknown>
}

export interface Harness {
  app: Context
  qq: FakeBot
  onebot?: FakeBot
  /** qq 群里的消息（默认 @机器人） */
  group(content: string, options?: MessageOptions): Promise<Sent[]>
  /** qq 单聊 */
  direct(content: string, options?: MessageOptions): Promise<Sent[]>
  /** onebot 群里的消息（默认不带 @） */
  onebotGroup(content: string, options?: MessageOptions): Promise<Sent[]>
  /** 用这个机器人的身份发一条群消息（Koishi 会直接忽略） */
  self(content: string, options?: MessageOptions): Promise<Sent[]>
  /** 任意机器人（例如测试里另建的沙盒机器人）收到一条消息 */
  send(bot: FakeBot, content: string, options?: MessageOptions & { direct?: boolean }): Promise<Sent[]>
  /** 设置用户的 Koishi 权限等级 */
  authority(userId: string, authority: number, platform?: string): Promise<void>
  stop(): Promise<void>
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { app, cleanup } = await newContext()
  // 这几个包的类型声明对不上 koishi 的 Context（依赖的是另一份 cordis 类型），运行时没有问题
  app.plugin(HTTP as never)
  app.plugin(Memory as never)
  if (options.help) app.plugin(Help as never)
  const qq = fakeBot(app, { platform: 'qq', selfId: QQ_SELF })
  const onebot = options.onebot ? fakeBot(app, { platform: 'onebot', selfId: ONEBOT_SELF }) : undefined
  await options.setup?.(app)
  await app.start()

  const send = (bot: FakeBot, content: string, direct: boolean, opts: MessageOptions = {}) =>
    dispatch(app, bot, bot.session(messageEvent(bot, content, direct, opts)), () => bot.sent)

  return {
    app,
    qq,
    onebot,
    group: (content, opts) => send(qq, content, false, opts),
    direct: (content, opts) => send(qq, content, true, opts),
    onebotGroup(content, opts) {
      if (!onebot) throw new Error('startHarness({ onebot: true }) first')
      return send(onebot, content, false, { at: false, ...opts })
    },
    self: (content, opts) => send(qq, content, false, { at: false, userId: QQ_SELF, ...opts }),
    send: (bot, content, opts = {}) => send(bot, content, !!opts.direct, opts),
    async authority(userId, authority, platform = 'qq') {
      const user = await app.database.getUser(platform, userId)
      if (user) await app.database.setUser(platform, userId, { authority })
      else await app.database.createUser(platform, userId, { authority })
    },
    async stop() {
      // 先停机器人（app.stop() 时 satori 的机器人列表已经没了，机器人自己的清理会报错）
      for (const bot of app.bots.filter((b): b is FakeBot => b instanceof FakeBot)) bot.ctx.scope.dispose()
      await app.stop()
      await options.beforeCleanup?.()
      await cleanup()
    },
  }
}

// ------------------------------------------------------------------ startRealQQ

export const REAL_GROUP = 'C0FFEE00000000000000000000000009'
export const REAL_MEMBER = 'BEEF0000000000000000000000000009'
export const REAL_USER = 'BEEF000000000000000000000000000A'

export interface RealQQOptions {
  help?: boolean
  setup?: (app: Context) => void | Promise<void>
  /** 同 HarnessOptions.beforeCleanup */
  beforeCleanup?: () => Promise<unknown>
}

export interface RealQQMessageOptions {
  ageSec?: number
  /** 自己指定事件里的消息 ID（去重测试） */
  messageId?: string
  /** 事件里作者的 union_openid */
  unionId?: string
  memberId?: string
  /** 附带几张图片（适配器把附件接在文字后面，不加空格） */
  images?: number
}

export interface RealQQ {
  app: Context
  bot: QQBot<Context>
  api: FakeQQOpenApi
  /** GROUP_AT_MESSAGE_CREATE；返回假开放平台在这期间收下的消息 */
  group(content: string, options?: RealQQMessageOptions): Promise<QQSentMessage[]>
  /** GROUP_MESSAGE_CREATE（群主打开了「接收群内全部消息」；不带 @） */
  groupAll(content: string, options?: RealQQMessageOptions & { authorId?: string }): Promise<QQSentMessage[]>
  /** C2C_MESSAGE_CREATE */
  direct(content: string, options?: RealQQMessageOptions): Promise<QQSentMessage[]>
  stop(): Promise<void>
}

type QQEventType = 'GROUP_AT_MESSAGE_CREATE' | 'GROUP_MESSAGE_CREATE' | 'C2C_MESSAGE_CREATE'

export async function startRealQQ(options: RealQQOptions = {}): Promise<RealQQ> {
  const api = new FakeQQOpenApi()
  await api.start()
  const { app, cleanup } = await newContext()
  app.plugin(HTTP as never)
  app.plugin(Memory as never)
  if (options.help) app.plugin(Help as never)
  app.plugin(QQBot as never, { id: APP_ID, secret: 'unused', type: 'private', endpoint: `${api.base}/`, protocol: 'webhook', path: '/qq' })
  await options.setup?.(app)
  await app.start()
  const bot = app.bots.find((b) => b.platform === 'qq') as unknown as QQBot<Context>
  // 预置 token：不去请求 bots.qq.com
  const seeded = bot as unknown as { _token: string }
  seeded._token = ACCESS_TOKEN
  bot.http.config.headers!.Authorization = `QQBot ${ACCESS_TOKEN}`
  bot.selfId = BOT_USER_ID
  bot.user = { id: BOT_USER_ID, name: 'eve-market-test' }

  let eventSeq = 0
  async function inject(type: QQEventType, content: string, opts: RealQQMessageOptions & { authorId?: string } = {}) {
    eventSeq++
    const direct = type === 'C2C_MESSAGE_CREATE'
    const memberId = opts.authorId ?? opts.memberId ?? REAL_MEMBER
    const author = direct
      ? { id: REAL_USER, user_openid: REAL_USER, ...opts.unionId ? { union_openid: opts.unionId } : {} }
      : { id: memberId, member_openid: memberId, ...opts.unionId ? { union_openid: opts.unionId } : {} }
    const d = {
      id: opts.messageId ?? `REAL-MSG-${eventSeq}`,
      content: type === 'GROUP_AT_MESSAGE_CREATE' ? ` ${content}` : content,
      timestamp: new Date(Date.now() - (opts.ageSec ?? 0) * 1000).toISOString(),
      author,
      ...direct ? {} : { group_id: REAL_GROUP, group_openid: REAL_GROUP },
      ...opts.images ? { attachments: Array.from({ length: opts.images }, () => ({ content_type: 'image/png', url: 'https://example.com/x.png', width: 849, height: 500 })) } : {},
    }
    const session = await adaptSession(bot, { op: 0, s: eventSeq, t: type, id: `REAL-EVT-${eventSeq}`, d } as never)
    if (!session) throw new Error('adapter ignored the event')
    const handled = session as unknown as Session
    return dispatchReal(app, bot, handled, api)
  }

  return {
    app,
    bot,
    api,
    group: (content, opts) => inject('GROUP_AT_MESSAGE_CREATE', content, opts),
    groupAll: (content, opts) => inject('GROUP_MESSAGE_CREATE', content, opts),
    direct: (content, opts) => inject('C2C_MESSAGE_CREATE', content, opts),
    async stop() {
      bot.ctx.scope.dispose()
      await app.stop()
      await options.beforeCleanup?.()
      await api.stop()
      await cleanup()
    },
  }
}

async function dispatchReal(app: Context, bot: QQBot<Context>, session: Session, api: FakeQQOpenApi): Promise<QQSentMessage[]> {
  const before = api.messages.length
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error(`message was not handled within ${SETTLE_TIMEOUT_MS} ms`))
    }, SETTLE_TIMEOUT_MS)
    // 事件参数会被包一层代理，按会话编号比较
    const dispose = app.on('middleware', (handled) => {
      if (handled.id !== session.id) return
      clearTimeout(timer)
      dispose()
      resolve()
    })
    bot.dispatch(session as never)
  })
  return api.messages.slice(before)
}
