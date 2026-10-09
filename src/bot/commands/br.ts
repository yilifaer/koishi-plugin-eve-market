// 战报（§2.11）：「战报 <BR 链接>」，或者 @机器人 的消息里带 BR 链接（后置中间件改成这个命令再执行）。
// - 每条消息只处理第一个有效链接；只打开规范化后的 br.evetools.org 地址；回复里不回显链接。
// - 同一链接 10 分钟内直接发缓存的图；排队按「从收到消息算起」估算，来不及在回复时限内完成就直接说繁忙。
// - 3 秒内没截完先发一次慢提示（前面有排队时写「前面还有 N 个」），然后发图（最多 2 段）；
//   提示占一条额度：单聊里发了提示就只发 1 段。页面过长截掉了、或者因为额度少发了一段时，在最后一张图下面注明。
// - 没有 puppeteer 时回复「截图服务没有启动」并写日志。

import { findBrLink, mentionsBrHost } from '../../core/universe'
import type { BrLink } from '../../core/universe'
import type { BrOutcome, BrShot } from '../../render'
import type { Card } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { startSlowHint } from './slow'
import { BR } from './text'

export function registerBr(commands: CommandContext): void {
  commands.registry.register('br', { args: '[link:text]', description: '战报：BR 工具的战报截图（直接 @我 发链接也行）' })
    ?.action(async ({ session }, link) => {
      if (!session) return
      await invoke(commands, 'br', session, (inv) => runBr(inv, typeof link === 'string' ? link : ''))
    })
}

async function runBr(inv: Invocation, text: string): Promise<void> {
  const link = findBrLink(text)
  if (!link) {
    if (mentionsBrHost(text)) await inv.reply.text(BR.badLink)
    else await sendCard(inv, usageCard(inv))
    return
  }
  const media = inv.commands.media
  if (!media?.renderer.available()) {
    inv.commands.logger.warn(BR.logNoBrowser)
    await inv.reply.text(BR.noBrowser)
    return
  }
  await shoot(inv, link)
}

/** 排队按「从收到消息算起」估算：用 QQ 事件的时间（和回复时限用的是同一个） */
async function shoot(inv: Invocation, link: BrLink): Promise<void> {
  const br = inv.commands.media!.br
  const stamp = inv.session.timestamp
  const receivedAt = typeof stamp === 'number' && stamp > 0 ? stamp : undefined
  const ticket = br.request(link.url, receivedAt === undefined ? {} : { receivedAt })
  switch (ticket.status) {
    case 'invalid':
      await inv.reply.text(BR.badLink)
      return
    case 'busy':
      await inv.reply.text(BR.busy)
      return
    case 'cached':
      await sendShot(inv, ticket.shot)
      return
    case 'queued': {
      // 提示后面至少还要发 1 张图
      const hint = startSlowHint(inv, 1, () => {
        const ahead = ticket.ahead()
        return ahead > 0 ? `${BR.hint}${BR.ahead(ahead)}` : BR.hint
      })
      const outcome = await ticket.done.finally(() => hint.stop())
      await hint.sent()
      await sendOutcome(inv, outcome)
    }
  }
}

async function sendOutcome(inv: Invocation, outcome: BrOutcome): Promise<void> {
  if (outcome.ok) return sendShot(inv, outcome.shot)
  switch (outcome.reason) {
    case 'closed':
      // 插件停用了：什么都不说
      return
    case 'no-browser':
      inv.commands.logger.warn(BR.logNoBrowser)
      await inv.reply.text(BR.noBrowser)
      return
    case 'timeout':
      await inv.reply.text(BR.timeout)
      return
    case 'http':
      await inv.reply.text(outcome.status ? BR.http(outcome.status) : BR.failed)
      return
    case 'unreachable':
      await inv.reply.text(BR.unreachable)
      return
    default:
      await inv.reply.text(BR.failed)
  }
}

/** 发图：段数不超过剩下的额度；截掉了（页面过长或者额度不够）在最后一张下面注明截到多少像素 */
async function sendShot(inv: Invocation, shot: BrShot): Promise<void> {
  const room = Math.max(1, inv.reply.remaining())
  const images = shot.images.slice(0, room)
  const shown = images.reduce((sum, img) => sum + img.height, 0)
  const cut = shot.truncated || images.length < shot.images.length
  for (let i = 0; i < images.length; i++) {
    const last = i === images.length - 1
    const caption = last && cut ? BR.truncated(shown) : undefined
    const image = images[i]
    if (!(await inv.reply.image(image.data, image.mime, caption))) {
      if (i === 0) await inv.reply.text(BR.sendFailed)
      return
    }
  }
}

function usageCard(inv: Invocation): Card {
  const name = escapeMarkdown(inv.commands.registry.name('br'))
  const card = emptyCard(BR.usageTitle)
  card.sections.push({
    lines: [
      { text: `${name} 加上 BR 工具的战报链接：截图发到群里` },
      { text: '也可以直接 @我 发战报链接，不用写命令' },
      { text: '长战报会分成两张图；同一个链接 10 分钟内再发很快' },
    ],
  })
  return card
}
