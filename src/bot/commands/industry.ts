// 制造、制造比价、反应（§2.6–§2.8）。无状态：每个按钮里都是完整命令（命令名 + 物品 + 参数）。
// 制造 / 反应：不写地点出基础参考；写了地点直接出结果（缺的参数用默认值）；写「高级」逐步选择（地点 → ME/TE → 建筑，
// 只有一个选项的步骤跳过）；写「材料」出材料清单，再单独发一条可以粘进游戏多重购买窗口的纯文本（回复额度按材料清单算）。
// 制造比价：本群能看到的地点各算一次，按总成本排序；第一次要取星系成本指数和调整价，3 秒还没好时发一次慢提示。

import { MATERIALS_BUDGET, MATERIALS_COPY_BLOCK, MAX_ACTIONS_PER_ROW } from '../../constants'
import type { CommandId } from '../../constants'
import { industryArgsText, portableStructure } from '../../core/parse'
import type { IndustryArgsParts } from '../../core/parse'
import { isFailure } from '../../core/types'
import type {
  CoreFailure, IndustryActivity, IndustryRequest, IndustryResult, IndustryStep, ItemInfo, LocationComparison, Resolution,
} from '../../core/types'
import { choicesOf, pendingKey } from '../pending'
import { createReplier, replyBudget, sendState } from '../send/replier'
import type { Action, Card, CommandRef } from '../view/card'
import { buttonLabel } from '../view/clickable'
import { escapeMarkdown, hasUrl, safeEcho } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { baseCard, compareCard, materialsCard, resultCard, stepCard } from './industry-card'
import type { IndustryEnv } from './industry-card'
import { sendChain } from './industry-chain'
import { BAD_ARG, IND } from './industry-text'
import { itemArgs, itemName } from './names'
import { candidatesCard, notFoundCard, searchKeyword } from './resolution'
import type { ChoiceOptions } from './resolution'
import { startSlowHint } from './slow'
import { SAY } from './text'

type PlanId = 'manufacture' | 'reaction'
type Parts = Omit<IndustryArgsParts, 'item'>

const ACTIVITY_OF: Record<PlanId, IndustryActivity> = { manufacture: 'manufacturing', reaction: 'reaction' }

export function registerIndustry(commands: CommandContext): void {
  commands.registry.register('manufacture', { args: '[args:text]', needsArgs: true, description: '制造：材料成本、制造时间和安装费用' })
    ?.action(async ({ session }, args) => {
      if (!session) return
      await invoke(commands, 'manufacture', session, (inv) => runPlan(inv, 'manufacture', textOf(args)))
    })
  commands.registry.register('manufactureCompare', { args: '[args:text]', needsArgs: true, description: '制造比价：比较各个制造地点的成本和时间' })
    ?.action(async ({ session }, args) => {
      if (!session) return
      await invoke(commands, 'manufactureCompare', session, (inv) => runCompare(inv, textOf(args)))
    })
  commands.registry.register('reaction', { args: '[args:text]', needsArgs: true, description: '反应：反应材料成本、时间和安装费用' })
    ?.action(async ({ session }, args) => {
      if (!session) return
      await invoke(commands, 'reaction', session, (inv) => runPlan(inv, 'reaction', textOf(args)))
    })
}

/** 参数里的换行当空格（粘贴时带出来的） */
const textOf = (args: unknown) => (typeof args === 'string' ? args.replace(/\s+/g, ' ').trim() : '')

function env(inv: Invocation): IndustryEnv {
  return { core: inv.core, display: inv.commands.settings.display, industry: inv.commands.settings.industry, direct: inv.access.isDirect }
}

// ------------------------------------------------------------------ 按钮里的命令

/** 命令名 + 物品 + 参数；整条命令超过 100 字时物品换成 #typeID。tail：接在最后的文字（「税:」） */
function commandOf(inv: Invocation, id: CommandId, product: ItemInfo, parts: Parts, tail = ''): CommandRef {
  return { id, args: itemArgs(inv.core, inv.render, id, product, (item) => `${industryArgsText({ item, ...parts }, inv.commands.settings.industry.chain)}${tail}`) }
}

/** core 给的步骤参数以 commandName 开头：整条命令太长时同样换成 #typeID */
function fitArgs(inv: Invocation, id: CommandId, product: ItemInfo, args: string): string {
  const name = inv.core.items.commandName(product)
  if (!args.startsWith(name)) return args
  const rest = args.slice(name.length)
  return itemArgs(inv.core, inv.render, id, product, (item) => `${item}${rest}`)
}

