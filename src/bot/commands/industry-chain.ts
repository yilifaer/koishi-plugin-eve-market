// 拆到原料（0.0.5）的命令处理：制造 / 反应 加上「拆到原料」或任何一个层的参数词时由 industry.ts 交到这里。
// 默认只发 1 张总览卡；「分层明细」「原料清单」「继续拆」是按钮（带「明细」「材料」「其他:造」的新命令），每次点都有新的回复额度。
// 回复额度按「材料」算（群里 4 条、单聊 3 条）：慢提示占 1 条，卡片至少留 1 条，多买清单最多 2 条。

import { CHAIN_ENABLED, MATERIALS_BUDGET, MATERIALS_COPY_BLOCK } from '../../constants'
import { industryArgsText } from '../../core/parse'
import type { IndustryArgsParts } from '../../core/parse'
import { isFailure } from '../../core/types'
import type { ChainLayer, ChainRequest, ChainResult, CoreFailure, IndustryRequest, IndustryResult, IndustryStep, LayerMode } from '../../core/types'
import { createReplier, replyBudget, sendState } from '../send/replier'
import type { Action } from '../view/card'
import { sendCard } from './context'
import type { Invocation } from './context'
import { buyList, detailsCard, materialsChainCard, overviewCard } from './industry-chain-card'
import { CH } from './industry-chain-text'
import type { IndustryEnv } from './industry-card'
import { itemArgs } from './names'
import { startSlowHint } from './slow'

type ChainCommand = 'manufacture' | 'reaction'
type Parts = Omit<IndustryArgsParts, 'item'>
type Layers = Record<ChainLayer, LayerMode>

/** industry.ts 里已有的失败卡和逐步选择，从那边传进来（免得两个文件互相引用） */
export interface ChainHooks {
  planFailure(inv: Invocation, id: ChainCommand, failure: CoreFailure, req: IndustryRequest): Promise<void>
  sendStep(inv: Invocation, id: ChainCommand, req: IndustryRequest, step: IndustryStep): Promise<void>
}

function env(inv: Invocation): IndustryEnv {
  return { core: inv.core, display: inv.commands.settings.display, industry: inv.commands.settings.industry, direct: inv.access.isDirect }
}

/** 拆到原料自己的回复器：额度同「材料」，慢提示、卡片、多买清单共用 */
function withReply(inv: Invocation): Invocation {
  const reply = createReplier(inv.session, {
    budget: replyBudget(MATERIALS_BUDGET.max, inv.session.isDirect),
    mode: inv.commands.settings.display.output,
    render: inv.render,
    state: sendState(inv.commands.store),
    logger: inv.commands.logger,
  })
  return { ...inv, reply }
}

export async function sendChain(inv0: Invocation, id: ChainCommand, req: IndustryRequest, hooks: ChainHooks): Promise<void> {
  const inv = withReply(inv0)
  if (!CHAIN_ENABLED || !req.chain) {
    await inv.reply.text(CH.disabled)
    return
  }
  const chainReq: ChainRequest = { ...req, chain: req.chain }
  const hint = startSlowHint(inv, 1, () => CH.slow)
  const out = await inv.core.industry.chain(chainReq).finally(() => hint.stop())
  await hint.sent()
  if (isFailure(out)) {
    if (out.reason === 'chain-size') await inv.reply.text(CH.tooBig)
    else await hooks.planFailure(inv, id, out, req)
    return
  }
  if (!('nodes' in out)) return hooks.sendStep(inv, id, req, out)
  if (req.chain.details) return sendDetails(inv, id, req, out)
  if (req.materials) return sendMaterials(inv, id, req, out)
  await sendCard(inv, overviewCard(env(inv), out, overviewActions(inv, id, req, out), req.me === undefined && req.te === undefined))
}

async function sendDetails(inv: Invocation, id: ChainCommand, req: IndustryRequest, r: ChainResult): Promise<void> {
  const actions = rows([
    { label: CH.btnOverview, command: command(inv, id, r, { ...baseParts(req, r), chain: chainOf(r) }), primary: true },
    { label: CH.btnMaterials, command: command(inv, id, r, { ...baseParts(req, r), chain: chainOf(r), materials: true }) },
  ])
  await inv.reply.card(detailsCard(env(inv), r, actions))
}

