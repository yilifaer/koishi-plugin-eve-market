// 样式自检（§2.17，管理员，上线前在测试群里用一次）：「样式自检 1」「样式自检 2」，每页最多 4 条测试消息。
// 每条测试消息开头都写清楚「正常」是什么样子；所有者照着回报，开发者据此改常量、发补丁版本。
// 第 1 页：Markdown 格式（行内代码、粗体、列表、引用、分割线、单个换行、零宽空格空行）、4 行按钮、<qqbot-cmd-input> 两种写法、回报格式。
// 第 2 页：长图下面接一行说明（合成一条）、引用回复、Markdown 卡片上的引用和 <qqbot-at-user> 提醒、3,900 字的长消息（最后写回报格式）。
// 长图发不出去正是 2-4 要查的事：在引用回复那条里说一句，后面几项照样发。
// 单聊的额度少 1 条：第 1 页的回报格式并进第 3 条，第 2 页不发 2-3 的卡片（单聊里没有 @ 提醒），回报格式里也不写 2-3。
// 只对管理员存在（在哪个群都行：测试群一般不是授权群，这里也不显示任何联盟信息）。

import type { Session } from 'koishi'
import { BR_MAX_HEIGHT, BR_VIEWPORT_WIDTH, HARD_MAX_MESSAGE_CHARS, MAX_ACTIONS_PER_ROW } from '../../constants'
import type { CommandId } from '../../constants'
import { BAND_NAMES, bandsPng } from '../../render'
import { buildAccess } from '../scope'
import type { Action, Card, Line } from '../view/card'
import { escapeAttr, escapeMarkdown } from '../view/escape'
import { toQQMarkdown } from '../view/markdown'
import { emptyCard, invoke } from './context'
import type { CommandContext, Invocation } from './context'

/** 2-4 的长消息有多少字（不超过 HARD_MAX_MESSAGE_CHARS） */
export const SELFTEST_LONG_CHARS = 3900
/** 2-1 / 2-4 的长图：和战报一样宽，和战报最多截的高度一样高 */
export const SELFTEST_IMAGE = { width: BR_VIEWPORT_WIDTH, height: BR_MAX_HEIGHT, bands: 8 } as const

const ZERO_WIDTH_SPACE = '\u200b'

export function registerSelfTest(commands: CommandContext): void {
  const only = (session: Session) => buildAccess(session, commands.settings.access).isAdmin
  commands.registry.register('selfTest', { args: '[page:text]', description: '样式自检：上线前检查 QQ 客户端的显示（管理员）', hidden: true, only })
    ?.action(async ({ session }, page) => {
      if (!session || !only(session)) return
      await invoke(commands, 'selfTest', session, (inv) => runSelfTest(inv, typeof page === 'string' ? page.trim() : ''))
    })
}

async function runSelfTest(inv: Invocation, page: string): Promise<void> {
  if (page === '' || page === '1') return pageOne(inv)
  if (page === '2') return pageTwo(inv)
  await inv.reply.text(`${inv.commands.registry.name('selfTest')}只有两页：发「${inv.commands.registry.name('selfTest')} 1」或「${inv.commands.registry.name('selfTest')} 2」`)
}

const name = (inv: Pick<Invocation, 'commands'>, id: CommandId) => inv.commands.registry.name(id)

// ------------------------------------------------------------------ 第 1 页

async function pageOne(inv: Invocation): Promise<void> {
  const short = inv.reply.remaining() < 4
  const first = markdownCard()
  for (const card of [first, buttonsCard(inv), cmdInputCard(inv, short)]) {
    // 1-1 是看格式的，不带自动的引用 / @（留给后面的消息）
    if (!(await inv.reply.card(card, card === first ? { attach: 'none' } : {}))) return
  }
  if (!short) await inv.reply.text(reportText(inv).join('\n'))
}

/** 1-1：Markdown 的几种格式，每一项都写了正常时的样子 */
export function markdownCard(): Card {
  const card = emptyCard('**样式自检 1-1：Markdown 格式**')
  card.meta.push('每一项后面写了正常的样子；和写的不一样，就记下是哪一项。')
  card.sections.push({
    lines: [
      { text: '这一行前面应该是一个圆点，不是减号' },
      { text: '这一行是嵌套列表：比上一行往右缩进一层', indent: 1 },
      { text: '行内代码 `258,400,000 ISK`：数字应该是灰底（或等宽）的字；数字两边多出小撇号就不正常' },
      { text: '**这几个字应该是粗体**；两边多出星号就不正常' },
    ],
  })
  card.sections.push({ style: 'plain', lines: [{ text: '> 这一行是引用：左边应该有一条竖线（或整行换了颜色）；看到 > 就不正常' }] })
  card.sections.push({
    style: 'plain',
    lines: [
      { text: '这一行和下一行之间只有一个换行，' },
      { text: '所以这一行应该紧挨着上一行，中间没有空行' },
      { text: ZERO_WIDTH_SPACE },
      { text: '上面是一行看不见的空格：这一行和上一行之间应该空出一行' },
    ],
  })
  // *** 写在行内代码里，不然 QQ 会把它当成粗斜体标记吃掉
  card.footer = '分割线：这一行上面应该有一条横线；看到 `***` 就不正常'
  return card
}

