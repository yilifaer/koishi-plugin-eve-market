// 查价、走势、搜索的参数（§2.0.3–§2.0.5）：切市场 → 切数量 → 识别物品 → 认不出时按需问 ESI。
// 数量怎么切由识别结果决定：先把整句当名字，0–2 档认出就用；不行再在几种读法里选（明确的乘号优先，
// 不带 ≈ 的优先，一样好时名字最长的）；都认不出时，写了乘号的按乘号读（候选按钮保留数量），否则按整句。
// 新物品兜底最多等 REMOTE_LOOKUP_MS，没等到就按本地的结果回答（查询在后台做完，结果进缓存，下次就有）。
// 不 import market、items：市场注册表和识别器由 core 传进来，免得 market → parse → market 绕成环。

import { REMOTE_LOOKUP_MS } from '../../constants'
import { DataNotReadyError } from '../data'
import type { Scheduler } from '../ports'
import type {
  Access, CoreFailure, IndustryRequest, ItemInfo, ItemResolver, MarketRegistry, MarketSplit, ParsedQuery, QueryOptions,
  QueryParser, Resolution, Scope,
} from '../types'
import { withDeadline } from '../util'
import { chooseHypothesis } from './choose'
import type { Judged } from './choose'
import { readLine } from './quantity'
import type { Hypothesis } from './quantity'
import { normalizeLine } from './text'

export interface QueryParserDeps {
  items: ItemResolver
  markets: Pick<MarketRegistry, 'split' | 'visible'>
  /** 新物品兜底的时限用；不给时一直等到有结果 */
  scheduler?: Scheduler
}

/** 一种读法识别得多好：exact = 0–2 档（含套装、组名、不在范围里）；prefix = 3 档；none = 认不出或要用户确认 */
type Strength = 'exact' | 'prefix' | 'none'

interface Picked {
  name: string
  /** 整句当名字时 null */
  quantity: number | null
  resolution: Resolution
}

/** 新物品兜底最多试几种读法（每种都可能是两次 ESI 请求；结果连同「查不到」缓存 7 天） */
const REMOTE_TRIES = 2

const EXACT_TIERS = new Set(['id', 'exact', 'alias', 'remote'])

export function strengthOf(res: Resolution): Strength {
  switch (res.kind) {
    case 'unique':
    case 'ambiguous':
      if (res.tier === 'prefix') return 'prefix'
      return EXACT_TIERS.has(res.tier) ? 'exact' : 'none'
    case 'set':
    case 'sets':
    case 'group':
    case 'out-of-scope':
      return 'exact'
    default:
      return 'none'
  }
}

/** 认不出时哪种读法的结果更有用：要确认的候选 > 有建议的「没有找到」 > 什么都没有 */
function usefulness(res: Resolution): number {
  if (res.kind === 'confirm') return 2
  return res.kind === 'none' && res.suggestions.length ? 1 : 0
}

/** 认不出时同样有用的读法里先看谁：明确的乘号，然后整句，然后其他（readLine 的顺序） */
function fallbackOrder(h: Hypothesis): number {
  if (h.kind === 'explicit') return 0
  return h.kind === 'whole' ? 1 : 2
}

const isWhole = (h: Hypothesis) => h.kind === 'whole'

function failure(code: CoreFailure['code'], extra: Omit<CoreFailure, 'ok' | 'code'> = {}): CoreFailure {
  return { ok: false, code, ...extra }
}

class Parser implements QueryParser {
  constructor(private readonly deps: QueryParserDeps) {}

  async query(text: string, opts: QueryOptions): Promise<ParsedQuery | CoreFailure> {
    try {
      return await this.parse(text, opts)
    } catch (e) {
      if (e instanceof DataNotReadyError) return failure('DATA_NOT_READY', { message: e.message })
      throw e
    }
  }

  /** 工业命令在 0.2.0 才有 */
  industryArgs(): IndustryRequest | CoreFailure {
    return failure('NOT_CONFIGURED', { message: '工业计算在 0.2.0 提供' })
  }

  // ---------------------------------------------------------------- 查询

