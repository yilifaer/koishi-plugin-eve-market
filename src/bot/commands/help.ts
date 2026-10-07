// 帮助（§2.14）：注册成隐藏的 eve-market.help [主题]，前置中间件把「帮助」「菜单」「帮助 查价」「帮助查价」改写过来，
// plugin-help 的快捷方式就不会再匹配；「帮助 <别的插件的命令>」原样交给 plugin-help。
// 只列已经注册的命令（0.0.1 还没有工业、走势这些），命令名按当前注册的名字。

import { Command } from 'koishi'
import { COMMAND_NAMES, SERVER_LABEL } from '../../constants'
import type { CommandId } from '../../constants'
import type { CommandRegistry } from '../register'
import type { Action, Card, Line, Section } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { marketNames, marketPrefix } from './names'

export function registerHelp(commands: CommandContext): void {
  commands.registry.register('help', { args: '[topic:text]', description: '帮助' })
    ?.action(async ({ session }, topic) => {
      if (!session) return
      await invoke(commands, 'help', session, (inv) => runHelp(inv, typeof topic === 'string' ? topic : ''))
    })
}

async function runHelp(inv: Invocation, topic: string): Promise<void> {
  const id = topic.trim() ? topicOf(inv.commands.registry, topic.trim()) : undefined
  const card = id ? topicCard(inv, id) : undefined
  await sendCard(inv, card ?? mainCard(inv))
}

/** 主题（命令名或别名）→ 本插件的命令 */
function topicOf(registry: Pick<CommandRegistry, 'get'>, topic: string): CommandId | undefined {
  const key = Command.normalize(topic)
  return (Object.keys(COMMAND_NAMES) as CommandId[]).find((id) => {
    const command = id === 'help' ? undefined : registry.get(id)
    return !!command && Object.keys(command._aliases).includes(key)
  })
}

type HelpEnv = Pick<Invocation, 'commands' | 'core' | 'access'>

const nameOf = (env: HelpEnv, id: CommandId) => escapeMarkdown(env.commands.registry.name(id))
const has = (env: HelpEnv, id: CommandId) => env.commands.registry.has(id)

function exampleMarket(env: HelpEnv): string {
  return escapeMarkdown(marketPrefix(env.core.markets.visible(env.access)[0]))
}

/** 「▲▼ 是和 Jita 4-4 相比」：基准市场本群看得到时写它的名字 */
function compareText(env: HelpEnv): string {
  const base = env.core.markets.base()
  const visible = base && env.core.markets.visible(env.access).some((m) => m.key === base.key)
  return `▲▼ 是和${visible ? ` ${escapeMarkdown(base.name)} ` : '基准市场'}相比`
}

function priceLines(env: HelpEnv): Line[] {
  const lines: Line[] = []
  if (has(env, 'price')) {
    lines.push({ text: `${nameOf(env, 'price')} 乌鸦级：默认市场的出售、中间、收购价` })
    lines.push({ text: `${nameOf(env, 'price')} ${exampleMarket(env)}PLEX*500：指定市场和数量` })
  }
  if (has(env, 'batch')) lines.push({ text: `${nameOf(env, 'batch')}：粘贴清单或装配，算总价` })
  if (has(env, 'trend')) lines.push({ text: `${nameOf(env, 'trend')} 乌鸦级：近 30 天价格图` })
  return lines
}

function industryLines(env: HelpEnv): Line[] {
  const lines: Line[] = []
  if (has(env, 'manufacture')) lines.push({ text: `${nameOf(env, 'manufacture')} 乌鸦级：材料成本和制造时间` })
  if (has(env, 'manufactureCompare')) lines.push({ text: `${nameOf(env, 'manufactureCompare')} 乌鸦级：比较各个制造地点` })
  if (has(env, 'reaction')) lines.push({ text: `${nameOf(env, 'reaction')} 富勒化合物：反应成本` })
  return lines
}

function universeLines(env: HelpEnv): Line[] {
  const simple = (['incursion', 'influenceMap', 'coalitionMap', 'serverStatus'] as const).filter((id) => has(env, id))
  const lines: Line[] = simple.length ? [{ text: simple.map((id) => nameOf(env, id)).join(' · ') }] : []
  if (has(env, 'br')) lines.push({ text: `${nameOf(env, 'br')} + BR 链接（直接 @我 发链接也行）` })
  return lines
}

function otherLines(env: HelpEnv): Line[] {
  const parts: string[] = []
  if (has(env, 'search')) parts.push(`${nameOf(env, 'search')} 乌鸦`)
  if (has(env, 'translate')) parts.push(`${nameOf(env, 'translate')} 三钛合金`)
  if (has(env, 'groupId')) parts.push(nameOf(env, 'groupId'))
  return parts.length ? [{ text: parts.join(' · ') }] : []
}

function section(heading: string, lines: Line[]): Section[] {
  return lines.length ? [{ heading, lines }] : []
}

const fill = (env: HelpEnv, ids: CommandId[]): Action[] =>
  ids.filter((id) => has(env, id)).map((id) => ({ label: env.commands.registry.name(id), command: { id }, fillOnly: true }))

const direct = (env: HelpEnv, ids: CommandId[]): Action[] =>
  ids.filter((id) => has(env, id)).map((id) => ({ label: env.commands.registry.name(id), command: { id }, ...id === 'br' ? { fillOnly: true } : {} }))

function topicButtons(env: HelpEnv): Action[] {
  const topics: Array<[CommandId, string]> = [['price', '查价说明'], ['batch', '批量说明'], ['manufacture', '制造说明']]
  return topics
    .filter(([id]) => has(env, id))
    .map(([id, label]) => ({ label, command: { id: 'help', args: env.commands.registry.name(id) } }))
}

