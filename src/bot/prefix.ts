// 前置中间件：只有一个，prepend 注册，跑在 Koishi 的 attach（解析命令、plugin-help 的快捷方式）之前。
// 按顺序：规范化 → 去重 → 取消 → 编号 → 批量清单 → 帮助改写，最后改写 session.stripped.content 并 next()，
// 之后的解析命令、权限检查、执行都由 Koishi 照常处理（不调用 session.execute，回复额度按这条新消息算）。
//
// session.stripped.content 是转义过的文字（& < > 是实体）：从待办里取出的命令和表头先 h.escape 再放进去。
// 开头的「/」只在 Koishi 不需要前缀就能认出命令时去掉（全局前缀里有空串，或者 @ 了机器人、单聊）；
// 否则保留，改写出来的命令也补上前缀，别的插件的命令照常能用。
// 这里的一句话回复（取消、编号过期）跳过 Koishi 里设成「忽略」的用户和频道（它们的命令由 attach 丢掉）。

import { Channel, Command, h, User } from 'koishi'
import type { Context, Next, Session } from 'koishi'
import { CANCEL_WORD, COMMAND_NAMES, HELP_COMMAND, HELP_WORDS } from '../constants'
import type { Logger, ModuleStore } from '../core/ports'
import { applyChoice, parseChoiceReply, pendingKey } from './pending'
import type { ChoicesPending, ListPending, Pending, PendingStore } from './pending'
import type { CommandName, CommandRegistry } from './register'
import { isAddressed, markImagesDropped, messageKey } from './scope'
import type { MessageDedupe } from './scope'
import { createReplier, replyBudget, sendState } from './send/replier'
import { REPLY } from './text'
import type { CardRenderOptions } from './view/card'

// ------------------------------------------------------------------ 纯函数

export interface NormalizeOptions {
  /** 本插件的命令名和别名（registry.names()） */
  names: readonly CommandName[]
  /** 这个词是不是某个插件的命令：是就不拆（例如别的插件的「查价格」） */
  isCommand?: (word: string) => boolean
}

const keyOf = (name: string) => Command.normalize(name)
const LEADING_SLASH = /^[/／]+\s*/

/**
 * 消息里的文字：图片、表情、@ 等元素各换成一个空格（前后已经是空白就不加），免得词粘在一起。
 * 输入输出都是转义过的文字，游戏里复制的 &lt;localized…&gt; 原样保留
 */
export function textOnly(content: string): string {
  if (!content.includes('<')) return content
  // 转义过的文字里 < > 只会出现在元素标签上（属性值里的 < > 也是实体），不能用在已经还原的文字上
  return content.replace(/(\s?)(?:<[^<>]*>)+(\s?)/g, (_m, a: string, b: string) => (a || b ? (a === ' ' && b === ' ' ? ' ' : a + b) : ' '))
}

/**
 * 「/」面板和粘在一起的命令名：去掉开头的 / 和 ／；命令名部分做 NFKC，后面的全角空格换成普通空格；
 * 命令名后面没写空格时，按本插件带参数的命令名从长到短匹配开头，补上空格（不带参数的命令必须完全相同才算，
 * 「入侵者是谁」不会变成「入侵 者是谁」）。命令名后面的文字原样保留（Tab 和换行是清单的格式）
 */
export function normalizeIncoming(content: string, options: NormalizeOptions): string {
  const text = content.trim().replace(LEADING_SLASH, '')
  // 开头是元素（图片、表情……）：不是文字命令，原样交给后面
  if (text.startsWith('<')) return text
  // 其余元素去掉，只看文字（图片常粘在最后一个词或命令名后面）
  const m = /^(\S+)([\s\S]*)$/.exec(textOnly(text).trim())
  if (!m) return ''
  // 内容是转义过的：先还原再 NFKC，全角的 ＜＆ 变成 <& 以后要重新转义
  const head = h.escape(h.unescape(m[1]).normalize('NFKC'))
  const rest = m[2].replace(/^[ 　 ]+/, ' ')
  return splitGlued(head, options) + rest
}

function splitGlued(head: string, { names, isCommand }: NormalizeOptions): string {
  const key = keyOf(head)
  if (names.some((n) => n.name === key) || isCommand?.(head)) return head
  const candidates = names.filter((n) => n.args && n.name.length < head.length).sort((a, b) => b.name.length - a.name.length)
  for (const { name } of candidates) {
    const prefix = head.slice(0, name.length)
    if (keyOf(prefix) === name) return `${prefix} ${head.slice(name.length)}`
  }
  return head
}

