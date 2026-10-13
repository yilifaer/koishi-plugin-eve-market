// core 对外的全部类型。bot 层和以后的其他入口（Discord、Web）只依赖这里和 ports.ts。
// 约定：价格是 number | null（null = 没有，绝不当成 0）；core 返回结构化结果，排版由 bot/view 决定。
// 名字以 Pct 结尾的字段都是百分数（-5 表示 -5%），不是小数。

import type { AuthStatus, CorePorts } from './ports'
import type { JobCostBreakdown } from './industry'

// ------------------------------------------------------------------ 基础

export type TypeId = number
export type PriceSide = 'sell' | 'mid' | 'buy'
/** 物品识别的范围：market 能上市场；industry 有制造蓝图的产品；reaction 反应产物；any 全部（翻译用） */
export type Scope = 'market' | 'industry' | 'reaction' | 'any'
export type Visibility = 'public' | 'allowed'
/** 安全等级分类：≥ 0.45 高安，> 0 低安，≤ 0 00（含虫洞） */
export type SecClass = 'high' | 'low' | 'null'
export type Lang = 'zh' | 'en'

/** 数据表里「没有」的整数值（Int32Array 里不能放 null） */
export const NO_ID = -1

/** 谁在问、在哪里问。可见性（联盟市场、工业地点、运费、告示）只按它判断 */
export interface Access {
  platform: string
  userId: string
  channelId: string
  /** 事件里有 union_openid 时 */
  unionId?: string
  isDirect: boolean
  isAdmin: boolean
  /** 授权群，或单聊里的授权私聊用户/管理员 */
  allowed: boolean
}

export type FailureCode =
  | 'DATA_NOT_READY' | 'ITEM_NOT_FOUND' | 'ITEM_AMBIGUOUS' | 'OUT_OF_SCOPE' | 'UNKNOWN_MARKET'
  | 'NO_HISTORY' | 'STRUCTURE_HISTORY' | 'NOT_MANUFACTURABLE' | 'IS_REACTION' | 'UNKNOWN_LOCATION'
  | 'HIGHSEC_REACTION' | 'UPSTREAM_UNAVAILABLE' | 'MARKET_UNAVAILABLE' | 'TOO_MANY_LINES' | 'BAD_ARGUMENT'
  /** 估价编号过期或不存在 */
  | 'APPRAISAL_EXPIRED'
  /** 需要的配置没填（例如 EVE 授权的 Client ID） */
  | 'NOT_CONFIGURED'

/** BAD_ARGUMENT 的具体原因，bot 按它选提示语 */
export type FailureReason =
  /** 数量不是 1 到 10¹² 之间的整数 */
  | 'quantity'
  | 'me-range'
  | 'te-range'
  /** 批量查价表头里有两个不同的市场 */
  | 'two-markets'
  /** 批量查价表头里的价格调整超出范围 */
  | 'modifier-range'
  /** UPSTREAM_UNAVAILABLE：图片超过大小上限（势力图） */
  | 'too-large'
  /** 工业：流程数超过 MAX_RUNS（N流程，或 *N 换算出来的流程数） */
  | 'runs-range'
  /** 工业：「税:」后面不是 0–100 的数字 */
  | 'tax-range'
  /** 工业：「改装:」后面不是「默认」或「无」 */
  | 'rig-option'
  /** UNKNOWN_LOCATION：地点存在，但不能做这种活动（没有对应的建筑） */
  | 'activity'
  /** UNKNOWN_LOCATION：地点能做这种活动，但建筑的能力造不了这个产品 */
  | 'capability'
  /** 工业：拆到原料的层参数写错（例如「组件:炼金」） */
  | 'chain-option'
  /** 工业：拆到原料涉及的物品超过 CHAIN_MAX_TYPES */
  | 'chain-size'

export interface CoreFailure {
  ok: false
  code: FailureCode
  /** 给日志和管理员看的原因，不直接发给群友 */
  message?: string
  reason?: FailureReason
  resolution?: Resolution
  /** UNKNOWN_MARKET / MARKET_UNAVAILABLE 时：本群可见的市场的 key，按显示顺序 */
  markets?: string[]
  /** UNKNOWN_LOCATION 时：本群可用的工业地点的名称，按表格顺序 */
  locations?: string[]
  /** UNKNOWN_LOCATION / NOT_CONFIGURED 且 reason 是 capability 时：造这个产品需要的建筑服务，例如「旗舰级船坞」 */
  need?: string
  /** MARKET_UNAVAILABLE / UNKNOWN_MARKET 时带上保存好的估价编号 */
  appraisalId?: string
  /** 用户写的、没认出来的那个词（未知市场、未知地点；制造、反应认不出的物品名），原样，回显前要经过 safeEcho */
  token?: string
  /**
   * UNKNOWN_MARKET / UNKNOWN_LOCATION 时：去掉那个词以后剩下的部分，按钮里保留原来的物品和数量。
   * 制造、反应的物品认不出、不唯一、不在范围里时：物品名后面的参数（空，或以「*」、空格开头），候选按钮是「精确名 + rest」
   */
  rest?: string
  /** MARKET_UNAVAILABLE 时：不可用的那个市场的 key（markets 里不含它） */
  marketKey?: string
  /** MARKET_UNAVAILABLE 时：为什么不可用（卡片按它选说法，例如「同步异常」） */
  quoteReason?: QuoteReason
}

export function isFailure(value: unknown): value is CoreFailure {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false
}

// ------------------------------------------------------------------ 配置（normalize 之后）

export type ConfigSection =
  | 'general' | 'display' | 'access' | 'markets' | 'aliases' | 'price' | 'appraisal'
  | 'freight' | 'notices' | 'industry' | 'sso' | 'render' | 'advanced'

/** 配置问题：日志每次加载只写一次，「市场状态」里全部列出 */
export interface ConfigIssue {
  section: ConfigSection
  /** 分组里有几张表格时，是哪一张（例如「授权群」）；不写 = 分组本身 */
  table?: string
  /** 表格的行号，从 1 开始 */
  row?: number
  /** 原始字段名，例如 location */
  field?: string
  /** 中文说明，例如「「位置」不是数字，已跳过」 */
  message: string
}

export type OutputMode = 'markdown' | 'text'
export type NumberStyle = 'code' | 'bold' | 'plain'
export type PriceDisplayMode = 'full_and_compact' | 'full_only' | 'compact_only'
export type ListPriceDisplayMode = 'compact_only' | 'inherit'
export type Clickable = 'buttons' | 'none'
export type MarketType = 'npc-station' | 'system' | 'region' | 'structure'

export interface GeneralSettings {
  requireAt: boolean
  allowSandbox: boolean
  /** 官方机器人连续 10 分钟不在线时自动重启 adapter-qq */
  qqWatchdog: boolean
}

export interface DisplaySettings {
  output: OutputMode
  numberStyle: NumberStyle
  priceDisplayMode: PriceDisplayMode
  listPriceDisplayMode: ListPriceDisplayMode
  /** 0–4 */
  compactDecimals: number
  thousandSeparator: boolean
  showCurrency: boolean
  clickable: Clickable
}

export interface AccessSettings {
  /** 去掉了 `qq:` 前缀；其他平台的 ID 保留前缀（例如 `sandbox:xxx`）。判断时 userId 和 `平台:userId` 都比 */
  admins: string[]
  /** 启用的授权群 ID */
  allowedGroups: string[]
  /** 启用的授权私聊用户 ID（管理员不需要写在这里） */
  allowedUsers: string[]
}