  private async parse(text: string, opts: QueryOptions): Promise<ParsedQuery | CoreFailure> {
    const line = normalizeLine(text).replace(/\s+/g, ' ')
    const split: MarketSplit = opts.market ? this.deps.markets.split(line, opts.access, this.deps.items, opts.scope) : { rest: line }
    if (split.unknown !== undefined) return this.unknownMarket(split, opts.access)
    const out = (picked: Picked): ParsedQuery => (split.market ? { market: split.market, ...picked } : picked)
    if (!split.rest) return out({ name: '', quantity: null, resolution: { kind: 'none', suggestions: [] } })

    const reading = readLine(split.rest, { flattened: false })
    const resolve = this.memo(opts.scope)
    let picked = this.pick(reading.hypotheses, resolve)
    if (reading.badQuantity && strengthOf(picked.resolution) !== 'exact') return failure('BAD_ARGUMENT', { reason: 'quantity' })
    if (opts.remote && opts.scope === 'market' && picked.resolution.kind === 'none') {
      picked = await this.remote(picked, reading.hypotheses)
    }
    const parsed = out(picked)
    const alt = split.market && split.alt ? this.alternative(split.alt, picked, resolve) : undefined
    if (alt) parsed.alt = alt
    return parsed
  }

  private unknownMarket(split: MarketSplit, access: Access): CoreFailure {
    const markets = this.deps.markets.visible(access).map((m) => m.key)
    return failure('UNKNOWN_MARKET', { token: split.unknown, rest: split.rest, markets })
  }

  /** 同一段文字只识别一次 */
  private memo(scope: Scope): (name: string) => Resolution {
    const cache = new Map<string, Resolution>()
    return (name) => {
      let res = cache.get(name)
      if (!res) {
        res = this.deps.items.resolve(name, { scope })
        cache.set(name, res)
      }
      return res
    }
  }

  private pick(hypotheses: readonly Hypothesis[], resolve: (name: string) => Resolution): Picked {
    const toPicked = (h: Hypothesis): Picked => ({ name: h.name, quantity: isWhole(h) ? null : h.quantity, resolution: resolve(h.name) })
    const whole = hypotheses.find(isWhole)
    if (whole && strengthOf(resolve(whole.name)) === 'exact') return toPicked(whole)

    const judge = (name: string): Judged<Resolution> | null => {
      const res = resolve(name)
      const strength = strengthOf(res)
      return strength === 'none' ? null : { approx: strength === 'prefix', value: res }
    }
    const choice = chooseHypothesis(hypotheses, judge)
    if (choice) return toPicked(choice.hypothesis)

    const ranked = hypotheses
      .map((h, order) => ({ h, order, useful: usefulness(resolve(h.name)) }))
      .sort((a, b) => b.useful - a.useful || fallbackOrder(a.h) - fallbackOrder(b.h) || a.order - b.order)
    return toPicked(ranked[0].h)
  }

  /** 新物品兜底，最多等 REMOTE_LOOKUP_MS；没等到时照样用本地的结果 */
  private async remote(picked: Picked, hypotheses: readonly Hypothesis[]): Promise<Picked> {
    const lookup = this.lookupRemote(picked, hypotheses)
    const { scheduler } = this.deps
    if (!scheduler) return lookup
    const got = await withDeadline(lookup, REMOTE_LOOKUP_MS, scheduler)
    return got.done ? got.value : picked
  }

  /** 先试选中的读法，再试别的带数量的读法 */
  private async lookupRemote(picked: Picked, hypotheses: readonly Hypothesis[]): Promise<Picked> {
    const tries: Array<{ name: string; quantity: number | null }> = [picked]
    for (const h of hypotheses) {
      if (!isWhole(h) && !tries.some((t) => t.name === h.name)) tries.push({ name: h.name, quantity: h.quantity })
    }
    for (const attempt of tries.slice(0, REMOTE_TRIES)) {
      const item = await this.deps.items.resolveRemote(attempt.name)
      if (item) return { ...attempt, resolution: { kind: 'unique', item, tier: 'remote' } }
    }
    return picked
  }

  /** 「开头是市场」和「整句是物品」都唯一精确命中时，整句当物品的那一个（「查所有市场」按钮） */
  private alternative(text: string, picked: Picked, resolve: (name: string) => Resolution): ItemInfo | undefined {
    if (picked.resolution.kind !== 'unique' || strengthOf(picked.resolution) !== 'exact') return undefined
    const whole = this.pick(readLine(text, { flattened: false }).hypotheses, resolve).resolution
    if (whole.kind !== 'unique' || strengthOf(whole) !== 'exact') return undefined
    return whole.item.typeId === picked.resolution.item.typeId ? undefined : whole.item
  }
}

export function createQueryParser(deps: QueryParserDeps): QueryParser {
  return new Parser(deps)
}