/** 1-2：4 行按钮（第 1、3 行是裸按钮，第 2、4 行包在 button-group 里），每行个数不同 */
export function buttonsCard(inv: Pick<Invocation, 'commands'>): Card {
  const has = (id: CommandId) => inv.commands.registry.has(id)
  const button = (id: CommandId, args?: string): Action => ({ label: args ? `${name(inv, id)} ${args}` : name(inv, id), command: args ? { id, args } : { id } })
  // 每行都按标签宽度排好（字长的一行少放几个），发出去和这里一模一样
  const plan: Array<Array<[CommandId, string?]>> = [
    [['help'], ['serverStatus'], ['coalitionMap']],
    [['incursion'], ['influenceMap'], ['groupId'], ['translate', 'Hek']],
    [['price', 'PLEX'], ['search', '三钛合金']],
    [['selfTest', '2']],
  ]
  const rows = plan
    .map((row) => row.filter(([id]) => id === 'help' || has(id)).slice(0, MAX_ACTIONS_PER_ROW).map(([id, args]) => button(id, args)))
    .filter((row) => row.length)
  if (rows[0]?.[0]) rows[0][0].primary = true
  const card = emptyCard('**样式自检 1-2：按钮**')
  const counts = rows.map((row, i) => `第 ${i + 1} 行 ${row.length} 个`).join('、')
  const lines: Line[] = [
    { text: `下面应该有 ${rows.length} 行按钮：${counts}，行和行之间没有空行` },
    { text: '第 1 行第 1 个是蓝色的，其他是灰色的' },
    { text: '按钮上的字都完整显示；出现「…」（比如「服务器…」）就不正常' },
    { text: '点任意一个，输入框里应该出现「@机器人 命令」（不会自动发送，可以直接删掉）' },
  ]
  if (inv.commands.settings.display.clickable === 'none') lines.push({ text: '控制台「可点元素」设成了不发按钮：这一项看不到按钮，跳过' })
  card.sections.push({ lines })
  card.actions = rows
  return card
}

/** 1-3：<qqbot-cmd-input> 的两种写法（命令不编码 / urlencode） */
export function cmdInputCard(inv: Pick<Invocation, 'commands'>, withReport: boolean): Card {
  const help = name(inv, 'help')
  const tag = (text: string, show: string) => `<qqbot-cmd-input text="${escapeAttr(text)}" show="${escapeAttr(show)}" reference="false" />`
  const card = emptyCard('**样式自检 1-3：可点文字**')
  card.meta.push('点下面两行里带下划线（或蓝色）的字，看输入框里出现了什么，两种写法分别记下来。')
  card.sections.push({
    lines: [
      { text: `写法 A（不编码）：${tag(help, '点这里 A')}` },
      { text: `写法 B（编码）：${tag(encodeURIComponent(help), '点这里 B')}` },
    ],
  })
  card.sections.push({
    style: 'plain',
    lines: [
      { text: `正常：输入框里是「@机器人 ${escapeMarkdown(help)}」。` },
      { text: `只有「${escapeMarkdown(help)}」没有 @ 记成「不带 @」；出现一串 % 记成「编码」；看到 < 符号或者点不动记成「不正常」。` },
    ],
  })
  if (withReport) card.sections.push({ style: 'plain', lines: reportText(inv).map((text) => ({ text: escapeMarkdown(text) })) })
  return card
}

/** 1-4：回报格式 */
export function reportText(inv: Pick<Invocation, 'commands'>): string[] {
  return [
    `${name(inv, 'selfTest')}第 1 页发完了。请照这个格式把结果告诉开发者（不正常的写上哪里不对）：`,
    '1-1 正常 / 1-2 不正常（第 2 行没显示）/ 1-3 A 不带 @、B 正常',
    `看完以后再发「${name(inv, 'selfTest')} 2」`,
  ]
}

// ------------------------------------------------------------------ 第 2 页