/** 市场表格的一行（已做本地检查；星系、星域、空间站要等数据加载后由 MarketRegistry 解析） */
export interface MarketSetting {
  row: number
  /** 名字规范化后的结果，表内唯一，用作 MarketDef.key（可能含空格和汉字，不要直接当文件名） */
  key: string
  name: string
  /** 手写的别名（不含自动加的星系名） */
  aliases: string[]
  type: MarketType
  /** 空间站 ID / 星系名或 ID / 星域名或 ID / 建筑 ID，原样 */
  location: string
  /** 只用于玩家建筑：所在星系（名字或 ID）；授权档案为空时一定有 */
  system: string
  /**
   * 自动 = 玩家建筑和基准市场列出（没有基准市场时列第一个公开市场）。这里按本地认出的基准市场算；
   * 数据加载后 MarketRegistry 按最终的基准市场再算一次 autoDefaultList 的行
   */
  inDefaultList: boolean
  /** 控制台里「默认查价」选的是自动 */
  autoDefaultList: boolean
  sortOrder: number
  /** auto 已经解析：玩家建筑只在授权群，其他公开 */
  visibility: Visibility
  /** 只用于玩家建筑；空 = 不用授权，从星域订单里读这个建筑的公开订单 */
  authProfile: string
  note: string
}

export interface ItemAliasSetting {
  row: number
  alias: string
  /** 英文名、中文名或 typeID，原样；数据加载后由 ItemResolver 解析 */
  target: string
}

export interface DefaultQuantitySetting {
  row: number
  item: string
  quantity: number
}

/** 配置里引用市场的字段 */
export type MarketRefField =
  | 'price.baseMarket' | 'appraisal.defaultMarket' | 'appraisal.fallbackMarket'
  | 'industry.materialMarket' | 'industry.productMarket' | 'industry.fallbackMarket'

/**
 * 配置里对市场的引用。和用户输入一样按名称、手写别名和自动别名（星系名）匹配；自动别名要等数据，
 * 所以 normalize 只在本地试一次，认不出也不报告。数据加载后和每次数据更新后由 MarketRegistry 重新解析，
 * 那时还认不出才报配置问题，并改用基准市场，再不行用第一个启用的公开市场。运行时一律用 MarketRegistry.configured()。
 */
export interface MarketRefSetting {
  section: ConfigSection
  /** 原始字段名，例如 defaultMarket */
  field: string
  /** 控制台里的名字，例如「默认市场」 */
  label: string
  /** 写的名称或别名，原样；'' = 留空 */
  ref: string
  /** 留空时：none = 不用（不显示差价、不回退），base = 用基准市场 */
  whenEmpty: 'none' | 'base'
  /** 只按名称和手写别名在本地认出的市场；'' = 留空或本地认不出 */
  key: string
  /** 认不出时不报配置问题（控制台里还没有这个分组） */
  quiet?: boolean
}

export interface PriceSettings {
  defaultQuantities: DefaultQuantitySetting[]
}

export interface AppraisalSettings {
  defaultPriceType: PriceSide
}

export interface FreightRoute {
  row: number
  name: string
  iskPerM3: number
  collateralPct: number
  /** 0 = 不限 */
  maxVolume: number
  visibility: Visibility
}

export interface NoticeSetting {
  row: number
  text: string
  visibility: 'all' | 'allowed'
  /** 截止时间（毫秒时间戳）；null = 一直显示 */
  until: number | null
}

export interface IndustryLocationSetting {
  row: number
  name: string
  aliases: string[]
  /** 星系名或 ID，原样 */
  system: string
  visibility: Visibility
  /** 只有一个地点会是 true */
  isDefault: boolean
  defaultME: number
  defaultTE: number
  sysCostBonusPct: number
}

export type IndustryActivity = 'manufacturing' | 'reaction'
/** 建筑的用途：造、反应，或提炼（炼金术） */
export type StructurePurpose = IndustryActivity | 'reprocessing'

export interface IndustryStructureSetting {
  row: number
  /** 所属地点的名字（已确认存在） */
  location: string
  name: string
  /** 建筑类型名或 typeID，原样；'' = 没有建筑加成 */
  structureType: string
  structureId: string
  activities: IndustryActivity[]
  /** 用途含提炼的完整列表；activities 只含造和反应 */
  purposes: StructurePurpose[]
  /** 改装件名称或 typeID，原样 */
  rigs: string[]
  /** 制造税，兼容旧代码；等于 taxPct.manufacturing */
  facilityTaxPct: number
  /** 各活动的税；反应税没填时等于制造税，提炼税没填时为 0 */
  taxPct: { manufacturing: number; reaction: number; reprocessing: number }
  /** 有超旗舰船坞（只在 00 生效） */
  supercapitalShipyard: boolean
  extraFeePct: number
  extraFeeIsk: number
  extraFeeLabel: string
  /** 每个地点最多一个 true；都没勾时用这个地点第一座建筑 */
  isDefault: boolean
}

export interface IndustrySettings {
  materialPriceType: PriceSide
  productPriceType: PriceSide
  meTeChoices: Array<{ me: number; te: number }>
  sccSurchargePct: number
  npcFacilityTaxPct: number
  sellFeesPct: number
  multibuyLanguage: Lang
  locations: IndustryLocationSetting[]
  structures: IndustryStructureSetting[]
  /** 拆到原料的默认设置 */
  chain: {
    layers: Record<ChainLayer, LayerMode>
    alchemy: AlchemyMode
    reactionLocation: string
    reprocessLocation: string
    scrapmetalLevel: number
  }
}

export interface SsoSettings {
  clientId: string
  clientSecret: string
  callbackUrl: string
  adminKey: string
}

export interface RenderSettings {
  influenceMapUrl: string
  coalitionMapUrl: string
  brAuto: boolean
}

export interface AdvancedSettings {
  /** 按顺序尝试；空数组 = 只用插件自带的数据 */
  manifestUrls: string[]
  glossaryUrls: string[]
  /** 只含可打印 ASCII，写进 User-Agent */
  esiContact: string
}

export interface Settings {
  general: GeneralSettings
  display: DisplaySettings
  access: AccessSettings
  /** 只含启用、有效的行，按表格顺序 */
  markets: MarketSetting[]
  aliases: ItemAliasSetting[]
  marketRefs: Record<MarketRefField, MarketRefSetting>
  price: PriceSettings
  appraisal: AppraisalSettings
  freight: { routes: FreightRoute[] }
  notices: { list: NoticeSetting[] }
  industry: IndustrySettings
  sso: SsoSettings
  render: RenderSettings
  advanced: AdvancedSettings
  /** 本地检查发现的问题；需要数据的检查由 core 在数据加载后补充 */
  issues: ConfigIssue[]
}

// ------------------------------------------------------------------ 数据（eve-cn-slang 的 official/data）

export type DataOrigin = 'online' | 'cache' | 'bundled'

export interface DataManifest {
  schema: number
  dataRevision: number
  buildNumber: number
  sdeReleaseDate: string
  generatedAt: string
  files: Record<string, { sha256: string; bytes: number; rows: number }>
  /** 插件快照里才有：eve-cn-slang 的来源提交 */
  sourceCommit?: string
}

