// ItemResolver（§6.1）：档位、自动选择、排序，以及搜索、相关物品、名字。
//
// 档位：0 #id → 1 精确 → 2 别名（后台 > 黑话表 > 套装 > 生成的写法）→ 不在范围里 → 3 前缀 → 4 包含 → 4p 拼音 → 4b 容错。
// 0–3 档唯一命中直接用；包含、拼音一律让用户确认（哪怕只有 1 个）；容错的结果作为「没有找到」的建议。
// 索引按数据版本建在模块级存储里（插件重载后复用），别名层再按黑话表版本和后台别名重建。

import { MAX_CANDIDATES, NOT_FOUND_SUGGESTIONS, UNRESOLVED_CANDIDATES, USE_GLOSSARY } from '../../constants'
import { memoByKey, sha256 } from '../data'
import type { Logger, ModuleStore } from '../ports'
import type {
  ConfigIssue, DataService, ItemAliasSetting, ItemIndexStats, ItemInfo, ItemResolver, ItemSearchResult, Lang,
  MatchTier, RelatedItems, Resolution, Scope, TypeId,
} from '../types'
import { describeError } from '../util'
import { buildAliasLayer } from './aliases'
import type { GlossaryReport } from './aliases'
import { buildItemIndex } from './item-index'
import type { ItemIndex } from './item-index'
import {
  aliasMatches, containsRows, exactRows, inScope, nearRows, pinyinMatch, prefixRows, withoutSkins,
} from './match'
import type { AliasMatch, State } from './match'
import { nameKey } from './normalize'
import { parseQuery } from './query'
import type { Query } from './query'
import { CATEGORY_SKIN, rankRows } from './rank'
import { relatedRows } from './related'
import { looksLikeFullName, RemoteItems } from './remote'
import type { RemoteDeps } from './remote'

export interface ItemResolverOptions {
  data: Pick<DataService, 'current' | 'glossary' | 'onUpdate'>
  store: ModuleStore
  /** 控制台「物品别名」（normalize 之后） */
  aliases: readonly ItemAliasSetting[]
  /** 新物品兜底；不给时 resolveRemote 总是 null */
  remote?: RemoteDeps
  logger?: Logger
  /** 默认 USE_GLOSSARY */
  useGlossary?: boolean
}

export interface ItemReport {
  glossary: GlossaryReport
  /** 认出的植入体套装个数、没当成套装的组合 */
  sets: { count: number; skipped: readonly string[] }
  /** 中文名以「级」结尾的船体名个数（去「级」写法的依据） */
  hulls: number
}

export interface ManagedItemResolver extends ItemResolver {
  /** 后台别名的坏行（需要数据才能检查），「市场状态」里列出 */
  issues(): ConfigIssue[]
  report(): ItemReport
  /** 现在就建好索引（启动、数据更新后调用，免得第一次查询时才建） */
  warm(): void
  /** 取消对数据更新的监听 */
  dispose(): void
}

/** 一档的命中（还没按 limit 截断） */
type Hit =
  /** 已按范围换算、排好序 */
  | { kind: 'rows'; tier: MatchTier; rows: number[] }
  | { kind: 'group'; groupId: number; rows: number[] }
  | { kind: 'sets'; sets: number[] }
  /** 名字精确命中，但不在这个范围里 */
  | { kind: 'outside'; row: number }

type LineResult = ReturnType<ItemResolver['resolveLine']>
type Unresolved = Extract<LineResult, { unresolved: true }>
type UnresolvedFields = Omit<Unresolved, 'unresolved'>

/**
 * 批量估价的每个假设都会问一次：认不出时的建议要线性扫描，等调用方真的读到时才算。
 * 字段是可枚举的 getter，展开（{ ...r }）和 JSON 都照常拿得到
 */
function lazyUnresolved(compute: () => UnresolvedFields): Unresolved {
  let value: UnresolvedFields | undefined
  const fields = () => (value ??= compute())
  const out = { unresolved: true } as Unresolved
  Object.defineProperties(out, {
    suggestion: { enumerable: true, get: () => fields().suggestion },
    candidates: { enumerable: true, get: () => fields().candidates },
    total: { enumerable: true, get: () => fields().total },
  })
  return out
}

const EAGER_TIERS = new Set<MatchTier>(['id', 'exact', 'alias'])

class Resolver implements ManagedItemResolver {
  private readonly aliasFingerprint: string
  private readonly remote?: RemoteItems
  private readonly unsubscribe: () => void

