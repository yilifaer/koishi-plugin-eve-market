// 帮助（§2.14）：注册成隐藏的 eve-market.help [主题]，前置中间件把「帮助」「菜单」「帮助 查价」「帮助查价」改写过来，
// plugin-help 的快捷方式就不会再匹配；「帮助 <别的插件的命令>」原样交给 plugin-help。
// 只列已经注册的命令，命令名按当前注册的名字（工业部分在 industry-help.ts）。管理命令只写给管理员看
// （单聊或授权群里；样式自检在哪个群都行），别人发「帮助 市场状态」得到的是主卡片。

import { Command } from 'koishi'
import { COMMAND_NAMES, SERVER_LABEL, TRANSLATE_ALIAS } from '../../constants'
import type { CommandId } from '../../constants'
import type { CommandRegistry } from '../register'
import type { Action, Card, Line, Section } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { INDUSTRY_TOPICS, industryHelpLines } from './industry-help'
import { marketNames, marketPrefix } from './names'
import { sitesOf } from './shot-send'

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

const industryLines = industryHelpLines

function universeLines(env: HelpEnv): Line[] {
  const simple = (['incursion', 'influenceMap', 'coalitionMap', 'serverStatus'] as const).filter((id) => has(env, id))
  const lines: Line[] = simple.length ? [{ text: simple.map((id) => nameOf(env, id)).join(' · ') }] : []
  if (has(env, 'br')) lines.push({ text: `${nameOf(env, 'br')} + BR 链接（直接 @我 发链接也行）` })
  if (has(env, 'shot')) lines.push({ text: `${nameOf(env, 'shot')} + 网址：${siteNamesOf(env)}` })
  return lines
}

/** 能截的网站（短名）：不写网址 */
function siteNamesOf(env: HelpEnv): string {
  const names = sitesOf(env.commands).sites.map((s) => s.name.replace(/估价结果$/, '估价'))
  return escapeMarkdown(names.join('、') || '暂时没有')
}

function otherLines(env: HelpEnv): Line[] {
  const parts: string[] = []
  if (has(env, 'search')) parts.push(`${nameOf(env, 'search')} 乌鸦`)
  if (has(env, 'translate')) parts.push(`${nameOf(env, 'translate')} 三钛合金`)
  if (has(env, 'groupId')) parts.push(nameOf(env, 'groupId'))
  return parts.length ? [{ text: parts.join(' · ') }] : []
}

/** 管理员，并且在单聊或授权群里（和管理命令自己的判断一样） */
const adminHere = (env: HelpEnv) => env.access.isAdmin && (env.access.isDirect || env.access.allowed)

function adminLines(env: HelpEnv): Line[] {
  if (!adminHere(env)) return []
  const ids = (['marketStatus', 'marketAuth', 'selfTest'] as const).filter((id) => has(env, id))
  const lines: Line[] = ids.length ? [{ text: `${ids.map((id) => nameOf(env, id)).join(' · ')}（只有管理员能用）` }] : []
  if (has(env, 'shotProbe')) lines.push({ text: `${nameOf(env, 'shotProbe')}（只有管理员能用）` })
  return lines
}

function section(heading: string, lines: Line[]): Section[] {
  return lines.length ? [{ heading, lines }] : []
}

const fill = (env: HelpEnv, ids: CommandId[]): Action[] =>
  ids.filter((id) => has(env, id)).map((id) => ({ label: env.commands.registry.name(id), command: { id }, fillOnly: true }))

const direct = (env: HelpEnv, ids: CommandId[]): Action[] =>
  ids.filter((id) => has(env, id)).map((id) => ({ label: env.commands.registry.name(id), command: { id }, ...id === 'br' ? { fillOnly: true } : {} }))