export interface ItemInfo {
  typeId: TypeId
  en: string
  /** 可能是 ''（约 317 种没有中文名） */
  zh: string
  groupId: number
  categoryId: number
  marketGroupId: number | null
  metaGroupId: number | null
  techLevel: number | null
  volume: number
  /** 已经按 packagedVolume ?? volume 填好 */
  packagedVolume: number
  portionSize: number
  capacity: number | null
  variationParent: TypeId | null
}

/** types.json 的物品表，按列存放，行按 typeId 升序；整数列里的 NO_ID 表示空 */
export interface TypeTable {
  readonly size: number
  readonly id: Int32Array
  readonly group: Int32Array
  /** 由分组推出 */
  readonly category: Int32Array
  readonly marketGroup: Int32Array
  readonly metaGroup: Int32Array
  readonly techLevel: Int32Array
  readonly volume: Float64Array
  /** 已经按 packagedVolume ?? volume 填好 */
  readonly packagedVolume: Float64Array
  readonly portionSize: Int32Array
  readonly variationParent: Int32Array
  /** NaN = 空 */
  readonly capacity: Float64Array
  readonly en: readonly string[]
  /** '' = 没有中文名 */
  readonly zh: readonly string[]
  /** 拼音列原文：「全拼 首字母」成对出现，空格分隔；'' = 没有 */
  readonly py: readonly string[]
  /** 找不到返回 -1 */
  rowOf(id: TypeId): number
  item(row: number): ItemInfo
}

export interface GroupInfo { id: number; categoryId: number; en: string; zh: string; published: boolean }
export interface CategoryInfo { id: number; en: string; zh: string; published: boolean }
export interface MarketGroupInfo { id: number; parentId: number | null; en: string; zh: string }
export interface MetaGroupInfo { id: number; en: string; zh: string }

/** 数据里的活动代码：m 制造、r 反应、i 发明、c 拷贝、rm 材料研究、rt 时间研究 */
export type ActivityCode = 'm' | 'r' | 'i' | 'c' | 'rm' | 'rt'

export interface BlueprintActivity {
  blueprintId: TypeId
  activity: 'm' | 'r' | 'i'
  /** 秒 */
  time: number
  /** SDE 的 maxProductionLimit */
  maxRuns: number
  products: Array<{ typeId: TypeId; quantity: number; probability?: number }>
  materials: Array<{ typeId: TypeId; quantity: number }>
}

export interface BonusSet { me?: number; te?: number; cost?: number }

export interface StructureTypeInfo {
  id: TypeId
  en: string
  zh: string
  group: number
  rigSize: number
  /** false = 不能放在高安（Sotiyo、Keepstar） */
  highsec: boolean
  /** 系数，例如 Raitaru 制造 { me: 0.99, te: 0.85, cost: 0.97 }；没有的活动不加成 */
  bonus: Partial<Record<ActivityCode, BonusSet>>
}

export interface RigInfo {
  id: TypeId
  en: string
  zh: string
  group: number
  size: number
  /** 百分比，和 SDE 一样，例如 { me: -2.0, te: -20.0 } */
  bonus: BonusSet
  /** 安全等级倍率；null = 这个安全等级不生效 */
  sec: { h: number | null; l: number | null; n: number | null }
  /** filter 为 null = 对这个活动的所有产品生效；pct 是这一条自己的百分比（Thukker 改装件对不同产品不一样） */
  effects: Array<{ activity: ActivityCode; kind: 'me' | 'te' | 'cost'; filter: number | null; pct: number }>
  thukkerMe?: number
}

export interface TargetFilter { id: number; name: string; categories: number[]; groups: number[] }

export interface IndustryData {
  blueprints: BlueprintActivity[]
  /** 蓝图 ID → 各活动 */
  byBlueprint: Map<TypeId, Partial<Record<'m' | 'r' | 'i', BlueprintActivity>>>
  /** 产品 → 制造蓝图 */
  manufacturing: Map<TypeId, BlueprintActivity>
  /** 产物 → 反应配方 */
  reactions: Map<TypeId, BlueprintActivity>
  structures: Map<TypeId, StructureTypeInfo>
  rigs: Map<TypeId, RigInfo>
  filters: Map<number, TargetFilter>
  /** 建筑服务表；数据里没有这张表时为 null */
  services: ServiceInfo[] | null
  /** 提炼表（炼金术用）；数据里没有这张表时为 null */
  reprocessing: Map<TypeId, ReprocessInfo> | null
}

/** 建筑服务：activity m 制造、r 反应、rp 提炼 */
export interface ServiceInfo {
  id: TypeId
  key: string | null
  en: string
  zh: string
  activity: 'm' | 'r' | 'rp'
  groups: number[]
  categories: number[]
  fitGroups: number[]
  fitTypes: TypeId[]
  sec: { h: boolean; l: boolean; n: boolean }
}

export interface ReprocessInfo {
  id: TypeId
  portion: number
  skill: TypeId | null
  materials: Array<{ typeId: TypeId; quantity: number }>
  /** 推导出来的：反应产物那一个产出；其余是副产品 */
  main: TypeId | null
}

export interface RegionInfo { id: number; en: string; zh: string }
export interface ConstellationInfo { id: number; regionId: number; en: string; zh: string }
/** zh 为 '' 时（代号星系）显示英文名 */
export interface SystemInfo { id: number; constellationId: number; regionId: number; security: number; en: string; zh: string }
export interface StationInfo { id: number; systemId: number }
export interface FactionInfo { id: number; en: string; zh: string }

export interface UniverseData {
  regions: Map<number, RegionInfo>
  constellations: Map<number, ConstellationInfo>
  systems: Map<number, SystemInfo>
  stations: Map<number, StationInfo>
  factions: Map<number, FactionInfo>
  /** 无向星门图：星系 → 相邻星系 */
  jumps: Map<number, number[]>
}

/** 不可变：数据更新时整份替换 */
export interface DataSet {
  /** 版本标识（三个文件的 sha256 合起来），相同就说明是同一份数据 */
  readonly key: string
  readonly manifest: DataManifest
  readonly origin: DataOrigin
  readonly loadedAt: number
  readonly types: TypeTable
  readonly groups: Map<number, GroupInfo>
  readonly categories: Map<number, CategoryInfo>
  readonly marketGroups: Map<number, MarketGroupInfo>
  readonly metaGroups: Map<number, MetaGroupInfo>
  readonly industry: IndustryData
  readonly universe: UniverseData
}

/** glossary.yaml 的一条 */
export interface GlossaryEntry {
  en: string
  zh: string
  mode: string
  dir: string
  enAliases: string[]
  zhAliases: string[]
  category: string
  note: string
}

export interface GlossaryData {
  readonly key: string
  readonly origin: DataOrigin
  readonly loadedAt: number
  readonly entries: readonly GlossaryEntry[]
}

export interface DataStatus {
  ready: boolean
  origin: DataOrigin | null
  buildNumber: number | null
  dataRevision: number | null
  sdeReleaseDate: string | null
  generatedAt: string | null
  /** 距上次在线确认是最新（lastConfirmedAt）几天，从来没确认过时按 generatedAt 算；超过 DATA_STALE_WARN_DAYS 时「市场状态」提醒 */
  ageDays: number | null
  lastCheckAt: number | null
  /** 最近一次在线确认是最新（304 或下载成功） */
  lastConfirmedAt: number | null
  /** 最近一次在线检查失败的原因（成功后清空） */
  lastError: string
  glossary: {
    origin: DataOrigin | null
    entries: number
    lastConfirmedAt: number | null
    lastError: string
  }
}