async function pageTwo(inv: Invocation): Promise<void> {
  const shown = await inv.reply.image(bandsPng(SELFTEST_IMAGE), 'image/png', imageCaption())
  // 图片没发出去时不另占一条：说明并进引用回复那条（真实适配器可能已经把说明文字单独发出去了）
  const quote = shown ? quoteText(inv) : `${imageRefusedText()}\n${quoteText(inv)}`
  if (!(await inv.reply.text(quote, inv.session.messageId ? { quote: inv.session.messageId } : {}))) return
  const mention = !inv.session.isDirect && inv.reply.remaining() > 1
  if (mention && !(await inv.reply.card(mentionCard(), { attach: 'always' }))) return
  await inv.reply.card(longCard(inv, mention), { maxChars: SELFTEST_LONG_CHARS })
}

/** 2-1（图片下面接一行说明）和 2-4（长图）一起测 */
export function imageCaption(): string {
  const { width, height, bands } = SELFTEST_IMAGE
  return `样式自检 2-1：这行字应该紧贴在图片下面、和图片是同一条消息。2-4：这是 ${width}×${height} 的长图，点开以后从上到下能看清 1 到 ${bands}（${BAND_NAMES.slice(0, bands).join('')}）就正常`
}

/** 长图没有发出去（QQ 拒绝了这么大的图片，或者上传失败；错误码写在日志里） */
export function imageRefusedText(): string {
  const { width, height } = SELFTEST_IMAGE
  return `样式自检 2-1、2-4：长图没有发出去（QQ 没有接受这张 ${width}×${height} 的图片，原因见日志），这两项的图片部分记成不正常`
}

export function quoteText(inv: Pick<Invocation, 'commands'>): string {
  return `样式自检 2-2：这条消息应该引用了你刚才发的「${name(inv, 'selfTest')} 2」（上面有一个小框显示那条消息）；没有引用就不正常`
}

/** 2-3：Markdown 卡片上的引用和 @ 提醒（发送时要求一定带，不看之前是否被平台拒绝过；这里只写正常的样子） */
export function mentionCard(): Card {
  const card = emptyCard('**样式自检 2-3：卡片上的引用和 @ 提醒**')
  card.sections.push({
    style: 'plain',
    lines: [
      { text: '正常：这张卡片引用了你刚发的那条消息，开头是 @你的名字，你也收到一条 @ 提醒' },
      { text: '看到 < 符号、没有引用、或者没有收到提醒，就不正常' },
      { text: '这张卡片每次都会尝试带引用和 @，即使之前的回复已经不带了；所以它不带，说明平台现在不接受' },
    ],
  })
  return card
}

/**
 * 2-4：正好 SELFTEST_LONG_CHARS 字的长消息（按发出去的 Markdown 算），最后一行是结束标记，前面写第 2 页的回报格式。
 * mention：发了 2-3 的 @ 提醒（单聊不发，回报格式里也就不写 2-3）
 */
const PAD = '补齐长度：'

export function longCard(inv: Pick<Invocation, 'commands' | 'render'>, mention = true): Card {
  const end = '——样式自检 2-4 到这里结束——'
  const target = Math.min(HARD_MAX_MESSAGE_CHARS, SELFTEST_LONG_CHARS)
  const example = ['2-1 正常 / 2-2 不正常（没有引用）/', ...mention ? ['2-3 正常 /'] : [], '2-4 长消息正常、长图看不清'].join(' ')
  const report = ['第 2 页到这里发完了。请照这个格式把结果告诉开发者：', example, end]
  const build = (filler: string[]): Card => {
    const card = emptyCard('**样式自检 2-4：长消息**')
    card.meta.push(`这条消息一共 ${SELFTEST_LONG_CHARS} 字。正常：能一直看到最后一行「${end}」；被截断、或者整条没发出来，就不正常。`)
    card.sections.push({ style: 'plain', lines: filler.map((text) => ({ text })) })
    card.sections.push({ style: 'plain', lines: report.map((text) => ({ text })) })
    return card
  }
  const length = (filler: string[]) => toQQMarkdown(build(filler), inv.render).md.length
  const filler = ['下面这些行只是用来把消息凑够长度。']
  for (let i = 1; ; i++) {
    const next = `第 ${i} 行：凑长度用的文字，不用看。`
    if (length([...filler, next]) > target) break
    filler.push(next)
  }
  // 最后加一行数字补齐，正好凑够（不在句子后面接一串「。」）
  while (filler.length > 1 && length([...filler, PAD]) > target) filler.pop()
  const pad = Math.max(0, target - length([...filler, PAD]))
  return build([...filler, PAD + '1234567890'.repeat(Math.ceil(pad / 10)).slice(0, pad)])
}
