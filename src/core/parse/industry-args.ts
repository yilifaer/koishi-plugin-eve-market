// 制造、反应的参数（§2.6.1、§2.8）：命令后面的文字 → IndustryRequest。
// 1. 先从任意位置取出参数词：ME10 / me=10 / ME 10、TE20、10/20、建筑:、改装:（rig:）、税:、N流程、高级、材料、不用改装；
// 2. 剩下的是物品（可以带 *N）和地点。整句精确是物品时整句当物品；否则末尾、再看开头最长的本群可见的地点名；
// 3. 都不是地点时按结构判断「未知地点」：末尾（或开头）的一个词 X，去掉 X 以后能识别成物品（0–3 档），整句不能；
// 4. 物品按 readLine 的几种读法识别（同查价：先整句，再明确的乘号，再其他），范围是 industry（蓝图名换成产品）或 reaction。
// 按钮里的命令统一用 industryArgsText 生成：物品*数量 地点 ME TE 建筑: 改装: 税: 高级 材料。

import { MAX_ME, MAX_RUNS, MAX_TE } from '../../constants'
import { DataNotReadyError } from '../data'
import type { AlchemyMode, Access, ChainLayer, ChainOptions, CoreFailure, FailureReason, IndustryActivity, IndustryRequest, ItemResolver, LayerMode, Resolution, Scope } from '../types'
import { chooseHypothesis } from './choose'
import type { Judged } from './choose'
import { looksLikeQuantity, parseQuantity, readLine } from './quantity'
import type { Hypothesis } from './quantity'
import { strengthOf } from './query'
import { normalizeLine } from './text'

/** 工业地点（core/industry 的 IndustryLocations 的一部分；parse 不 import industry，免得绕成环） */
export interface IndustryArgsLocations {
  /** 本群能看到的地点，按名称、别名、星系名；找不到返回 null */
  match(token: string, access: Access): { name: string } | null
  /** 本群能用的名称和别名最多几个词 */
  maxWords(access: Access): number
  /** 本群能用的地点（给了 activity 时只留能做这种活动的） */
  visible(access: Access, activity?: IndustryActivity): Array<{ name: string }>
}

export interface IndustryArgsDeps {
  items: Pick<ItemResolver, 'resolve'>
  locations: IndustryArgsLocations
}

export type IndustryArgsParser = (text: string, activity: IndustryActivity, access: Access) => IndustryRequest | CoreFailure

// ------------------------------------------------------------------ 生成命令

/** 按钮里一条制造、反应命令的参数（不含命令名） */
export interface IndustryArgsParts {
  /** 物品名或 #typeID */
  item: string
  quantity?: number
  runs?: number
  location?: string
  me?: number
  te?: number
  /** ME 或 TE 后面没写数字：原样带着，下一步还要提示 */
  meteMissing?: 'me' | 'te'
  /** 建筑名称、'none'（无建筑加成）或 '?'（列出全部建筑） */
  structure?: string
  rigs?: 'default' | 'none'
  facilityTaxPct?: number
  /** 「高级」：逐步选择 */
  steps?: boolean
  /** 「材料」：材料清单 */
  materials?: boolean
  /** 拆到原料：只带命令里写了的层（layers 实际只有写了的那几层）；details = 「明细」 */
  chain?: Partial<ChainOptions> & { on: true, details?: boolean }
}

const CHAIN_LAYERS: ChainLayer[] = ['reaction1', 'reaction2', 'component', 'other']
const LAYER_NAME: Record<ChainLayer, string> = { reaction1: '低级反应', reaction2: '高级反应', component: '组件', other: '其他' }
const MODE_WORD: Record<LayerMode, string> = { build: '造', buy: '买' }
const ALCHEMY_WORD: Record<AlchemyMode, string> = { alchemy: '炼金', normal: '正常', auto: '自动' }

/**
 * 拆到原料的参数词：只写和控制台默认不一样的层（没给 defaults 时写命令里有的全部）。
 * 炼金模式写在「低级反应:」后面（它同时表示低级反应自己造）；一个层的词都不用写时单写「拆到原料」
 */