export interface RefreshResult {
  /** 数据有没有换成新版本 */
  changed: boolean
  glossaryChanged: boolean
  /** 在线检查成功（包括 304） */
  checked: boolean
  error?: string
}

export interface DataService {
  /** ready 之前调用会抛错 */
  current(): DataSet
  glossary(): GlossaryData | null
  status(): DataStatus
  refresh(): Promise<RefreshResult>
  /** 数据或黑话表换了版本时调用（重新解析配置里需要数据的部分） */
  onUpdate(listener: (data: DataSet, glossary: GlossaryData | null) => void): () => void
}

// ------------------------------------------------------------------ 物品识别

export type MatchTier = 'id' | 'exact' | 'alias' | 'prefix' | 'contains' | 'pinyin' | 'near' | 'remote'

export interface ImplantSet {
  name: { en: string; zh: string }
  grade: 'high' | 'mid' | 'low'
  /** 阿尔法到欧米伽，6 件 */
  items: ItemInfo[]
}

export type Resolution =
  /** via：命中的写法，用于「按「X」查询」 */
  | { kind: 'unique'; item: ItemInfo; tier: MatchTier; via?: string }
  | { kind: 'set'; set: ImplantSet }
  /** 黑话里的组名：总是列候选 */
  | { kind: 'group'; groupName: string; candidates: ItemInfo[]; total: number }
  | { kind: 'ambiguous'; tier: MatchTier; candidates: ItemInfo[]; total: number }
  /** 必须确认，哪怕只有 1 个 */
  | { kind: 'confirm'; tier: 'contains' | 'pinyin' | 'near'; candidates: ItemInfo[]; total: number }
  | { kind: 'out-of-scope'; item: ItemInfo; scope: Scope }
  | { kind: 'none'; suggestions: ItemInfo[] }
  /** 不带等级的套装名（「水晶」「crystal set」）：各等级的套装，总是让用户选 */
  | { kind: 'sets'; sets: ImplantSet[] }

export interface RelatedItems {
  variants: ItemInfo[]
  blueprint?: ItemInfo
  product?: ItemInfo
  containing: ItemInfo[]
  /** 涂装只给数量 */
  skins: number
}

export interface ItemSearchResult {
  /** 关键词精确或别名唯一命中时只有这一项（调用方列 related），items 为空 */
  exact?: ItemInfo
  /** 这一页：前缀、包含、拼音各档合在一起，按物品排序规则排，同一物品只出现一次 */
  items: ItemInfo[]
  total: number
  /** 没有列出的涂装个数（关键词里有「涂装」或 skin 时涂装照常列出，这里是 0） */
  skins: number
}

export interface ItemIndexStats {
  items: number
  marketItems: number
  adminAliases: number
  glossaryAliases: number
  sets: number
}

export interface ItemResolver {
  resolve(query: string, opts: { scope: Scope; limit?: number }): Resolution
  /** resolve 返回 none 且查询像完整名字时调用：ESI 精确名兜底，结果缓存 7 天 */
  resolveRemote(query: string): Promise<ItemInfo | null>
  /** 批量估价逐行用：0–2 档和唯一前缀接受（前缀带 approx 标记），其余返回未识别和一个建议；notTradable = 名字对得上但不能上市场 */
  resolveLine(name: string): { item: ItemInfo; approx: boolean } | { unresolved: true; suggestion?: ItemInfo; candidates?: ItemInfo[]; notTradable?: ItemInfo; total: number }
  /** 「搜索」：按名字列出全部匹配，分页 */
  search(query: string, opts: { scope: Scope; offset: number; limit: number }): ItemSearchResult
  byId(id: TypeId): ItemInfo | undefined
  related(id: TypeId): RelatedItems
  aliasesOf(id: TypeId): string[]
  /** 'Raven / 乌鸦级' 或单语 */
  displayName(item: ItemInfo, lang?: Lang): string
  /** 中文名唯一时用中文名，否则英文名，再不行 #typeId */
  commandName(item: ItemInfo): string
  stats(): ItemIndexStats
}

// ------------------------------------------------------------------ 市场

export interface MarketDef {
  key: string
  name: string
  /** 手写别名 + 自动加的星系中英文名 */
  aliases: string[]
  /** 生成按钮命令时用的最短写法 */
  shortAlias: string
  type: MarketType
  regionId: number | null
  systemId?: number
  /** 空间站或建筑 ID */
  locationId?: number
  inDefaultList: boolean
  sortOrder: number
  visibility: Visibility
  authProfile?: string
}

export interface MarketSplit {
  market?: MarketDef
  /** 去掉市场名以后的部分 */
  rest: string
  /** 两种解释都精确命中时，整句当物品的那种（「查所有市场」按钮用） */
  alt?: string
  /** 满足「未知市场」结构规则时，用户写的那个词 */
  unknown?: string
}

export interface MarketRegistry {
  visible(access: Access): MarketDef[]
  /** 查价不写市场时用 */
  defaults(access: Access): MarketDef[]
  /** 看不到的市场返回 null（和不存在一样） */
  match(token: string, access: Access): MarketDef | null
  /** 从查询开头切出市场名，多词名字和别名最长匹配，冲突和「未知市场」按结构规则判断 */
  split(text: string, access: Access, items: ItemResolver, scope: Scope): MarketSplit
  get(key: string): MarketDef | undefined
  /** price.baseMarket；留空时 undefined（不显示差价，需要一个默认市场时用第一个启用的公开市场） */
  base(): MarketDef | undefined
  /**
   * 配置里引用的市场（见 MarketRefSetting）。给了 access 并且本群看不到这个市场时，悄悄改用基准市场；
   * 留空的回退市场返回 undefined
   */
  configured(field: MarketRefField, access?: Access): MarketDef | undefined
}

export interface Side {
  best: number
  volumeAtBest: number
  orders: number
  totalVolume: number
}

export type QuoteStatus = 'ok' | 'stale' | 'unavailable' | 'auth_error' | 'not_ready' | 'timeout'

/** status 不是 ok 时具体是哪种情况，卡片按它选说法 */
export type QuoteReason =
  /** NPC 市场：ESI 出错，用的是 60 分钟内的缓存（stale） */
  | 'cache'
  /** NPC 市场：ESI 出错，没有能用的缓存（unavailable） */
  | 'esi_error'
  /** 建筑市场：同步出错；stale = 有 60 分钟内的旧数据，unavailable = 更旧 */
  | 'sync_error'
  /** 建筑市场：暂停后恢复同步，没等到新数据，用的是旧数据（stale） */
  | 'refreshing'
  /** 建筑市场：首次同步还没完成（not_ready） */
  | 'first_sync'
  /** 建筑市场：暂停超过 24 小时，正在重新同步（not_ready） */
  | 'resyncing'
  /** 建筑市场：授权或停靠权限异常（auth_error） */
  | 'auth'
  /** 建筑市场：还没授权或没填 Client ID（not_ready；群里的说法和 auth 一样） */
  | 'needs_auth'