/** 原料清单：卡片 + 多买清单（纯文本，最多 2 条，并且给卡片留至少 1 条） */
async function sendMaterials(inv: Invocation, id: ChainCommand, req: IndustryRequest, r: ChainResult): Promise<void> {
  const room = Math.max(0, Math.min(2, inv.reply.remaining() - 1))
  const copies = MATERIALS_COPY_BLOCK ? inv.core.industry.multibuy({ materials: buyList(r) } as IndustryResult).slice(0, room) : []
  const actions = rows([
    { label: CH.btnOverview, command: command(inv, id, r, { ...baseParts(req, r), chain: chainOf(r) }), primary: true },
    { label: CH.btnDetails, command: command(inv, id, r, { ...baseParts(req, r), chain: chainOf(r, {}, true) }) },
  ])
  await inv.reply.card(materialsChainCard(env(inv), r, copies, actions))
}

// ------------------------------------------------------------------ 按钮里的命令

const rows = (...list: Action[][]): Action[][] => list.filter((row) => row.length)

/** 命令名 + 物品 + 参数；整条命令超过 100 字时物品换成 #typeID */
function command(inv: Invocation, id: ChainCommand, r: ChainResult, parts: Parts): Action['command'] {
  return { id, args: itemArgs(inv.core, inv.render, id, r.product, (item) => industryArgsText({ item, ...parts }, inv.commands.settings.industry.chain)) }
}

/** 这次计算写了什么就带什么（地点用规范的名字；自动挑的成品建筑也带上，后面的按钮用的是同一座） */
function baseParts(req: IndustryRequest, r: ChainResult): Parts {
  const top = r.nodes[0]
  const parts: Parts = {
    quantity: req.quantity, runs: req.runs, location: r.location, me: req.me, te: req.te, rigs: req.rigs, facilityTaxPct: req.facilityTaxPct,
  }
  if (req.structure !== undefined || top.autoPicked) parts.structure = top.structure ?? 'none'
  return parts
}

/** 拆到原料的参数：用结果里实际生效的层设置，换掉 layers 里指定的几层 */
function chainOf(r: ChainResult, layers: Partial<Layers> = {}, details = false): NonNullable<IndustryArgsParts['chain']> {
  return { on: true, layers: { ...r.options.layers, ...layers }, alchemy: r.options.alchemy, ...details ? { details } : {} }
}

/** 反应、组件的开关：现在是造的（并且用到了）给「买」，现在是买的给「造」；没用到的层没有可改的 */
function layerToggle(inv: Invocation, id: ChainCommand, req: IndustryRequest, r: ChainResult, which: 'reaction' | 'component'): Action | undefined {
  const names: ChainLayer[] = which === 'reaction' ? ['reaction1', 'reaction2'] : ['component']
  const building = names.some((l) => r.options.layers[l] === 'build')
  if (building && !r.layers.some((row) => names.includes(row.layer as ChainLayer) && row.used)) return undefined
  const mode: LayerMode = building ? 'buy' : 'build'
  const layers = Object.fromEntries(names.map((l) => [l, mode])) as Partial<Layers>
  return { label: CH.btnLayer(which, mode), command: command(inv, id, r, { ...baseParts(req, r), chain: chainOf(r, layers) }) }
}

/** 买的东西里有能造的：只把它们所在的层改成造（没有能造的就没有这个按钮） */
function moreAction(inv: Invocation, id: ChainCommand, req: IndustryRequest, r: ChainResult): Action | undefined {
  const buildable = [...new Set(r.leaves.map((l) => l.layer).filter((l): l is ChainLayer => !!l))]
  if (!buildable.length) return undefined
  const layers = Object.fromEntries(buildable.map((l) => [l, 'build'])) as Partial<Layers>
  return { label: CH.btnMore, command: command(inv, id, r, { ...baseParts(req, r), chain: chainOf(r, layers) }) }
}

/** 总览卡的按钮（最多 3 行）：看细节 / 改造买 / 换地点、只算成品 */
function overviewActions(inv: Invocation, id: ChainCommand, req: IndustryRequest, r: ChainResult): Action[][] {
  const base = baseParts(req, r)
  const amounts: Parts = { quantity: req.quantity, runs: req.runs }
  return rows(
    [
      { label: CH.btnDetails, command: command(inv, id, r, { ...base, chain: chainOf(r, {}, true) }), primary: true },
      { label: CH.btnMaterials, command: command(inv, id, r, { ...base, chain: chainOf(r), materials: true }) },
      moreAction(inv, id, req, r),
    ].filter((a): a is Action => !!a),
    [layerToggle(inv, id, req, r, 'reaction'), id === 'manufacture' ? layerToggle(inv, id, req, r, 'component') : undefined].filter((a): a is Action => !!a),
    [
      { label: CH.btnLocation, command: command(inv, id, r, { ...amounts, me: req.me, te: req.te, chain: chainOf(r), steps: true }) },
      { label: CH.btnProductOnly, command: command(inv, id, r, base) },
    ],
  )
}