/**
 * 「帮助」「菜单」「帮助 查价」「帮助查价」→ 隐藏的 eve-market.help [主题]，plugin-help 的快捷方式就不会再匹配；
 * 「帮助 <别的插件的命令>」不动，返回 null
 */
export function helpRewrite(content: string, names: readonly CommandName[]): string | null {
  const text = content.trim()
  for (const word of HELP_WORDS) {
    if (text === word) return HELP_COMMAND
    if (!text.startsWith(word)) continue
    const topic = text.slice(word.length).trim()
    if (topic && !/\s/.test(topic) && names.some((n) => n.name === keyOf(topic))) return `${HELP_COMMAND} ${topic}`
  }
  return null
}

// ------------------------------------------------------------------ 中间件

/** 批量清单待办要知道的两件事，由 core 回答（不给时只按行数判断） */
export interface ListProbe {
  /** 这一行全是批量查价的表头参数（市场、价格类型、±%） */
  isHeader(line: string, session: Session): boolean
  /** 这一行能识别成物品（可以带数量） */
  isItem(line: string, session: Session): boolean
}

export interface PrefixDeps {
  registry: Pick<CommandRegistry, 'names' | 'name' | 'has'>
  pending: PendingStore
  dedupe: MessageDedupe
  probe?: ListProbe
  /** 回一句纯文字（取消、编号过期）；textReply() 给的就行 */
  say(session: Session, text: string): Promise<unknown>
}

type Outcome = { done: true } | { done: false; content: string }

/**
 * Koishi 认这条消息里的命令要不要前缀：不要返回 ''，要的话返回一个能用的（优先「/」）。
 * 全局前缀里有空串时都不要；默认的 auto 模式下 @ 了机器人或单聊也不要
 */
export function requiredPrefix(session: Pick<Session, 'app' | 'isDirect' | 'stripped' | 'resolve'>): string {
  const { prefix, prefixMode } = session.app.config
  const value = session.resolve(prefix)
  const list = (Array.isArray(value) ? value : [value || '']).map(String)
  if (list.includes('')) return ''
  if (prefixMode !== 'strict' && (session.isDirect || session.stripped.appel)) return ''
  return list.includes('/') ? '/' : list[0] ?? ''
}

export async function runPrefix(session: Session, next: Next, deps: PrefixDeps) {
  const names = deps.registry.names()
  const isCommand = (word: string) => !!session.app.$commander.resolve(word, session)
  const raw = session.stripped.content ?? ''
  let content = normalizeIncoming(raw, { names, isCommand })
  if (!deps.dedupe.first(messageKey(session))) return
  // 文字里夹着图片等元素（开头就是元素的不算）：只有本插件的命令才改写成纯文字，别的插件的消息原样放行
  const typed = raw.trim().replace(LEADING_SLASH, '')
  const hasElements = !typed.startsWith('<') && textOnly(typed) !== typed
  let rewritten = false
  if (isAddressed(session)) {
    const outcome = await takePending(session, content, deps, isCommand)
    if (outcome.done) return
    rewritten = outcome.content !== content
    content = outcome.content
  }
  const help = deps.registry.has('help') ? helpRewrite(content, names) : null
  if (help) content = help
  if (hasElements) {
    const word = firstWord(content)
    const own = names.find((n) => n.name === keyOf(h.unescape(word)))
    if (!rewritten && !help && !own) return next()
    // 命令后面的参数只因为去掉了图片而变空：命令的回复里补一句提示
    if (own?.needsArgs && !help && !rewritten && !content.slice(word.length).trim()) markImagesDropped(session)
  }
  // 用户写了「/」、或者内容换成了一条命令：Koishi 要前缀时补上
  const lead = requiredPrefix(session)
  const prefixed = lead && (rewritten || !!help || LEADING_SLASH.test(raw.trim()))
  session.stripped.content = prefixed ? h.escape(lead) + content : content
  return next()
}

const firstWord = (content: string) => content.trim().split(/\s/, 1)[0]