export interface PriceQuote {
  marketKey: string
  typeId: TypeId
  /** 一侧没有就是 null */
  sell: Side | null
  buy: Side | null
  /** 同一个市场两侧都有才算 */
  mid: number | null
  status: QuoteStatus
  reason?: QuoteReason
  /** 出错发生在 EVE 时间 11:00–11:30（DT 维护） */
  downtime?: boolean
  /** ESI Last-Modified，或建筑同步完成时间 */
  dataTime: number | null
  ageSec: number | null
  source: 'region' | 'structure' | 'global'
  /** 给管理员看的原因 */
  detail?: string
}

export interface MarketAvailability {
  status: QuoteStatus
  reason?: QuoteReason
}

/** 建筑市场：OK / NEEDS_AUTH / DEGRADED / AUTH_ERROR 加上首次同步中；NPC 市场只有 OK 和 DEGRADED */
export type MarketSourceState = AuthStatus | 'FIRST_SYNC'

export interface SafeErrorInfo {
  route?: string
  status?: number
  code?: string
  message: string
}

export interface MarketSourceStatus {
  marketKey: string
  name: string
  type: MarketType
  source: 'region' | 'structure'
  state: MarketSourceState
  /** 24 小时没人查，同步已暂停 */
  paused: boolean
  authProfile?: string
  /** NPC 市场：最近一次请求 */
  lastRequestAt: number | null
  /** 建筑市场：最近一次同步完成 */
  lastSyncAt: number | null
  lastSuccessAt: number | null
  lastError: SafeErrorInfo | null
  lastErrorAt: number | null
  pages: number | null
  orders: number | null
}

export interface MarketService {
  /** lane：background = 比较用的附加报价，走 ESI 的后台通道，不占交互请求的位置（默认 interactive） */
  getQuote(marketKey: string, typeId: TypeId, opts?: { qty?: number; deadlineMs?: number; lane?: 'interactive' | 'background' }): Promise<PriceQuote>
  getQuotes(marketKey: string, items: Array<{ typeId: TypeId; qty: number }>, opts?: { deadlineMs?: number; lane?: 'interactive' | 'background' }): Promise<Map<TypeId, PriceQuote>>
  /** 每个市场：状态、上次成功、上次错误、订单条数、页数 */
  sources(): MarketSourceStatus[]
  /** 只重新同步已过期或出错的建筑市场 */
  resync(marketKey?: string): Promise<void>
  /** 有人查了建筑市场：恢复暂停的同步；数据太旧时最多等 waitMs */
  touch(marketKey: string, waitMs?: number): Promise<void>
  /** 整个市场能不能用（估价、工业定价前先查） */
  available(marketKey: string): MarketAvailability
}

export interface HistoryPoint {
  /** YYYY-MM-DD（UTC 日） */
  date: string
  average: number
  highest: number
  lowest: number
  volume: number
  orderCount: number
  /** 当天的成交额（ISK）：各件的 volume × average 之和（套装）；不写 = volume × average */
  turnover?: number
}

export interface HistoryResult {
  points: HistoryPoint[]
  /** 取不到历史的物品（套装缺件） */
  missing: TypeId[]
  lastModified: number | null
  /** ESI 出错，用的是 24 小时内的旧数据（卡片写「N 分钟前（缓存）」） */
  stale: boolean
  /** 出错发生在 EVE 时间 11:00–11:30（DT 维护） */
  downtime?: boolean
}

export interface HistoryService {
  /** 多个物品时按日期对齐后相加（套装） */
  get(regionId: number, typeIds: TypeId[], days: number): Promise<HistoryResult | CoreFailure>
}

// ------------------------------------------------------------------ 批量估价

export interface PasteHeader {
  /** 市场的写法，原样；本群看不到或不存在的词也放在这里，由 appraise 回复「未知市场」 */
  market?: string
  side?: PriceSide
  modifierPct?: number
  /** #K7Q2：用保存的清单重算 */
  appraisalId?: string
  /** 「全部」：长清单的完整明细 */
  all?: boolean
  /** 「从81」：完整清单从第 81 项接着列（带上它就是「全部」） */
  from?: number
  /** 行号=#typeID：替换某一行未识别的物品 */
  replace?: Record<number, TypeId>
}

export interface PasteLine {
  lineNo: number
  raw: string
  /** 按可能性从高到低；appraise 用 ItemResolver 选一个 */
  hypotheses: Array<{ name: string; quantity: number }>
  /** EFT 装配里的行：属于 fittings 里的第几个 */
  fitting?: number
  /** hull = 表头里的船；module = 不带数量的行；cargo = `名称 xN`（无人机、弹药、货柜里的东西，分组由 appraise 按物品大类定） */
  role?: 'hull' | 'module' | 'cargo'
  /** `模块, 弹药` 里的弹药名：数量要等两者都识别出来后按模块容量 ÷ 弹药体积算 */
  loadedCharge?: string
  /** 去掉了行尾的 [n] 的突变装备，按基础型号估价 */
  mutated?: boolean
}

export interface PasteParse {
  header: PasteHeader
  format: 'lines' | 'eft' | 'industry-window'
  fittings: Array<{ ship: string; name: string }>
  lines: PasteLine[]
  /** quantity：写了乘号或数量列，但不是 1 到 10¹² 之间的整数（Raven*0.5），回复「数量要是正整数」 */
  skipped: Array<{ lineNo: number; raw: string; reason: 'empty' | 'header' | 'slot' | 'mutaplasmid' | 'bpc' | 'quantity' }>
  /** 超过 MAX_LINES 被忽略的行数 */
  truncated: number
}

export interface AppraisalRow {
  item: ItemInfo
  quantity: number
  /** 唯一前缀命中，显示时加 ≈ */
  approx: boolean
  /** 名称跟着输入的语言走（第一次出现的那一行） */
  lang: Lang
  sourceLines: number[]
  unit: number | null
  adjustedUnit: number | null
  total: number | null
  packagedM3: number
  status: QuoteStatus
  /** 用了回退市场，必须明确标出（†） */
  fallback?: { marketKey: string; side: PriceSide }
  /** 装配估价的分类小计 */
  group: 'hull' | 'module' | 'drone-charge' | 'other'
}

export interface AppraisalResult {
  /** 短编号，例如 K7Q2 */
  id: string
  market: MarketDef
  side: PriceSide
  modifierPct: number
  /** 粘贴顺序 */
  rows: AppraisalRow[]
  /** notTradable：名字对得上，但这个物品不能在市场上交易 */
  unresolved: Array<{ lineNo: number; raw: string; suggestion?: ItemInfo; candidates?: ItemInfo[]; notTradable?: ItemInfo; total: number }>
  noPrice: Array<{ item: ItemInfo; reason: 'no-orders' | 'timeout' | 'market-unavailable' }>
  skipped: PasteParse['skipped']
  truncated: number
  totals: { market: number; adjusted: number; packagedM3: number; pricedTypes: number; units: number; missing: number }
  /** 只在估价市场是基准市场时有，最多 2 条 */
  freight: Array<{ route: string; fee: number; contracts: number; landed: number }>
  /** 基准市场没有出售价、没算进押金的物品种数 */
  freightMissing: number
  /** 只用 1 秒内拿得到的基准报价；拿不全就没有 */
  vsBase?: { marketKey: string; side: PriceSide; total: number; diffPct: number }
  fitting?: {
    ship: ItemInfo
    name: string
    /** 满装弹药：每个模块装多少发、几个模块 */
    loadedCharges?: Array<{ charge: ItemInfo; modules: number; perModule: number }>
  }
  /** 按基础型号估价的突变装备件数 */
  mutated: number
  dataTime: number | null
}