function helpActions(env: HelpEnv): Action[][] {
  return [
    fill(env, ['price', 'batch', 'trend', 'manufacture']),
    direct(env, ['incursion', 'influenceMap', 'br', 'serverStatus']),
    topicButtons(env),
  ].filter((row) => row.length)
}

const TITLE = `**EVE 市场助手** · ${SERVER_LABEL}`

/** 主卡片：价格、工业、宇宙、其他，最后是用法提示和数据来源的署名（黑话表 CC BY 4.0 要求，不能去掉） */
function mainCard(env: HelpEnv): Card {
  const card = emptyCard(TITLE)
  card.sections.push(
    ...section('价格', priceLines(env)),
    ...section('工业', industryLines(env)),
    ...section('宇宙', universeLines(env)),
    ...section('其他', otherLines(env)),
  )
  const topic = has(env, 'price') ? `；发「${nameOf(env, 'help')} ${nameOf(env, 'price')}」看详细用法` : ''
  card.sections.push({
    style: 'plain',
    lines: [
      { text: `群里先 @我 再输入${topic}。时间都是北京时间。` },
      { text: '数据：CCP hf.（非商业使用）· 黑话表：EVE Online 中文黑话表 eve-cn-slang（CC BY 4.0）' },
    ],
  })
  card.actions = helpActions(env)
  return card
}

/** 只 @ 机器人、没有内容：主卡片的前几行加按钮 */
export function shortCard(env: HelpEnv): Card {
  const card = emptyCard(TITLE)
  card.sections.push(...section('价格', priceLines(env)))
  card.actions = helpActions(env)
  return card
}

// ------------------------------------------------------------------ 分项帮助

function marketsSection(env: HelpEnv): Section {
  const lines: Line[] = [{ text: `本群可查：${marketNames(env.core.markets.visible(env.access)) || '无'}` }]
  const defaults = env.core.markets.defaults(env.access)
  if (defaults.length) lines.push({ text: `默认显示：${marketNames(defaults)}` })
  return { style: 'plain', lines }
}

function back(env: HelpEnv, id: CommandId): Action[][] {
  return [[{ label: env.commands.registry.name(id), command: { id }, fillOnly: true, primary: true }, { label: '全部帮助', command: { id: 'help' } }]]
}

function priceTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'price')
  const card = emptyCard(`**${name}**`)
  card.sections.push(
    {
      lines: [
        { text: `${name} 乌鸦级：查本群的默认市场` },
        { text: `${name} ${exampleMarket(env)}乌鸦级*10：只查一个市场，数量写成 *10` },
        { text: '中文名、英文名、简称都可以；有多个可能时会让你选' },
      ],
    },
    {
      heading: '价格的意思',
      lines: [
        { text: '出售：市场上最便宜的卖单，你马上买入要付的价' },
        { text: '收购：能成交的最高买单，你马上卖出能拿到的价' },
        { text: `中间：两者平均；${compareText(env)}` },
      ],
    },
    marketsSection(env),
  )
  card.actions = back(env, 'price')
  return card
}

function batchTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'batch')
  const card = emptyCard(`**${name}**`)
  card.sections.push(
    {
      lines: [
        { text: `${name} 换行后粘贴清单：一行一个，可以直接从游戏里复制（资产、合同、多买窗口）` },
        { text: '数量写法：Raven*2、2 Raven、Tritanium 1000000' },
        { text: '也可以粘贴整段 EFT 装配，算装配估价（装填的弹药按满装算）' },
      ],
    },
    {
      heading: '表头参数（写在命令后面，顺序随意）',
      lines: [
        { text: `市场：本群可查的市场，例如 ${exampleMarket(env).trim() || 'Jita'}` },
        { text: '价格：出售 / 中间 / 收购（也可以写 sell / mid / buy）' },
        { text: '调整：-5%、+10%、95% 或 95折' },
        { text: `例：${name} ${exampleMarket(env)}收购 -5%` },
      ],
    },
    marketsSection(env),
  )
  card.actions = back(env, 'batch')
  return card
}

function searchTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'search')
  const card = emptyCard(`**${name}**`)
  card.sections.push({
    lines: [
      { text: `${name} 乌鸦：名字里有「乌鸦」的物品，带出售和收购价（中文、英文、拼音都可以）` },
      { text: `${name} 乌鸦级：写完整名字时列出相关物品（同系列、蓝图）` },
      { text: `${name} ${exampleMarket(env)}护盾扩展：用指定市场的价格` },
      { text: `${name} 乌鸦 第2页：翻页` },
    ],
  })
  card.actions = back(env, 'search')
  return card
}

function groupIdTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'groupId')
  const card = emptyCard(`**${name}**`)
  card.sections.push({
    lines: [
      { text: `${name}：查看本群和你的完整 ID` },
      { text: '管理员在控制台填授权群、管理员时用' },
    ],
  })
  card.actions = [[{ label: env.commands.registry.name('groupId'), command: { id: 'groupId' }, primary: true }, { label: '全部帮助', command: { id: 'help' } }]]
  return card
}

const TOPICS: Partial<Record<CommandId, (env: HelpEnv) => Card>> = {
  price: priceTopic,
  batch: batchTopic,
  search: searchTopic,
  groupId: groupIdTopic,
}

/** 没写分项说明的命令回主卡片 */
function topicCard(env: HelpEnv, id: CommandId): Card | undefined {
  return TOPICS[id]?.(env)
}
