// 拆到原料的三张卡（0.0.5）：总览卡（默认只发这一张）、分层明细卡、原料清单卡。
// 金额跟 priceDisplayMode（清单里每一行跟 listPriceDisplayMode）；没有价格的写「缺价格」，总成本标不完整，绝不写 0。
// 按钮由调用方算好传进来（卡片只管排版）。

import { SERVER_LABEL } from '../../constants'
import { listPriceMode } from '../../core/format'
import type { ChainLeaf, ChainNode, ChainResult, FormattedPrice, IndustryResult, ItemInfo } from '../../core/types'
import type { Action, Card, Line } from '../view/card'
import { escapeMarkdown, scrubUrls } from '../view/escape'
import { emptyCard } from './context'
import { priceSource, productTitle } from './industry-card'
import type { IndustryEnv } from './industry-card'
import { ALCHEMY_NAME, CH, LAYER_NAME, MODE_NAME } from './industry-chain-text'
import { IND, SIDE_NONE, SIDE_SHORT } from './industry-text'
import { amountText, itemName } from './names'
import { SEC_CLASS, SIDE_LABEL } from './text'

/** 舰船大类：数量单位写「艘」 */
const CATEGORY_SHIP = 6
/** 「直接买」里最多列几个半成品的名字 */
const MIDDLE_NAMES = 3
/** 「炼金多出」最多列几种 */
const SURPLUS_LISTED = 5
/** 自己造比直接买贵过这个倍数，提示量太少 */
const TOO_SMALL_RATIO = 3
/** 层对应的「买」按钮、命令里的层词 */
const LAYER_WORD: Record<ChainNode['layer'], string> = { product: '', component: '组件', other: '其他', reaction2: '反应', reaction1: '反应' }

const esc = escapeMarkdown
const nameOf = (item: ItemInfo) => esc(itemName(item))
const unitOf = (item: ItemInfo) => (item.categoryId === CATEGORY_SHIP ? '艘' : '个')
const qty = (env: IndustryEnv, n: number) => env.core.format.quantity(n)
const isk = (env: IndustryEnv, v: number) => env.core.format.isk(v)
const amount = (env: IndustryEnv, v: number) => amountText(env.core.format, v, env.display.priceDisplayMode)
const money = (env: IndustryEnv, v: number | null) => (v === null ? CH.noPrice : amount(env, v))
const duration = (env: IndustryEnv, sec: number) => env.core.format.duration(sec)
const pctTrim = (p: number) => `${Math.round(p * 100) / 100 || 0}%`

const productNode = (r: ChainResult): ChainNode => r.nodes[0]
const nodesOf = (r: ChainResult, layer: ChainNode['layer']) => r.nodes.filter((n) => n.layer === layer)

function marketName(env: IndustryEnv, key: string): string {
  return esc(env.core.markets.get(key)?.name ?? key)
}

/** 页脚：欧服 · 价格更新于 … · 星系成本指数更新于 … */
function footer(env: IndustryEnv, r: ChainResult): string {
  const clock = (ms: number) => env.core.format.clock(ms)
  const parts: string[] = [SERVER_LABEL]
  if (r.pricesAt) parts.push(IND.footerPrices(clock(r.pricesAt)))
  if (r.indicesAt) parts.push(IND.footerIndices(clock(r.indicesAt)))
  return parts.join(' · ')
}

/** 引擎写的警告（已经是完整的句子） */
function engineWarnings(r: ChainResult): string[] {
  return r.warnings.map((w) => esc(scrubUrls(w)))
}

/** 去掉空白后的地点和建筑：「星点甲 甲莱塔卢」 */
const placeOf = (n: ChainNode) => [n.location, n.structure ?? ''].filter(Boolean).map(esc).join(' ')

/** 反应不在命令里写的地点做时，反应实际在哪里 */
function awayPlace(r: ChainResult): string | undefined {
  const away = [...new Set(r.nodes.filter((n) => n.fallbackLocation).map((n) => n.location))]
  return r.location && away.length ? away.map(esc).join('、') : undefined
}

// ------------------------------------------------------------------ 总览卡

/** 反应 造 · 组件 造 · 其他 买 · 炼金 自动 */
function modesLine(r: ChainResult): string {
  const { layers, alchemy } = r.options
  const low = MODE_NAME[layers.reaction1]
  const high = MODE_NAME[layers.reaction2]
  const reaction = low === high ? CH.modeReaction(low) : CH.modeReactionSplit(low, high)
  return CH.modes(reaction, MODE_NAME[layers.component], MODE_NAME[layers.other], ALCHEMY_NAME[alchemy])
}