/** 不写的项用 PasteParse.header 里的，再不写用配置的默认值 */
export interface AppraiseOptions {
  /** 市场的写法，原样，按 access 匹配；看不到或不存在 → UNKNOWN_MARKET（带估价编号） */
  market?: string
  side?: PriceSide
  modifierPct?: number
  access: Access
}

/**
 * 估价编号由这里保存（ModuleStore 里，APPRAISAL_ID_HOURS 小时、最多 APPRAISAL_ID_MAX 份，LRU），
 * bot 层的待办只有编号回复和批量清单两种。
 */
export interface AppraisalService {
  /** 表头里两个不同的市场、调整超出范围 → BAD_ARGUMENT（reason 说明是哪种） */
  parse(text: string, access: Access): PasteParse | CoreFailure
  appraise(input: PasteParse, opts: AppraiseOptions): Promise<AppraisalResult | CoreFailure>
  /** replace：行号 → typeId，替换某一行未识别的物品；all：长清单的完整明细 */
  reprice(id: string, opts: AppraiseOptions & { replace?: Record<number, TypeId>; all?: boolean }): Promise<AppraisalResult | CoreFailure>
}

// ------------------------------------------------------------------ 工业

export interface IndustryRequest {
  typeId: TypeId
  activity: IndustryActivity
  /** *N 是产品数量；N流程 是流程数 */
  quantity?: number
  runs?: number
  mode: 'base' | 'advanced' | 'steps'
  materials: boolean
  /** 地点的写法（名称或别名），原样，按 access 匹配；看不到或不存在 → UNKNOWN_LOCATION */
  location?: string
  structure?: string | 'none' | '?'
  rigs?: 'default' | 'none'
  me?: number
  te?: number
  facilityTaxPct?: number
  /** 拆到原料：命令里写的层设置（layers 只有写了的层），没写的用控制台默认；undefined = 不是拆到原料；details = 「明细」 */
  chain?: Partial<ChainOptions> & { on: true, details?: boolean }
  /** 命令里的 ME 或 TE 后面没写数字：回到 ME/TE 这一步并提醒（只对制造） */
  meteMissing?: 'me' | 'te'
  access: Access
}

export interface IndustryResult {
  product: ItemInfo
  blueprint: ItemInfo
  runs: number
  /** 每个工作的流程数（T2 超过单张拷贝上限时拆成多个） */
  jobs: number[]
  outputQuantity: number
  applied: {
    location?: string
    systemId?: number
    secClass?: SecClass
    structure?: string
    /** 已乘安等倍率的百分比 */
    rigs: Array<{ item: ItemInfo; me: number; te: number; cost: number }>
    me: number
    te: number
    /** 建筑自带的加成（百分比，负数 = 减少）；没有建筑或没有这项加成时不给 */
    structureBonus?: { me: number; te: number; cost: number }
    sci?: number
    facilityTaxPct?: number
    sccPct?: number
    defaulted: Array<'location' | 'me' | 'te' | 'structure' | 'rigs' | 'tax'>
    /** 自动选中的建筑是这个地点唯一能做这种活动的一座 */
    structureOnly?: boolean
    /** 建筑是自动挑的：在这么多座能做的里选了最合适的 */
    autoPicked?: { among: number }
    /** 改装件的情况（有地点时给，见 IndustryRigState） */
    rigState?: IndustryRigState
  }
  materials: Array<{ item: ItemInfo; baseQuantity: number; quantity: number; unit: number | null; total: number | null; manufacturable: boolean; fallback?: boolean }>
  materialCost: number
  missingPrices: number
  jobCost?: { eiv: number; grossSci: number; bonuses: number; facility: number; scc: number; extra: number; extraLabel?: string; total: number; missingAdjusted: number }
  timeSeconds: number
  timeSecondsMaxSkill?: number
  productValue?: { marketKey: string; side: PriceSide; unit: number | null; total: number | null; fallback?: boolean }
  profit?: { value: number; marginPct: number } | null
  formulaRevision: string
  warnings: string[]
  /** 材料按哪个市场、哪种价格算（配置的市场）；整个市场不可用时 unavailable；用到的回退市场是 fallbackKey（行上标 fallback） */
  materialPrices?: { marketKey: string; side: PriceSide; unavailable?: boolean; fallbackKey?: string }
  /** 计入的报价里最旧的数据时间 */
  pricesAt?: number | null
  /** 星系成本指数的数据时间（ESI 的 Last-Modified）；没有算安装费时不给 */
  indicesAt?: number | null
  /** 星系成本指数是更新失败前的旧数据（卡片上标「缓存」） */
  indicesStale?: boolean
  /** 调整价的数据时间；没有算安装费时不给 */
  adjustedPricesAt?: number | null
  /** 调整价是更新失败前的旧数据 */
  adjustedStale?: boolean
}

/**
 * 改装件的情况：applied 有生效的；disabled 命令里写了「改装:无」；not-installed 没装（装的尺寸不对、已经在配置检查里去掉的也算）；
 * not-applicable 装了但对这个产品不生效（或在这个安全等级不生效）；impossible 没有建筑加成（「建筑:无」、NPC 空间站），装不了
 */
export type IndustryRigState = 'applied' | 'disabled' | 'not-installed' | 'not-applicable' | 'impossible'

export interface IndustryStep {
  /** 选「6 步」时加 'rigs' | 'tax'，'mete' 拆成 'me' | 'te' */
  step: 'location' | 'mete' | 'structure'
  /** command：命令名后面的参数（例如「乌鸦级 XX-1 高级」），命令名由 bot 渲染时加上；button：按钮上的字（不给时用 label） */
  options: Array<{ label: string; detail?: string; command: string; button?: string; recommended?: boolean; cost?: number }>
  summary: string[]
  /** 「其余默认」：不再逐步问、直接出结果的参数；没有默认地点时不给 */
  defaults?: string
  /** 第 2 步「自定义」：填进输入框、用户在末尾补数字的参数（以「ME」结尾）；编号待办的 ME7、TE14 接在去掉末尾「ME」的那段后面 */
  custom?: string
  /** 这一步要先说明的事（例如写的建筑在这个地点找不到） */
  notice?: string
  /** 这一步的补充说明 */
  note?: string
}

export interface LocationComparison {
  product: ItemInfo
  runs: number
  me: number
  te: number
  /** 按总成本排序 */
  rows: Array<{
    location: string; structure?: string; noRigs: boolean; result: IndustryResult; cheapest: boolean; fastest: boolean
    /** 建筑是自动挑的：在 among 座能做的里选了最合适的 */
    autoPicked?: boolean; among?: number
  }>
  materialMarketKey: string
  materialSide: PriceSide
  /** 命令里写了「改装:无」：各地点都不用改装件 */
  rigsOff?: boolean
  /** 命令里写的设施税：各地点都按它算 */
  facilityTaxPct?: number
  /** 按产品筛过地点：造不了这个产品的地点数和缺什么（例如「旗舰级船坞」） */
  unable?: { count: number; need: string }
  /** 命令里写了拆到原料的参数词：比价不拆到原料，卡片上提示一句 */
  chainIgnored?: boolean
}

export interface IndustryLocationInfo {
  name: string
  isDefault: boolean
}

