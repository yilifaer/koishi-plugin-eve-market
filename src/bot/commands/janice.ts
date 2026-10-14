// 估价：「估价 <Janice 估价链接>」读出这份现成估价的结果（密钥是所有者在控制台填的），@机器人 的消息里带 Janice 链接时由后置中间件改成这个命令。
// 回复顺序（预算不够时从后往前丢）：卡片 > 三个价格（可复制）> 物品清单（可复制）> 网页截图；
// 群里预算够、Janice 网站「启用」且「自动截图」开着时直接发截图，否则卡片上放「网页截图」按钮（单聊一律是按钮）。
// 「估价 #K7Q2」交给「批量查价」；其他文字回一行提示。没密钥、没权限、失败的说法见 text.ts 的 JANICE。
// 回复和按钮里不出现网址；按钮只写「截图 janice 编号」。

import { JANICE_WAIT_MS, MAX_BUTTON_COMMAND_CHARS } from '../../constants'
import { findJaniceLink, itemListBlocks, janicePageUrl, priceCopyText } from '../../core/janice'
import type { JaniceLink } from '../../core/janice'
import { isFailure } from '../../core/types'
import type { Access, CoreFailure, JaniceSettings } from '../../core/types'
import type { Action, Card } from '../view/card'
import { escapeMarkdown, hasUrl } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { janiceCard } from './janice-card'
import { shootLink, sitesOf } from './shot-send'
import { startSlowHint } from './slow'
import { JANICE, SAY } from './text'

/** 「估价 #K7Q2 …」：第一个词是估价编号 */
const BATCH_REF = /^#[A-Za-z0-9]{4}(?:\s|$)/

export function registerJanice(commands: CommandContext): void {
  commands.registry.register('janice', { args: '[arg:text]', needsArgs: true, description: '估价：读 Janice 估价链接里的估价结果（直接 @我 发 Janice 链接也行）' })
    ?.action(async ({ session }, arg) => {
      if (!session) return
      const text = typeof arg === 'string' ? arg.trim() : ''
      // 批量查价卡片页脚写的是「估价 #编号」，人们会照着打：直接当「批量查价 #编号」执行
      const batch = commands.registry.get('batch')
      if (batch && BATCH_REF.test(text)) {
        await session.execute({ command: batch, args: [text], options: {} })
        return
      }
      await invoke(commands, 'janice', session, (inv) => runJanice(inv, text))
    })
}

/** 谁能用：管理员一直可以；allowed = 授权群和授权私聊；all = 所有人；admins = 只有管理员 */
export function janiceAllowed(janice: Pick<JaniceSettings, 'who'>, access: Pick<Access, 'isAdmin' | 'allowed'>): boolean {
  if (access.isAdmin || janice.who === 'all') return true
  return janice.who === 'allowed' && access.allowed
}

async function runJanice(inv: Invocation, text: string): Promise<void> {
  if (!text) return void await sendCard(inv, usageCard(inv))
  const link = findJaniceLink(text)
  if (!link) return void await notLink(inv, text)
  await appraiseLink(inv, link)
}

// ------------------------------------------------------------------ 不是链接

/** 一行提示；原文不长、没有网址、没有换行时，放一个「批量查价 原文」按钮 */
async function notLink(inv: Invocation, text: string): Promise<void> {
  const batch = inv.commands.registry.name('batch')
  const line = JANICE.notLink(batch)
  const command = `${batch} ${text}`
  if (!inv.commands.registry.has('batch') || /[\r\n]/.test(text) || hasUrl(text) || command.length > MAX_BUTTON_COMMAND_CHARS) {
    return void await inv.reply.text(line)
  }
  const card = emptyCard(escapeMarkdown(line))
  card.actions.push([{ label: batch, command: { id: 'batch', args: text }, primary: true }])
  await sendCard(inv, card)
}

// ------------------------------------------------------------------ 估价

