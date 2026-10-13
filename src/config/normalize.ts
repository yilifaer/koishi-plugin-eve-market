// 原始配置 → Settings + ConfigIssue[]。纯函数，不联网、不读数据：
// 星系名、空间站、别名目标、改装件、对市场的引用这些要等数据加载后由 core 再检查一遍。
// 原则：写错一行只影响那一行；坏行跳过并报告，插件照常加载。

import { DEFAULT_SCRAPMETAL_LEVEL, MAX_ME, MAX_QUANTITY, MAX_TE, NOTICE_MAX_CHARS, PRICE_TYPE_WORDS, SSO_CALLBACK_PATH } from '../constants'
import { FORMULA_DEFAULTS } from '../core/industry'
import type {
  AccessSettings, AdvancedSettings, AppraisalSettings, ConfigIssue, ConfigSection, DefaultQuantitySetting, DisplaySettings,
  FreightRoute, IndustryActivity, IndustryLocationSetting, IndustrySettings, IndustryStructureSetting, ItemAliasSetting,
  MarketRefField, MarketRefSetting, MarketSetting, MarketType, NoticeSetting, PriceSide, RenderSettings, Settings, SsoSettings,
  Visibility,
} from '../core/types'
import {
  DEFAULT_BASE_MARKET, DEFAULT_CALLBACK_URL, DEFAULT_COALITION_MAP_URL, DEFAULT_EXTRA_FEE_LABEL, DEFAULT_GLOSSARY_URL,
  DEFAULT_INFLUENCE_MAP_URL, DEFAULT_MANIFEST_URL, DEFAULT_ME_TE_CHOICES, DEFAULT_QUANTITIES, PRESET_MARKETS,
} from './presets'

/** 表格的一行写错时 Schema 回退成带这个键的对象 */
export const INVALID_ROW_KEY = '__invalidRow'

export interface NormalizedConfig {
  settings: Settings
  /** 和 settings.issues 是同一个数组 */
  issues: ConfigIssue[]
}

const SECTION_LABELS: Record<ConfigSection, string> = {
  general: '基本',
  display: '显示',
  access: '权限',
  markets: '市场',
  aliases: '物品别名',
  price: '查价',
  appraisal: '批量查价',
  freight: '运费',
  notices: '查价告示',
  industry: '工业',
  sso: 'EVE 授权',
  render: '图片与截图',
  advanced: '高级',
}

/** 「市场第 6 行「位置」不是数字，已跳过」「授权群第 2 行…」「查价：…」 */
export function formatIssue(issue: ConfigIssue): string {
  const label = SECTION_LABELS[issue.section] ?? issue.section
  if (issue.row) return `${issue.table ?? label}第 ${issue.row} 行${issue.message}`
  return `${label}${issue.table ? ` · ${issue.table}` : ''}：${issue.message}`
}

/** 市场名、地点名的比较键：NFKC、小写、破折号统一、连续空白合成一个 */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[‒–—―−‑]/g, '-').replace(/\s+/g, ' ').trim()
}

/** 别名表的比较键：再去掉所有空白 */
function compactKey(value: string): string {
  return nameKey(value).replace(/ /g, '')
}

/** 像网址或域名的片段（QQ 群里不允许发网址）。宁可多拦：「Raven.Navy」也算 */
export function containsUrl(value: string): boolean {
  return /:\/\/|www\.|[a-z0-9-]\.[a-z]{2,}(?![a-z0-9-])/i.test(value)
}

