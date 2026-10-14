// createEveCore：按端口把 core 的各个模块组装成 EveCore 门面（§3.4、§3.7.3）。bot 和以后的其他入口只依赖它。
// 生命周期：start() 读回 ESI 的暂停窗口 → 读模块级存储、缓存或自带快照 → ready → 后台在线检查；stop() 取消一切。
// 需要数据的配置检查（市场位置、配置里引用的市场、物品别名、默认数量）每次数据更新后重跑，新出现的问题写一次日志。
// EVE 授权档案在 start() 时同时从数据库读入（ready 也等它）；数据和档案都好了以后从缓存恢复建筑市场的订单簿、排上后台同步。
// 工业：地点和建筑的配置问题和别的配置问题一起报；配了工业地点时，星系成本指数和调整价在数据加载后排上后台预取，
// 「市场状态」也列出它们的更新时间（没配地点时用不到这两份数据：基础参考不算安装费用）。

import { MAX_NOTICES } from '../constants'
import { createAppraisalService } from './appraisal'
import { createDataService } from './data'
import { createEsi } from './esi'
import { createPriceFormatter } from './format'
import { createIndustryIndices, createIndustryLocations, createIndustryService } from './industry'
import type { IndustryLocations } from './industry'
import { createKillService } from './killmail'
import { createItemResolver } from './items'
import type { ManagedItemResolver } from './items'
import { createHistoryService, createMarketRegistry, createMarketService, createStructureMarkets } from './market'
import type { ManagedMarketRegistry } from './market'
import { createIndustryArgs, createQueryParser } from './parse'
import type { CorePorts, Logger } from './ports'
import { createAuthService } from './sso'
import type {
  Access, AuthService, ConfigIssue, ConfigSection, CoreOverrides, CoreStatus, DataService, DataSet, EveCore, ItemIndexStats, Settings,
} from './types'
import { createIncursions, createInfluenceMaps, createServerStatus, createUniverseService } from './universe'
import { ZkillClient } from './zkill'

const EMPTY_STATS: ItemIndexStats = { items: 0, marketItems: 0, adminAliases: 0, glossaryAliases: 0, sets: 0 }

/** 日志里的分组名（和控制台一致） */
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
  screenshot: '截图',
  advanced: '高级',
}

/** 「市场第 6 行「位置」…」「查价：…」 */
export function describeIssue(issue: ConfigIssue): string {
  const label = SECTION_LABELS[issue.section]
  if (issue.row) return `${issue.table ?? label}第 ${issue.row} 行${issue.message}`
  return `${label}${issue.table ? ` · ${issue.table}` : ''}：${issue.message}`
}

// ------------------------------------------------------------------ 需要数据的配置检查

interface CheckDeps {
  settings: Settings
  data: Pick<DataService, 'status' | 'current'>
  items: ManagedItemResolver
  markets: ManagedMarketRegistry
  industry: Pick<IndustryLocations, 'issues'>
  auth: Pick<AuthService, 'profiles'>
  logger: Logger
}

/** 默认数量表里的物品要能唯一认出（编号、官方名或别名），否则这一行不生效 */
function quantityIssues(settings: Settings, items: ManagedItemResolver): ConfigIssue[] {
  return settings.price.defaultQuantities.flatMap((q): ConfigIssue[] => {
    const res = items.resolve(q.item, { scope: 'market' })
    if (res.kind === 'unique' && res.tier !== 'prefix') return []
    const why = res.kind === 'none' ? '找不到对应的物品'
      : res.kind === 'out-of-scope' ? '不能在市场上交易'
        : res.kind === 'ambiguous' ? '对应多个物品，请改写成 #typeID'
          : '不是一个确定的物品，请写完整的名字或 #typeID'
    return [{ section: 'price', table: '默认数量', row: q.row, field: 'item', message: `「物品」${q.item} ${why}，这一行不生效` }]
  })
}

/**
 * 用了还没授权的档案的建筑市场（§2.2.7：群里的说法和授权异常一样，这里写清楚原因）。
 * 还没填 Client ID 时 normalize 已经报过同一行，这里不重复
 */
function authIssues(settings: Settings, auth: Pick<AuthService, 'profiles'>): ConfigIssue[] {
  if (!settings.sso.clientId) return []
  // 还没授权时 lastError 是空的；密钥变了、读不出档案这些情况写明原因
  const waiting = new Map(auth.profiles().filter((p) => p.status === 'NEEDS_AUTH').map((p) => [p.profile, p.lastError]))
  return settings.markets
    .filter((m) => m.type === 'structure' && waiting.has(m.authProfile))
    .map((m) => {
      const reason = waiting.get(m.authProfile)
      const message = reason ? `「${m.name}」使用的授权档案 ${m.authProfile} 不能用：${reason}` : `「${m.name}」使用的授权档案 ${m.authProfile} 还没有授权`
      return { section: 'markets', row: m.row, field: 'authProfile', message }
    })
}

/** 数据里缺新表、或提炼有专用技能的物品（炼金术不算） */
function industryDataIssues(data: DataSet): ConfigIssue[] {
  const { services, reprocessing } = data.industry
  const issue = (message: string): ConfigIssue => ({ section: 'industry', message })
  if (!services || !reprocessing) return [issue('数据较旧：地点不按产品筛选、炼金术不可用')]
  return [...reprocessing.values()].filter((r) => r.skill !== null).map((r) => {
    const row = data.types.rowOf(r.id)
    const name = row < 0 ? `#${r.id}` : data.types.zh[row] || data.types.en[row]
    return issue(`${name} 有专用提炼技能，炼金术不计算这一种`)
  })
}