  constructor(private readonly opts: ItemResolverOptions) {
    this.aliasFingerprint = sha256(JSON.stringify(opts.aliases.map((a) => [a.row, a.alias, a.target]))).slice(0, 16)
    if (opts.remote) this.remote = new RemoteItems(opts.remote, () => opts.data.current())
    this.unsubscribe = opts.data.onUpdate(() => {
      try {
        this.warm()
      } catch (e) {
        opts.logger?.warn('物品索引重建失败：%s', describeError(e))
      }
    })
  }

  private state(): State {
    const { data, store } = this.opts
    const current = data.current()
    const glossary = (this.opts.useGlossary ?? USE_GLOSSARY) ? data.glossary() : null
    const index = memoByKey(store, 'items/index', current.key, () => buildItemIndex(current))
    const aliasKey = `${current.key}|${glossary?.key ?? '-'}|${this.aliasFingerprint}`
    const aliases = memoByKey(store, 'items/aliases', aliasKey, () => buildAliasLayer(index, glossary, this.opts.aliases))
    return { index, aliases }
  }

  warm() {
    this.state()
  }

  dispose() {
    this.unsubscribe()
  }

  // ---------------------------------------------------------------- 档位

  private ranked(index: ItemIndex, rows: number[], q: Query): number[] {
    return rankRows(rows, index.rank, q.rank)
  }

  /** 范围里有就是这一档的命中；全在范围外时记下来，最后回复「不在范围里」 */
  private rowsHit(index: ItemIndex, rows: readonly number[], tier: MatchTier, q: Query, scope: Scope, outside: number[]): Hit | null {
    const found = inScope(index, rows, scope)
    if (found.length) return { kind: 'rows', tier, rows: this.ranked(index, found, q) }
    outside.push(...rows)
    return null
  }

  private aliasHit(st: State, m: AliasMatch, q: Query, scope: Scope, outside: number[]): Hit | null {
    const { index } = st
    if (m.kind === 'items') return this.rowsHit(index, m.rows, 'alias', q, scope, outside)
    if (m.kind === 'sets') return { kind: 'sets', sets: [...m.sets] }
    const members = m.groupIds.flatMap((id) => index.groupRows.get(id) ?? [])
    const rows = inScope(index, withoutSkins(index, members, q).rows, scope)
    return rows.length ? { kind: 'group', groupId: m.groupIds[0], rows: this.ranked(index, rows, q) } : null
  }

  /** 0–2 档；名字精确命中但不在范围里时返回 outside */
  private headHit(st: State, q: Query, scope: Scope): Hit | null {
    const { index } = st
    const outside: number[] = []
    if (q.id !== null) {
      const row = index.table.rowOf(q.id)
      return row < 0 ? null : this.rowsHit(index, [row], 'id', q, scope, outside) ?? { kind: 'outside', row }
    }
    const hit = this.rowsHit(index, exactRows(index, q.key), 'exact', q, scope, outside)
      ?? aliasMatches(st, q, scope).reduce<Hit | null>((found, m) => found ?? this.aliasHit(st, m, q, scope, outside), null)
    if (hit || !outside.length) return hit
    return { kind: 'outside', row: this.ranked(index, [...new Set(outside)], q)[0] }
  }

  /** 3 档：涂装不列（除非查询提到涂装） */
  private prefixHit(index: ItemIndex, q: Query, scope: Scope): Hit | null {
    const rows = inScope(index, withoutSkins(index, prefixRows(index, q.key), q).rows, scope)
    return rows.length ? { kind: 'rows', tier: 'prefix', rows: this.ranked(index, rows, q) } : null
  }

  private fuzzyRows(index: ItemIndex, q: Query, scope: Scope, tier: 'contains' | 'pinyin'): number[] {
    const raw = tier === 'contains' ? containsRows(index, q, scope) : pinyinMatch(index, q)
    return inScope(index, withoutSkins(index, raw, q).rows, scope)
  }

  /** 4、4p 档 */
  private fuzzyHit(index: ItemIndex, q: Query, scope: Scope): Hit | null {
    for (const tier of ['contains', 'pinyin'] as const) {
      const rows = this.fuzzyRows(index, q, scope, tier)
      if (rows.length) return { kind: 'rows', tier, rows: this.ranked(index, rows, q) }
    }
    return null
  }