/** 地点 · 蓝图 ME/TE · 流程（产出）；第二行是各层的造买设置 */
function headLines(env: IndustryEnv, r: ChainResult, meTeDefaulted: boolean): Line[] {
  const top = productNode(r)
  const parts: string[] = [r.location ? esc(r.location) : CH.noPlace]
  if (r.secClass) parts.push(SEC_CLASS[r.secClass])
  if (top.activity === 'manufacturing') {
    const mark = !meTeDefaulted || !r.location ? '' : r.product.techLevel === 2 ? IND.defaulted.meTeT2 : IND.defaulted.meTe
    parts.push(`${IND.blueprint(top.me, top.te)}${mark}`)
  }
  parts.push(IND.runs(qty(env, r.runs), qty(env, r.outputQuantity), unitOf(r.product)))
  return [{ text: parts.join(' · ') }, { text: modesLine(r) }]
}

/** 成品这一步：建筑 · 安装费和税 */
function productLine(env: IndustryEnv, r: ChainResult): Line {
  const top = productNode(r)
  const where = top.structure ? (top.autoPicked ? IND.autoPicked(esc(top.structure)) : esc(top.structure)) : IND.noStructure
  const fees = top.jobCost ? `${CH.jobFees} ${env.core.format.isk(top.jobCost.total, { integer: true }).full ?? '—'}` : CH.noJobFees
  return { text: CH.productLine(`${where} · ${fees}`) }
}

/** 某一层没用到时，是因为它上面的哪一层直接买了 */
function unusedReason(r: ChainResult, layer: ChainNode['layer']): string {
  const above: Partial<Record<ChainNode['layer'], Array<keyof ChainResult['options']['layers']>>> = {
    reaction1: ['reaction2', 'component'], reaction2: ['component'],
  }
  return (above[layer] ?? []).filter((l) => r.options.layers[l] === 'buy').map((l) => LAYER_NAME[l]).join('、')
}

/** 每层一行：几种、自己造多少钱、直接买约多少钱；没用到的写原因 */
function layerLines(env: IndustryEnv, r: ChainResult): Line[] {
  const lines: Line[] = []
  for (const row of r.layers) {
    if (row.layer === 'product' || row.mode === 'buy') continue
    const name = LAYER_NAME[row.layer]
    if (row.used) {
      const buy = row.buy === null ? undefined : money(env, row.buy)
      lines.push({ text: CH.layerLine(name, nodesOf(r, row.layer).length, money(env, row.build), buy, row.where ? esc(row.where) : '') })
      // 两个数都知道才比；整批生产的量远超需要时，自己造反而贵得多
      if (row.build !== null && row.buy !== null && row.buy > 0 && row.build > row.buy * TOO_SMALL_RATIO) lines.push({ text: CH.layerTooSmall(LAYER_WORD[row.layer]) })
      continue
    }
    const reasons = unusedReason(r, row.layer)
    if (reasons) lines.push({ text: CH.layerUnused(name, reasons) })
  }
  if (lines.length && lines.some((l) => 'text' in l && l.text.includes('自己造'))) lines.push({ text: CH.layerNoSum })
  return lines
}

/** 炼金 N 种：比正常省 X，多 Y（一种也没选炼金、但有候选时写都是正常更划算） */
function alchemyLines(env: IndustryEnv, r: ChainResult): Line[] {
  const candidates = r.nodes.filter((n) => n.alchemy)
  if (!candidates.length) return []
  const used = candidates.filter((n) => n.route === 'alchemy')
  if (!used.length) return [{ text: CH.alchemyNone, indent: 1 }]
  const known = used.every((n) => n.buildCost !== null && n.alchemy!.other.cost !== null)
  if (!known) return [{ text: CH.alchemyLine(used.length, CH.alchemyNoCompare), indent: 1 }, ...reprocessLines(used)]
  const saved = used.reduce((sum, n) => sum + (n.alchemy!.other.cost! - n.buildCost!), 0)
  const time = used.reduce((sum, n) => sum + (n.timeSeconds - n.alchemy!.other.timeSeconds), 0)
  const parts = [saved >= 0 ? CH.alchemyCheaper(money(env, saved)) : CH.alchemyDearer(money(env, -saved))]
  if (time) parts.push(time > 0 ? CH.alchemyMoreTime(duration(env, time)) : CH.alchemyLessTime(duration(env, -time)))
  return [{ text: CH.alchemyLine(used.length, parts.join('，')), indent: 1 }, ...reprocessLines(used)]
}