/** 数量、流程数和拆到原料的设置：每条按钮命令都带着 */
const amountOf = (req: Pick<IndustryRequest, 'quantity' | 'runs' | 'chain'>): Parts => ({ quantity: req.quantity, runs: req.runs, chain: req.chain })

/** 这次计算的参数（写了什么就带什么；地点用规范的名字，建筑用实际选中的那座） */
function currentParts(req: IndustryRequest, r: IndustryResult): Parts {
  const parts: Parts = { ...amountOf(req), location: r.applied.location, me: req.me, te: req.te, rigs: req.rigs, facilityTaxPct: req.facilityTaxPct }
  // 自动挑的建筑也带上：以后的材料、改装开关、改税用的还是同一座
  if (req.structure !== undefined || r.applied.autoPicked) parts.structure = r.applied.structure ?? 'none'
  return parts
}

/** 没写地点时「快速计算」用的地点：造得了这个产品的默认地点，或者唯一能造的地点（没有就不给按钮） */
function quickLocation(inv: Invocation, activity: IndustryActivity, product: ItemInfo): string | undefined {
  const list = inv.core.industry.locationsFor(inv.access, activity, product.typeId)
  return (list.find((l) => l.isDefault) ?? (list.length === 1 ? list[0] : undefined))?.name
}

/** 本群能比较制造地点（制造比价注册了、能看到 2 个以上能造这个产品的地点） */
function canCompare(inv: Invocation, product: ItemInfo): boolean {
  return inv.commands.registry.has('manufactureCompare') && inv.core.industry.locationsFor(inv.access, 'manufacturing', product.typeId).length >= 2
}

function rows(...list: Array<Array<Action | undefined>>): Action[][] {
  return list.map((row) => row.filter((a): a is Action => !!a)).filter((row) => row.length)
}

function baseActions(inv: Invocation, id: PlanId, req: IndustryRequest, product: ItemInfo): Action[][] {
  const activity = ACTIVITY_OF[id]
  const keep: Parts = { ...amountOf(req), me: req.me, te: req.te }
  const quick = quickLocation(inv, activity, product)
  return rows([
    quick ? { label: IND.quick, command: commandOf(inv, id, product, { ...keep, location: quick }), primary: true } : undefined,
    { label: IND.advanced, command: commandOf(inv, id, product, { ...keep, steps: true }) },
    { label: IND.materials, command: commandOf(inv, id, product, { ...keep, materials: true }) },
    activity === 'manufacturing' && canCompare(inv, product)
      ? { label: IND.compare, command: commandOf(inv, 'manufactureCompare', product, keep) }
      : undefined,
  ])
}

function resultActions(inv: Invocation, id: PlanId, req: IndustryRequest, r: IndustryResult): Action[][] {
  const { product, applied } = r
  const current = currentParts(req, r)
  const amounts = amountOf(req)
  const manufacturing = id === 'manufacture'
  // 改建筑、改税率：ME/TE 写明，免得重新问第 2 步
  const fixed: Parts = { ...current, me: manufacturing ? applied.me : undefined, te: manufacturing ? applied.te : undefined }
  const structure = applied.structure ?? (req.structure === 'none' ? 'none' : undefined)
  // 开关改装件后建筑要重新挑：自动选的不带，用户自己写的才带
  const toggled: Parts = req.structure === undefined ? { ...current, structure: undefined } : current
  // 只在改装件能开关时给（「建筑:无」、NPC 空间站装不了；没装、不生效时开关没有区别）
  const rigsToggle: Action | undefined = applied.rigState === 'disabled'
    ? { label: IND.rigsOn, command: commandOf(inv, id, product, { ...toggled, rigs: 'default' }) }
    : applied.rigState === 'applied' ? { label: IND.rigsOff, command: commandOf(inv, id, product, { ...toggled, rigs: 'none' }) }
      : undefined
  return rows(
    [
      { label: IND.materials, command: commandOf(inv, id, product, { ...current, materials: true }), primary: true },
      manufacturing
        ? { label: IND.changeMeTe, command: commandOf(inv, id, product, { ...current, me: undefined, te: undefined, structure, steps: true }) }
        : undefined,
      { label: IND.changeLocation, command: commandOf(inv, id, product, { ...amounts, me: req.me, te: req.te, steps: true }) },
      manufacturing && canCompare(inv, product)
        ? { label: IND.compareAgain, command: commandOf(inv, 'manufactureCompare', product, { ...amounts, me: applied.me, te: applied.te }) }
        : undefined,
    ],
    [
      { label: IND.changeStructure, command: commandOf(inv, id, product, { ...fixed, structure: '?', steps: true }) },
      rigsToggle,
      { label: IND.changeTax, command: commandOf(inv, id, product, { ...fixed, structure, facilityTaxPct: undefined }, ' 税:') },
    ],
  )
}