class ConfigChecks {
  /** 这次加载里已经写过日志的问题 */
  private readonly logged = new Set<string>()

  constructor(private readonly deps: CheckDeps) {}

  /** 要有数据才能做的检查；数据还没加载好时为空 */
  dataIssues(): ConfigIssue[] {
    const { settings, data, items, markets, industry } = this.deps
    if (!data.status().ready) return []
    return [...markets.issues(), ...items.issues(), ...quantityIssues(settings, items), ...industry.issues(), ...industryDataIssues(this.deps.data.current())]
  }

  all(): ConfigIssue[] {
    return [...this.deps.settings.issues, ...this.dataIssues(), ...authIssues(this.deps.settings, this.deps.auth)]
  }

  /** 数据加载或更新后：新出现的问题写一次日志 */
  recheck() {
    for (const issue of this.dataIssues()) {
      const text = describeIssue(issue)
      if (this.logged.has(text)) continue
      this.logged.add(text)
      this.deps.logger.warn('配置问题：%s', text)
    }
  }
}

// ------------------------------------------------------------------ 组装

export function createEveCore(ports: CorePorts, settings: Settings, overrides: CoreOverrides = {}): EveCore {
  const { clock, scheduler, logger, store, cache } = ports
  const esi = createEsi(ports, {
    base: overrides.esiBase,
    compatibilityDate: overrides.compatibilityDate,
    contact: settings.advanced.esiContact,
    random: overrides.random,
  })
  const data = createDataService(ports, {
    manifestUrls: settings.advanced.manifestUrls,
    glossaryUrls: settings.advanced.glossaryUrls,
    random: overrides.random,
  })
  const items = createItemResolver({ data, store, aliases: settings.aliases, remote: { esi, cache, clock, logger }, logger })
  const markets = createMarketRegistry(settings, data)
  const auth = createAuthService({ ports, settings, esi, ssoBase: overrides.ssoBase })
  const structures = createStructureMarkets({ esi, auth, registry: markets, cache, clock, scheduler, logger, store, random: overrides.random })
  const prices = createMarketService({ registry: markets, esi, clock, scheduler, logger, store, structures })
  const locations = createIndustryLocations(settings.industry, data)
  const industryUsed = settings.industry.locations.length > 0
  const indices = createIndustryIndices({ esi, clock, scheduler, logger, store, random: overrides.random })
  const industry = createIndustryService({
    data, items, markets, prices, locations, indices, settings: settings.industry, clock, scheduler, logger,
  })
  const checks = new ConfigChecks({ settings, data, items, markets, industry: locations, auth, logger })
  const maps = createInfluenceMaps({
    http: ports.http,
    cache,
    clock,
    scheduler,
    logger,
    urls: { influence: settings.render.influenceMapUrl, coalition: settings.render.coalitionMapUrl },
    version: ports.version,
    random: overrides.random,
  })
  const universe = createUniverseService({
    data, items, store, clock, esi, logger,
    incursions: createIncursions({ esi, data, clock, logger }),
    status: createServerStatus({ esi, clock, logger }),
  })
  const zkill = new ZkillClient(ports, { base: overrides.zkillBase, userAgent: esi.client.userAgent })
  const unsubscribe = data.onUpdate(() => checks.recheck())
  let started: Promise<void> | undefined
  // ready 等数据和授权档案都读好：刚启动时还没读到的档案不会被当成「需要授权」
  let authLoaded!: () => void
  const ready = Promise.all([data.ready, new Promise<void>((resolve) => { authLoaded = resolve })]).then(() => undefined)

  return {
    ready,
    data,
    items,
    parse: createQueryParser({ items, markets, scheduler, industry: createIndustryArgs({ items, locations }) }),
    markets,
    prices,
    history: createHistoryService({ esi, clock }),
    appraisal: createAppraisalService({ items, markets, prices, settings, store, clock, scheduler, logger, random: overrides.random }),
    industry,
    universe,
    auth,
    format: createPriceFormatter(settings.display, clock),
    maps,
    kills: createKillService({ zkill, esi, items, universe, clock, scheduler, logger }),

    notices(access: Access): string[] {
      const now = clock.now()
      return settings.notices.list
        .filter((n) => (n.until === null || n.until > now) && (n.visibility === 'all' || access.allowed))
        .slice(0, MAX_NOTICES)
        .map((n) => n.text)
    },

    status(): CoreStatus {
      const dataStatus = data.status()
      return {
        at: clock.now(),
        ready: dataStatus.ready,
        data: dataStatus,
        items: dataStatus.ready ? items.stats() : EMPTY_STATS,
        markets: prices.sources(),
        auth: auth.profiles(),
        esi: esi.client.status(),
        ...(industryUsed ? { industry: indices.status() } : {}),
        issues: checks.all(),
      }
    },

    start(): Promise<void> {
      // 势力图先读本地缓存，过一会儿再预取，不和数据加载抢
      maps.start()
      started ??= Promise.all([
        esi.client.start().then(() => data.start()).then(() => { if (industryUsed) indices.start() }),
        auth.start().finally(authLoaded),
      ]).then(() => structures.start())
      return started
    },

    async stop(): Promise<void> {
      unsubscribe()
      maps.stop()
      zkill.stop()
      indices.stop()
      structures.stop()
      auth.stop()
      items.dispose()
      data.stop()
      esi.client.stop()
      await Promise.all([structures.flush(), esi.client.flush()]).catch(() => undefined)
    },
  }
}
