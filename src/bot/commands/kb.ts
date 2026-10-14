// KB：「KB <人物名 | 人物 ID | zKill 人物链接>」回一张报纸头版风格的人物卡（图片）；@机器人 的消息里带 zKill 人物链接时由后置中间件改成这个命令。
// 流程：范围检查 → 频道限速 → 解析 → 认人（不完整的名字列候选，回编号） → 不显示名单 → 取资料 → 出图；
// 没有浏览器或出图失败时发文字版简报。zKill 取不到时照样出卡（人设「查无此人」），不多说什么。
// 回复里不出现网址：人物名、军团名先过 safeEcho / scrubUrls；按钮只写「KB <ID>」。慢提示 3 秒（占一条额度）。

import { KB_ALIAS, KB_CHANNEL_PER_MIN } from '../../constants'
import { isFailure } from '../../core/types'
import type { Access, CoreFailure, KbSettings, PilotImageSet, PilotProfile, PilotRef } from '../../core/types'
import { kbCardText } from '../../render'
import type { RenderedImage } from '../../render'
import type { Card } from '../view/card'
import { escapeMarkdown, safeEcho, scrubUrls } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { startSlowHint } from './slow'
import { KB } from './text'

export function registerKb(commands: CommandContext): void {
  // Koishi 的命令名不分大小写，「KB」「kb」是同一个名字，别名只需要「战绩」
  commands.registry.register('kb', { args: '[arg:text]', needsArgs: true, description: 'KB：人物战绩卡（人物英文名、ID 或 zKill 人物链接，直接 @我 发人物链接也行）', aliases: [KB_ALIAS] })
    ?.action(async ({ session }, arg) => {
      if (!session) return
      await invoke(commands, 'kb', session, (inv) => runKb(inv, typeof arg === 'string' ? arg : ''))
    })
}

/** 这个人能不能用：管理员一直可以；all = 所有人；allowed = 授权群和授权私聊；off = 都不行 */
export function kbAllowed(kb: Pick<KbSettings, 'scope'>, access: Pick<Access, 'isAdmin' | 'allowed'>): boolean {
  if (kb.scope === 'off') return false
  return kb.scope === 'all' || access.isAdmin || access.allowed
}

// ------------------------------------------------------------------ 限速

const RATE_STORE_KEY = 'bot/kb-rate'
const MINUTE_MS = 60_000

/** 每个频道最近一分钟的查询时间（内存里，重载插件也保留） */
function rateLog(commands: CommandContext): Map<string, number[]> {
  return commands.store.get(RATE_STORE_KEY, () => new Map<string, number[]>())
}

/** 这个频道这一分钟还能查就记一次并返回 true；超过 KB_CHANNEL_PER_MIN 次返回 false（不记） */
function takeSlot(commands: CommandContext, channel: string): boolean {
  const log = rateLog(commands)
  const now = commands.clock.now()
  const recent = (log.get(channel) ?? []).filter((t) => now - t < MINUTE_MS)
  if (recent.length >= KB_CHANNEL_PER_MIN) {
    log.set(channel, recent)
    return false
  }
  recent.push(now)
  log.set(channel, recent)
  // 顺手清掉早就没有记录的频道
  if (log.size > 500) for (const [key, times] of log) if (!times.some((t) => now - t < MINUTE_MS)) log.delete(key)
  return true
}

const channelOf = (inv: Invocation) => `${inv.session.platform}:${inv.session.channelId ?? inv.session.userId ?? ''}`

// ------------------------------------------------------------------ 命令

/** 一次查询的结果：等慢提示发完再发 */
type Outcome =
  | { kind: 'text'; text: string }
  | { kind: 'card'; card: Card }
  | { kind: 'profile'; profile: PilotProfile; image: RenderedImage | null }

const NO_IMAGES: PilotImageSet = { portrait: null, corporation: null, alliance: null, ships: {} }

async function runKb(inv: Invocation, text: string): Promise<void> {
  const { kb } = inv.commands.settings
  if (kb.scope === 'off') return void await inv.reply.text(KB.off)
  if (!kbAllowed(kb, inv.access)) return void await inv.reply.text(KB.denied)
  if (!text.trim()) return void await sendCard(inv, usageCard(inv))
  if (!takeSlot(inv.commands, channelOf(inv))) return void await inv.reply.text(KB.tooFast)

  const arg = inv.core.pilots.parse(text)
  if (arg.kind === 'error') {
    if (arg.error === 'empty') return void await sendCard(inv, usageCard(inv))
    return void await inv.reply.text(arg.error === 'cjk' ? KB.cjk : KB.badName)
  }

  const hint = startSlowHint(inv, 1, () => KB.hint)
  let outcome: Outcome
  try {
    outcome = await lookup(inv, arg.kind === 'id' ? { id: arg.id } : { name: arg.name })
  } finally {
    hint.stop()
  }
  await hint.sent()
  await deliver(inv, outcome)
}