  /** 4b 容错：越接近越靠前，一样接近时按物品排序 */
  private suggestions(index: ItemIndex, q: Query, scope: Scope, limit: number): ItemInfo[] {
    const best = new Map<number, number>()
    for (const { row, score } of nearRows(index, q, scope)) {
      if (!q.rank.skin && index.table.category[row] === CATEGORY_SKIN) continue
      const target = index.scopeOf[scope][row]
      const old = best.get(target)
      if (old === undefined || score < old) best.set(target, score)
    }
    const rows = this.ranked(index, [...best.keys()], q).sort((a, b) => best.get(a)! - best.get(b)!)
    return this.items(index, rows.slice(0, limit))
  }

  // ---------------------------------------------------------------- 结果

  private items(index: ItemIndex, rows: readonly number[]): ItemInfo[] {
    return rows.map((row) => index.table.item(row))
  }

  private nameIn(item: ItemInfo, lang: Lang): string {
    return lang === 'zh' && item.zh ? item.zh : item.en
  }

  private toResolution(st: State, hit: Hit, q: Query, scope: Scope, limit: number): Resolution {
    const { index } = st
    if (hit.kind === 'outside') return { kind: 'out-of-scope', item: index.table.item(hit.row), scope }
    if (hit.kind === 'sets') {
      const sets = hit.sets.map((i) => index.sets[i].set)
      return sets.length === 1 ? { kind: 'set', set: sets[0] } : { kind: 'sets', sets }
    }
    const candidates = this.items(index, hit.rows.slice(0, limit))
    const total = hit.rows.length
    if (hit.kind === 'group') {
      const group = index.data.groups.get(hit.groupId)
      const groupName = group ? (q.lang === 'zh' && group.zh ? group.zh : group.en) : String(hit.groupId)
      return { kind: 'group', groupName, candidates, total }
    }
    const { tier } = hit
    if (tier === 'contains' || tier === 'pinyin' || tier === 'near') return { kind: 'confirm', tier, candidates, total }
    if (total > 1) return { kind: 'ambiguous', tier, candidates, total }
    const item = index.table.item(hit.rows[0])
    return tier === 'alias' || tier === 'prefix' ? { kind: 'unique', item, tier, via: this.nameIn(item, q.lang) } : { kind: 'unique', item, tier }
  }

  resolve(query: string, opts: { scope: Scope; limit?: number }): Resolution {
    const st = this.state()
    const { index } = st
    const q = parseQuery(query)
    const limit = Math.max(1, opts.limit ?? MAX_CANDIDATES)
    if (!q.key) return { kind: 'none', suggestions: [] }
    const hit = q.id !== null
      ? this.headHit(st, q, opts.scope)
      : this.headHit(st, q, opts.scope) ?? this.prefixHit(index, q, opts.scope) ?? this.fuzzyHit(index, q, opts.scope)
    if (hit) return this.toResolution(st, hit, q, opts.scope, limit)
    const suggestions = q.id === null ? this.suggestions(index, q, opts.scope, Math.min(limit, NOT_FOUND_SUGGESTIONS)) : []
    return { kind: 'none', suggestions }
  }

  async resolveRemote(query: string): Promise<ItemInfo | null> {
    if (!this.remote || !looksLikeFullName(query)) return null
    return this.remote.lookup(query)
  }

  // ---------------------------------------------------------------- 批量估价逐行

  private unresolvedOf(resolution: Resolution): UnresolvedFields {
    switch (resolution.kind) {
      case 'ambiguous':
      case 'confirm':
      case 'group':
        return { suggestion: resolution.candidates[0], candidates: resolution.candidates, total: resolution.total }
      case 'set':
        return { candidates: resolution.set.items.slice(0, UNRESOLVED_CANDIDATES), total: resolution.set.items.length }
      // 什么都没匹配到：total 是 0，容错的建议只作「是不是：X」
      case 'none':
        return { suggestion: resolution.suggestions[0], candidates: resolution.suggestions, total: 0 }
      default:
        return { total: 0 }
    }
  }