function topicButtons(env: HelpEnv): Action[] {
  const topics: Array<[CommandId, string]> = [['price', '查价说明'], ['batch', '批量说明'], ['trend', '走势说明'], ['manufacture', '制造说明']]
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
    ...section('管理', adminLines(env)),
  )
  const topic = has(env, 'price') ? `；发「${nameOf(env, 'help')} ${nameOf(env, 'price')}」看详细用法` : ''
  card.sections.push({
    style: 'plain',
    lines: [
      { text: `群里先 @我 再输入${topic}。时间都是北京时间。` },
      { text: '按钮只把命令填进输入框，要再按发送' },
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

function adminBack(env: HelpEnv, id: CommandId): Action[][] {
  return [[{ label: env.commands.registry.name(id), command: { id }, primary: true }, { label: '全部帮助', command: { id: 'help' } }]]
}

function marketStatusTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'marketStatus')
  const card = emptyCard(`**${name}**（管理员）`)
  card.sections.push({
    lines: [
      { text: `${name}：每个市场能不能用、建筑市场上次同步、授权档案、物品数据版本、ESI 配额、配置问题` },
      { text: `${name} 刷新：马上检查在线数据，只重新同步已经过期或出错的建筑市场（不会打破 ESI 的缓存规则）` },
      { text: '🟢 正常 · 🟡 需要授权或暂时出错 · 🔴 授权异常（失去停靠或访问权限、令牌失效）' },
    ],
  }, {
    style: 'plain',
    lines: [{ text: '只在单聊或授权群里回应，其他人发了没有反应。' }],
  })
  card.actions = adminBack(env, 'marketStatus')
  return card
}

function marketAuthTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'marketAuth')
  const card = emptyCard(`**${name}**（管理员）`)
  card.sections.push({
    lines: [
      { text: `${name}：列出 EVE 授权档案（服务角色、权限、上次刷新）和用到它的建筑市场` },
      { text: '授权和重新授权在浏览器里做：Koishi 控制台 → 本插件的设置页 → 最上面的「打开 EVE 授权页面」' },
    ],
  }, {
    style: 'plain',
    lines: [{ text: '只在单聊或授权群里回应；消息里只有状态，不会出现口令和网址。' }],
  })
  card.actions = adminBack(env, 'marketAuth')
  return card
}

function trendTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'trend')
  const card = emptyCard(`**${name}**`)
  const npc = env.core.markets.visible(env.access).filter((m) => m.type !== 'structure')
  const example = npc[1] ?? npc[0]
  card.sections.push({
    lines: [
      { text: `${name} 乌鸦级：近 30 天的价格图，再加一张小卡片（最近均价、最高最低、日均成交）` },
      { text: `${name} 乌鸦级 季：近 90 天；写「年」是近 365 天` },
      { text: `${name} ${example ? escapeMarkdown(marketPrefix(example)) : ''}乌鸦级：指定 NPC 市场，按它所在的星域` },
    ],
  }, {
    style: 'plain',
    lines: [{ text: '数据是 ESI 的星域成交历史，每天更新一次；玩家建筑市场没有成交历史。' }],
  })
  card.actions = back(env, 'trend')
  return card
}

function brTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'br')
  const card = emptyCard(`**${name}**`)
  card.sections.push({
    lines: [
      { text: `${name} 加上战报链接（BR 工具、Warbeacon）：把战报页面截图发出来` },
      { text: '也可以直接 @我 发战报链接，不用写命令' },
      { text: '一般要 10–30 秒；长战报分成两张图；同一个链接 10 分钟内再发很快' },
    ],
  })
  card.actions = back(env, 'br')
  return card
}

function shotTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'shot')
  const card = emptyCard(`**${name}**`)
  card.sections.push({
    lines: [
      { text: `${name} 加上网址：把网页截图发出来` },
      { text: `能截的网站：${siteNamesOf(env)}` },
      { text: '也可以直接 @我 发这些网站的链接，不用写命令' },
      { text: '一般要 10–30 秒；长页面最多分成几张图；同一个链接 10 分钟内再发很快' },
      { text: `${nameOf(env, 'br')}：只认战报网站的链接` },
    ],
  })
  card.actions = back(env, 'shot')
  return card
}

function shotProbeTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'shotProbe')
  const card = emptyCard(`**${name}**（管理员）`)
  card.sections.push({
    lines: [
      { text: `${name} 加上网址：不用缓存截一次，先发一张检查卡片，再发图` },
      { text: '卡片上有：HTTP 状态、打开用时、页面标题、页面高度、截了几张、是不是验证页、拦下的跳转和内网请求个数' },
      { text: '用来核对新网站的页面参数；结果告诉开发者' },
    ],
  })
  return card
}