function chainWords(chain: NonNullable<IndustryArgsParts['chain']>, defaults?: ChainOptions): string[] {
  const layers: Partial<Record<ChainLayer, LayerMode>> = chain.layers ?? {}
  const alchemy = chain.alchemy !== undefined && chain.alchemy !== defaults?.alchemy && layers.reaction1 !== 'buy' ? chain.alchemy : undefined
  const mode = (layer: ChainLayer) => {
    const m = layers[layer]
    return m !== undefined && m !== defaults?.layers[layer] ? m : undefined
  }
  const words: string[] = []
  const low = mode('reaction1')
  const high = mode('reaction2')
  if (alchemy) words.push(`低级反应:${ALCHEMY_WORD[alchemy]}`)
  if (!alchemy && low && low === high) words.push(`反应:${MODE_WORD[low]}`)
  else {
    if (!alchemy && low) words.push(`低级反应:${MODE_WORD[low]}`)
    if (high) words.push(`高级反应:${MODE_WORD[high]}`)
  }
  for (const layer of ['component', 'other'] as const) {
    const m = mode(layer)
    if (m) words.push(`${LAYER_NAME[layer]}:${MODE_WORD[m]}`)
  }
  if (!words.length) words.push('拆到原料')
  if (chain.details) words.push('明细')
  return words
}

/** 1.5 → 1.5，1 → 1（不带多余的 0） */
function trimNumber(n: number): string {
  return String(Math.round(n * 1e6) / 1e6)
}

/** 命令里的建筑名：去掉空白（findStructure 也按去掉空白的写法认） */
function structureWord(structure: string): string {
  if (structure === 'none') return '建筑:无'
  if (structure === '?') return '建筑:?'
  return `建筑:${structure.replace(/\s+/g, '')}`
}

/**
 * 物品名后面的部分：以「*」（数量紧贴物品名）或空格开头，什么都没有时是 ''。
 * 「物品名 + 这一段」就是完整的参数（候选按钮把物品名换成精确名时用）
 */
export function industryArgsTail(p: Omit<IndustryArgsParts, 'item'>, chainDefaults?: ChainOptions): string {
  const words: string[] = []
  if (p.runs !== undefined) words.push(`${p.runs}流程`)
  if (p.location) words.push(p.location)
  if (p.me !== undefined) words.push(`ME${p.me}`)
  if (p.te !== undefined) words.push(`TE${p.te}`)
  if (p.meteMissing) words.push(p.meteMissing.toUpperCase())
  if (p.structure !== undefined) words.push(structureWord(p.structure))
  if (p.rigs) words.push(p.rigs === 'none' ? '改装:无' : '改装:默认')
  if (p.facilityTaxPct !== undefined) words.push(`税:${trimNumber(p.facilityTaxPct)}%`)
  if (p.chain) words.push(...chainWords(p.chain, chainDefaults))
  if (p.steps) words.push('高级')
  if (p.materials) words.push('材料')
  const quantity = p.runs === undefined && p.quantity !== undefined ? `*${p.quantity}` : ''
  return `${quantity}${words.map((w) => ` ${w}`).join('')}`
}

/** 制造 乌鸦级 XX-1 ME10 TE20 建筑:索迪约 改装:默认 税:1% 高级 材料 的参数部分 */
export function industryArgsText(p: IndustryArgsParts, chainDefaults?: ChainOptions): string {
  return `${p.item}${industryArgsTail(p, chainDefaults)}`
}

/** 换地点时还能带着的「建筑:」：建筑名只属于原来的地点，「建筑:无」「建筑:?」哪里都能用 */
export function portableStructure(structure: string | undefined): string | undefined {
  return structure === 'none' || structure === '?' ? structure : undefined
}

// ------------------------------------------------------------------ 参数词

interface Args {
  me?: number
  te?: number
  structure?: string
  rigs?: 'default' | 'none'
  tax?: number
  runs?: number
  /** ME 或 TE 后面没有数字（只记第一个） */
  meteMissing?: 'me' | 'te'
  /** 单独写的「*10」（例如写在地点后面） */
  quantity?: number
  steps: boolean
  materials: boolean
  /** 拆到原料：写了「拆到原料」或任何一个层的参数词 */
  chain?: NonNullable<IndustryArgsParts['chain']>
  /** 写错的参数（只记第一个） */
  bad?: { reason: FailureReason; message: string }
  /** 不是参数的词，按原来的顺序 */
  words: string[]
}

