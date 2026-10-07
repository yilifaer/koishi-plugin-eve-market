// 粘贴解析结果 → 估价清单（§6.5.2–§6.5.4）：给每一行选读法、识别物品、算装填弹药的数量。
// 清单只记 typeId 和数量，存进估价编号以后换了数据版本照样能重算；行号替换（7=#17636）也在这里。
// 「是不是：X」要线性扫描整张表，只给卡片上列得出来的前 MAX_WARNING_LINES 个未识别的物品找。

import { EFT_LOADED_CHARGES, MAX_WARNING_LINES } from '../../constants'
import { selectHypotheses } from '../parse'
import type { Judge } from '../parse'
import type { ItemInfo, ItemResolver, Lang, PasteHeader, PasteLine, PasteParse, TypeId } from '../types'

/** full 按满装、once 算 1 个、ignore 不算 */
export type LoadedChargeMode = 'full' | 'once' | 'ignore'

/** hull 船体；module 装上的模块；charge 模块里装填的弹药；cargo 无人机舱、货柜里的东西；不写 = 普通清单 */
export type EntryRole = 'hull' | 'module' | 'charge' | 'cargo'

/** 清单里的一种物品（一行可能有几种：「Raven*2、Tritanium*1000」，或者模块和它装填的弹药） */
export interface Entry {
  lineNo: number
  /** 原文；装填的弹药是弹药名那一段 */
  raw: string
  quantity: number
  /** null = 未识别 */
  typeId: TypeId | null
  /** 唯一前缀命中 */
  approx: boolean
  /** 名称跟着输入的语言走 */
  lang: Lang
  role?: EntryRole
  /** EFT：属于第几个装配 */
  fitting?: number
  /** 突变装备，按基础型号估价 */
  mutated?: boolean
  /** 装填的弹药：装在哪种模块里（模块没认出来时 null） */
  loadedIn?: TypeId | null
  /** 未识别时：最接近的一个、候选、一共匹配到几个（0 = 什么都没匹配到，只有容错的建议）；只有前几个未识别的物品有 */
  suggestion?: TypeId
  candidates?: TypeId[]
  total?: number
}

/** 估价编号保存的就是它 */
export interface ItemList {
  format: PasteParse['format']
  fittings: PasteParse['fittings']
  entries: Entry[]
  skipped: PasteParse['skipped']
  truncated: number
}

export type LineResolver = Pick<ItemResolver, 'resolveLine'>
export type ItemLookup = Pick<ItemResolver, 'byId'>

type LineResult = ReturnType<ItemResolver['resolveLine']>
type Unresolved = Extract<LineResult, { unresolved: true }>

/** 除法的浮点误差：1.35 ÷ 0.05 要正好是 27 */
const EPSILON = 1e-9
const HAN = /\p{Script=Han}/u

export function langOf(name: string): Lang {
  return HAN.test(name) ? 'zh' : 'en'
}

/** 每个模块装几发：满装 = ⌊模块容量 ÷ 弹药体积⌋，任一个值缺失时算 1 个 */
export function chargesPerModule(module: ItemInfo | undefined, charge: ItemInfo, mode: LoadedChargeMode): number {
  if (mode !== 'full') return 1
  const capacity = module?.capacity ?? null
  if (capacity === null || !(capacity > 0) || !(charge.volume > 0)) return 1
  return Math.max(1, Math.floor(capacity / charge.volume + EPSILON))
}

type HintFields = Pick<Entry, 'suggestion' | 'candidates' | 'total'>

/** 还能给几个未识别的物品找建议（超出的只记「没有找到」，卡片上本来也列不出来） */
class HintBudget {
  constructor(private left = MAX_WARNING_LINES) {}

  take(): boolean {
    if (this.left <= 0) return false
    this.left--
    return true
  }
}

function unresolvedFields(r: Unresolved, hints: HintBudget): HintFields {
  if (!hints.take()) return {}
  const out: HintFields = { total: r.total }
  if (r.suggestion) out.suggestion = r.suggestion.typeId
  if (r.candidates?.length) out.candidates = r.candidates.map((c) => c.typeId)
  return out
}

/** 没有能接受的读法：用最可能的那种读法给出「是不是：X」 */
function failedFields(name: string, items: LineResolver, hints: HintBudget): HintFields {
  const r = items.resolveLine(name)
  // 压平的分列行只接受 0–2 档，前缀命中在这里当作建议
  if (!('unresolved' in r)) return { suggestion: r.item.typeId, candidates: [r.item.typeId], total: 1 }
  return unresolvedFields(r, hints)
}