// ------------------------------------------------------------------ 制造、反应

async function runPlan(inv: Invocation, id: PlanId, text: string): Promise<void> {
  const activity = ACTIVITY_OF[id]
  if (!text) {
    await sendCard(inv, usageCard(inv, id))
    return
  }
  const req = inv.core.parse.industryArgs(text, activity, inv.access)
  if (isFailure(req)) return planFailure(inv, id, req)
  if (req.chain) return sendChain(inv, id, req, { planFailure, sendStep })
  const out = await inv.core.industry.plan(req)
  if (isFailure(out)) return planFailure(inv, id, out, req)
  if (isStep(out)) return sendStep(inv, id, req, out)
  if (req.materials) return sendMaterials(inv, id, req, out)
  const card = req.mode === 'base'
    ? baseCard(env(inv), out, activity, baseActions(inv, id, req, out.product), IND.materials)
    : resultCard(env(inv), out, activity, resultActions(inv, id, req, out))
  await sendCard(inv, card)
}

function isStep(out: IndustryResult | IndustryStep): out is IndustryStep {
  return 'step' in out && 'options' in out
}

async function sendStep(inv: Invocation, id: PlanId, req: IndustryRequest, step: IndustryStep): Promise<void> {
  const product = inv.core.items.byId(req.typeId)
  if (!product) {
    await inv.reply.text(SAY.failed)
    return
  }
  const fit = (args: string): CommandRef => ({ id, args: fitArgs(inv, id, product, args) })
  const custom = step.custom ? fit(step.custom).args! : undefined
  const actions: Action[] = []
  if (custom) actions.push({ label: IND.custom, command: { id, args: custom } })
  if (step.defaults) {
    const label = step.step === 'location' ? IND.directResult : IND.restDefault
    actions.push({ label, command: fit(step.defaults), primary: true })
  }
  const card = stepCard(product, ACTIVITY_OF[id], step, { option: fit, actions: actions.length ? [actions] : [] })
  await inv.reply.card(card)
  // 第 2 步也接受「ME7 TE14」：接在去掉末尾「ME」的自定义命令后面
  const meTe = custom ? `${inv.commands.registry.name(id)} ${custom.replace(/\s*ME$/i, '')}` : undefined
  inv.commands.pending.setChoices(pendingKey(inv.session), choicesOf(card, inv.commands.registry.namer()), meTe ? { meTe } : {})
}

/** 材料清单：卡片 + 多买清单（纯文本，最多 2 条，并且给卡片留至少 1 条） */
async function sendMaterials(inv: Invocation, id: PlanId, req: IndustryRequest, r: IndustryResult): Promise<void> {
  const reply = createReplier(inv.session, {
    budget: replyBudget(MATERIALS_BUDGET.max, inv.session.isDirect),
    mode: inv.commands.settings.display.output,
    render: inv.render,
    state: sendState(inv.commands.store),
    logger: inv.commands.logger,
  })
  const copies = MATERIALS_COPY_BLOCK ? inv.core.industry.multibuy(r).slice(0, Math.max(0, Math.min(2, reply.remaining() - 1))) : []
  const back: Parts = req.mode === 'base' ? { ...amountOf(req), me: req.me, te: req.te } : currentParts(req, r)
  const actions = [[{ label: IND.costDetail, command: commandOf(inv, id, r.product, back) }]]
  await reply.card(materialsCard(env(inv), r, ACTIVITY_OF[id], copies, actions))
}

// ------------------------------------------------------------------ 失败