const LEVEL = /^(me|te)[=:]?(\d+)?$/i
const LEVEL_PAIR = /^(\d{1,3})\/(\d{1,3})$/
const KEY_VALUE = /^(建筑|structure|改装件?|rigs?|税率?|tax)[=:](.*)$/i
const RUNS = /^(\d+)(?:流程|runs?)$/i
const RUNS_WORD = /^(?:流程|runs?)$/i
const DIGITS = /^\d+$/
const STAR_QUANTITY = /^[*×](.+)$/
const TAX = /^(\d+(?:\.\d+)?)%?$/
const LAYER = /^(低级反应|高级反应|反应|组件|其他)[=:：](造|买|炼金|正常|自动)$/
const RIGS_ON = /^(?:默认|default|有|用|on|yes)$/i
const RIGS_OFF = /^(?:无|none|不用|没有|off|no|0)$/i
const STRUCTURE_NONE = /^(?:无|none|-)$/i
const WORD_RIGS_OFF = /^(?:不用|无)改装件?$/
const WORD_RIGS_ON = /^用改装件?$/

/** 这个词自己就是一个参数（「建筑:」后面空着时，下一个词是不是它的值） */
function isArgWord(word: string): boolean {
  return LEVEL.test(word) || LEVEL_PAIR.test(word) || KEY_VALUE.test(word) || RUNS.test(word)
    || word === '高级' || word === '材料' || word === '拆到原料' || word === '明细' || LAYER.test(word) || WORD_RIGS_OFF.test(word) || WORD_RIGS_ON.test(word)
}

function setBad(args: Args, reason: FailureReason, message: string) {
  args.bad ??= { reason, message }
}

function setLevel(args: Args, kind: 'me' | 'te', value: string) {
  const n = Number(value)
  const max = kind === 'me' ? MAX_ME : MAX_TE
  if (n > max) return setBad(args, kind === 'me' ? 'me-range' : 'te-range', `${kind.toUpperCase()} 只能是 0–${max}`)
  args[kind] = n
}

function setKeyValue(args: Args, key: string, value: string) {
  const k = key.toLowerCase()
  if (k === '建筑' || k === 'structure') {
    args.structure = !value || value === '?' ? '?' : STRUCTURE_NONE.test(value) ? 'none' : value
  } else if (k.startsWith('改装') || k.startsWith('rig')) {
    if (RIGS_ON.test(value)) args.rigs = 'default'
    else if (RIGS_OFF.test(value)) args.rigs = 'none'
    else setBad(args, 'rig-option', '改装件只能写「改装:默认」或「改装:无」')
  } else {
    const m = TAX.exec(value)
    const n = m ? Number(m[1]) : NaN
    if (!(n >= 0 && n <= 100)) return setBad(args, 'tax-range', '税率要写成「税:1.5%」（0–100）')
    args.tax = n
  }
}

function setRuns(args: Args, value: string) {
  const n = Number(value)
  if (!(n >= 1 && n <= MAX_RUNS)) return setBad(args, 'runs-range', `流程数只能是 1–${MAX_RUNS}`)
  args.runs = n
}

const LAYER_KEY: Record<string, ChainLayer[]> = {
  低级反应: ['reaction1'], 高级反应: ['reaction2'], 反应: ['reaction1', 'reaction2'], 组件: ['component'], 其他: ['other'],
}
const MODE_KEY: Record<string, LayerMode> = { 造: 'build', 买: 'buy' }
const ALCHEMY_KEY: Record<string, AlchemyMode> = { 炼金: 'alchemy', 正常: 'normal', 自动: 'auto' }

/** 「反应:造」这样的层参数：写了就算拆到原料；炼金、正常、自动只认在「反应:」「低级反应:」后面 */
function setLayer(args: Args, name: string, value: string) {
  const chain = (args.chain ??= { on: true })
  const layers = (chain.layers ??= {} as ChainOptions['layers'])
  const alchemy = ALCHEMY_KEY[value]
  if (!alchemy) {
    for (const layer of LAYER_KEY[name]) layers[layer] = MODE_KEY[value]
  } else if (name === '反应' || name === '低级反应') {
    layers.reaction1 = 'build'
    chain.alchemy = alchemy
  } else {
    setBad(args, 'chain-option', `「${name}:${value}」不对：炼金、正常、自动只能写在「反应:」或「低级反应:」后面`)
  }
}

