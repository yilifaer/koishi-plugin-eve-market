import { Schema } from 'koishi'
import { FORMULA_DEFAULTS } from '../core/industry'
import type {
  Clickable, JaniceWho, KbScope, Lang, ListPriceDisplayMode, MarketType, NumberStyle, OutputMode, PriceDisplayMode, PriceSide, Visibility,
} from '../core/types'
import { INVALID_ROW_KEY } from './normalize'
import {
  DEFAULT_BASE_MARKET, DEFAULT_CALLBACK_URL, DEFAULT_COALITION_MAP_URL, DEFAULT_EXTRA_FEE_LABEL, DEFAULT_GLOSSARY_URL,
  DEFAULT_INFLUENCE_MAP_URL, DEFAULT_MANIFEST_URL, DEFAULT_ME_TE_CHOICES, DEFAULT_QUANTITIES, PRESET_MARKETS,
} from './presets'

// Schema 校验失败会让整个插件加载失败，所以每个字段只做宽松的声明并加 .loose()（类型不对时回到默认值），
// 具体检查放到 normalize.ts。表格的每一行整体 loose：类型、启用这类选项写错时整行变成 INVALID_ROW，
// 由 normalize 标成无效并跳过，只影响这一行。
// 「工业」分组 0.0.4 加入；之前存下的配置里没有这个分组，按默认值处理。

export interface GroupRow { groupId: string; note: string; enabled: boolean }
export interface UserRow { userId: string; note: string; enabled: boolean }

export interface MarketRow {
  name: string
  aliases: string
  type: MarketType
  location: string
  system: string
  enabled: boolean
  inDefaultList: 'auto' | 'yes' | 'no'
  sortOrder: number
  visibility: 'auto' | 'public' | 'allowed'
  authProfile: string
  note: string
}

export interface AliasRow { alias: string; target: string; enabled: boolean; note: string }
export interface QuantityRow { item: string; quantity: number }

export interface FreightRow {
  name: string
  iskPerM3: number
  collateralPct: number
  maxVolume: number
  visibility: 'public' | 'allowed'
  enabled: boolean
  note: string
}

export interface KbHiddenRow { characterId: string; note: string; enabled: boolean }
export interface NoticeRow { text: string; visibility: 'all' | 'allowed'; until: string; enabled: boolean }

export interface IndustryLocationRow {
  name: string
  aliases: string
  system: string
  visibility: Visibility
  isDefault: boolean
  defaultME: number
  defaultTE: number
  sysCostBonusPct: number
  enabled: boolean
  note: string
}

export interface IndustryStructureRow {
  location: string
  name: string
  structureType: string
  structureId: string
  activities: 'manufacturing' | 'reaction' | 'both' | 'reprocessing' | 'reaction-reprocessing' | 'manufacturing-reprocessing' | 'all'
  rigs: string
  /** 制造税 % */
  facilityTaxPct: number
  /** 反应税 %；没填时运行时是 undefined */
  reactionTaxPct: number
  /** 提炼税 %；同上 */
  reprocessingTaxPct: number
  supercapitalShipyard: boolean
  extraFeePct: number
  extraFeeIsk: number
  extraFeeLabel: string
  isDefault: boolean
  enabled: boolean
  note: string
}

export interface IndustryConfig {
  materialMarket: string
  materialPriceType: PriceSide
  productMarket: string
  productPriceType: PriceSide
  fallbackMarket: string
  meTeChoices: string
  sccSurchargePct: number
  npcFacilityTaxPct: number
  sellFeesPct: number
  multibuyLanguage: Lang
  chainReaction1: 'build' | 'buy'
  chainReaction2: 'build' | 'buy'
  chainComponents: 'build' | 'buy'
  chainOther: 'build' | 'buy'
  chainAlchemy: 'auto' | 'normal' | 'alchemy'
  chainReactionLocation: string
  reprocessLocation: string
  scrapmetalLevel: number
  locations: IndustryLocationRow[]
  structures: IndustryStructureRow[]
}

export interface ShotSiteConfig { enabled: boolean; auto: boolean; maxImages: number }
export interface ShotCustomRow { name: string; host: string; pathPrefix: string; auto: boolean; maxImages: number }

