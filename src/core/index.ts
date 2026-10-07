// createEveCore：按端口把 core 的各个模块组装成 EveCore 门面（§3.4、§3.7.3）。bot 和以后的其他入口只依赖它。
// 生命周期：start() 读回 ESI 的暂停窗口 → 读模块级存储、缓存或自带快照 → ready → 后台在线检查；stop() 取消一切。
// 需要数据的配置检查（市场位置、配置里引用的市场、物品别名、默认数量）每次数据更新后重跑，新出现的问题写一次日志。
// EVE 授权（0.0.2）和工业（0.2.0）在那之前是占位：授权档案一律「需要授权」，工业回复 NOT_CONFIGURED。

import { MAX_NOTICES, SSO_SCOPES } from '../constants'
import { createAppraisalService } from './appraisal'
import { createDataService } from './data'
import { createEsi } from './esi'
import { createPriceFormatter } from './format'
import { createItemResolver } from './items'
import type { ManagedItemResolver } from './items'
import { createHistoryService, createMarketRegistry, createMarketService } from './market'
import type { ManagedMarketRegistry } from './market'
import { createQueryParser } from './parse'
import type { CorePorts, Logger } from './ports'
import type {
  Access, AuthProfileStatus, AuthService, ConfigIssue, ConfigSection, CoreFailure, CoreOverrides, CoreStatus, DataService,
  EveCore, IndustryService, ItemIndexStats, Settings,
} from './types'
import { createUniverseService } from './universe'

const NOT_AUTHORIZED_YET = 'EVE 授权在 0.0.2 提供'
const NO_INDUSTRY_YET = '工业计算在 0.2.0 提供'
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
  advanced: '高级',
}

/** 「市场第 6 行「位置」…」「查价：…」 */
export function describeIssue(issue: ConfigIssue): string {
  const label = SECTION_LABELS[issue.section]
  if (issue.row) return `${issue.table ?? label}第 ${issue.row} 行${issue.message}`
  return `${label}${issue.table ? ` · ${issue.table}` : ''}：${issue.message}`
}

// ------------------------------------------------------------------ 占位（0.0.2 授权、0.2.0 工业）

/** 用到授权档案的市场：按档案分组，名字按表格顺序 */
function profileMarkets(settings: Settings): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const m of settings.markets) {
    if (m.type !== 'structure' || !m.authProfile) continue
    out.set(m.authProfile, [...out.get(m.authProfile) ?? [], m.name])
  }
  return out
}

function pendingAuth(settings: Settings): AuthService {
  const profiles = (): AuthProfileStatus[] => [...profileMarkets(settings)].map(([profile, markets]) => ({
    profile,
    status: 'NEEDS_AUTH',
    characterId: '',
    characterName: '',
    scopesGranted: 0,
    scopesRequired: SSO_SCOPES.length,
    tokenValid: false,
    lastRefreshAt: null,
    lastSuccessAt: null,
    lastError: '',
    lastErrorAt: null,
    markets,
  }))
  const notConfigured: CoreFailure = { ok: false, code: 'NOT_CONFIGURED', message: NOT_AUTHORIZED_YET }
  return {
    profiles,
    getAccessToken: async () => ({ ok: false, status: 'NEEDS_AUTH', reason: NOT_AUTHORIZED_YET }),
    beginAuth: () => {
      throw new Error(NOT_AUTHORIZED_YET)
    },
    completeAuth: async () => ({ ok: false, reason: 'not_configured', message: NOT_AUTHORIZED_YET }),
    remove: async () => {},
    searchStructures: async () => notConfigured,
  }
}

function pendingIndustry(): IndustryService {
  const notConfigured: CoreFailure = { ok: false, code: 'NOT_CONFIGURED', message: NO_INDUSTRY_YET }
  return {
    locations: () => [],
    plan: async () => notConfigured,
    compare: async () => notConfigured,
    multibuy: () => [],
  }
}

// ------------------------------------------------------------------ 需要数据的配置检查

interface CheckDeps {
  settings: Settings
  data: Pick<DataService, 'status'>
  items: ManagedItemResolver
  markets: ManagedMarketRegistry
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
  const waiting = new Set(auth.profiles().filter((p) => p.status === 'NEEDS_AUTH').map((p) => p.profile))
  return settings.markets
    .filter((m) => m.type === 'structure' && waiting.has(m.authProfile))
    .map((m) => ({ section: 'markets', row: m.row, field: 'authProfile', message: `「${m.name}」使用的授权档案 ${m.authProfile} 还没有授权` }))
}

class ConfigChecks {
  /** 这次加载里已经写过日志的问题 */
  private readonly logged = new Set<string>()

  constructor(private readonly deps: CheckDeps) {}

  /** 要有数据才能做的检查；数据还没加载好时为空 */
  dataIssues(): ConfigIssue[] {
    const { settings, data, items, markets } = this.deps
    if (!data.status().ready) return []
    return [...markets.issues(), ...items.issues(), ...quantityIssues(settings, items)]
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
  const prices = createMarketService({ registry: markets, esi, clock, scheduler, logger, store })
  const auth = pendingAuth(settings)
  const checks = new ConfigChecks({ settings, data, items, markets, auth, logger })
  const unsubscribe = data.onUpdate(() => checks.recheck())
  let started: Promise<void> | undefined

  return {
    ready: data.ready,
    data,
    items,
    parse: createQueryParser({ items, markets, scheduler }),
    markets,
    prices,
    history: createHistoryService({ esi, clock }),
    appraisal: createAppraisalService({ items, markets, prices, settings, store, clock, scheduler, logger, random: overrides.random }),
    industry: pendingIndustry(),
    universe: createUniverseService({ data, items, store, clock, esi, logger }),
    auth,
    format: createPriceFormatter(settings.display, clock),

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
        issues: checks.all(),
      }
    },

    start(): Promise<void> {
      started ??= esi.client.start().then(() => data.start())
      return started
    },

    async stop(): Promise<void> {
      unsubscribe()
      items.dispose()
      data.stop()
      esi.client.stop()
      await esi.client.flush().catch(() => undefined)
    },
  }
}