  resolveLine(name: string): LineResult {
    const st = this.state()
    const q = parseQuery(name)
    const scope: Scope = 'market'
    const hit = q.key ? this.headHit(st, q, scope) ?? (q.id === null ? this.prefixHit(st.index, q, scope) : null) : null
    if (hit?.kind === 'rows' && hit.rows.length === 1 && (EAGER_TIERS.has(hit.tier) || hit.tier === 'prefix')) {
      return { item: st.index.table.item(hit.rows[0]), approx: hit.tier === 'prefix' }
    }
    if (hit) return { unresolved: true, ...this.unresolvedOf(this.toResolution(st, hit, q, scope, UNRESOLVED_CANDIDATES)) }
    return lazyUnresolved(() => this.unresolvedOf(this.resolve(name, { scope, limit: UNRESOLVED_CANDIDATES })))
  }

  // ---------------------------------------------------------------- 搜索、相关物品

  search(query: string, opts: { scope: Scope; offset: number; limit: number }): ItemSearchResult {
    const st = this.state()
    const { index } = st
    const q = parseQuery(query)
    if (!q.key) return { items: [], total: 0, skins: 0 }
    const head = this.headHit(st, q, opts.scope)
    if (head?.kind === 'rows' && head.rows.length === 1 && EAGER_TIERS.has(head.tier)) {
      return { exact: index.table.item(head.rows[0]), items: [], total: 1, skins: 0 }
    }
    const list = new Set<number>(this.headRows(index, head))
    const skins = new Set<number>()
    if (q.id === null) {
      for (const raw of [prefixRows(index, q.key), containsRows(index, q, opts.scope), pinyinMatch(index, q)]) {
        const split = withoutSkins(index, raw, q)
        for (const row of inScope(index, split.skins, opts.scope)) skins.add(row)
        for (const row of this.ranked(index, inScope(index, split.rows, opts.scope), q)) list.add(row)
      }
    }
    const rows = [...list]
    const offset = Math.max(0, opts.offset)
    return { items: this.items(index, rows.slice(offset, offset + Math.max(0, opts.limit))), total: rows.length, skins: skins.size }
  }

  private headRows(index: ItemIndex, head: Hit | null): number[] {
    if (!head || head.kind === 'outside') return []
    if (head.kind === 'sets') return head.sets.flatMap((i) => index.sets[i].set.items.map((item) => index.table.rowOf(item.typeId)))
    return head.rows
  }

  related(id: TypeId): RelatedItems {
    const { index } = this.state()
    const row = index.table.rowOf(id)
    if (row < 0) return { variants: [], containing: [], skins: 0 }
    const r = relatedRows(index, row)
    const out: RelatedItems = { variants: this.items(index, r.variants), containing: this.items(index, r.containing), skins: r.skins }
    if (r.blueprint !== undefined) out.blueprint = index.table.item(r.blueprint)
    if (r.product !== undefined) out.product = index.table.item(r.product)
    return out
  }

  // ---------------------------------------------------------------- 名字、别名、状态

  byId(id: TypeId): ItemInfo | undefined {
    const { index } = this.state()
    const row = index.table.rowOf(id)
    return row >= 0 ? index.table.item(row) : undefined
  }

  aliasesOf(id: TypeId): string[] {
    return [...this.state().aliases.byType.get(id) ?? []]
  }

  displayName(item: ItemInfo, lang?: Lang): string {
    if (lang === 'en' || !item.zh) return item.en
    if (lang === 'zh') return item.zh
    return `${item.en} / ${item.zh}`
  }

  commandName(item: ItemInfo): string {
    const { index } = this.state()
    // 新物品（ESI 兜底来的）本地没有，#typeID 认不出，只能写名字
    if (index.table.rowOf(item.typeId) < 0) return item.en
    const unique = (name: string) => {
      const rows = name ? exactRows(index, nameKey(name)) : []
      return rows.length === 1 && index.table.id[rows[0]] === item.typeId
    }
    if (unique(item.zh)) return item.zh
    if (unique(item.en)) return item.en
    return `#${item.typeId}`
  }

  stats(): ItemIndexStats {
    const { index, aliases } = this.state()
    return {
      items: index.table.size,
      marketItems: index.scopeRows.market.length,
      adminAliases: aliases.adminCount,
      glossaryAliases: aliases.glossaryReport.aliases,
      sets: index.sets.length,
    }
  }

  issues(): ConfigIssue[] {
    return [...this.state().aliases.issues]
  }

  report(): ItemReport {
    const { index, aliases } = this.state()
    return {
      glossary: aliases.glossaryReport,
      sets: { count: index.sets.length, skipped: index.setSkipped },
      hulls: index.hulls,
    }
  }
}

export function createItemResolver(options: ItemResolverOptions): ManagedItemResolver {
  return new Resolver(options)
}