function lineContext(line: PasteLine): Pick<Entry, 'lineNo' | 'role' | 'fitting' | 'mutated'> {
  const out: Pick<Entry, 'lineNo' | 'role' | 'fitting' | 'mutated'> = { lineNo: line.lineNo }
  if (line.role) out.role = line.role
  if (line.fitting !== undefined) out.fitting = line.fitting
  if (line.mutated) out.mutated = true
  return out
}

interface ReadContext {
  items: LineResolver
  mode: LoadedChargeMode
  hints: HintBudget
}

function chargeEntry(line: PasteLine, name: string, module: ItemInfo | undefined, { items, mode, hints }: ReadContext): Entry {
  const base = { lineNo: line.lineNo, raw: name, role: 'charge' as const, lang: langOf(name), loadedIn: module?.typeId ?? null }
  const fitting = line.fitting === undefined ? {} : { fitting: line.fitting }
  const r = items.resolveLine(name)
  if ('unresolved' in r) return { ...base, ...fitting, quantity: 1, typeId: null, approx: false, ...unresolvedFields(r, hints) }
  return { ...base, ...fitting, quantity: chargesPerModule(module, r.item, mode), typeId: r.item.typeId, approx: r.approx }
}

/** 选好读法、识别物品；同时得出最终的表头（第一行开头的参数只在那一行真用了去掉参数的读法时才算） */
export function readList(parse: PasteParse, items: LineResolver, mode: LoadedChargeMode = EFT_LOADED_CHARGES): { header: PasteHeader; list: ItemList } {
  const judge: Judge<ItemInfo> = (name) => {
    const r = items.resolveLine(name)
    return 'unresolved' in r ? null : { approx: r.approx, value: r.item }
  }
  const selection = selectHypotheses(parse, judge)
  const read: ReadContext = { items, mode, hints: new HintBudget() }
  const entries: Entry[] = []
  for (const { line, choice, primary } of selection.lines) {
    const context = lineContext(line)
    if (choice) {
      const { name, quantity } = choice.hypothesis
      entries.push({ ...context, raw: line.raw, quantity, typeId: choice.value.typeId, approx: choice.approx, lang: langOf(name) })
    } else {
      const name = primary?.name ?? line.raw
      const guess = failedFields(name, items, read.hints)
      entries.push({ ...context, raw: line.raw, quantity: primary?.quantity ?? 1, typeId: null, approx: false, lang: langOf(name), ...guess })
    }
    if (line.loadedCharge && mode !== 'ignore') entries.push(chargeEntry(line, line.loadedCharge, choice?.value, read))
  }
  const list: ItemList = { format: parse.format, fittings: parse.fittings, entries, skipped: parse.skipped, truncated: parse.truncated }
  return { header: selection.header, list }
}

/** 识别出来的物品要能上市场（和逐行识别的范围一样） */
function marketItem(lookup: ItemLookup, typeId: TypeId | null | undefined): ItemInfo | undefined {
  const item = typeId === null || typeId === undefined ? undefined : lookup.byId(typeId)
  return item && item.marketGroupId !== null ? item : undefined
}

function settle(entry: Entry, item: ItemInfo): void {
  entry.typeId = item.typeId
  entry.approx = false
  delete entry.suggestion
  delete entry.candidates
  delete entry.total
}

/**
 * 行号 → typeId：替换这一行第一个未识别的物品，数量照原来的。换上的是模块时，同一行装填的弹药按新模块的容量重算；
 * 换上的是弹药时按它所在的模块算。认不出的 typeId 和没有未识别物品的行号不理会
 */
export function replaceLines(list: ItemList, replace: Readonly<Record<number, TypeId>>, lookup: ItemLookup, mode: LoadedChargeMode = EFT_LOADED_CHARGES): ItemList {
  const entries = list.entries.map((e) => ({ ...e }))
  for (const [key, typeId] of Object.entries(replace)) {
    const lineNo = Number(key)
    const item = marketItem(lookup, typeId)
    const target = entries.find((e) => e.lineNo === lineNo && e.typeId === null)
    if (!item || !target) continue
    settle(target, item)
    if (target.role === 'charge') target.quantity = chargesPerModule(marketItem(lookup, target.loadedIn), item, mode)
    if (target.role !== 'module') continue
    for (const charge of entries.filter((e) => e.lineNo === lineNo && e.role === 'charge')) {
      charge.loadedIn = item.typeId
      const loaded = marketItem(lookup, charge.typeId)
      if (loaded) charge.quantity = chargesPerModule(item, loaded, mode)
    }
  }
  return { ...list, entries }
}