async function planFailure(inv: Invocation, id: PlanId | 'manufactureCompare', failure: CoreFailure, req?: IndustryRequest): Promise<void> {
  const activity: IndustryActivity = id === 'reaction' ? 'reaction' : 'manufacturing'
  switch (failure.code) {
    case 'ITEM_NOT_FOUND':
    case 'ITEM_AMBIGUOUS':
      await sendCard(inv, itemCard(inv, id, failure))
      return
    case 'IS_REACTION':
    case 'OUT_OF_SCOPE':
      await sendCard(inv, otherActivityCard(inv, failure, activity))
      return
    case 'NOT_MANUFACTURABLE': {
      const item = itemOf(failure.resolution)
      const name = item ? itemName(item) : failure.token ?? ''
      await inv.reply.text(activity === 'manufacturing' ? IND.notManufacturable(name) : IND.notReactable(name))
      return
    }
    case 'UNKNOWN_LOCATION':
    case 'HIGHSEC_REACTION':
      await sendCard(inv, locationCard(inv, id === 'reaction' ? 'reaction' : 'manufacture', failure, req))
      return
    case 'NOT_CONFIGURED':
      await sendCard(inv, noLocationsCard(inv, id, failure, activity, req))
      return
    case 'BAD_ARGUMENT':
      await inv.reply.text((failure.reason && BAD_ARG[failure.reason]) ?? SAY.badQuantity)
      return
    case 'DATA_NOT_READY':
      await inv.reply.text(SAY.loading)
      return
    default:
      inv.commands.logger.warn(`「${inv.commands.registry.name(id)}」失败：${failure.code} ${failure.message ?? ''}`)
      await inv.reply.text(SAY.failed)
  }
}

function itemOf(res: Resolution | undefined): ItemInfo | undefined {
  return res && (res.kind === 'unique' || res.kind === 'out-of-scope') ? res.item : undefined
}

/** 认不出、不唯一：候选（同查价）；每一项是「精确名 + 原来的参数」 */
function itemCard(inv: Invocation, id: CommandId, failure: CoreFailure): Card {
  const query = failure.token ?? ''
  const rest = failure.rest ?? ''
  const command = (item: ItemInfo): CommandRef => ({ id, args: itemArgs(inv.core, inv.render, id, item, (name) => `${name}${rest}`) })
  const res = failure.resolution
  const suggestions = res?.kind === 'none' ? res.suggestions : []
  const options: ChoiceOptions = { query, command }
  const keyword = res?.kind === 'none' ? searchKeyword(inv.core, query, suggestions) : query
  if (keyword && !hasUrl(keyword) && inv.commands.registry.has('search')) {
    options.search = { id: 'search', args: keyword }
    options.searchName = inv.commands.registry.name('search')
  }
  if (res?.kind === 'ambiguous' || res?.kind === 'confirm' || res?.kind === 'group') return candidatesCard(inv.core, res, options)
  if (res?.kind === 'set') return candidatesCard(inv.core, { kind: 'ambiguous', tier: 'exact', candidates: res.set.items, total: res.set.items.length }, options)
  return notFoundCard(inv.core, suggestions, options)
}

/** 制造的是反应产物（或者反过来）：说明，再给一个改用另一个命令的按钮 */
function otherActivityCard(inv: Invocation, failure: CoreFailure, activity: IndustryActivity): Card {
  const item = itemOf(failure.resolution)
  const other: PlanId = activity === 'manufacturing' ? 'reaction' : 'manufacture'
  // ME/TE 只属于制造，换命令时去掉
  const rest = (failure.rest ?? '').replace(/\s(?:ME|TE)\d+/gi, '')
  const name = item ? inv.core.items.commandName(item) : failure.token ?? ''
  const ref: CommandRef = { id: other, args: `${name}${rest}` }
  const shown = escapeMarkdown(`${inv.commands.registry.name(other)} ${item ? itemName(item) : name}`)
  const title = item ? escapeMarkdown(itemName(item)) : safeEcho(name)
  const card = emptyCard(activity === 'manufacturing' ? IND.isReaction(title, shown) : IND.notReaction(title, shown))
  if (inv.commands.registry.has(other)) card.actions.push([{ label: `${inv.commands.registry.name(other)} ${item ? itemName(item) : name}`, command: ref, primary: true }])
  return card
}