/** 提炼在哪里做、税多少（没找到提炼建筑时引擎已有警告，这里不写） */
function reprocessLines(used: ChainNode[]): Line[] {
  const spots = [...new Set(used.flatMap((n) => {
    const a = n.alchemy!
    return a.reprocessAt && a.reprocessLocation !== undefined && a.reprocessPct !== undefined
      ? [CH.alchemyAt(esc(a.reprocessAt), esc(a.reprocessLocation), pctTrim(a.reprocessPct))]
      : []
  }))]
  return spots.map((text) => ({ text, indent: 1 }))
}

/** 直接买：原料 N 种 · 半成品 N 种（名字）· 没地方造 N 种 */
function buyLine(r: ChainResult): Line | undefined {
  const of = (kind: ChainLeaf['kind']) => r.leaves.filter((l) => l.kind === kind)
  const raw = of('raw')
  const middle = of('bought')
  const cannot = of('unbuildable')
  const parts = [
    raw.length ? CH.buyRaw(raw.length) : '',
    middle.length ? CH.buyMiddle(middle.length, listNames(middle)) : '',
    cannot.length ? CH.buyCannot(cannot.length) : '',
  ].filter(Boolean)
  return parts.length ? { text: CH.buyLine(parts) } : undefined
}

function listNames(leaves: ChainLeaf[]): string {
  const names = leaves.slice(0, MIDDLE_NAMES).map((l) => nameOf(l.item)).join('、')
  return leaves.length > MIDDLE_NAMES ? `${names}等` : names
}

/** 预计总成本：缺价格时标不完整；叶子一个价格都没有时写「—」 */
function totalLine(env: IndustryEnv, r: ChainResult): Line {
  const { missingPrices, total } = r.totals
  const price: FormattedPrice = r.leaves.length && missingPrices >= r.leaves.length ? { na: true } : isk(env, total)
  return missingPrices ? { label: IND.totalCost, price, extra: IND.incomplete(missingPrices) } : { label: IND.totalCost, price }
}

/** 成品 Jita 4-4 出售 …；没有价格时「暂无卖单」 */
function valueLines(env: IndustryEnv, r: ChainResult): Line[] {
  const v = r.productValue
  if (!v) return []
  const market = marketName(env, v.marketKey)
  if (v.total === null) return [{ text: IND.productNone(market, SIDE_NONE[v.side]) }]
  const label = IND.product(market, SIDE_SHORT[v.side])
  const lines: Line[] = [v.fallback ? { label, price: isk(env, v.total), extra: IND.fallbackMark } : { label, price: isk(env, v.total) }]
  if (r.totals.missingPrices) {
    lines.push({ text: CH.profitIncomplete })
  } else if (r.profit) {
    const fees = env.industry.sellFeesPct > 0 ? IND.profitFees(pctTrim(env.industry.sellFeesPct)) : IND.profitNoFees
    const margin = `${Math.round(r.profit.marginPct * 10) / 10 || 0}%`
    lines.push({ text: `${IND.profit(amount(env, r.profit.value), margin)}${fees}` })
  }
  return lines
}

/** 时间：每层一条生产线串行，各层相加 */
function timeLines(env: IndustryEnv, r: ChainResult): Line[] {
  const rows = r.layers.filter((l) => l.used && l.timeSeconds > 0)
  if (!rows.length) return []
  const parts = rows.map((l) => `${LAYER_NAME[l.layer]} ${duration(env, l.timeSeconds)}`)
  if (rows.length > 1) parts.push(CH.timeTotal(duration(env, rows.reduce((sum, l) => sum + l.timeSeconds, 0))))
  return [{ text: CH.timeLine(parts) }, { text: CH.timeNote }]
}

/** ⚠ T2 发明成本不计入 · 炼金按废料 55% 规则计算 */
function noteWarning(r: ChainResult): string[] {
  const notes: string[] = []
  if (r.inventionExcluded) notes.push(CH.inventionNote)
  const yieldPct = r.nodes.find((n) => n.alchemy)?.alchemy?.yieldPct
  if (yieldPct !== undefined) notes.push(CH.scrapNote(String(Math.round(yieldPct * 100) / 100)))
  return notes.length ? [notes.join(' · ')] : []
}