async function appraiseLink(inv: Invocation, link: JaniceLink): Promise<void> {
  const { janice } = inv.commands.settings
  if (!janice.apiKey) {
    await inv.reply.text(JANICE.notEnabled)
    // 没开通也还是给截图（截图自己的开关照常管）
    await shootPage(inv, link.code)
    return
  }
  if (!janiceAllowed(janice, inv.access)) return void await inv.reply.text(JANICE.denied(janice.who === 'admins' ? 'admins' : 'allowed'))
  // 慢提示后面至少还要发三条（卡片、价格、清单），所以单聊（只有 3 条）不发提示
  const hint = startSlowHint(inv, 3, () => JANICE.hint)
  const view = await inv.core.janice.get(link.code, { deadlineMs: JANICE_WAIT_MS }).finally(() => hint.stop())
  const hinted = await hint.sent()
  if (isFailure(view)) return void await failure(inv, view)

  // 条数分配：卡片 1 条；其余先给价格，再给清单，最后才是截图
  const room = Math.max(1, inv.reply.remaining())
  const copyRoom = Math.max(0, room - 1)
  const list = itemListBlocks(view, { maxBlocks: Math.max(0, copyRoom - 1) })
  const copies = [...copyRoom >= 1 ? [priceCopyText(view)] : [], ...list.blocks]
  const site = sitesOf(inv.commands).sites.find((s) => s.id === 'janice')
  const canShoot = !!site && !!inv.commands.media?.renderer.available()
  const fits = list.omitted === 0 && room - 1 - copies.length >= 1
  const auto = canShoot && site.auto && !inv.session.isDirect && !hinted && fits
  const card = janiceCard(inv, view, { omitted: list.omitted, shotButton: canShoot && !auto })
  card.copyBlocks = copies
  if (!(await sendCard(inv, card))) return
  if (auto) await shootPage(inv, view.code)
}

/** 截估价页（编号拼回地址再过名单的识别）；网站在控制台关掉了、没有浏览器时什么都不发 */
async function shootPage(inv: Invocation, code: string): Promise<void> {
  const target = sitesOf(inv.commands).parse(janicePageUrl(code))
  if (!target || !inv.commands.media?.renderer.available()) return
  await shootLink(inv, target)
}

// ------------------------------------------------------------------ 失败

async function failure(inv: Invocation, f: CoreFailure): Promise<void> {
  switch (f.code) {
    case 'JANICE_NOT_FOUND':
      return void await inv.reply.text(JANICE.notFound)
    case 'JANICE_BAD_KEY':
      return void await inv.reply.text(JANICE.badKey)
    case 'JANICE_BUSY': {
      const minutes = f.retryAt === undefined ? 1 : Math.max(1, Math.ceil((f.retryAt - inv.commands.clock.now()) / 60_000))
      return void await inv.reply.text(JANICE.busy(minutes))
    }
    case 'JANICE_DOWN':
      return void await inv.reply.text(JANICE.down(inv.commands.registry.name('batch')))
    case 'JANICE_BAD_RESPONSE':
      return void await inv.reply.text(JANICE.badResponse)
    case 'DEADLINE':
      return void await inv.reply.text(JANICE.slow)
    case 'NOT_CONFIGURED':
      return void await inv.reply.text(JANICE.notEnabled)
    default:
      inv.commands.logger.warn(`估价失败：${f.code}`)
      await inv.reply.text(SAY.failed)
  }
}

function usageCard(inv: Invocation): Card {
  const name = escapeMarkdown(inv.commands.registry.name('janice'))
  const batch = escapeMarkdown(inv.commands.registry.name('batch'))
  const card = emptyCard(JANICE.usageTitle)
  card.sections.push({
    lines: [
      { text: `${name} 加上 Janice 估价链接：读出这份估价的三个价格、物品清单和网页截图` },
      { text: '也可以直接 @我 发 Janice 估价链接，不用写命令' },
      { text: `${name} #编号：和「${batch} #编号」一样，用保存的清单重新算` },
      { text: `我只读你已经在 Janice 上做好的估价，不会把清单发给 Janice；要估一段清单请用「${batch}」` },
    ],
  })
  return card
}