/** 地点认不出、本群看不到、不能做这种活动、高安反应：列出本群能用的地点，按钮保留原来的参数 */
function locationCard(inv: Invocation, id: PlanId, failure: CoreFailure, req?: IndustryRequest): Card {
  const activity = ACTIVITY_OF[id]
  const token = failure.token ?? ''
  const product = req ? inv.core.items.byId(req.typeId) : undefined
  const direct = inv.access.isDirect
  const hidden = failure.code === 'UNKNOWN_LOCATION' && !failure.reason && inv.core.industry.locationHidden(token, inv.access)
  const title = failure.code === 'HIGHSEC_REACTION' ? IND.highsec(safeEcho(token))
    : failure.reason === 'capability' && product ? IND.cannotBuild(safeEcho(token), activity, escapeMarkdown(itemName(product)), escapeMarkdown(failure.need ?? ''))
      : failure.reason === 'activity' ? IND.wrongActivity(safeEcho(token), activity)
      : hidden ? IND.locationHidden(safeEcho(token))
        : IND.unknownLocation(safeEcho(token))
  const card = emptyCard(title)
  // 能造的地点一个都没有：说明缺什么，不是「还没有工业地点」
  const noneText = failure.reason === 'capability' && product
    ? IND.noCapable(activity, escapeMarkdown(itemName(product)), escapeMarkdown(failure.need ?? ''), direct) : IND.noLocationsHere(activity, direct)
  const locations = failure.locations ?? inv.core.industry.locations(inv.access, activity).map((l) => l.name)
  const usable = locations.filter((name) => name !== token)
  card.sections.push({
    style: 'plain',
    lines: [{ text: usable.length ? IND.locationsHere(activity, usable.map(escapeMarkdown).join(' · '), direct) : noneText }],
  })
  // 按钮：parser 给的 rest 是去掉那个词以后的参数；服务给的（地点存在但不能用）按请求重新拼
  const rest = failure.rest ?? (req ? restOf(inv, id, req) : '')
  if (rest) {
    const buttons: Action[] = usable.slice(0, MAX_ACTIONS_PER_ROW).map((name) => ({ label: buttonLabel(name), command: { id, args: `${rest} ${name}` } }))
    if (!buttons.length) buttons.push({ label: IND.basic, command: { id, args: rest } })
    card.actions.push(buttons)
  }
  return card
}

/** 去掉地点和只属于它的建筑名以后的参数（物品 + 数量 + ME/TE + 建筑:无 / 建筑:? + 改装件 + 税 + 高级 + 材料） */
function restOf(inv: Invocation, id: PlanId, req: IndustryRequest): string {
  const product = inv.core.items.byId(req.typeId)
  if (!product) return ''
  const parts: Parts = {
    ...amountOf(req), me: req.me, te: req.te, structure: portableStructure(req.structure), rigs: req.rigs, facilityTaxPct: req.facilityTaxPct,
    steps: req.mode === 'steps', materials: req.materials,
  }
  return commandOf(inv, id, product, parts).args ?? ''
}

function noLocationsCard(inv: Invocation, id: PlanId | 'manufactureCompare', failure: CoreFailure, activity: IndustryActivity, req?: IndustryRequest): Card {
  const locations = failure.locations ?? []
  const product = req ? inv.core.items.byId(req.typeId) : undefined
  // 本群有地点，但没有一个造得了这个产品：说明缺什么
  const capable = failure.reason === 'capability' && product
  const need = escapeMarkdown(failure.need ?? '')
  const direct = inv.access.isDirect
  const title = capable && id === 'manufactureCompare' && locations.length ? IND.compareTooFewNeed(need, direct)
    : capable ? IND.noCapable(activity, escapeMarkdown(itemName(product)), need, direct)
      : id === 'manufactureCompare' ? IND.compareTooFew(direct)
        : IND.noLocationsHere(activity, direct)
  const card = emptyCard(title)
  if (locations.length) card.sections.push({ style: 'plain', lines: [{ text: IND.locationsHere(activity, locations.map(escapeMarkdown).join(' · '), direct) }] })
  const planId: PlanId = activity === 'reaction' ? 'reaction' : 'manufacture'
  if (product && !capable && inv.commands.registry.has(planId)) {
    const base = commandOf(inv, planId, product, { ...amountOf(req!), me: req!.me, te: req!.te })
    card.actions.push([{ label: IND.basic, command: base, primary: true }])
  }
  return card
}

// ------------------------------------------------------------------ 制造比价

