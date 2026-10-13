// 帮助里的工业部分（§2.14）：主卡片的「工业」一节，「帮助 制造」「帮助 制造比价」「帮助 反应」三张分项说明。
// 本群看不到 2 个以上能制造的地点时不写「制造比价」（基础参考不需要地点，「制造」「反应」总是写）。

import { CHAIN_ENABLED } from '../../constants'
import type { CommandId } from '../../constants'
import type { IndustryActivity } from '../../core/types'
import type { Action, Card, Line, Section } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { emptyCard } from './context'
import type { Invocation } from './context'
import { IND } from './industry-text'

type HelpEnv = Pick<Invocation, 'commands' | 'core' | 'access'>
type IndustryId = 'manufacture' | 'manufactureCompare' | 'reaction'

const nameOf = (env: HelpEnv, id: CommandId) => escapeMarkdown(env.commands.registry.name(id))
const has = (env: HelpEnv, id: CommandId) => env.commands.registry.has(id)

function locationNames(env: HelpEnv, activity: IndustryActivity): string[] {
  return env.core.industry.locations(env.access, activity).map((l) => escapeMarkdown(l.name))
}

/** 主卡片的「工业」一节 */
export function industryHelpLines(env: HelpEnv): Line[] {
  const lines: Line[] = []
  if (has(env, 'manufacture')) lines.push({ text: `${nameOf(env, 'manufacture')} 乌鸦级：材料成本和制造时间` })
  if (has(env, 'manufactureCompare') && locationNames(env, 'manufacturing').length >= 2) {
    lines.push({ text: `${nameOf(env, 'manufactureCompare')} 乌鸦级：比较各个制造地点` })
  }
  if (has(env, 'reaction')) lines.push({ text: `${nameOf(env, 'reaction')} 富勒化合物：反应成本` })
  return lines
}

function placesLine(env: HelpEnv, activity: IndustryActivity): Line {
  const names = locationNames(env, activity)
  return { text: names.length ? IND.locationsHere(activity, names.join(' · '), env.access.isDirect) : IND.noLocationsHere(activity, env.access.isDirect) }
}

function back(env: HelpEnv, id: IndustryId): Action[][] {
  return [[{ label: env.commands.registry.name(id), command: { id }, fillOnly: true, primary: true }, { label: '全部帮助', command: { id: 'help' } }]]
}

function example(env: HelpEnv, activity: IndustryActivity): string {
  return locationNames(env, activity)[0] ?? 'XX-1'
}

/** 拆到原料的用法：先回一张总览卡，细节点按钮看 */
function chainSection(name: string, place: string): Section {
  return {
    heading: '拆到原料',
    lines: [
      { text: `${name} 帕拉丁级 ${place} 拆到原料：从原料一路算到成品，先回一张总览卡，再点按钮看「分层明细」「原料清单」` },
      { text: '每一层造还是买：反应:买 / 反应:造、组件:买 / 组件:造、其他:造（连 T1 船体、R.A.M.、燃料块也自己造）；写了任何一个就是拆到原料' },
      { text: '低级反应可以走炼金术：反应:炼金（都走炼金）、反应:正常、反应:自动（挑便宜的，默认）' },
      { text: '加上 明细 直接出分层明细，加上 材料 直接出原料清单和可以粘进游戏的清单；税:1% 只改成品这一步的税' },
    ],
  }
}

function manufactureTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'manufacture')
  const place = example(env, 'manufacturing')
  const card = emptyCard(`**${name}**`)
  card.sections.push(
    {
      lines: [
        { text: `${name} 乌鸦级：基础参考，材料成本和制造时间（蓝图 ME 0 / TE 0，不计地点和税）` },
        { text: `${name} 乌鸦级 ${place}：快速计算，按这个地点的建筑、改装件和税直接出结果` },
        { text: `${name} 乌鸦级 高级：高级计算，一步一步选（地点 → ME/TE → 建筑）` },
        { text: `${name} 乌鸦级 材料：材料清单，再发一条可以粘进游戏「多重购买」窗口的清单` },
        { text: '数量写成 乌鸦级*10（按产品数量），或者 10流程' },
      ],
    },
    {
      heading: 'ME / TE 和其他参数',
      lines: [
        { text: 'ME 是蓝图的材料效率（0–10，越高越省材料），TE 是时间效率（0–20，越高越快）' },
        { text: '写法：ME10 TE20，或者 10/20；不写时用地点的默认值（T2 产品按 ME 2 / TE 4）' },
        { text: '建筑:名称（建筑:无 = 不用建筑加成）、改装:默认 / 改装:无、税:1.5%' },
        { text: '结果卡片下面的按钮可以改 ME/TE、换地点、改建筑和改装件、改税率' },
      ],
    },
    ...CHAIN_ENABLED ? [chainSection(name, place)] : [],
    { style: 'plain', lines: [placesLine(env, 'manufacturing'), { text: '想慢慢调参数可以私聊我，不刷群。' }] },
  )
  card.actions = back(env, 'manufacture')
  return card
}

function compareTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'manufactureCompare')
  const card = emptyCard(`**${name}**`)
  card.sections.push(
    {
      lines: [
        { text: `${name} 乌鸦级：每个能用的制造地点各算一次，按总成本排序，标出最便宜和最快的` },
        { text: `${name} 乌鸦级*10 ME8 TE16：指定数量和蓝图 ME/TE（${IND.compareDefaults}）` },
        { text: '每个地点用它的默认建筑、改装件和税；材料价格各地点相同' },
        { text: '加上 改装:无 或 税:1.5%：每个地点都不用改装件、或者都按这个税算' },
      ],
    },
    { style: 'plain', lines: [placesLine(env, 'manufacturing')] },
  )
  card.actions = back(env, 'manufactureCompare')
  return card
}

function reactionTopic(env: HelpEnv): Card {
  const name = nameOf(env, 'reaction')
  const place = example(env, 'reaction')
  const card = emptyCard(`**${name}**`)
  card.sections.push(
    {
      lines: [
        { text: `${name} 富勒化合物：基础参考，每流程的材料成本、时间和产出价值` },
        { text: `${name} 富勒化合物 ${place} 20流程：按这个地点的建筑、改装件和税直接出结果` },
        { text: `${name} 富勒化合物 高级：一步一步选（地点 → 建筑）` },
        { text: `${name} 富勒化合物 材料：材料清单和可以粘进游戏的清单` },
      ],
    },
    {
      style: 'plain',
      lines: [
        { text: '反应配方不能研究，没有 ME/TE；高安不能进行反应。' },
        placesLine(env, 'reaction'),
      ],
    },
  )
  card.actions = back(env, 'reaction')
  return card
}

/** 分项说明：「帮助 制造」「帮助 制造比价」「帮助 反应」 */
export const INDUSTRY_TOPICS: Partial<Record<CommandId, (env: HelpEnv) => Card>> = {
  manufacture: manufactureTopic,
  manufactureCompare: compareTopic,
  reaction: reactionTopic,
}