/** 认人 → 不显示名单 → 取资料 → 出图 */
async function lookup(inv: Invocation, who: { id: number } | { name: string }): Promise<Outcome> {
  const { core, commands } = inv
  const { kb } = commands.settings
  let id: number
  if ('id' in who) {
    id = who.id
  } else {
    const found = await core.pilots.resolve(who.name)
    if (isFailure(found)) return { kind: 'text', text: failureText(found, who.name) }
    if ('candidates' in found) {
      const candidates = found.candidates.filter((c) => !kb.hidden.includes(c.id))
      if (!candidates.length) return { kind: 'text', text: KB.noMatch(safeEcho(who.name)) }
      return { kind: 'card', card: candidatesCard(who.name, candidates) }
    }
    id = found.id
  }
  if (kb.hidden.includes(id)) return { kind: 'text', text: KB.hidden }

  const profile = await core.pilots.profile(id, { recent: kb.recent })
  if (isFailure(profile)) return { kind: 'text', text: failureText(profile, '') }
  const image = await render(inv, profile)
  return { kind: 'profile', profile, image }
}

/** 出图；没有浏览器返回 null，出图失败（写日志）也返回 null，由调用方改发文字版 */
async function render(inv: Invocation, profile: PilotProfile): Promise<RenderedImage | null> {
  const { media, clock, logger } = inv.commands
  if (!media?.renderer.available()) return null
  try {
    const now = clock.now()
    // 缓存里有成图就不再下载图片
    const hit = media.kbCards.cached({ profile, images: NO_IMAGES, now })
    if (hit) return hit
    const images = await inv.core.pilots.images.forProfile(profile)
    return await media.kbCards.get({ profile, images, now })
  } catch (e) {
    logger.warn(`KB 人物卡出图失败（人物 ${profile.id}）：${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

async function deliver(inv: Invocation, outcome: Outcome): Promise<void> {
  switch (outcome.kind) {
    case 'text':
      return void await inv.reply.text(outcome.text)
    case 'card':
      return void await sendCard(inv, outcome.card)
    case 'profile': {
      const { image, profile } = outcome
      if (image && await inv.reply.image(image.data, image.mime)) return
      // 没有浏览器、出图失败、图发不出去：文字版简报（图发失败时还有额度才补）
      if (image && inv.reply.remaining() < 1) return
      await sendCard(inv, briefCard(profile))
    }
  }
}

// ------------------------------------------------------------------ 失败

function failureText(f: CoreFailure, name: string): string {
  switch (f.code) {
    case 'PILOT_NOT_FOUND':
      return f.reason === 'need-full-name' ? KB.notFound(safeEcho(name)) : KB.noMatch(safeEcho(name))
    case 'BAD_ARGUMENT':
      return f.reason === 'cjk-name' ? KB.cjk : KB.badName
    case 'NOT_A_CHARACTER':
      return KB.notCharacter
    case 'DEADLINE':
      return KB.deadline
    default:
      return KB.esiDown
  }
}

// ------------------------------------------------------------------ 卡片

/** 候选：每个人一个「KB <ID>」按钮（也可以回编号）；只写名字，从不替用户挑 */
function candidatesCard(query: string, candidates: PilotRef[]): Card {
  const card = emptyCard(KB.candidatesTitle(safeEcho(query)))
  card.choices = candidates.map((c, i) => ({
    no: i + 1,
    label: safeEcho(c.name),
    command: { id: 'kb' as const, args: String(c.id) },
  }))
  return card
}

/** 文字版简报：kbCardText 逐行转义（人物名、军团名里的网址样子的片段换成「[链接]」） */
export function briefCard(profile: PilotProfile): Card {
  const [head, ...rest] = kbCardText(profile).split('\n')
  const clean = (line: string) => escapeMarkdown(scrubUrls(line))
  const [name, persona = ''] = head.split('｜')
  const card = emptyCard(persona ? KB.cardTitle(clean(name), clean(persona)) : `**${clean(head)}**`)
  card.sections.push({ style: 'plain', lines: rest.filter((l) => l.trim()).map((l) => ({ text: clean(l) })) })
  return card
}

function usageCard(inv: Invocation): Card {
  const name = escapeMarkdown(inv.commands.registry.name('kb'))
  const card = emptyCard(KB.usageTitle)
  card.sections.push({
    lines: [
      { text: `${name} 加上人物的英文名或人物 ID：回一张人物战绩卡（也可以写「${escapeMarkdown(KB_ALIAS)}」）` },
      { text: '名字要写完整，大小写无所谓；欧服人物名都是英文' },
      { text: '也可以直接 @我 发 zKill 的人物链接，不用写命令' },
    ],
  })
  return card
}