async function runCompare(inv: Invocation, text: string): Promise<void> {
  if (!text) {
    await sendCard(inv, usageCard(inv, 'manufactureCompare'))
    return
  }
  let req = inv.core.parse.industryArgs(text, 'manufacturing', inv.access)
  // 比价不看地点：多写的一个词按「未知地点」切出来了，就去掉它再试一次
  if (isFailure(req) && req.code === 'UNKNOWN_LOCATION' && req.rest) req = inv.core.parse.industryArgs(req.rest, 'manufacturing', inv.access)
  if (isFailure(req)) return planFailure(inv, 'manufactureCompare', req)
  const hint = startSlowHint(inv, 1, () => IND.slowCompare)
  const { typeId, activity, quantity, runs, me, te, rigs, facilityTaxPct, access } = req
  const out = await inv.core.industry.compare({ typeId, activity, quantity, runs, me, te, rigs, facilityTaxPct, materials: false, access })
    .finally(() => hint.stop())
  await hint.sent()
  if (isFailure(out)) return planFailure(inv, 'manufactureCompare', out, req)
  if (req.chain) out.chainIgnored = true
  await sendCompare(inv, req, out)
}

async function sendCompare(inv: Invocation, req: IndustryRequest, c: LocationComparison): Promise<void> {
  // 详情和比价的这一行一致：写了的改装件、税也带上
  // 比价不拆到原料，详情也不带层设置
  const parts: Parts = { ...amountOf(req), chain: undefined, me: c.me, te: c.te, rigs: req.rigs, facilityTaxPct: req.facilityTaxPct }
  // 自动挑的建筑也带上，详情和这一行是同一座
  const commands = c.rows.map((row) => commandOf(inv, 'manufacture', c.product, {
    ...parts, location: row.location, ...row.autoPicked && row.structure ? { structure: row.structure } : {},
  }))
  const actions: Action[][] = inv.commands.registry.has('manufacture')
    ? [c.rows.slice(0, MAX_ACTIONS_PER_ROW).map((row, i) => ({ label: detailLabel(row.location), command: commands[i] }))]
    : []
  await inv.reply.card(compareCard(env(inv), c, actions))
  if (actions.length) {
    const choices = commands.map((command, i) => ({ no: i + 1, label: c.rows[i].location, command }))
    inv.commands.pending.setChoices(pendingKey(inv.session), choicesOf({ choices }, inv.commands.registry.namer()))
  }
}

/** 「XX-1 详情」；放不下时只写地点名 */
function detailLabel(location: string): string {
  const full = IND.detail(location)
  return buttonLabel(full) === full ? full : buttonLabel(location)
}

// ------------------------------------------------------------------ 用法

function usageCard(inv: Invocation, id: PlanId | 'manufactureCompare'): Card {
  const name = escapeMarkdown(inv.commands.registry.name(id))
  const activity: IndustryActivity = id === 'reaction' ? 'reaction' : 'manufacturing'
  const example = activity === 'reaction' ? '富勒化合物' : '乌鸦级'
  const locations = inv.core.industry.locations(inv.access, activity).map((l) => l.name)
  const place = locations[0] ? escapeMarkdown(locations[0]) : 'XX-1'
  const card = emptyCard(IND.usageTitle(name))
  const lines = id === 'manufactureCompare'
    ? [
        { text: `${name} ${example}：每个能用的地点各算一次，按总成本排序` },
        { text: `${name} ${example}*10 ME8 TE16：指定数量和蓝图 ME/TE（${IND.compareDefaults}）` },
        { text: `${name} ${example} 改装:无 税:1%：每个地点都不用改装件、按这个税算` },
      ]
    : [
        { text: `${name} ${example}：基础参考（材料成本和时间，不计地点和税）` },
        { text: `${name} ${example} ${place}：在这个地点算（建筑、改装件、税按配置）` },
        ...activity === 'manufacturing' ? [{ text: `${name} ${example} ${place} ME10 TE20 建筑:名称 税:1%：参数都写上` }] : [],
        { text: `${name} ${example} 高级：一步一步选择` },
        { text: `${name} ${example} 材料：材料清单，另发一条可以粘进游戏「多重购买」的清单` },
        { text: `数量写成 ${example}*10，按流程数写成 10流程` },
      ]
  card.sections.push({ lines })
  card.sections.push({
    style: 'plain',
    lines: [{ text: locations.length ? IND.locationsHere(activity, locations.map(escapeMarkdown).join(' · '), inv.access.isDirect) : IND.noLocationsHere(activity, inv.access.isDirect) }],
  })
  const fill: Action = { label: IND.enterItem, command: { id }, fillOnly: true }
  card.actions.push([{ label: `${inv.commands.registry.name(id)} ${example}`, command: { id, args: example }, primary: true }, fill])
  return card
}