/** 总览卡：成品、每层造还是买、炼金、直接买、总成本、利润、时间 */
export function overviewCard(env: IndustryEnv, r: ChainResult, actions: Action[][], meTeDefaulted: boolean): Card {
  const card = emptyCard(productTitle(r.product, CH.overviewTitle))
  card.sections.push({ style: 'plain', lines: headLines(env, r, meTeDefaulted) })
  const away = awayPlace(r)
  const buy = buyLine(r)
  card.sections.push({
    style: 'plain',
    lines: [
      productLine(env, r),
      ...layerLines(env, r),
      ...alchemyLines(env, r),
      ...away ? [{ text: CH.reactionAway(away, esc(r.location!)) }] : [],
      ...buy ? [buy] : [],
      totalLine(env, r),
    ],
  })
  const tail = [...valueLines(env, r), ...timeLines(env, r)]
  if (tail.length) card.sections.push({ style: 'plain', lines: tail })
  card.warnings = [...noteWarning(r), ...engineWarnings(r)]
  card.footer = footer(env, r)
  card.actions = actions
  return card
}

// ------------------------------------------------------------------ 分层明细

const LAYER_SHOWN: ChainNode['layer'][] = ['component', 'other', 'reaction2', 'reaction1']

/** 和另一条路线比：炼金的写比正常省多少、多花多少时间；正常的写炼金贵多少 */
function compareParts(env: IndustryEnv, n: ChainNode): { inline: string; nested: string } {
  const other = n.alchemy!.other
  if (n.buildCost === null || other.cost === null) return { inline: '', nested: n.route === 'alchemy' ? CH.alchemyNoCompare : '' }
  if (n.route === 'normal') {
    const diff = other.cost - n.buildCost
    return { inline: diff >= 0 ? CH.detailAlchemyDearer(money(env, diff)) : CH.detailAlchemyCheaper(money(env, -diff)), nested: '' }
  }
  const saved = other.cost - n.buildCost
  const time = n.timeSeconds - other.timeSeconds
  const parts = [saved >= 0 ? CH.alchemyCheaper(money(env, saved)) : CH.alchemyDearer(money(env, -saved))]
  if (time) parts.push(time > 0 ? CH.alchemyMoreTime(duration(env, time)) : CH.alchemyLessTime(duration(env, -time)))
  return { inline: '', nested: parts.join('，') }
}

function nodeLines(env: IndustryEnv, n: ChainNode): Line[] {
  const runs = qty(env, n.runs)
  const compare = n.alchemy ? compareParts(env, n) : { inline: '', nested: '' }
  const how = n.route === 'alchemy' ? CH.detailAlchemy(runs) : n.alchemy ? CH.detailNormal(runs) : CH.detailBatches(n.activity, runs)
  const text = CH.detailLine(nameOf(n.item), qty(env, n.demand), how, n.surplus > 0 ? qty(env, n.surplus) : '', money(env, n.buildCost))
  const lines: Line[] = [{ text: `${text}${compare.inline}` }]
  if (compare.nested) lines.push({ text: compare.nested, indent: 1 })
  return lines
}

/** 这一层的小标题：层名 · 地点 建筑 · ME/TE；反应换了地点时写明 */
function layerHeading(r: ChainResult, layer: ChainNode['layer'], list: ChainNode[]): string {
  const where = [...new Set(list.map(placeOf))].join('、') || IND.noStructure
  const away = list.some((n) => n.fallbackLocation) && r.location ? `${CH.detailAway(where, esc(r.location))}` : where
  const meTe = list[0].activity === 'manufacturing' ? CH.detailMeTe(list[0].me, list[0].te) : ''
  return CH.detailHead(LAYER_NAME[layer], [away, meTe].filter(Boolean).join(' · '))
}