/** 编号待办；只发了表头、一行都没认出来时的批量清单待办也带着候选的编号 */
function choicesIn(pending: Pending | undefined): ChoicesPending | undefined {
  if (pending?.kind === 'choices') return pending
  if (pending?.kind === 'list' && pending.choices?.length) return { kind: 'choices', choices: pending.choices, quantity: false }
  return undefined
}

/** 取消 → 编号 → 批量清单；只发了编号但没有待办时回复「编号已经过期」 */
async function takePending(session: Session, content: string, deps: PrefixDeps, isCommand: (word: string) => boolean): Promise<Outcome> {
  const key = pendingKey(session)
  const pending = deps.pending.get(key)
  if (content === CANCEL_WORD) {
    if (!pending) return { done: false, content }
    deps.pending.clear(key)
    return say(session, deps, REPLY.cancelled)
  }
  const reply = parseChoiceReply(content)
  const choices = choicesIn(pending)
  if (reply && choices) {
    const result = applyChoice(choices, reply)
    if (result?.ok) return { done: false, content: h.escape(result.command) }
    if (result && reply.kind === 'number') return say(session, deps, REPLY.choiceMissing(reply.no, result.max))
  }
  if (pending?.kind === 'list' && deps.registry.has('batch') && isList(session, content, deps, isCommand)) {
    deps.pending.clear(key)
    return { done: false, content: listCommand(session, pending, content, deps) }
  }
  if (reply?.kind === 'number') return say(session, deps, REPLY.choiceExpired)
  return { done: false, content }
}

/** Koishi 里设成「忽略」的用户或频道（Koishi 只在 attach 里看，前置中间件要自己看） */
async function ignored(session: Session): Promise<boolean> {
  if (!session.app.database) return false
  try {
    const user = await session.observeUser(['flag'])
    if (user.flag & User.Flag.ignore) return true
    if (session.isDirect) return false
    const channel = await session.observeChannel(['flag'])
    return !!(channel.flag & Channel.Flag.ignore)
  } catch {
    return false
  }
}

/** 回一句话，这条消息到此为止；被忽略的用户和频道不回 */
async function say(session: Session, deps: PrefixDeps, text: string): Promise<Outcome> {
  if (!(await ignored(session))) await deps.say(session, text)
  return { done: true }
}

const linesOf = (content: string) => content.split(/\r?\n/).filter((line) => line.trim())

/** 第一个词不是任何插件的命令，并且有 2 行以上或第一行能识别成物品 */
function isList(session: Session, content: string, deps: PrefixDeps, isCommand: (word: string) => boolean): boolean {
  const lines = linesOf(content)
  const first = lines[0]?.trim() ?? ''
  const word = first.split(/\s+/)[0]
  if (!word || isCommand(word) || HELP_WORDS.includes(word) || word === CANCEL_WORD) return false
  return lines.length >= 2 || !!deps.probe?.isItem(h.unescape(first), session)
}

/** 批量查价 <表头>\n<清单>；清单自己带了表头时以新表头为准 */
function listCommand(session: Session, pending: ListPending, content: string, deps: PrefixDeps): string {
  const name = h.escape(deps.registry.name('batch'))
  const first = linesOf(content)[0] ?? ''
  if (!pending.header || deps.probe?.isHeader(h.unescape(first.trim()), session)) return `${name}\n${content}`
  return `${name} ${h.escape(pending.header)}\n${content}`
}

/** 注册前置中间件（prepend；插件停用时 Koishi 自动取消） */
export function installPrefix(ctx: Context, deps: PrefixDeps): void {
  ctx.middleware((session, next) => runPrefix(session, next, deps), true)
}

// ------------------------------------------------------------------ 一句话回复

/** 纯文字回复只用到预算、熔断和回声记录，卡片相关的设置随便给 */
const PLAIN_RENDER: CardRenderOptions = {
  numberStyle: 'plain',
  clickable: 'none',
  cmdInputInLists: false,
  commandName: (id) => COMMAND_NAMES[id],
}

/** 经 Replier 发一句纯文字（预算、290 秒时限、自我回声记录照常） */
export function textReply(store: ModuleStore, logger: Logger): (session: Session, text: string) => Promise<boolean> {
  const state = sendState(store)
  return (session, text) => createReplier(session, {
    budget: replyBudget(2, session.isDirect),
    mode: 'text',
    render: PLAIN_RENDER,
    state,
    logger,
  }).text(text)
}