/** 北京时间 `YYYY-MM-DD HH:mm`（也接受 / 分隔；只写日期 = 当天 23:59）→ 毫秒时间戳；写错返回 undefined */
export function parseBeijingTime(value: string): number | undefined {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?$/.exec(value.normalize('NFKC').trim())
  if (!m) return undefined
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const [h, mi] = m[4] === undefined ? [23, 59] : [Number(m[4]), Number(m[5])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return undefined
  const utc = Date.UTC(y, mo - 1, d, h, mi)
  // 2 月 30 日这类日期会顺延到下个月，按写错处理
  if (new Date(utc).getUTCDate() !== d) return undefined
  return utc - 8 * 3600_000
}

/** 「10/20, 5/10, 0/0」→ [{ me: 10, te: 20 }, …]；看不懂的放进 bad */
export function parseMeTeChoices(value: string): { choices: Array<{ me: number; te: number }>; bad: string[] } {
  const choices: Array<{ me: number; te: number }> = []
  const bad: string[] = []
  for (const part of splitList(value.normalize('NFKC'))) {
    const m = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(part)
    const me = m ? Number(m[1]) : NaN
    const te = m ? Number(m[2]) : NaN
    if (!m || me > MAX_ME || te > MAX_TE) {
      bad.push(part)
      continue
    }
    if (!choices.some((c) => c.me === me && c.te === te)) choices.push({ me, te })
  }
  return { choices, bad }
}

// ------------------------------------------------------------------ 读原始值的小工具

type Raw = Record<string, unknown>

function obj(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {}
}

function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

/** 一行文字：去掉首尾空白，换行和连续空白合成一个空格 */
function line(value: unknown, fallback = ''): string {
  return text(value, fallback).replace(/\s+/g, ' ').trim()
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function isMissing(value: unknown) {
  return value === undefined || value === null
}

function isInvalidRow(row: unknown): boolean {
  return !row || typeof row !== 'object' || Array.isArray(row) || (row as Raw)[INVALID_ROW_KEY] === true
}

/** 逗号（中英文）、顿号、分号分隔的列表 */
function splitList(value: string): string[] {
  return value.split(/[,，、;；]/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

function isDigits(value: string) {
  return /^\d+$/.test(value)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 和批量查价表头、工业命令的参数冲突的名字 */
const RESERVED_WORDS = new Set([
  ...PRICE_TYPE_WORDS.sell, ...PRICE_TYPE_WORDS.buy, ...PRICE_TYPE_WORDS.mid,
  '全部', 'all', '高级', '材料', '刷新',
].map(nameKey))

function reservedReason(name: string): string | null {
  const key = nameKey(name)
  if (RESERVED_WORDS.has(key)) return '和命令的参数冲突'
  if (/^[\d\s.,]+$/.test(key)) return '是纯数字，会被当成数量'
  if (/^[+-]?\d+(\.\d+)?\s*(%|折)$/.test(key)) return '会被当成价格调整'
  if (key.startsWith('#')) return '不能以 # 开头'
  if (/^从\d+$/.test(key)) return '会被当成「全部 从N」的页码'
  return null
}

interface At { table?: string; row?: number; field?: string }

class IssueList {
  readonly list: ConfigIssue[] = []

  add(section: ConfigSection, message: string, at: At = {}) {
    const issue: ConfigIssue = { section, message }
    if (at.table !== undefined) issue.table = at.table
    if (at.row !== undefined) issue.row = at.row
    if (at.field !== undefined) issue.field = at.field
    this.list.push(issue)
  }
}

/** 取一个枚举值；写了但不认识时报告并用默认值 */
function pick<T extends string>(
  issues: IssueList, section: ConfigSection, label: string, value: unknown,
  allowed: readonly T[], fallback: T, at: At = {},
): T {
  if (isMissing(value) || value === '') return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  issues.add(section, `「${label}」写的「${text(value, String(value))}」不认识，已改用默认值`, at)
  return fallback
}

/** 数字字段：不是数字时用默认值，超出范围按边界值处理，都报告 */
function clampNumber(
  issues: IssueList, section: ConfigSection, label: string, value: unknown, fallback: number,
  min: number, max: number, at: At & { integer?: boolean } = {},
): number {
  let n = numeric(value)
  if (n === undefined) {
    if (!isMissing(value) && value !== '') issues.add(section, `「${label}」不是数字，已改用默认值 ${fallback}`, at)
    return fallback
  }
  if (at.integer && !Number.isInteger(n)) n = Math.round(n)
  if (n < min || n > max) {
    const clamped = Math.min(max, Math.max(min, n))
    issues.add(section, `「${label}」应该在 ${min}–${max} 之间，已按 ${clamped} 处理`, at)
    return clamped
  }
  return n
}

/** 表格：不是数组时用默认值（没写过的静默，写成别的东西的报告） */
function tableRows(issues: IssueList, section: ConfigSection, value: unknown, fallback: unknown[] = [], table?: string): unknown[] {
  if (Array.isArray(value)) return value
  if (!isMissing(value)) issues.add(section, '格式不对，已改用默认值', { table })
  return fallback
}

function invalidRow(issues: IssueList, section: ConfigSection, row: number, table?: string) {
  issues.add(section, '有写错的字段（例如类型、启用写成了别的值），已跳过', { table, row })
}

// ------------------------------------------------------------------ 各分组

function normalizeDisplay(raw: Raw, issues: IssueList): DisplaySettings {
  const d = obj(raw.display)
  const s: ConfigSection = 'display'
  return {
    output: pick(issues, s, '输出方式', d.output, ['markdown', 'text'], 'markdown', { field: 'output' }),
    numberStyle: pick(issues, s, '价格样式', d.numberStyle, ['code', 'bold', 'plain'], 'code', { field: 'numberStyle' }),
    priceDisplayMode: pick(issues, s, '主要金额的写法', d.priceDisplayMode, ['full_and_compact', 'full_only', 'compact_only'], 'full_and_compact', { field: 'priceDisplayMode' }),
    listPriceDisplayMode: pick(issues, s, '清单价格的写法', d.listPriceDisplayMode, ['compact_only', 'inherit'], 'compact_only', { field: 'listPriceDisplayMode' }),
    compactDecimals: clampNumber(issues, s, '简写的小数位数', d.compactDecimals, 2, 0, 4, { integer: true, field: 'compactDecimals' }),
    thousandSeparator: bool(d.thousandSeparator, true),
    showCurrency: bool(d.showCurrency, true),
    clickable: pick(issues, s, '按钮', d.clickable, ['buttons', 'none'], 'buttons', { field: 'clickable' }),
  }
}

/** 用户、群 ID：去掉首尾空白和 qq: 前缀 */
function cleanId(value: string): string {
  return value.trim().replace(/^qq:/i, '').trim()
}

function normalizeIdTable(issues: IssueList, value: unknown, field: 'groupId' | 'userId', label: string, table: string): string[] {
  const out: string[] = []
  tableRows(issues, 'access', value, [], table).forEach((rawRow, i) => {
    const row = i + 1
    if (isInvalidRow(rawRow)) return invalidRow(issues, 'access', row, table)
    const r = rawRow as Raw
    if (!bool(r.enabled, true)) return
    const id = cleanId(text(r[field]))
    if (!id) return issues.add('access', `「${label}」为空，已跳过`, { table, row, field })
    if (/\s/.test(id)) return issues.add('access', `「${label}」里有空格，已跳过`, { table, row, field })
    if (!out.includes(id)) out.push(id)
  })
  return out
}

function normalizeAccess(raw: Raw, issues: IssueList): AccessSettings {
  const a = obj(raw.access)
  const admins: string[] = []
  const rawAdmins = Array.isArray(a.admins) ? a.admins : typeof a.admins === 'string' ? a.admins.split(/[,，\n]/) : []
  for (const entry of rawAdmins) {
    const id = cleanId(text(entry))
    if (!id) continue
    if (/\s/.test(id)) {
      issues.add('access', `管理员「${id}」里有空格，已跳过`, { field: 'admins' })
      continue
    }
    if (!admins.includes(id)) admins.push(id)
  }
  return {
    admins,
    allowedGroups: normalizeIdTable(issues, a.allowedGroups, 'groupId', '群 ID', '授权群'),
    allowedUsers: normalizeIdTable(issues, a.allowedUsers, 'userId', '用户 ID', '授权私聊用户'),
  }
}

const MARKET_TYPES: readonly MarketType[] = ['npc-station', 'system', 'region', 'structure']
const PROFILE_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u

interface MarketDraft extends Omit<MarketSetting, 'inDefaultList' | 'autoDefaultList' | 'visibility'> {
  inDefaultListRaw: 'auto' | 'yes' | 'no'
  visibility: Visibility
}

function normalizeMarkets(raw: Raw, issues: IssueList): MarketDraft[] {
  const s: ConfigSection = 'markets'
  const drafts: MarketDraft[] = []
  const byKey = new Map<string, MarketDraft>()
  tableRows(issues, s, raw.markets, PRESET_MARKETS).forEach((rawRow, i) => {
    const row = i + 1
    if (isInvalidRow(rawRow)) return invalidRow(issues, s, row)
    const r = rawRow as Raw
    if (!bool(r.enabled, true)) return
    const name = line(r.name)
    if (!name) return issues.add(s, '「名称」为空，已跳过', { row, field: 'name' })
    const reserved = reservedReason(name)
    if (reserved) return issues.add(s, `「名称」${name} ${reserved}，已跳过`, { row, field: 'name' })
    const key = nameKey(name)
    const same = byKey.get(key)
    if (same) return issues.add(s, `「名称」${name} 和第 ${same.row} 行重复，已跳过`, { row, field: 'name' })

    const typeRaw = isMissing(r.type) ? 'npc-station' : r.type
    if (typeof typeRaw !== 'string' || !MARKET_TYPES.includes(typeRaw as MarketType)) {
      return issues.add(s, `「类型」写的「${text(typeRaw)}」不认识，已跳过`, { row, field: 'type' })
    }
    const type = typeRaw as MarketType
    const location = line(r.location)
    if (!location) return issues.add(s, '「位置」为空，已跳过', { row, field: 'location' })
    if ((type === 'npc-station' || type === 'structure') && !isDigits(location)) {
      const hint = type === 'structure' ? '玩家建筑填建筑 ID' : 'NPC 空间站填空间站 ID'
      return issues.add(s, `「位置」不是数字（${hint}），已跳过`, { row, field: 'location' })
    }

    let authProfile = ''
    const system = type === 'structure' ? line(r.system) : ''
    if (type === 'structure') {
      authProfile = isMissing(r.authProfile) ? 'default' : line(r.authProfile)
      if (authProfile && !PROFILE_PATTERN.test(authProfile)) {
        return issues.add(s, `「授权档案」${authProfile} 只能用文字、数字、- 和 _（最多 32 个字），已跳过`, { row, field: 'authProfile' })
      }
      // 不用授权时只能从星域订单里找这个建筑，要靠所在星系知道星域
      if (!authProfile && !system) return issues.add(s, '「授权档案」留空时要填「建筑所在星系」，已跳过', { row, field: 'system' })
    }

    const inDefaultListRaw = r.inDefaultList === true ? 'yes' : r.inDefaultList === false ? 'no'
      : pick(issues, s, '默认查价', r.inDefaultList, ['auto', 'yes', 'no'] as const, 'auto', { row, field: 'inDefaultList' })
    const visibilityRaw = pick(issues, s, '谁能看到', r.visibility, ['auto', 'public', 'allowed'] as const, 'auto', { row, field: 'visibility' })
    const draft: MarketDraft = {
      row,
      key,
      name,
      aliases: splitList(text(r.aliases)),
      type,
      location,
      system,
      inDefaultListRaw,
      sortOrder: clampNumber(issues, s, '排序', r.sortOrder, 0, -1e6, 1e6, { row, field: 'sortOrder' }),
      // 自动 = 玩家建筑只在授权群，其他公开
      visibility: visibilityRaw === 'auto' ? (type === 'structure' ? 'allowed' : 'public') : visibilityRaw,
      authProfile,
      note: line(r.note),
    }
    drafts.push(draft)
    byKey.set(key, draft)
  })

  // 别名：所有名称都确定以后再检查冲突；名称永远优先，同一个别名先到先得
  const owner = new Map<string, MarketDraft>()
  for (const d of drafts) owner.set(d.key, d)
  for (const d of drafts) {
    const kept: string[] = []
    for (const alias of d.aliases) {
      const key = nameKey(alias)
      if (key === d.key || kept.some((a) => nameKey(a) === key)) continue
      const reserved = reservedReason(alias)
      if (reserved) {
        issues.add(s, `别名「${alias}」${reserved}，已忽略`, { row: d.row, field: 'aliases' })
        continue
      }
      const other = owner.get(key)
      if (other) {
        const what = other.key === key ? `和第 ${other.row} 行市场的名称相同` : `已经被第 ${other.row} 行的市场使用`
        issues.add(s, `别名「${alias}」${what}，这一行的不生效`, { row: d.row, field: 'aliases' })
        continue
      }
      owner.set(key, d)
      kept.push(alias)
    }
    d.aliases = kept
  }
  return drafts
}

/** 按市场的名称或手写别名找市场（星系名这类自动别名要等数据加载，不在这里认） */
function findMarket(drafts: MarketDraft[], ref: string): MarketDraft | undefined {
  const key = nameKey(ref)
  return drafts.find((d) => d.key === key) ?? drafts.find((d) => d.aliases.some((a) => nameKey(a) === key))
}

/** 本地只认名称和手写别名；认不出时不报告，可能是星系名这类自动别名，数据加载后由 core 再认 */
function marketRef(
  drafts: MarketDraft[], section: ConfigSection, field: string, label: string,
  value: unknown, defaultRef: string, whenEmpty: MarketRefSetting['whenEmpty'], quiet = false,
): MarketRefSetting {
  const ref = isMissing(value) ? defaultRef : line(value)
  const out: MarketRefSetting = { section, field, label, ref, whenEmpty, key: ref ? findMarket(drafts, ref)?.key ?? '' : '' }
  if (quiet) out.quiet = true
  return out
}

function normalizeItemAliases(raw: Raw, issues: IssueList): ItemAliasSetting[] {
  const s: ConfigSection = 'aliases'
  const out: ItemAliasSetting[] = []
  const seen = new Map<string, number>()
  tableRows(issues, s, raw.aliases).forEach((rawRow, i) => {
    const row = i + 1
    if (isInvalidRow(rawRow)) return invalidRow(issues, s, row)
    const r = rawRow as Raw
    if (!bool(r.enabled, true)) return
    const alias = line(r.alias)
    const target = line(r.target)
    if (!alias) return issues.add(s, '「别名」为空，已跳过', { row, field: 'alias' })
    if (!target) return issues.add(s, `别名「${alias}」没有写目标物品，已跳过`, { row, field: 'target' })
    const key = compactKey(alias)
    const first = seen.get(key)
    if (first !== undefined) return issues.add(s, `别名「${alias}」和第 ${first} 行重复，已跳过`, { row, field: 'alias' })
    seen.set(key, row)
    out.push({ row, alias, target })
  })
  return out
}

function normalizeQuantities(price: Raw, issues: IssueList): DefaultQuantitySetting[] {
  const s: ConfigSection = 'price'
  const table = '默认数量'
  const out: DefaultQuantitySetting[] = []
  const seen = new Map<string, number>()
  tableRows(issues, s, price.defaultQuantities, DEFAULT_QUANTITIES, table).forEach((rawRow, i) => {
    const row = i + 1
    if (isInvalidRow(rawRow)) return invalidRow(issues, s, row, table)
    const r = rawRow as Raw
    const item = line(r.item)
    if (!item) return issues.add(s, '「物品」为空，已跳过', { table, row, field: 'item' })
    const quantity = numeric(r.quantity)
    if (quantity === undefined || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return issues.add(s, `${item} 的数量要是 1 到 10¹² 之间的整数，已跳过`, { table, row, field: 'quantity' })
    }
    const key = compactKey(item)
    const first = seen.get(key)
    if (first !== undefined) return issues.add(s, `${item} 和第 ${first} 行重复，已跳过`, { table, row, field: 'item' })
    seen.set(key, row)
    out.push({ row, item, quantity })
  })
  return out
}

function normalizeFreight(raw: Raw, issues: IssueList): FreightRoute[] {
  const s: ConfigSection = 'freight'
  const out: FreightRoute[] = []
  const seen = new Map<string, number>()
  tableRows(issues, s, obj(raw.freight).routes).forEach((rawRow, i) => {
    const row = i + 1
    if (isInvalidRow(rawRow)) return invalidRow(issues, s, row)
    const r = rawRow as Raw
    if (!bool(r.enabled, true)) return
    const name = line(r.name)
    if (!name) return issues.add(s, '「名称」为空，已跳过', { row, field: 'name' })
    const key = nameKey(name)
    const first = seen.get(key)
    if (first !== undefined) return issues.add(s, `「名称」${name} 和第 ${first} 行重复，已跳过`, { row, field: 'name' })
    seen.set(key, row)
    out.push({
      row,
      name,
      iskPerM3: clampNumber(issues, s, 'ISK/m³', r.iskPerM3, 0, 0, 1e9, { row, field: 'iskPerM3' }),
      collateralPct: clampNumber(issues, s, '押金费率', r.collateralPct, 0, 0, 100, { row, field: 'collateralPct' }),
      maxVolume: clampNumber(issues, s, '单单最大体积', r.maxVolume, 0, 0, 1e9, { row, field: 'maxVolume' }),
      visibility: pick(issues, s, '谁能看到', r.visibility, ['public', 'allowed'] as const, 'allowed', { row, field: 'visibility' }),
    })
  })
  return out
}

function normalizeNotices(raw: Raw, issues: IssueList): NoticeSetting[] {
  const s: ConfigSection = 'notices'
  const out: NoticeSetting[] = []
  tableRows(issues, s, obj(raw.notices).list).forEach((rawRow, i) => {
    const row = i + 1
    if (isInvalidRow(rawRow)) return invalidRow(issues, s, row)
    const r = rawRow as Raw
    if (!bool(r.enabled, true)) return
    const content = line(r.text)
    if (!content) return issues.add(s, '「内容」为空，已跳过', { row, field: 'text' })
    if ([...content].length > NOTICE_MAX_CHARS) return issues.add(s, `「内容」超过 ${NOTICE_MAX_CHARS} 字，已跳过`, { row, field: 'text' })
    if (containsUrl(content)) return issues.add(s, '「内容」里有网址（QQ 群里不允许发网址），已跳过', { row, field: 'text' })
    const untilRaw = line(r.until)
    let until: number | null = null
    if (untilRaw) {
      const parsed = parseBeijingTime(untilRaw)
      if (parsed === undefined) return issues.add(s, `「截止时间」${untilRaw} 看不懂（应该写成 2026-12-31 23:59），已跳过`, { row, field: 'until' })
      until = parsed
    }
    out.push({
      row,
      text: content,
      visibility: pick(issues, s, '谁能看到', r.visibility, ['all', 'allowed'] as const, 'allowed', { row, field: 'visibility' }),
      until,
    })
  })
  return out
}

function normalizeIndustry(raw: Raw, allIssues: IssueList): IndustrySettings {
  const s: ConfigSection = 'industry'
  const ind = obj(raw.industry)
  // 0.1.x 存下的配置里没有这个分组：没写时全部用默认值，不报告
  const issues = isMissing(raw.industry) ? new IssueList() : allIssues
  const sides = ['sell', 'mid', 'buy'] as const

  const meTe = parseMeTeChoices(isMissing(ind.meTeChoices) ? DEFAULT_ME_TE_CHOICES : text(ind.meTeChoices))
  if (meTe.bad.length) issues.add(s, `「ME/TE 选项」里的 ${meTe.bad.join('、')} 看不懂（应该写成 10/20），已忽略`, { field: 'meTeChoices' })
  const meTeChoices = meTe.choices.length ? meTe.choices : parseMeTeChoices(DEFAULT_ME_TE_CHOICES).choices

  const locTable = '工业地点'
  const locations: IndustryLocationSetting[] = []
  const locationKeys = new Map<string, IndustryLocationSetting>()
  // 停用的地点（名称和别名）：它的建筑跟着不生效，不报告
  const disabledKeys = new Set<string>()
  tableRows(issues, s, ind.locations, [], locTable).forEach((rawRow, i) => {
    const row = i + 1
    const at = { table: locTable, row }
    if (isInvalidRow(rawRow)) return invalidRow(issues, s, row, locTable)
    const r = rawRow as Raw
    if (!bool(r.enabled, true)) {
      for (const n of [line(r.name), ...splitList(text(r.aliases))]) if (n) disabledKeys.add(nameKey(n))
      return
    }
    const name = line(r.name)
    if (!name) return issues.add(s, '「名称」为空，已跳过', { ...at, field: 'name' })
    const reserved = reservedReason(name)
    if (reserved) return issues.add(s, `「名称」${name} ${reserved}，已跳过`, { ...at, field: 'name' })
    const key = nameKey(name)
    const same = locationKeys.get(key)
    if (same) return issues.add(s, `「名称」${name} 和第 ${same.row} 行重复，已跳过`, { ...at, field: 'name' })
    const system = line(r.system)
    if (!system) return issues.add(s, `${name} 没有填星系，已跳过`, { ...at, field: 'system' })
    const loc: IndustryLocationSetting = {
      row,
      name,
      aliases: splitList(text(r.aliases)),
      system,
      visibility: pick(issues, s, '谁能看到', r.visibility, ['public', 'allowed'] as const, 'allowed', { ...at, field: 'visibility' }),
      isDefault: bool(r.isDefault, false),
      defaultME: clampNumber(issues, s, '默认 ME', r.defaultME, 10, 0, MAX_ME, { ...at, integer: true, field: 'defaultME' }),
      defaultTE: clampNumber(issues, s, '默认 TE', r.defaultTE, 20, 0, MAX_TE, { ...at, integer: true, field: 'defaultTE' }),
      sysCostBonusPct: clampNumber(issues, s, '星系费用加成', r.sysCostBonusPct, 0, -100, 100, { ...at, field: 'sysCostBonusPct' }),
    }
    locations.push(loc)
    locationKeys.set(key, loc)
  })
  // 地点别名：和其他地点的名称、别名冲突时后一个不生效
  const locOwner = new Map<string, IndustryLocationSetting>()
  for (const loc of locations) locOwner.set(nameKey(loc.name), loc)
  for (const loc of locations) {
    loc.aliases = loc.aliases.filter((alias) => {
      const key = nameKey(alias)
      const other = locOwner.get(key)
      if (other === loc) return false
      if (other || reservedReason(alias)) {
        const why = other ? `和第 ${other.row} 行冲突` : '和命令的参数冲突'
        issues.add(s, `别名「${alias}」${why}，这一行的不生效`, { table: locTable, row: loc.row, field: 'aliases' })
        return false
      }
      locOwner.set(key, loc)
      return true
    })
  }
  const defaultLocations = locations.filter((l) => l.isDefault)
  if (defaultLocations.length > 1) {
    issues.add(s, `勾了多个默认地点，只有第一个（${defaultLocations[0].name}）生效`, { table: locTable, field: 'isDefault' })
    for (const l of defaultLocations.slice(1)) l.isDefault = false
  }

  const stTable = '工业建筑'
  const structures: IndustryStructureSetting[] = []
  tableRows(issues, s, ind.structures, [], stTable).forEach((rawRow, i) => {
    const row = i + 1
    const at = { table: stTable, row }
    if (isInvalidRow(rawRow)) return invalidRow(issues, s, row, stTable)
    const r = rawRow as Raw
    if (!bool(r.enabled, true)) return
    // 地点按名称找，也认地点的别名
    const locName = line(r.location)
    const loc = locOwner.get(nameKey(locName))
    if (!loc && disabledKeys.has(nameKey(locName))) return
    if (!loc) return issues.add(s, `地点「${locName}」不在工业地点表里，已跳过`, { ...at, field: 'location' })
    const name = line(r.name)
    if (!name) return issues.add(s, '「名称」为空，已跳过', { ...at, field: 'name' })
    if (structures.some((x) => x.location === loc.name && nameKey(x.name) === nameKey(name))) {
      return issues.add(s, `${loc.name} 已经有一座叫「${name}」的建筑，已跳过`, { ...at, field: 'name' })
    }
    let structureType = line(r.structureType)
    if (['无', 'none', '-'].includes(nameKey(structureType))) structureType = ''
    let structureId = line(r.structureId)
    if (structureId && !isDigits(structureId)) {
      issues.add(s, '「建筑 ID」不是数字，已忽略', { ...at, field: 'structureId' })
      structureId = ''
    }
    const activity = pick(issues, s, '用途', r.activities, ['manufacturing', 'reaction', 'both'] as const, 'manufacturing', { ...at, field: 'activities' })
    const activities: IndustryActivity[] = activity === 'both' ? ['manufacturing', 'reaction'] : [activity]
    const facilityTaxPct = clampNumber(issues, s, '设施税', r.facilityTaxPct, 0, 0, 100, { ...at, field: 'facilityTaxPct' })
    structures.push({
      row,
      location: loc.name,
      name,
      structureType,
      structureId,
      activities,
      purposes: [...activities],
      rigs: splitList(text(r.rigs)),
      facilityTaxPct,
      taxPct: { manufacturing: facilityTaxPct, reaction: facilityTaxPct, reprocessing: 0 },
      supercapitalShipyard: false,
      extraFeePct: clampNumber(issues, s, '其他费用（%）', r.extraFeePct, 0, 0, 100, { ...at, field: 'extraFeePct' }),
      extraFeeIsk: clampNumber(issues, s, '其他费用（ISK）', r.extraFeeIsk, 0, 0, 1e13, { ...at, field: 'extraFeeIsk' }),
      extraFeeLabel: line(r.extraFeeLabel) || DEFAULT_EXTRA_FEE_LABEL,
      isDefault: bool(r.isDefault, false),
    })
  })
  for (const loc of locations) {
    const marked = structures.filter((x) => x.location === loc.name && x.isDefault)
    if (marked.length > 1) {
      issues.add(s, `${loc.name} 勾了多座默认建筑，只有第一座（${marked[0].name}）生效`, { table: stTable, field: 'isDefault' })
      for (const x of marked.slice(1)) x.isDefault = false
    }
  }

  return {
    materialPriceType: pick(issues, s, '材料价格', ind.materialPriceType, sides, 'sell', { field: 'materialPriceType' }),
    productPriceType: pick(issues, s, '成品价格', ind.productPriceType, sides, 'sell', { field: 'productPriceType' }),
    meTeChoices,
    sccSurchargePct: clampNumber(issues, s, 'SCC 附加费', ind.sccSurchargePct, FORMULA_DEFAULTS.sccSurchargePct, 0, 100, { field: 'sccSurchargePct' }),
    npcFacilityTaxPct: clampNumber(issues, s, 'NPC 空间站设施税', ind.npcFacilityTaxPct, FORMULA_DEFAULTS.npcFacilityTaxPct, 0, 100, { field: 'npcFacilityTaxPct' }),
    sellFeesPct: clampNumber(issues, s, '销售税和经纪费', ind.sellFeesPct, 0, 0, 100, { field: 'sellFeesPct' }),
    multibuyLanguage: pick(issues, s, '多买清单语言', ind.multibuyLanguage, ['en', 'zh'] as const, 'en', { field: 'multibuyLanguage' }),
    locations,
    structures,
    chain: {
      layers: { reaction1: 'build', reaction2: 'build', component: 'build', other: 'buy' },
      alchemy: 'auto',
      reactionLocation: '',
      reprocessLocation: '',
      scrapmetalLevel: DEFAULT_SCRAPMETAL_LEVEL,
    },
  }
}

function normalizeSso(raw: Raw, issues: IssueList): SsoSettings {
  const s: ConfigSection = 'sso'
  const o = obj(raw.sso)
  let callbackUrl = line(o.callbackUrl) || DEFAULT_CALLBACK_URL
  if (!isHttpUrl(callbackUrl)) {
    issues.add(s, `「回调地址」${callbackUrl} 不是 http:// 或 https:// 开头的网址，已改用 ${DEFAULT_CALLBACK_URL}`, { field: 'callbackUrl' })
    callbackUrl = DEFAULT_CALLBACK_URL
  } else if (new URL(callbackUrl).pathname !== SSO_CALLBACK_PATH) {
    issues.add(s, `「回调地址」的路径应该是 ${SSO_CALLBACK_PATH}，现在写的地址授权后回不到插件`, { field: 'callbackUrl' })
  }
  const settings: SsoSettings = {
    clientId: line(o.clientId),
    clientSecret: text(o.clientSecret).trim(),
    callbackUrl,
    adminKey: text(o.adminKey).trim(),
  }
  if (settings.clientId && !settings.clientSecret) issues.add(s, '填了 Client ID，但还没填 Secret Key', { field: 'clientSecret' })
  if (!settings.clientId && settings.clientSecret) issues.add(s, '填了 Secret Key，但还没填 Client ID', { field: 'clientId' })
  return settings
}

function urlField(issues: IssueList, section: ConfigSection, field: string, label: string, value: unknown, fallback: string): string {
  if (isMissing(value)) return fallback
  const url = line(value)
  if (!url) return ''
  if (isHttpUrl(url)) return url
  issues.add(section, `「${label}」不是 http:// 或 https:// 开头的网址，已改用默认地址`, { field })
  return fallback
}

function normalizeRender(raw: Raw, issues: IssueList): RenderSettings {
  const o = obj(raw.render)
  return {
    influenceMapUrl: urlField(issues, 'render', 'influenceMapUrl', '势力图地址', o.influenceMapUrl, DEFAULT_INFLUENCE_MAP_URL),
    coalitionMapUrl: urlField(issues, 'render', 'coalitionMapUrl', '联盟势力图地址', o.coalitionMapUrl, DEFAULT_COALITION_MAP_URL),
    brAuto: bool(o.brAuto, true),
  }
}

/** `a || b`：逐个检查，写错的丢掉并报告；空 = [] */
function urlList(issues: IssueList, field: string, label: string, value: unknown, fallback: string): string[] {
  const source = isMissing(value) ? fallback : text(value)
  const out: string[] = []
  for (const part of source.split('||').map((p) => p.trim()).filter(Boolean)) {
    if (!isHttpUrl(part)) {
      issues.add('advanced', `「${label}」里的「${part}」不是 http:// 或 https:// 开头的网址，已忽略`, { field })
    } else if (!out.includes(part)) {
      out.push(part)
    }
  }
  return out
}

function normalizeAdvanced(raw: Raw, issues: IssueList): AdvancedSettings {
  const o = obj(raw.advanced)
  const contactRaw = line(o.esiContact)
  // 请求头里只能有可打印的 ASCII 字符
  let esiContact = contactRaw.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim()
  if (esiContact !== contactRaw) {
    issues.add('advanced', '「ESI 联系方式」只能用英文字母、数字和常见符号，其他字符已去掉', { field: 'esiContact' })
  }
  if (esiContact.length > 100) esiContact = esiContact.slice(0, 100)
  return {
    manifestUrls: urlList(issues, 'manifestUrl', '物品数据网址', o.manifestUrl, DEFAULT_MANIFEST_URL),
    glossaryUrls: urlList(issues, 'glossaryUrl', '黑话表网址', o.glossaryUrl, DEFAULT_GLOSSARY_URL),
    esiContact,
  }
}

// ------------------------------------------------------------------ 入口

export function normalizeConfig(input: unknown): NormalizedConfig {
  const raw = obj(input)
  const issues = new IssueList()

  const g = obj(raw.general)
  const general = { requireAt: bool(g.requireAt, true), allowSandbox: bool(g.allowSandbox, false), qqWatchdog: bool(g.qqWatchdog, true) }
  const display = normalizeDisplay(raw, issues)
  const access = normalizeAccess(raw, issues)

  const drafts = normalizeMarkets(raw, issues)
  const firstPublic = drafts.find((d) => d.visibility === 'public')
  if (!drafts.length) issues.add('markets', '没有启用的市场，查价用不了')
  else if (!firstPublic) issues.add('markets', '没有启用的公开市场，没有授权的群查不到任何价格')

  const price = obj(raw.price)
  const appraisalRaw = obj(raw.appraisal)
  const ind = obj(raw.industry)
  const industryQuiet = isMissing(raw.industry)
  const marketRefs: Record<MarketRefField, MarketRefSetting> = {
    'price.baseMarket': marketRef(drafts, 'price', 'baseMarket', '基准市场', price.baseMarket, DEFAULT_BASE_MARKET, 'none'),
    'appraisal.defaultMarket': marketRef(drafts, 'appraisal', 'defaultMarket', '默认市场', appraisalRaw.defaultMarket, DEFAULT_BASE_MARKET, 'base'),
    'appraisal.fallbackMarket': marketRef(drafts, 'appraisal', 'fallbackMarket', '回退市场', appraisalRaw.fallbackMarket, '', 'none'),
    'industry.materialMarket': marketRef(drafts, 'industry', 'materialMarket', '材料市场', ind.materialMarket, DEFAULT_BASE_MARKET, 'base', industryQuiet),
    'industry.productMarket': marketRef(drafts, 'industry', 'productMarket', '成品市场', ind.productMarket, DEFAULT_BASE_MARKET, 'base', industryQuiet),
    'industry.fallbackMarket': marketRef(drafts, 'industry', 'fallbackMarket', '回退市场', ind.fallbackMarket, '', 'none', industryQuiet),
  }

  // 默认查价：自动 = 玩家建筑和基准市场列出；没有基准市场（留空或本地还认不出）时列第一个公开市场
  const listedKey = marketRefs['price.baseMarket'].key || firstPublic?.key
  const markets: MarketSetting[] = drafts.map(({ inDefaultListRaw, ...d }) => ({
    ...d,
    inDefaultList: inDefaultListRaw === 'auto' ? d.type === 'structure' || d.key === listedKey : inDefaultListRaw === 'yes',
    autoDefaultList: inDefaultListRaw === 'auto',
  }))
  if (firstPublic && !markets.some((m) => m.visibility === 'public' && m.inDefaultList)) {
    issues.add('markets', '没有任何公开市场列入默认查价：没有授权的群不写市场时查不到价格')
  }
  const restricted = markets.filter((m) => m.visibility === 'allowed')
  if (restricted.length && !restricted.some((m) => m.inDefaultList)) {
    issues.add('markets', '没有任何「只在授权群」的市场列入默认查价：授权群里不写市场时只会看到公开市场')
  }

  const appraisal: AppraisalSettings = {
    defaultPriceType: pick<PriceSide>(issues, 'appraisal', '默认价格', appraisalRaw.defaultPriceType, ['sell', 'mid', 'buy'], 'sell', { field: 'defaultPriceType' }),
  }

  const sso = normalizeSso(raw, issues)
  if (!sso.clientId) {
    for (const m of markets) {
      if (m.type === 'structure' && m.authProfile) {
        issues.add('markets', `「${m.name}」使用的授权档案 ${m.authProfile} 还没有授权（「EVE 授权」里还没填 Client ID）`, { row: m.row, field: 'authProfile' })
      }
    }
  }

  const settings: Settings = {
    general,
    display,
    access,
    markets,
    aliases: normalizeItemAliases(raw, issues),
    marketRefs,
    price: { defaultQuantities: normalizeQuantities(price, issues) },
    appraisal,
    freight: { routes: normalizeFreight(raw, issues) },
    notices: { list: normalizeNotices(raw, issues) },
    industry: normalizeIndustry(raw, issues),
    sso,
    render: normalizeRender(raw, issues),
    advanced: normalizeAdvanced(raw, issues),
    issues: issues.list,
  }
  return { settings, issues: issues.list }
}