/** 分层明细卡：每个节点一行，按层分组，炼金的比较缩进一行 */
export function detailsCard(env: IndustryEnv, r: ChainResult, actions: Action[][]): Card {
  const card = emptyCard(productTitle(r.product, CH.detailTitle))
  const top = productNode(r)
  card.meta = [[r.location ? esc(r.location) : CH.noPlace, IND.runs(qty(env, r.runs), qty(env, r.outputQuantity), unitOf(r.product)), top.structure ? esc(top.structure) : ''].filter(Boolean).join(' · ')]
  for (const layer of LAYER_SHOWN) {
    const list = nodesOf(r, layer)
    if (list.length) card.sections.push({ heading: layerHeading(r, layer, list), style: 'ordered', lines: list.flatMap((n) => nodeLines(env, n)) })
  }
  if (r.nodes.some((n) => n.surplus > 0)) card.sections.push({ style: 'plain', lines: [{ text: CH.detailNote }] })
  card.warnings = [...noteWarning(r), ...engineWarnings(r)]
  card.footer = footer(env, r)
  card.actions = actions
  return card
}

// ------------------------------------------------------------------ 原料清单

/** 要买的原料：炼金副产品抵掉的不用买（IndustryResult.materials 的形状，多买清单也用它） */
export function buyList(r: ChainResult): IndustryResult['materials'] {
  return r.leaves
    .map((l) => ({ leaf: l, buy: l.quantity - l.offset }))
    .filter(({ buy }) => buy > 0)
    .map(({ leaf, buy }) => ({
      item: leaf.item, baseQuantity: buy, quantity: buy, unit: leaf.unit, total: leaf.total, manufacturable: false, ...leaf.fallback ? { fallback: true } : {},
    }))
}

function materialLines(env: IndustryEnv, r: ChainResult): Line[] {
  const listIsk = (v: number) => env.core.format.isk(v, { mode: listPriceMode(env.display) })
  const lines: Line[] = []
  for (const leaf of r.leaves) {
    const buy = leaf.quantity - leaf.offset
    if (buy > 0) {
      const label = `${nameOf(leaf.item)} ×${qty(env, buy)} ·`
      if (leaf.total === null) lines.push({ text: `${label} ${IND.missingPrice}` })
      else lines.push(leaf.fallback ? { label, price: listIsk(leaf.total), extra: IND.fallbackMark } : { label, price: listIsk(leaf.total) })
    }
    if (leaf.offset > 0) {
      const text = buy > 0 ? CH.offsetLine(nameOf(leaf.item), qty(env, leaf.offset)) : CH.offsetAll(nameOf(leaf.item), qty(env, leaf.offset))
      lines.push({ text, indent: buy > 0 ? 1 : 0 })
    }
  }
  return lines
}

/** 原料清单卡：要买的原料（和「材料」同样的排版）、炼金副产品抵扣、多出的副产品；多买清单由调用方放进 copies */
export function materialsChainCard(env: IndustryEnv, r: ChainResult, copies: string[], actions: Action[][]): Card {
  const card = emptyCard(CH.materialsTitle(nameOf(r.product)))
  const top = productNode(r)
  const meta = [r.location ? esc(r.location) : '', top.structure ? esc(top.structure) : '', `${qty(env, r.runs)} 流程`].filter(Boolean)
  if (r.materialPrices) meta.push(priceSource(env, r.materialPrices.marketKey, r.materialPrices.side))
  card.meta = [meta.join(' · ')]
  card.sections.push({ style: 'ordered', lines: materialLines(env, r) })
  const missing = r.leaves.filter((l) => l.total === null).length
  const volume = buyList(r).reduce((sum, m) => sum + m.quantity * m.item.packagedVolume, 0)
  const price: FormattedPrice = r.leaves.length && missing >= r.leaves.length ? { na: true } : isk(env, r.totals.leaves)
  const extra = `${missing ? IND.incomplete(missing) : ''}· ${env.core.format.volume(volume)}`
  const lines: Line[] = [{ label: IND.materialsTotal, price, extra }]
  if (r.leaves.some((l) => l.fallback)) lines.push({ text: CH.fallbackNote(SIDE_LABEL[r.materialPrices?.side ?? 'sell']) })
  if (r.surplusByproducts.length) {
    const shown = r.surplusByproducts.slice(0, SURPLUS_LISTED).map((s) => `${nameOf(s.item)} ${qty(env, s.quantity)}`)
    const more = r.surplusByproducts.length > SURPLUS_LISTED ? '等' : ''
    lines.push({ text: CH.surplusLine(`${shown.join(' · ')}${more}`) })
  }
  if (copies.length) lines.push({ text: IND.pasteNext })
  card.sections.push({ style: 'plain', lines })
  card.warnings = engineWarnings(r)
  card.footer = footer(env, r)
  card.actions = actions
  card.copyBlocks = copies
  return card
}