export interface IndustryService {
  /** 本群能用的工业地点，按表格顺序；给了 activity 时只列能做这种活动的（帮助、「快速计算」「制造比价」按钮用） */
  locations(access: Access, activity?: IndustryActivity): IndustryLocationInfo[]
  /** 本群能用、并且造得了这个产品的工业地点（「快速计算」按钮用）；数据没有服务表时同 locations */
  locationsFor(access: Access, activity: IndustryActivity, typeId: TypeId): IndustryLocationInfo[]
  /** steps 模式缺参数时返回下一步 */
  plan(req: IndustryRequest): Promise<IndustryResult | IndustryStep | CoreFailure>
  compare(req: Omit<IndustryRequest, 'location' | 'structure' | 'mode'>): Promise<LocationComparison | CoreFailure>
  /** 拆到原料：缺参数时返回下一步（IndustryStep），和 plan 一样 */
  chain(req: ChainRequest): Promise<ChainResult | IndustryStep | CoreFailure>
  /** 按长度切好的纯文本块 */
  multibuy(result: IndustryResult): string[]
}

// 拆到原料

/** 层：低级反应、高级反应、组件、其他 */
export type ChainLayer = 'reaction1' | 'reaction2' | 'component' | 'other'
export type LayerMode = 'build' | 'buy'
export type AlchemyMode = 'auto' | 'normal' | 'alchemy'
export interface ChainOptions { layers: Record<ChainLayer, LayerMode>; alchemy: AlchemyMode }
/** 命令里写的；没写的用控制台默认 */
export interface ChainRequest extends IndustryRequest { chain: NonNullable<IndustryRequest['chain']> }
export interface ChainNode {
  item: ItemInfo; layer: ChainLayer | 'product'; activity: IndustryActivity
  /** surplus = output - demand（整批） */
  demand: number; runs: number; output: number; surplus: number
  location: string; structure: string | null; autoPicked: boolean; fallbackLocation?: boolean
  me: number; te: number; inputs: Array<{ typeId: TypeId; quantity: number }>
  /** 输入按市场价，加上本节点的安装费和税 */
  jobCost: JobCostBreakdown | null; buildCost: number | null
  /** demand x 市场单价（同一层「直接买」约数） */
  buyCost: number | null
  timeSeconds: number; timeSecondsMaxSkill: number
  route?: 'normal' | 'alchemy'; alchemy?: AlchemyDetail
}
export interface AlchemyDetail {
  unrefined: ItemInfo; units: number; runs: number; yieldPct: number; perUnit: number
  byproducts: Array<{ typeId: TypeId; quantity: number }>; reprocessTax: number | null; reprocessAt?: string
  /** 另一条路线 */
  other: { route: 'normal' | 'alchemy'; cost: number | null; timeSeconds: number }
}
export interface ChainLeaf {
  item: ItemInfo; quantity: number; offset: number; unit: number | null; total: number | null
  fallback?: boolean; kind: 'raw' | 'bought' | 'unbuildable'
  /** 能造、但因为这一层选了买才买的：它属于哪一层（「继续拆」只改这些层） */
  layer?: ChainLayer
}
export interface ChainResult {
  product: ItemInfo; runs: number; outputQuantity: number; location?: string; options: ChainOptions
  /** 地点的安全等级（基础模式没有地点就没有） */
  secClass?: SecClass
  /** T2 成品：发明成本没有计入 */
  inventionExcluded: boolean
  /** 材料按哪个市场、哪一侧的价格 */
  materialPrices?: IndustryResult['materialPrices']
  /** 拓扑顺序；按 layer 分组展示 */
  nodes: ChainNode[]
  layers: Array<{ layer: ChainLayer | 'product'; mode: LayerMode; used: boolean; build: number | null; buy: number | null; timeSeconds: number; where?: string }>
  leaves: ChainLeaf[]; surplusByproducts: Array<{ item: ItemInfo; quantity: number }>
  totals: { leaves: number; jobs: number; reprocessTax: number; total: number; missingPrices: number }
  productValue?: IndustryResult['productValue']; profit?: IndustryResult['profit']
  warnings: string[]; pricesAt?: number | null; indicesAt?: number | null; formulaRevision: string
}

// ------------------------------------------------------------------ 金额格式（core 里唯一的金额格式化）

export interface PriceFormatOptions {
  mode: PriceDisplayMode
  compactDecimals: number
  thousandSeparator: boolean
  showCurrency: boolean
  /** 完整价格一律取整（工业费用明细，不写 .00） */
  integer?: boolean
}

/** 版式（代码/粗体/括号）由 view 决定 */
export interface FormattedPrice {
  na: boolean
  full?: string
  compact?: string
}

export interface PriceFormatter {
  /** null → { na: true } */
  isk(v: number | null, o?: Partial<PriceFormatOptions>): FormattedPrice
  /** 1.25K / 1.25M / 1.25B / 1.25T；< 1000 时 5.40 */
  compact(v: number): string
  quantity(n: number, compact?: boolean): string
  /** p 是百分数：4.5 → 4.5% */
  percent(p: number, signed?: boolean): string
  volume(m3: number): string
  /** 1 小时 23 分 / 3 天 4 小时 */
  duration(sec: number): string
  /** 按配置时区：今天 HH:MM，否则 MM/DD HH:MM */
  clock(ms: number): string
}

// ------------------------------------------------------------------ 宇宙：入侵、服务器状态、翻译

export interface NamePair { id: number; en: string; zh: string }

export interface Incursion {
  constellation: NamePair
  region: NamePair | null
  staging: (NamePair & { security: number }) | null
  /** 按集结星系的安全等级 */
  secClass: SecClass
  state: 'established' | 'mobilizing' | 'withdrawing'
  /** 0–1（显示时乘 100 再交给 percent） */
  influence: number
  hasBoss: boolean
  faction: NamePair | null
  /** 集结星系在前，其余按 ESI 的顺序。数据里没有的星系（staging 同样）：en 是 ID 本身、zh 为空、security 是 NaN */
  systems: Array<NamePair & { security: number }>
}

export interface IncursionsResult {
  /** 高安 → 低安 → 00 */
  incursions: Incursion[]
  dataTime: number | null
  /** 用的是出错前的缓存 */
  stale: boolean
}

export interface ServerStatus {
  players: number
  serverVersion: string
  startTime: number
  vip: boolean
  dataTime: number | null
  /** 已经运行了多久（秒）：现在 − startTime */
  uptimeSec: number
  /** 下一次例行维护开始的时间（每天 EVE 时间 11:00） */
  nextDowntime: number
  /** 请求失败，用的是几分钟内的缓存（维护时间里不会这样） */
  stale: boolean
}

export type TranslateKind = 'item' | 'group' | 'category' | 'system' | 'constellation' | 'region' | 'slang'

export interface TranslateEntry {
  kind: TranslateKind
  id: number | null
  zh: string
  en: string
  item?: ItemInfo
  group?: { zh: string; en: string }
  category?: { zh: string; en: string }
  region?: { zh: string; en: string }
  security?: number
  slang?: { category: string; note: string }
  /** 物品的别名（后台别名 + 黑话表） */
  aliases: string[]
}

export interface TranslateResult {
  entries: TranslateEntry[]
  total: number
}

export interface SystemView {
  id: number
  en: string
  zh: string
  security: number
  secClass: SecClass
  constellation: NamePair | null
  region: NamePair | null
}