export interface Config {
  general: { requireAt: boolean; allowSandbox: boolean; qqWatchdog: boolean }
  display: {
    output: OutputMode
    numberStyle: NumberStyle
    priceDisplayMode: PriceDisplayMode
    listPriceDisplayMode: ListPriceDisplayMode
    compactDecimals: number
    thousandSeparator: boolean
    showCurrency: boolean
    clickable: Clickable
  }
  access: { admins: string[]; allowedGroups: GroupRow[]; allowedUsers: UserRow[] }
  markets: MarketRow[]
  aliases: AliasRow[]
  price: { baseMarket: string; defaultQuantities: QuantityRow[] }
  appraisal: { defaultMarket: string; defaultPriceType: PriceSide; fallbackMarket: string }
  freight: { routes: FreightRow[] }
  notices: { list: NoticeRow[] }
  industry: IndustryConfig
  sso: { clientId: string; clientSecret: string; callbackUrl: string; adminKey: string }
  render: { influenceMapUrl: string; coalitionMapUrl: string; brAuto: boolean }
  screenshot: {
    killAuto: boolean
    br: ShotSiteConfig
    warbeacon: ShotSiteConfig
    janice: ShotSiteConfig
    dotlan: ShotSiteConfig
    custom: ShotCustomRow[]
  }
  janice: { apiKey: string; who: JaniceWho }
  kb: { scope: KbScope; recent: boolean; auto: boolean; hidden: KbHiddenRow[] }
  advanced: { manifestUrl: string; glossaryUrl: string; esiContact: string }
}

const str = (value = '') => Schema.string().default(value).loose()
const num = (value: number) => Schema.number().default(value).loose()
const bool = (value: boolean) => Schema.boolean().default(value).loose()
const secret = () => Schema.string().role('secret').default('').loose()
// 表格的行里不加 loose：写错时让整行失败
const strictBool = (value: boolean) => Schema.boolean().default(value)

function choice<T extends string>(options: Array<[T, string]>) {
  return Schema.union(options.map(([value, label]) => Schema.const(value).description(label)))
}

const INVALID_ROW = { [INVALID_ROW_KEY]: true }

function table<T>(row: Schema<any, T>, fallback: T[] = []) {
  return Schema.array(row.default(INVALID_ROW as T).loose()).role('table').default(fallback).loose()
}

const shotSite = (max: number) => Schema.object({
  enabled: bool(true).description('启用'),
  auto: bool(true).description('自动截图'),
  maxImages: num(max).description('最多几张（1–3）'),
}).default({} as ShotSiteConfig).loose()