/** 从任意位置取出参数词，剩下的词按原来的顺序留在 words 里 */
function readArgs(tokens: readonly string[]): Args {
  const args: Args = { steps: false, materials: false, words: [] }
  // 「明细」只在拆到原料时有用
  let detail = false
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]
    const next = tokens[i + 1]
    let m: RegExpExecArray | null
    if ((m = LEVEL.exec(word))) {
      const kind = m[1].toLowerCase() as 'me' | 'te'
      if (m[2] !== undefined) setLevel(args, kind, m[2])
      else if (next !== undefined && DIGITS.test(next)) setLevel(args, kind, tokens[++i])
      else args.meteMissing ??= kind
    } else if ((m = LEVEL_PAIR.exec(word))) {
      setLevel(args, 'me', m[1])
      setLevel(args, 'te', m[2])
    } else if ((m = KEY_VALUE.exec(word))) {
      let value = m[2].trim()
      // 「建筑: 索迪约」：冒号后面空了一格
      if (!value && next !== undefined && !isArgWord(next)) value = tokens[++i]
      setKeyValue(args, m[1], value)
    } else if ((m = RUNS.exec(word))) {
      setRuns(args, m[1])
    } else if (i > 0 && (m = STAR_QUANTITY.exec(word)) && looksLikeQuantity(m[1])) {
      // 单独的「*10」：写在地点或别的参数后面也认（紧贴物品名的「乌鸦级*10」由 readLine 读）
      const quantity = parseQuantity(m[1])
      if (quantity === undefined) setBad(args, 'quantity', '数量要是正整数')
      else args.quantity = quantity
    } else if (DIGITS.test(word) && next !== undefined && RUNS_WORD.test(next)) {
      setRuns(args, word)
      i++
    } else if (word === '高级') {
      args.steps = true
    } else if (word === '材料') {
      args.materials = true
    } else if (word === '拆到原料') {
      args.chain ??= { on: true }
    } else if (word === '明细') {
      detail = true
    } else if ((m = LAYER.exec(word))) {
      setLayer(args, m[1], m[2])
    } else if (WORD_RIGS_OFF.test(word)) {
      args.rigs = 'none'
    } else if (WORD_RIGS_ON.test(word)) {
      args.rigs = 'default'
    } else {
      args.words.push(word)
    }
  }
  if (args.chain && detail) args.chain.details = true
  return args
}

// ------------------------------------------------------------------ 物品和地点

type Strength = ReturnType<typeof strengthOf>
const RANK: Record<Strength, number> = { none: 0, prefix: 1, exact: 2 }

interface Picked {
  /** 物品名（去掉了数量） */
  name: string
  quantity: number | null
  resolution: Resolution
}

const isWhole = (h: Hypothesis) => h.kind === 'whole'

/** 认不出时哪种读法的结果更有用（同查价）：要确认的候选 > 有建议的「没有找到」 > 什么都没有 */
function usefulness(res: Resolution): number {
  if (res.kind === 'confirm') return 2
  return res.kind === 'none' && res.suggestions.length ? 1 : 0
}

function fallbackOrder(h: Hypothesis): number {
  if (h.kind === 'explicit') return 0
  return h.kind === 'whole' ? 1 : 2
}

class Reader {
  private readonly cache = new Map<string, Resolution>()

  constructor(private readonly items: Pick<ItemResolver, 'resolve'>, private readonly scope: Scope) {}

  resolve(name: string): Resolution {
    let res = this.cache.get(name)
    if (!res) {
      res = this.items.resolve(name, { scope: this.scope })
      this.cache.set(name, res)
    }
    return res
  }

  /** 在另一个范围里识别（不缓存） */
  resolveIn(name: string, scope: Scope): Resolution {
    return this.items.resolve(name, { scope })
  }

  /** 一段文字（可能带着数量）最好能识别到哪一档；只是一个数量的读法不算 */
  recognize(text: string): Strength {
    let best: Strength = 'none'
    if (!text) return best
    for (const { name } of readLine(text, { flattened: false }).hypotheses) {
      if (looksLikeQuantity(name)) continue
      const found = strengthOf(this.resolve(name))
      if (RANK[found] > RANK[best]) best = found
      if (best === 'exact') break
    }
    return best
  }