export interface UniverseService {
  incursions(): Promise<IncursionsResult | CoreFailure>
  /** 请求失败或 503 → UPSTREAM_UNAVAILABLE */
  serverStatus(): Promise<ServerStatus | CoreFailure>
  translate(q: string, limit: number): TranslateResult
  system(id: number): SystemView | undefined
}

// ------------------------------------------------------------------ 势力图（§2.10）

export type InfluenceMapKind = 'influence' | 'coalition'

/** 交给机器人的图片只有这两种（MIME 都按文件头判断） */
export type ImageMime = 'image/png' | 'image/jpeg'

export interface InfluenceMap {
  kind: InfluenceMapKind
  /** 下载到的图片原样（不转码） */
  body: Buffer
  /** 按文件头判断，不信响应头 */
  mime: ImageMime
  /** 图片更新时间：来源的 Last-Modified，没有时是第一次下载到这张图的时间 */
  updatedAt: number
  /** 最近一次下载或确认没变的时间 */
  checkedAt: number
  /** 最近一次更新失败（来源暂时访问不了），发的是旧图 */
  stale: boolean
}

export interface InfluenceMapService {
  /**
   * 控制台里地址留空 → NOT_CONFIGURED；下载失败又没有旧图 → UPSTREAM_UNAVAILABLE（图片超过大小上限时 reason 是 too-large）。
   * 有缓存时很快返回（过期了最多等 2 秒新图）；没有缓存时要等下载（最多 30 秒）
   */
  get(kind: InfluenceMapKind): Promise<InfluenceMap | CoreFailure>
  /** 本地已经有这张图（没有时第一次要现下载，bot 按它决定要不要准备慢提示） */
  cached(kind: InfluenceMapKind): boolean
}

// ------------------------------------------------------------------ EVE 授权（服务角色）

export interface AuthProfileStatus {
  profile: string
  status: AuthStatus
  characterId: string
  characterName: string
  /** 需要的权限里拿到了几项 */
  scopesGranted: number
  scopesRequired: number
  /** 内存里有没过期的 access token */
  tokenValid: boolean
  lastRefreshAt: number | null
  lastSuccessAt: number | null
  lastError: string
  lastErrorAt: number | null
  /** 用这个档案的市场名 */
  markets: string[]
}

export type TokenResult =
  | { ok: true; token: string; characterId: string }
  | { ok: false; status: AuthStatus; reason: string }

export interface StructureProbe {
  marketKey: string
  marketName: string
  structureId: string
  access: 'ok' | 'forbidden' | 'not_found' | 'error'
  structureName?: string
  systemId?: number
}

export type AuthCompletion =
  | { ok: true; profile: string; characterId: string; characterName: string; structures: StructureProbe[] }
  | {
    ok: false
    /** exchange_failed：应用本身的问题（Client ID、Secret Key）；code_rejected：授权码失效；unavailable：连不上 EVE；save_failed：没能写进数据库 */
    reason: 'bad_state' | 'exchange_failed' | 'missing_scopes' | 'not_configured' | 'code_rejected' | 'unavailable' | 'save_failed'
    message: string
  }

export interface StructureSearchHit {
  id: string
  name: string
  systemId: number | null
}

export interface AuthService {
  /** 内存里的状态（启动时从 AuthStore 读入） */
  profiles(): AuthProfileStatus[]
  /** 剩不到 60 秒时先刷新；同一个档案同时只刷新一次 */
  getAccessToken(profile: string): Promise<TokenResult>
  /** 没填 Client ID 时抛错（管理页先检查配置再调用） */
  beginAuth(profile: string): { url: string; state: string }
  completeAuth(code: string, state: string): Promise<AuthCompletion>
  remove(profile: string): Promise<void>
  searchStructures(profile: string, text: string): Promise<StructureSearchHit[] | CoreFailure>
}

// ------------------------------------------------------------------ 命令参数

export interface QueryOptions {
  scope: Scope
  access: Access
  /** 开头可以写市场（查价、走势、搜索） */
  market?: boolean
  /** 识别不到、但像完整名字时试 ESI 精确名兜底（查价、走势） */
  remote?: boolean
}

export interface ParsedQuery {
  /** 开头写了本群可见的市场 */
  market?: MarketDef
  /** 去掉市场和数量以后的物品名 */
  name: string
  /** 没写数量时 null */
  quantity: number | null
  resolution: Resolution
  /** 「开头是市场」和「整句是物品」都唯一精确命中时，整句当物品的结果（「查所有市场」按钮） */
  alt?: ItemInfo
}

/**
 * 命令后面的文字 → 结构化参数。顺序：切市场 → 切数量 → 识别物品；数量的几种切法由识别结果决定
 * （先整句当名字，不行再试末尾乘号、开头数量、末尾数字），所以要在 core 里做。
 * 命令自己的尾巴（走势的「月」、搜索的「第2页」）由 bot 先去掉。
 */
export interface QueryParser {
  /** 未知市场 → UNKNOWN_MARKET（token、rest、markets）；数量写错 → BAD_ARGUMENT（reason: quantity） */
  query(text: string, opts: QueryOptions): Promise<ParsedQuery | CoreFailure>
  /** 制造、反应的参数；地点认不出 → UNKNOWN_LOCATION（token、rest、locations），ME/TE 超出范围 → BAD_ARGUMENT */
  industryArgs(text: string, activity: IndustryActivity, access: Access): IndustryRequest | CoreFailure
}

// ------------------------------------------------------------------ 状态与门面

export interface EsiGroupStatus {
  group: string
  limit: number | null
  remaining: number | null
  pausedUntil: number | null
}

export interface EsiStatus {
  groups: EsiGroupStatus[]
  errorLimitRemain: number | null
  errorLimitResetAt: number | null
  /** 收到 420 后全部暂停到这个时间 */
  pausedUntil: number | null
}

/** 「市场状态」：数据版本、ESI 配额、各市场、授权档案、配置问题 */
export interface CoreStatus {
  at: number
  ready: boolean
  data: DataStatus
  items: ItemIndexStats
  markets: MarketSourceStatus[]
  auth: AuthProfileStatus[]
  esi: EsiStatus
  /** 星系成本指数和调整价的更新时间（配了工业地点时才有） */
  industry?: { indicesAt: number | null; adjustedPricesAt: number | null }
  /** 本地检查和需要数据的检查合在一起 */
  issues: ConfigIssue[]
}

export interface EveCore {
  /** 首次数据加载完成（快照或缓存），授权档案也从数据库读好了 */
  readonly ready: Promise<void>
  data: DataService
  items: ItemResolver
  parse: QueryParser
  markets: MarketRegistry
  prices: MarketService
  history: HistoryService
  appraisal: AppraisalService
  industry: IndustryService
  universe: UniverseService
  auth: AuthService
  format: PriceFormatter
  /** 势力图、联盟势力图 */
  maps: InfluenceMapService
  /** 查价告示：启用、没过期、本群能看的前 MAX_NOTICES 条 */
  notices(access: Access): string[]
  status(): CoreStatus
  start(): Promise<void>
  stop(): Promise<void>
}

/** 测试用：把 ESI、SSO 指到假服务，固定随机数 */
export interface CoreOverrides {
  esiBase?: string
  ssoBase?: string
  compatibilityDate?: string
  random?: () => number
}

export type CreateEveCore = (ports: CorePorts, settings: Settings, overrides?: CoreOverrides) => EveCore
