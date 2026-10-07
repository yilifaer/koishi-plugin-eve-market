// 本群ID（§2.15）：所有 ID 都显示完整的（授权群和管理员要填完整值）。第 1 条是说明，
// 后面每条只有一个 ID（群里：群 ID、你的 ID；单聊：你的 ID），长按就能复制。

import type { Card } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'

export function registerGroupId(commands: CommandContext): void {
  commands.registry.register('groupId', { description: '本群ID：查看本群和你的完整 ID（配置授权群和管理员用）' })
    ?.action(async ({ session }) => {
      if (!session) return
      await invoke(commands, 'groupId', session, runGroupId)
    })
}

/** QQ 的 ID 原样（配置里 qq: 可写可不写）；其他平台（沙盒）带上平台名 */
function idForConfig(platform: string, id: string): string {
  return platform === 'qq' ? id : `${platform}:${id}`
}

async function runGroupId(inv: Invocation): Promise<void> {
  await sendCard(inv, groupIdCard(inv))
}

function groupIdCard(inv: Pick<Invocation, 'session' | 'access'>): Card {
  const { session, access } = inv
  const qq = session.platform === 'qq'
  const admin = qq ? 'qq: 加上' : ''
  const user = idForConfig(session.platform, session.userId ?? '')
  const status = access.allowed ? '已授权' : '未授权'
  const union = access.unionId ? [{ text: `你的跨群 ID：${escapeMarkdown(access.unionId)}` }] : []
  if (session.isDirect) {
    const card = emptyCard('**你的 ID**')
    card.sections.push(
      { style: 'plain', lines: [{ text: '下一条消息是你的 ID，长按就能复制。' }] },
      { lines: [{ text: `管理员一栏填：${admin}下一条的 ID` }, { text: `本私聊现在：${status}` }] },
      ...union.length ? [{ style: 'plain' as const, lines: union }] : [],
    )
    card.copyBlocks = [user]
    return card
  }
  const card = emptyCard('**本群 ID**')
  card.sections.push(
    { style: 'plain', lines: [{ text: '下面两条消息分别是本群的 ID 和你的 ID，长按就能复制。' }] },
    {
      lines: [
        { text: '授权群一栏填：本群 ID（下一条）' },
        { text: `管理员一栏填：${admin}你的 ID（最后一条）` },
        { text: `本群现在：${status}` },
      ],
    },
    { style: 'plain', lines: [...union, { text: '同一个人在不同群、在私聊里的 ID 可能不一样；管理员建议填私聊里拿到的 ID。' }] },
  )
  card.copyBlocks = [idForConfig(session.platform, session.channelId ?? ''), user]
  return card
}