  /** 选一种读法（规则同查价）：整句 0–2 档 → 明确的乘号 → 识别得最好的；都认不出时取最有用的 */
  pick(text: string): { picked: Picked; badQuantity: boolean } {
    const reading = readLine(text, { flattened: false })
    const { hypotheses } = reading
    const toPicked = (h: Hypothesis): Picked => ({ name: h.name, quantity: isWhole(h) ? null : h.quantity, resolution: this.resolve(h.name) })
    const whole = hypotheses.find(isWhole)
    if (whole && strengthOf(this.resolve(whole.name)) === 'exact') return { picked: toPicked(whole), badQuantity: reading.badQuantity }
    const judge = (name: string): Judged<Resolution> | null => {
      const res = this.resolve(name)
      const strength = strengthOf(res)
      return strength === 'none' ? null : { approx: strength === 'prefix', value: res }
    }
    const choice = chooseHypothesis(hypotheses, judge)
    if (choice) return { picked: toPicked(choice.hypothesis), badQuantity: reading.badQuantity }
    const ranked = hypotheses
      .map((h, order) => ({ h, order, useful: usefulness(this.resolve(h.name)) }))
      .sort((a, b) => b.useful - a.useful || fallbackOrder(a.h) - fallbackOrder(b.h) || a.order - b.order)
    return { picked: toPicked(ranked[0].h), badQuantity: reading.badQuantity }
  }
}

type LocationSplit =
  | { kind: 'item'; item: string; location?: { name: string } }
  | { kind: 'unknown'; token: string; item: string }

function splitLocation(words: readonly string[], reader: Reader, deps: IndustryArgsDeps, access: Access): LocationSplit {
  const whole = words.join(' ')
  if (words.length < 2 || reader.recognize(whole) === 'exact') return { kind: 'item', item: whole }
  const max = Math.min(deps.locations.maxWords(access), words.length - 1)
  // 末尾的地点（所有者批准的写法）优先，再看开头；多词的名字按最长匹配
  for (let n = max; n >= 1; n--) {
    const location = deps.locations.match(words.slice(-n).join(' '), access)
    if (location) return { kind: 'item', item: words.slice(0, -n).join(' '), location }
  }
  for (let n = max; n >= 1; n--) {
    const location = deps.locations.match(words.slice(0, n).join(' '), access)
    if (location) return { kind: 'item', item: words.slice(n).join(' '), location }
  }
  // 未知地点：只按结构判断，不看「像不像地名」
  if (reader.recognize(whole) === 'none') {
    const last = words[words.length - 1]
    const before = words.slice(0, -1).join(' ')
    if (!looksLikeQuantity(last) && reader.recognize(before) !== 'none') return { kind: 'unknown', token: last, item: before }
    const first = words[0]
    const after = words.slice(1).join(' ')
    if (!looksLikeQuantity(first) && reader.recognize(after) !== 'none') return { kind: 'unknown', token: first, item: after }
  }
  return { kind: 'item', item: whole }
}

// ------------------------------------------------------------------ 合起来

function failure(code: CoreFailure['code'], extra: Omit<CoreFailure, 'ok' | 'code'> = {}): CoreFailure {
  return { ok: false, code, ...extra }
}

/** 物品认不出、不唯一、不在范围里 */
function itemFailure(
  picked: Picked, res: Exclude<Resolution, { kind: 'unique' }>, reader: Reader, activity: IndustryActivity, rest: string,
): CoreFailure {
  const extra = { resolution: res, token: picked.name, rest }
  switch (res.kind) {
    case 'none':
      return failure('ITEM_NOT_FOUND', extra)
    case 'out-of-scope': {
      // 制造的是反应产物 → 请用「反应」；反应的是能制造的东西 → 不在反应的范围里
      const other: Scope = activity === 'manufacturing' ? 'reaction' : 'industry'
      // 写的是蓝图或配方时，提示和按钮里要的是它的产品
      const there = reader.resolveIn(`#${res.item.typeId}`, other)
      if (there.kind === 'unique') {
        const resolution: Resolution = { kind: 'out-of-scope', item: there.item, scope: res.scope }
        return failure(activity === 'manufacturing' ? 'IS_REACTION' : 'OUT_OF_SCOPE', { ...extra, resolution })
      }
      return failure('NOT_MANUFACTURABLE', extra)
    }
    default:
      return failure('ITEM_AMBIGUOUS', extra)
  }
}

