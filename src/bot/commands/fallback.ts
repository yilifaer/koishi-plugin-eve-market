// 后置中间件（§2.18、§3.7.5）：命令没匹配到、消息 @ 了机器人时才轮到。
// 带战报链接（控制台 brAuto 开着）→ 改成「战报 <链接>」再走一遍命令；只 @ 没内容 → 简短帮助；内容精确命中一个物品 → 改成「查价 …」再走一遍命令；短的 → 「没看懂…你是想查价吗？」；
// 长的（闲聊）→ 一句「发「帮助」看我能做什么」。回复了就不再调用 next()（否则 Koishi 的「您要找的是不是」还会再发一条）。
// 没有待办时的「取消」、只有图片没有文字的消息不回复，交给后面的处理者；别人发的管理命令（对他来说不存在）也不回复。

import { h } from 'koishi'
import type { Context, Next, Session } from 'koishi'
import { BARE_ITEM_QUERY, CANCEL_WORD, FALLBACK_SHORT_CHARS } from '../../constants'
import { isFailure } from '../../core/types'
import { findBrLink } from '../../core/universe'
import { buildAccess, isAddressed } from '../scope'
import type { Action } from '../view/card'
import { hasUrl, safeEcho } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { shortCard } from './help'
import { SAY } from './text'

/** 精确命中（官方名、别名、#typeID、套装名）的唯一物品，可以带市场和数量 */
const EXACT_TIERS = new Set(['id', 'exact', 'alias'])

async function isExactItem(commands: CommandContext, session: Session, content: string): Promise<boolean> {
  const core = commands.core.current()
  if (!core) return false
  const access = buildAccess(session, commands.settings.access)
  const parsed = await core.parse.query(content, { scope: 'market', access, market: true })
  if (isFailure(parsed) || !parsed.name) return false
  const res = parsed.resolution
  return res.kind === 'set' || (res.kind === 'unique' && EXACT_TIERS.has(res.tier))
}

/** 带着制造、反应才有的参数词（高级、材料、拆到原料、明细、反应:买、ME7、10流程、建筑:…）*/
const INDUSTRY_WORDS = /高级|材料|拆到原料|明细|(?:低级反应|高级反应|反应|组件|其他)[:：=]|\b[mt]e\s*[=:]?\s*\d|\d+\s*流程|(?:建筑|改装|税)[:：]/i

/** 缺了命令名的制造、反应：认得出物品时给出该用的命令（反应产物用「反应」） */
function missingIndustry(inv: Invocation, content: string): { id: 'manufacture' | 'reaction'; command: string } | null {
  if (!INDUSTRY_WORDS.test(content) || hasUrl(content)) return null
  const { core, access, commands } = inv
  const req = core.parse.industryArgs(content, 'manufacturing', access)
  let id: 'manufacture' | 'reaction' | null = null
  if (isFailure(req)) {
    if (req.code === 'IS_REACTION') id = 'reaction'
  } else {
    id = 'manufacture'
  }
  if (!id || !commands.registry.has(id)) return null
  return { id, command: `${commands.registry.name(id)} ${content}` }
}

async function confused(inv: Invocation, content: string): Promise<void> {
  const industry = missingIndustry(inv, content)
  if (industry) {
    const card = emptyCard(SAY.maybeIndustry(safeEcho(content), safeEcho(industry.command)))
    const actions: Action[] = [{ label: industry.command, command: { id: industry.id, args: content }, primary: true }]
    actions.push({ label: inv.commands.registry.name('help'), command: { id: 'help' } })
    card.actions.push(actions)
    await sendCard(inv, card)
    return
  }
  if (Array.from(content).length > FALLBACK_SHORT_CHARS) {
    await inv.reply.text(SAY.chat(inv.commands.registry.name('help')))
    return
  }
  const card = emptyCard(SAY.confused(safeEcho(content)))
  const actions: Action[] = []
  // 像网址的文字不放进按钮（群里发网址会被拒绝）
  if (inv.commands.registry.has('price') && !hasUrl(content)) {
    actions.push({ label: `${inv.commands.registry.name('price')} ${content}`, command: { id: 'price', args: content }, primary: true })
  }
  actions.push({ label: inv.commands.registry.name('help'), command: { id: 'help' } })
  card.actions.push(actions)
  await sendCard(inv, card)
}

/** 消息里的文字；图片、表情这些元素不算 */
function textOf(content: string): string {
  return h.select(h.parse(content), 'text').map((e) => String(e.attrs.content ?? '')).join('').trim()
}

async function runFallback(commands: CommandContext, session: Session, next: Next): Promise<void | h.Fragment> {
  if (!isAddressed(session)) return next()
  const raw = (session.stripped.content ?? '').trim()
  const content = textOf(raw)
  // 「取消」只在有待办时由前置中间件接管；没有待办时什么都不说。只有图片之类、没有文字的消息也不归这里
  if (content === CANCEL_WORD || (raw && !content)) return next()
  // 非管理员发的管理命令：什么都不回（也不交给 Koishi 的「您要找的是不是」）
  if (commands.registry.hiddenFrom(session, content)) return
  if (!content) {
    await invoke(commands, 'help', session, (inv) => sendCard(inv, shortCard(inv)).then(() => undefined))
    return
  }
  // 战报自动识别：每条消息只取第一个有效链接
  const br = commands.settings.render.brAuto ? commands.registry.get('br') : undefined
  const link = br ? findBrLink(content) : null
  if (br && link) {
    await session.execute({ command: br, args: [link.url], options: {} })
    return
  }
  const price = commands.registry.get('price')
  if (BARE_ITEM_QUERY && price && await isExactItem(commands, session, content)) {
    await session.execute({ command: price, args: [content], options: {} })
    return
  }
  await invoke(commands, 'help', session, (inv) => confused(inv, content))
}

/** 注册后置中间件（排在 Koishi 的命令执行之后；插件停用时 Koishi 自动取消） */
export function installFallback(ctx: Context, commands: CommandContext): void {
  ctx.middleware((session, next) => runFallback(commands, session, next))
}