/** 「中英对照」：别名还在（没有和别的插件撞名）时写出来 */
function translateAlias(env: HelpEnv): string {
  const command = env.commands.registry.get('translate')
  return command && Command.normalize(TRANSLATE_ALIAS) in command._aliases ? `（也可以写「${escapeMarkdown(TRANSLATE_ALIAS)}」）` : ''
}

function translateTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'translate')
  const card = emptyCard(`**${name}**${translateAlias(env)}`)
  card.sections.push({
    lines: [
      { text: `${name} 三钛合金：物品的中英文名，物品有别名时一起列出` },
      { text: `${name} Jita：星系、星座、星域（星系带安全等级）` },
      { text: `${name} 打X：黑话表里的说法和解释` },
    ],
  })
  card.actions = back(env, 'translate')
  return card
}

const UNIVERSE: CommandId[] = ['incursion', 'influenceMap', 'coalitionMap', 'serverStatus']

function universeTopic(env: HelpEnv): Card {
  const ids = UNIVERSE.filter((id) => has(env, id))
  const card = emptyCard(`**${ids.map((id) => nameOf(env, id)).join(' · ')}**`)
  const about: Partial<Record<CommandId, string>> = {
    incursion: '当前所有入侵的位置、状态和影响力',
    influenceMap: '欧服主权影响力图（来源 Verite，每小时更新）',
    coalitionMap: '联盟影响力图（来源 Verite，每小时更新）',
    serverStatus: '在线人数、本次开服、下次维护',
  }
  card.sections.push({ lines: ids.map((id) => ({ text: `${nameOf(env, id)}：${about[id] ?? ''}` })) }, {
    style: 'plain',
    lines: [{ text: '这几个命令都不用加参数。' }],
  })
  card.actions = [
    ids.map((id) => ({ label: env.commands.registry.name(id), command: { id } })),
    [{ label: '全部帮助', command: { id: 'help' } }],
  ]
  return card
}

function selfTestTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'selfTest')
  const card = emptyCard(`**${name}**（管理员）`)
  card.sections.push({
    lines: [
      { text: `${name} 1：Markdown 格式、按钮、可点文字，最后是回报格式` },
      { text: `${name} 2：图片下面的说明、引用回复、@ 提醒、长消息和长图` },
      { text: '每条测试消息开头写了正常是什么样子；上线前在测试群里做一次，照回报格式把结果告诉开发者' },
    ],
  })
  card.actions = [[
    { label: `${env.commands.registry.name('selfTest')} 1`, command: { id: 'selfTest', args: '1' }, primary: true },
    { label: `${env.commands.registry.name('selfTest')} 2`, command: { id: 'selfTest', args: '2' } },
  ]]
  return card
}

const TOPICS: Partial<Record<CommandId, (env: HelpEnv) => Card>> = {
  price: priceTopic,
  batch: batchTopic,
  trend: trendTopic,
  search: searchTopic,
  br: brTopic,
  shot: shotTopic,
  translate: translateTopic,
  incursion: universeTopic,
  influenceMap: universeTopic,
  coalitionMap: universeTopic,
  serverStatus: universeTopic,
  groupId: groupIdTopic,
  ...INDUSTRY_TOPICS,
}

const ADMIN_TOPICS: Partial<Record<CommandId, (env: HelpEnv) => Card>> = {
  marketStatus: marketStatusTopic,
  marketAuth: marketAuthTopic,
}

/** 没写分项说明的命令回主卡片；管理命令只给管理员看说明（样式自检、截图测试不限群） */
function topicCard(env: HelpEnv, id: CommandId): Card | undefined {
  if (id === 'selfTest') return env.access.isAdmin ? selfTestTopic(env) : undefined
  if (id === 'shotProbe') return env.access.isAdmin ? shotProbeTopic(env) : undefined
  const admin = adminHere(env) ? ADMIN_TOPICS[id] : undefined
  return (TOPICS[id] ?? admin)?.(env)
}