function parse(text: string, activity: IndustryActivity, access: Access, deps: IndustryArgsDeps): IndustryRequest | CoreFailure {
  const line = normalizeLine(text).replace(/\s+/g, ' ').trim()
  const args = readArgs(line ? line.split(' ') : [])
  if (args.bad) return failure('BAD_ARGUMENT', args.bad)
  const reaction = activity === 'reaction'
  // 反应配方不能研究：写了 ME/TE 也不用
  const parts: Omit<IndustryArgsParts, 'item'> = {
    quantity: args.quantity,
    runs: args.runs,
    me: reaction ? undefined : args.me,
    te: reaction ? undefined : args.te,
    structure: args.structure,
    rigs: args.rigs,
    facilityTaxPct: args.tax,
    steps: args.steps,
    materials: args.materials,
    chain: args.chain,
  }
  const reader = new Reader(deps.items, reaction ? 'reaction' : 'industry')
  const split = splitLocation(args.words, reader, deps, access)
  if (split.kind === 'unknown') {
    const locations = deps.locations.visible(access, activity).map((l) => l.name)
    const rest = `${split.item}${industryArgsTail({ ...parts, structure: portableStructure(parts.structure) })}`
    return failure('UNKNOWN_LOCATION', { token: split.token, rest, locations })
  }
  const { picked, badQuantity } = reader.pick(split.item)
  const location = split.location?.name
  const quantity = picked.quantity ?? args.quantity
  const rest = industryArgsTail({ ...parts, quantity, location })
  if (badQuantity && strengthOf(picked.resolution) !== 'exact') return failure('BAD_ARGUMENT', { reason: 'quantity' })
  const res = picked.resolution
  if (res.kind !== 'unique') return itemFailure(picked, res, reader, activity, rest)

  // 反应没有 ME/TE，不提醒
  const meteMissing = reaction ? undefined : args.meteMissing
  const mode: IndustryRequest['mode'] = args.steps || meteMissing ? 'steps'
    : location ? 'advanced'
      // 建筑、改装件、税都要先有地点：没写地点时从第 1 步问起
      : args.structure !== undefined || args.rigs || args.tax !== undefined ? 'steps' : 'base'
  const req: IndustryRequest = { typeId: res.item.typeId, activity, mode, materials: args.materials, access }
  if (quantity !== undefined) req.quantity = quantity
  if (args.runs !== undefined) req.runs = args.runs
  if (location) req.location = location
  if (args.structure !== undefined) req.structure = args.structure
  if (args.rigs) req.rigs = args.rigs
  if (parts.me !== undefined) req.me = parts.me
  if (parts.te !== undefined) req.te = parts.te
  if (args.tax !== undefined) req.facilityTaxPct = args.tax
  if (meteMissing) req.meteMissing = meteMissing
  if (args.chain) req.chain = args.chain
  return req
}

/**
 * 制造、反应的参数解析器（QueryParser.industryArgs）。失败时：
 * - 物品认不出、不唯一、不在范围里：ITEM_NOT_FOUND / ITEM_AMBIGUOUS / IS_REACTION / OUT_OF_SCOPE / NOT_MANUFACTURABLE，
 *   带 resolution；token 是写的物品名，rest 是物品名后面的部分（industryArgsTail），候选按钮是「精确名 + rest」；
 * - 地点认不出或本群看不到：UNKNOWN_LOCATION，token 是那个词，rest 是去掉它以后的参数，locations 是本群能用的地点；
 * - ME/TE、流程数、税、改装件写错，数量不是正整数：BAD_ARGUMENT（reason 说明是哪种）
 */
export function createIndustryArgs(deps: IndustryArgsDeps): IndustryArgsParser {
  return (text, activity, access) => {
    try {
      return parse(text, activity, access, deps)
    } catch (e) {
      if (e instanceof DataNotReadyError) return failure('DATA_NOT_READY', { message: e.message })
      throw e
    }
  }
}