const priceSide = () => choice<PriceSide>([['sell', '出售价'], ['mid', '中间价'], ['buy', '收购价']])

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    general: Schema.object({
      requireAt: bool(true)
        .description('群里只处理 @机器人 的消息（私聊不受影响）。群主打开「接收群内全部消息」后，这个开关可以避免和群里其他机器人重复回复。'),
      allowSandbox: bool(false)
        .description('测试用：也在 Koishi 控制台的「沙盒」里回复（纯文字版本），测完关掉。插件只在 QQ 官方机器人上回复，不会在 LLBot 上回复。'),
      qqWatchdog: bool(true)
        .description('官方机器人连续 10 分钟不在线时，自动重启 adapter-qq（和在控制台停用再启用一样），两次至少隔 30 分钟。断网恢复后 adapter-qq 有时一直报「AccessToken无效或过期」，重启就好。'),
    }).default({} as Config['general']).loose(),
  }).description('基本'),

  Schema.object({
    display: Schema.object({
      output: choice<OutputMode>([['markdown', 'Markdown 卡片'], ['text', '纯文字']]).default('markdown').loose()
        .description('QQ 上用 Markdown 卡片，被拒绝时自动改发纯文字；选「纯文字」则一律发纯文字。'),
      numberStyle: choice<NumberStyle>([['code', '灰底等宽'], ['bold', '加粗'], ['plain', '普通']]).default('code').loose()
        .description('完整价格在卡片里的样式。'),
      priceDisplayMode: choice<PriceDisplayMode>([
        ['full_and_compact', '875,700,000 ISK（875.70M）'],
        ['full_only', '875,700,000 ISK'],
        ['compact_only', '875.70M'],
      ]).default('full_and_compact').loose()
        .description('主要金额的写法：查价的单价和合计，批量查价的合计和运费，工业的成本、费用和利润。'),
      listPriceDisplayMode: choice<ListPriceDisplayMode>([['compact_only', '只用简写'], ['inherit', '和上一项相同']]).default('compact_only').loose()
        .description('清单里每一行的价格（批量查价、材料、比价、套装、搜索）。只用简写时消息不会太长。'),
      compactDecimals: num(2)
        .description('简写（例如 875.70M）保留几位小数，0–4。'),
      thousandSeparator: bool(true)
        .description('完整价格加千位分隔符。'),
      showCurrency: bool(true)
        .description('完整价格后面带「ISK」。'),
      clickable: choice<Clickable>([['buttons', '带按钮'], ['none', '不带']]).default('buttons').loose()
        .description('消息下面带可以点的按钮；选「不带」时只写编号和完整命令。按钮出问题时可以临时改成「不带」。'),
    }).default({} as Config['display']).loose(),
  }).description('显示'),

  Schema.object({
    access: Schema.object({
      admins: Schema.array(str()).default([]).loose()
        .description('管理员的用户 ID。在群里或私聊里 @机器人 发「本群ID」可以看到，前面写不写 `qq:` 都行。群里和私聊的 ID、不同群里的 ID 可能不同，建议填私聊里的。管理员可以用「市场状态」「市场授权」「样式自检」。'),
      allowedGroups: table(Schema.object({
        groupId: str().description('群 ID'),
        note: str().description('备注'),
        enabled: strictBool(true).description('启用'),
      }))
        .description('授权群：能看到「只在授权群」的市场、运费和告示。群 ID 用「本群ID」查看。注意：重新创建 QQ 机器人以后群 ID 会变。'),
      allowedUsers: table(Schema.object({
        userId: str().description('用户 ID'),
        note: str().description('备注'),
        enabled: strictBool(true).description('启用'),
      }))
        .description('私聊时按授权群对待的用户（管理员自动算在内）。'),
    }).default({} as Config['access']).loose(),
  }).description('权限'),

  Schema.object({
    markets: table(Schema.object({
      name: str().description('名称'),
      aliases: str().description('别名'),
      type: choice<MarketType>([
        ['npc-station', 'NPC 空间站'],
        ['system', '整个星系'],
        ['region', '整个星域'],
        ['structure', '玩家建筑'],
      ]).default('npc-station').description('类型'),
      location: str().description('位置'),
      system: str().description('建筑所在星系'),
      enabled: strictBool(true).description('启用'),
      inDefaultList: choice<MarketRow['inDefaultList']>([['auto', '自动'], ['yes', '列出'], ['no', '不列']]).default('auto').description('默认查价'),
      sortOrder: num(0).description('排序'),
      visibility: choice<MarketRow['visibility']>([['auto', '自动'], ['public', '所有群'], ['allowed', '只在授权群']]).default('auto').description('谁能看到'),
      authProfile: str('default').description('授权档案'),
      note: str().description('备注'),
    }), PRESET_MARKETS)
      .description([
        '一行一个市场。**名称**不能重复，例如「Jita 4-4」。**别名**用逗号分隔，不区分大小写；NPC 空间站和星系类市场自动加上星系的中英文名。',
        '**位置**：NPC 空间站填空间站 ID；星系填星系名或 ID；星域填星域名或 ID；玩家建筑填建筑 ID（授权页面可以按名字搜）。**建筑所在星系**只用于玩家建筑，授权档案留空时必须填。',
        '**默认查价**：「查价 物品」不写市场时列不列出；自动 = 玩家建筑和基准市场列出，其他 NPC 市场不列。**谁能看到**：自动 = 玩家建筑只在授权群，其他所有群。',
        '**授权档案**只用于玩家建筑，留空表示不用授权、只读这个建筑公开的订单（这时要填建筑所在星系）。写错的行会被跳过，并在「市场状态」里标出来。',
      ].join('\n')),
  }).description('市场'),

  Schema.object({
    aliases: table(Schema.object({
      alias: str().description('别名'),
      target: str().description('目标物品'),
      enabled: strictBool(true).description('启用'),
      note: str().description('备注'),
    }))
      .description('物品别名，例如「大鸟」→ Raven。目标物品写英文名、中文名或 typeID，找不到就跳过并在「市场状态」里报告。黑话表里的叫法会自动接入，这里写的优先。别名不能和另一个物品的正式名称相同。'),
  }).description('物品别名'),

  Schema.object({
    price: Schema.object({
      baseMarket: str(DEFAULT_BASE_MARKET)
        .description('差价基准：其他市场的价格后面显示「▲4.5%」。也是走势、搜索、运费和各种回退的默认市场。填市场表格里的名称或别名；留空 = 不显示差价。'),
      defaultQuantities: table(Schema.object({
        item: str().description('物品'),
        quantity: num(1).description('数量'),
      }), DEFAULT_QUANTITIES)
        .description('查价不写数量时，另外给出这个数量的合计。'),
    }).default({} as Config['price']).loose(),
  }).description('查价'),

  Schema.object({
    appraisal: Schema.object({
      defaultMarket: str(DEFAULT_BASE_MARKET)
        .description('批量查价不写市场时用哪个（填市场的名称或别名）。本群看不到这个市场时改用基准市场。'),
      defaultPriceType: priceSide().default('sell').loose()
        .description('默认按哪个价格估价。'),
      fallbackMarket: str()
        .description('某个物品在选的市场没有挂单时改用哪个市场，并用 † 标出；留空 = 不回退，这些物品不计入合计。整个市场不可用时不会回退。'),
    }).default({} as Config['appraisal']).loose(),
  }).description('批量查价'),

  Schema.object({
    freight: Schema.object({
      routes: table(Schema.object({
        name: str().description('名称'),
        iskPerM3: num(0).description('ISK/m³'),
        collateralPct: num(0).description('押金费率 %'),
        maxVolume: num(0).description('单单最大体积 m³'),
        visibility: choice<FreightRow['visibility']>([['public', '所有群'], ['allowed', '只在授权群']]).default('allowed').description('谁能看到'),
        enabled: strictBool(true).description('启用'),
        note: str().description('备注'),
      }))
        .description('运费路线：卡片上显示成「运到 名称」。押金按 Jita 出售价合计算；单单最大体积填 0 = 不限，超过时按几单计算。只在用基准市场（Jita）估价时显示，最多 2 条。留空 = 不显示运费。'),
    }).default({} as Config['freight']).loose(),
  }).description('运费'),

  Schema.object({
    notices: Schema.object({
      list: table(Schema.object({
        text: str().description('内容'),
        visibility: choice<NoticeRow['visibility']>([['all', '所有群'], ['allowed', '只在授权群']]).default('allowed').description('谁能看到'),
        until: str().description('截止时间'),
        enabled: strictBool(true).description('启用'),
      }))
        .description('附在查价、批量查价结果下面的告示，最多显示前 2 条。内容一行、不超过 80 字，不能带网址（QQ 群里不允许发网址，带了会跳过）。截止时间写成 `2026-12-31 23:59`（北京时间），留空 = 一直显示。'),
    }).default({} as Config['notices']).loose(),
  }).description('查价告示'),

  Schema.object({
    industry: Schema.object({
      materialMarket: str(DEFAULT_BASE_MARKET)
        .description('材料按哪个市场的价格算（填市场表格里的名称或别名）。本群看不到这个市场时改用基准市场。'),
      materialPriceType: priceSide().default('sell').loose()
        .description('材料按哪个价格算。'),
      productMarket: str(DEFAULT_BASE_MARKET)
        .description('成品价值（用来算利润）按哪个市场的价格算。'),
      productPriceType: priceSide().default('sell').loose()
        .description('成品按哪个价格算。'),
      fallbackMarket: str()
        .description('材料在材料市场没有价格、或者材料市场整个暂时不可用时，改用哪个市场，并用 † 标出；留空 = 列为「缺价格」，总成本标「不完整」。'),
      meTeChoices: str(DEFAULT_ME_TE_CHOICES)
        .description('高级计算第 2 步列出的蓝图 ME/TE 组合，每组写成「ME/TE」，用逗号分隔。ME 是 0–10，TE 是 0–20。'),
      sccSurchargePct: num(FORMULA_DEFAULTS.sccSurchargePct)
        .description('SCC 附加费（%），按预估物品价值收。游戏调整了这个税率时改这里。'),
      npcFacilityTaxPct: num(FORMULA_DEFAULTS.npcFacilityTaxPct)
        .description('在 NPC 空间站制造（或者命令里写「建筑:无」）时的设施税（%）。游戏调整了这个税率时改这里。'),
      sellFeesPct: num(0)
        .description('算利润时从成品价值里扣掉的销售税和经纪费（%）。填 0 = 不扣，卡片上注明「未计销售税和经纪费」。'),
      multibuyLanguage: choice<Lang>([['en', '英文名'], ['zh', '中文名']]).default('en').loose()
        .description('「查看材料」另外发的清单（可以粘进游戏的「多重购买」窗口）用英文名还是中文名。'),
      chainReaction1: choice<'build' | 'buy'>([['build', '造'], ['buy', '买']]).default('build').loose()
        .description('拆到原料时，低级反应（月矿原料）自己造还是直接买。'),
      chainReaction2: choice<'build' | 'buy'>([['build', '造'], ['buy', '买']]).default('build').loose()
        .description('拆到原料时，高级反应自己造还是直接买。'),
      chainComponents: choice<'build' | 'buy'>([['build', '造'], ['buy', '买']]).default('build').loose()
        .description('拆到原料时，组件自己造还是直接买。'),
      chainOther: choice<'build' | 'buy'>([['build', '造'], ['buy', '买']]).default('buy').loose()
        .description('拆到原料时，其他（T1 船体、R.A.M.、燃料块）自己造还是直接买。'),
      chainAlchemy: choice<'auto' | 'normal' | 'alchemy'>([['auto', '自动'], ['normal', '正常'], ['alchemy', '炼金']]).default('auto').loose()
        .description('月矿原料怎么来：自动 = 哪个便宜用哪个；正常 = 只走反应；炼金 = 只走提炼。'),
      chainReactionLocation: str()
        .description('拆到原料时默认的反应地点（填工业地点表里的名称或别名）。留空 = 自动用表里第一个能反应的地点。'),
      reprocessLocation: str()
        .description('提炼（炼金）的地点。留空 = 先找命令里写的地点，再找第一个有「提炼」建筑的地点。'),
      scrapmetalLevel: num(5)
        .description('废料处理技能等级，0–5 的整数。5 = 提炼出 55%。'),
      locations: table(Schema.object({
        name: str().description('名称'),
        aliases: str().description('别名'),
        system: str().description('星系'),
        visibility: choice<Visibility>([['public', '所有群'], ['allowed', '只在授权群']]).default('allowed').description('谁能看到'),
        isDefault: strictBool(false).description('默认地点'),
        defaultME: num(10).description('默认 ME'),
        defaultTE: num(20).description('默认 TE'),
        sysCostBonusPct: num(0).description('星系费用加成 %'),
        enabled: strictBool(true).description('启用'),
        note: str().description('备注'),
      }))
        .description([
          '**工业地点**：「制造」「反应」命令里写的地点，一行一个。**名称**不能重复，例如「XX-1」；**别名**用逗号分隔，地点所在星系的中英文名自动算别名。**星系**填星系名或星系 ID。',
          '**谁能看到**：只在授权群 = 其他群看不到这个地点。**默认地点**只能勾一个，卡片上的「快速计算」用它。**默认 ME/TE**：在这里计算、命令里又没写 ME/TE 时用。',
          '**星系费用加成**：这个星系对安装费的额外加成（%，例如 -50），一般填 0。高安地点不能做反应。写错的行会被跳过，并在「市场状态」里标出来。',
        ].join('\n')),
      structures: table(Schema.object({
        location: str().description('地点'),
        name: str().description('名称'),
        structureType: str().description('建筑类型'),
        structureId: str().description('建筑 ID'),
        activities: choice<IndustryStructureRow['activities']>([
          ['manufacturing', '制造'],
          ['reaction', '反应'],
          ['both', '制造和反应'],
          ['reprocessing', '提炼'],
          ['reaction-reprocessing', '反应和提炼'],
          ['manufacturing-reprocessing', '制造和提炼'],
          ['all', '全部'],
        ]).default('manufacturing').description('用途'),
        rigs: str().description('改装件'),
        facilityTaxPct: num(0).description('制造税 %'),
        reactionTaxPct: Schema.number().loose().description('反应税 %（留空 = 和制造税一样）'),
        reprocessingTaxPct: Schema.number().loose().description('提炼税 %（留空 = 0）'),
        supercapitalShipyard: strictBool(false).description('有超旗舰船坞（只能勾在索迪约上）'),
        extraFeePct: num(0).description('其他费用 %'),
        extraFeeIsk: num(0).description('其他费用 ISK'),
        extraFeeLabel: str(DEFAULT_EXTRA_FEE_LABEL).description('其他费用的名称'),
        isDefault: strictBool(false).description('默认建筑'),
        enabled: strictBool(true).description('启用'),
        note: str().description('备注'),
      }))
        .description([
          '**工业建筑**：一行一座，一个地点可以有几座。**地点**填上面「工业地点」里的名称；**名称**是建筑的简称，命令里用（例如「建筑:大工厂」），同一个地点里不能重复。',
          '**建筑类型**填 Raitaru（莱塔卢）、Azbel（阿兹贝尔）、Sotiyo（索迪约）、Athanor（阿塔诺）、Tatara（塔塔拉）、势力铁壁等的名字或 typeID；在 NPC 空间站填「NPC」；不要建筑加成填「无」。建筑和改装件的加成数值来自物品数据，不用填。**用途**：反应只能在精炼厂（阿塔诺、塔塔拉）做，高安不能做反应；「提炼」用来炼金，建筑类型「无」不能提炼（莱塔卢、阿兹贝尔等游戏里也能装提炼设施）。',
          '**改装件**填建筑上实际装的改装件，名字或 typeID，用逗号分隔，例如「屹立超大型舰船制造效率 II」。插件按产品自动判断哪个生效；尺寸和建筑不符、或者在这个安全等级不生效的，会在「市场状态」里报告。',
          '**制造税 / 反应税 / 提炼税**：游戏里建筑主人设的税率（%）。反应税留空 = 和制造税一样，提炼税留空 = 0。**有超旗舰船坞**：只能勾在索迪约上（在 00 才生效）。**其他费用**：联盟另外收的钱，按预估物品价值的 % 和/或每个工作固定多少 ISK，**其他费用的名称**显示在卡片上；没有就填 0。**默认建筑**：这个地点默认用哪座，没勾时用第一座。',
        ].join('\n')),
    }).default({} as Config['industry']).loose(),
  }).description('工业'),

  Schema.object({
    sso: Schema.object({
      clientId: str()
        .description('EVE 开发者网站上应用的 Client ID。'),
      clientSecret: secret()
        .description('应用的 Secret Key。只填在这里，不要发给任何人。'),
      callbackUrl: str(DEFAULT_CALLBACK_URL)
        .description('回调地址：必须和开发者网站上填的完全一样，并且是你的浏览器能打开的地址。授权页面会显示应该填什么，不一致时标红，照抄即可。'),
      adminKey: secret()
        .description('授权页面的口令。授权页面只接受在 Koishi 所在电脑上直接打开（经 SSH 隧道也算）。只要这台电脑上有反向代理（例如 QQ 机器人用 webhook 方式时的 nginx、Caddy）、内网穿透或端口转发把 Koishi 的端口开放出去，就一定要设；都没有时可以不填。'),
    }).default({} as Config['sso']).loose(),
  }).description('EVE 授权'),

  Schema.object({
    render: Schema.object({
      influenceMapUrl: str(DEFAULT_INFLUENCE_MAP_URL)
        .description('「势力图」的图片地址。'),
      coalitionMapUrl: str(DEFAULT_COALITION_MAP_URL)
        .description('「联盟势力图」的图片地址。'),
      brAuto: bool(true)
        .description('旧设置：关掉时 BR 工具战报一律不自动截图。新的开关在「截图」分组里，这个以后会删掉。'),
    }).default({} as Config['render']).loose(),
  }).description('图片与截图'),

  Schema.object({
    screenshot: Schema.object({
      killAuto: bool(true)
        .description('@机器人 的消息里带 zKill 击杀链接时，自动回复击杀卡片（战报网站用下面的 BR 工具和 Warbeacon 设置）'),
      br: shotSite(2).description('BR 工具战报（br.evetools.org）'),
      warbeacon: shotSite(2).description('Warbeacon 战报（warbeacon.net）'),
      janice: shotSite(2).description('Janice 估价结果（janice.e-351.com/a/…）'),
      dotlan: shotSite(1).description('DOTLAN 星图（evemaps.dotlan.net 的星域、星系、联盟、军团页和星图）'),
      custom: table(Schema.object({
        name: str().description('名称'),
        host: str().description('域名'),
        pathPrefix: str().description('网址开头'),
        auto: strictBool(true).description('自动截图'),
        maxImages: num(1).description('最多几张'),
      }))
        .description([
          '**自定义网站**：一行一个，最多 10 行。**名称**是回复里显示的名字，不能写成网址的样子；**域名**只写域名，例如 kb.example.com，它下面的子域名也算，粘贴整个网址会自动只取域名。',
          '**网址开头**可选：只截这个开头的页面，例如 /kill/，留空 = 这个域名下的所有页面。**自动截图**关掉 = 要写「截图 网址」才截。**最多几张**1–3，每张最多 4000 像素高。',
          'IP 地址、localhost、内网域名、带端口或用户名的域名、内置网站已有的域名和 zKillboard 会被跳过，并在「市场状态」里写明。',
        ].join('\n')),
    }).default({} as Config['screenshot']).loose(),
  }).description('截图'),

  Schema.object({
    janice: Schema.object({
      apiKey: secret()
        .description('Janice 的 API 密钥（向 Janice 网站申请）。只填在这里，不要发给任何人；它只会出现在发给 Janice 的请求头里，不会出现在回复、日志和「市场状态」里。留空 = 不开通，「估价」命令回复还没开通，Janice 链接只截图。'),
      who: choice<JaniceWho>([
        ['allowed', '授权群和授权私聊'],
        ['all', '所有人'],
        ['admins', '只有管理员'],
      ]).default('allowed').loose().description('谁能用「估价」：授权群和授权私聊里的人 / 所有人 / 只有管理员。没有权限的人发 Janice 链接只会得到截图（如果截图开着）。'),
    }).default({} as Config['janice']).loose(),
  }).description('Janice 估价'),

  Schema.object({
    kb: Schema.object({
      scope: choice<KbScope>([
        ['all', '所有群和私聊'],
        ['allowed', '只在授权群和授权私聊'],
        ['off', '关闭'],
      ]).default('all').loose().description('谁能用「KB」：所有群和私聊 / 只在授权群和授权私聊 / 关闭。'),
      recent: bool(true)
        .description('人物卡上显示近期大击杀、大损失和活跃时段（每张卡多查 2 次 zKill，慢 2–3 秒）。关掉出图更快。'),
      auto: bool(true)
        .description('@机器人 的消息里带 zKill 人物链接时，自动回复人物卡。'),
      hidden: table(Schema.object({
        characterId: str().description('人物 ID'),
        note: str().description('备注'),
        enabled: strictBool(true).description('启用'),
      }))
        .description('**不显示的人物**：一行一个，人物 ID 只能写数字，备注随便写（例如名字）。查到这些人只回一句话，不出卡片。默认空。'),
    }).default({} as Config['kb']).loose(),
  }).description('KB 人物卡'),

  Schema.object({
    advanced: Schema.object({
      manifestUrl: str(DEFAULT_MANIFEST_URL)
        .description('物品数据清单的网址，用 `||` 分隔备用网址。留空 = 只用插件自带的数据。'),
      glossaryUrl: str(DEFAULT_GLOSSARY_URL)
        .description('黑话表的网址（提供别名和中英对照），用 `||` 分隔备用网址。留空 = 只用插件自带的黑话表。'),
      esiContact: str()
        .description('可选：写进 ESI 请求头的联系方式（例如游戏角色名或邮箱），出问题时 CCP 能联系到你。只能用英文字母、数字和常见符号。'),
    }).collapse().default({} as Config['advanced']).loose(),
  }).description('高级'),
]) as Schema<Config>
