// 固定值。所有者不需要改的调优值都在这里，不放进控制台；样式自检、实测或核实之后要改时，发补丁版本改这里。
// core 也从这里读（这个文件不依赖任何东西）；测试通过 createEveCore 的参数覆盖 ESI、SSO 地址。

// ------------------------------------------------------------------ 时间

export const TIMEZONE = 'Asia/Shanghai'
export const SERVER_LABEL = '欧服'
/** EVE 每天例行维护（UTC），这段时间出错时写「DT 维护中，显示维护前数据」 */
export const DT_START_UTC = { hour: 11, minute: 0 }
export const DT_END_UTC = { hour: 11, minute: 30 }

// ------------------------------------------------------------------ 回复

/** 文字类查询最多等多久，没回来的市场标「超时」 */
export const QUERY_DEADLINE_MS = 6000
/** 整份批量估价最多等多久 */
export const BATCH_DEADLINE_MS = 12000
/** 和基准市场（Jita）比较时最多等多久，拿不到就不画箭头 */
export const BASE_COMPARE_WAIT_MS = 1000
/** 等 core 按时限返回的结果时多给的余量（只防它卡住） */
export const DEADLINE_GUARD_MS = 250
/** 一天（UTC 日）的毫秒数 */
export const DAY_MS = 86_400_000
/** 重操作超过这么久还没好才发慢提示 */
export const SLOW_HINT_MS = 3000
/** 冷启动、未缓存的物品超过这么多种时，批量查价才可能发慢提示 */
export const SLOW_HINT_UNCACHED_TYPES = 30
/** 收到消息超过这么多秒就不再被动回复（适配器 298 秒后会悄悄改成主动消息） */
export const REPLY_CUTOFF_SEC = 290
/** 数据还没准备好时，命令最多等多久 */
export const READY_WAIT_MS = 8000

/** 单条消息上限，按最终序列化后的 Markdown 计（含标签和转义字符） */
export const MAX_MESSAGE_CHARS = 3500
/** 任何情况下都不能超过 */
export const HARD_MAX_MESSAGE_CHARS = 4000
/** 一条回复最多拆成几段 */
export const MAX_SPLIT_PARTS = 3

/** 平台规则：群里每条用户消息 5 分钟内最多 5 条回复，单聊 60 分钟内 4 条；各留 1 条给错误提示 */
export const REPLY_BUDGET_GROUP = 4
export const REPLY_BUDGET_DIRECT = 3

export type CommandId =
  | 'price' | 'batch' | 'trend' | 'search' | 'incursion' | 'influenceMap' | 'coalitionMap' | 'br'
  | 'serverStatus' | 'translate' | 'help' | 'groupId' | 'marketStatus' | 'marketAuth' | 'selfTest'
  | 'manufacture' | 'manufactureCompare' | 'reaction'

/** 命令的默认名字（注册时用；按钮、提示里的名字在渲染时从已注册的 Command 取） */
export const COMMAND_NAMES: Record<CommandId, string> = {
  price: '查价',
  batch: '批量查价',
  trend: '走势',
  search: '搜索',
  incursion: '入侵',
  influenceMap: '势力图',
  coalitionMap: '联盟势力图',
  br: '战报',
  serverStatus: '服务器状态',
  translate: '翻译',
  help: '帮助',
  groupId: '本群ID',
  marketStatus: '市场状态',
  marketAuth: '市场授权',
  selfTest: '样式自检',
  manufacture: '制造',
  manufactureCompare: '制造比价',
  reaction: '反应',
}

/** 「翻译」的别名 */
export const TRANSLATE_ALIAS = '中英对照'
/** 「帮助」「菜单」改写成这个隐藏命令，避开 plugin-help 的快捷方式 */
export const HELP_COMMAND = 'eve-market.help'
export const HELP_WORDS = ['帮助', '菜单']
export const CANCEL_WORD = '取消'

/** 每个命令的回复条数（群聊；单聊再少 1 条，由 Replier 统一裁剪） */
export const COMMAND_BUDGET: Record<CommandId, { normal: number; max: number }> = {
  price: { normal: 1, max: 2 },
  batch: { normal: 1, max: 3 },
  trend: { normal: 2, max: 3 },
  search: { normal: 1, max: 2 },
  incursion: { normal: 1, max: 2 },
  influenceMap: { normal: 1, max: 2 },
  coalitionMap: { normal: 1, max: 2 },
  br: { normal: 2, max: 3 },
  serverStatus: { normal: 1, max: 2 },
  translate: { normal: 1, max: 2 },
  help: { normal: 1, max: 2 },
  groupId: { normal: 3, max: 3 },
  marketStatus: { normal: 1, max: 2 },
  marketAuth: { normal: 1, max: 2 },
  selfTest: { normal: 4, max: 4 },
  manufacture: { normal: 1, max: 2 },
  manufactureCompare: { normal: 1, max: 2 },
  reaction: { normal: 1, max: 2 },
}
/** 「制造 … 材料」：卡片 + 可复制的清单，大型旗舰拆分时最多 4 条（单聊 3） */
export const MATERIALS_BUDGET = { normal: 2, max: 4 }

/** 候选最多列几个；超过 CANDIDATE_OVERFLOW 个时只写「匹配太多」加几个例子 */
export const MAX_CANDIDATES = 8
export const CANDIDATE_OVERFLOW = 50
export const OVERFLOW_EXAMPLES = 5
/** 「没有找到」时最多给几个相近的 */
export const NOT_FOUND_SUGGESTIONS = 3

/** 编号回复、批量清单待办的有效期 */
export const PENDING_MINUTES = 5
/** 编号回复只认 1–99 */
export const MAX_CHOICE_NO = 99
/** 估价编号：保存多久、最多几份（LRU）；4 位，至少一个字母，不用容易看错的 I O 0 1 */
export const APPRAISAL_ID_HOURS = 24
export const APPRAISAL_ID_MAX = 200
export const APPRAISAL_ID_LENGTH = 4
export const APPRAISAL_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 10 分钟内 Markdown 失败 3 次 → 之后 30 分钟全部发纯文本 */
export const BREAKER_FAILURES = 3
export const BREAKER_WINDOW_MIN = 10
export const BREAKER_COOLDOWN_MIN = 30

/** 同一条消息（platform:messageId）多久内只处理一次 */
export const DEDUP_MINUTES = 2
/** 自我回声保护：本插件发过的纯文字在这个频道记多久 */
export const SELF_ECHO_SEC = 60

/** 发送失败时按错误码处理 */
export const QQ_ERROR = {
  /** Markdown 长度超限 */
  MARKDOWN_TOO_LONG: 40054007,
  /** 不允许发送 URL */
  URL_NOT_ALLOWED: 40054010,
  /** 超过被动回复次数 */
  REPLY_LIMIT: 40034128,
} as const

// ------------------------------------------------------------------ 显示

/** 某个市场的数据比最新的旧超过这么多分钟时，在小标题后面写「· N 分钟前」 */
export const STALE_AFTER_MINUTES = 10
/** 和基准市场相差不到这个百分比时不画 ▲▼ */
export const DIFF_MIN_PCT = 0.1
/** 默认查价最多列几个市场 */
export const MAX_MARKETS = 8
export const SHOW_MID = true
export const SHOW_ORDER_VOLUME = false
/** @机器人 后面直接是物品名（精确或别名唯一命中）时按查价处理 */
export const BARE_ITEM_QUERY = true
export const INCURSION_LIST_SYSTEMS = true
/** 查价、批量查价卡片上最多几条告示 */
export const MAX_NOTICES = 2
export const NOTICE_MAX_CHARS = 80
/** 回显用户的文字截到多少字 */
export const ECHO_MAX_CHARS = 30
/** 搜索每页几个；翻译最多列几个 */
export const SEARCH_PAGE_SIZE = 10
export const TRANSLATE_LIMIT = 10
/** @机器人 但没有命中命令时，不超过这么多字才问「你是想查价吗？」 */
export const FALLBACK_SHORT_CHARS = 20

/** 按钮：标签不超过 8 个汉字；命令不超过 100 字（超过时把物品名换成 #typeID） */
export const MAX_BUTTON_LABEL = 8
export const MAX_BUTTON_COMMAND_CHARS = 100
/** 平台上限 5 行 × 5 个；动作按钮最多 4 行、每行 4 个，编号按钮每行 5 个 */
export const MAX_KEYBOARD_ROWS = 5
export const MAX_ACTION_ROWS = 4
export const MAX_ACTIONS_PER_ROW = 4
export const MAX_CHOICES_PER_ROW = 5
/** 纯文字降级时动作按钮最多写几行 */
export const TEXT_ACTION_LINES = 2

// ------------------------------------------------------------------ 要等样式自检才能定的开关

/** 列表项写成 <qqbot-cmd-input>（确认群里点击会自动带 @机器人 以后再开） */
export const CMD_INPUT_IN_LISTS = false
/** 回复时引用用户的消息（message_reference） */
export const QUOTE_REPLY = false
/** 用 <qqbot-at-user> 提醒提问的人 */
export const MENTION_USER = false
/** 势力图下面附一行说明文字（和图片合成一条） */
export const MAP_CAPTION = false

// ------------------------------------------------------------------ 权限

/** Koishi 权限等级达到这个值也算管理员 */
export const ADMIN_AUTHORITY = 4

// ------------------------------------------------------------------ 输入限制

/** 单条消息最多处理多少字 */
export const MAX_INPUT_CHARS = 20000
/** 数量必须是 1 到 10¹² 之间的整数 */
export const MAX_QUANTITY = 1e12

// ------------------------------------------------------------------ 批量查价

/** 表头里的价格类型写法（卡片标题里印的词都能原样输回来）；市场名、别名不能用这些词 */
export const PRICE_TYPE_WORDS: { readonly sell: readonly string[]; readonly buy: readonly string[]; readonly mid: readonly string[] } = {
  sell: ['sell', '出售', '出售价', '卖', '卖价', '卖单'],
  buy: ['buy', '收购', '收购价', '买', '买价', '买单'],
  mid: ['mid', '中间', '中间价', '中', 'split'],
}

export const MAX_LINES = 200
/** ≤ 10 种详细排版；11–40 紧凑；41–120 拆成最多 3 条；更多时明细只列前 120 种 */
export const DETAIL_LINES = 10
export const COMPACT_LINES = 40
export const SPLIT_MAX_ROWS = 120
/** 拆分时第一条消息列金额最高的几行 */
export const SPLIT_FIRST_ROWS = 30
/** ±N% 的绝对值上限；不带符号的 N% 只接受 50–150 */
export const MAX_MODIFIER_PCT = 90
export const BARE_PCT_MIN = 50
export const BARE_PCT_MAX = 150
/** 装填的弹药：full 按满装、once 算 1 个、ignore 不算 */
export const EFT_LOADED_CHARGES: 'full' | 'once' | 'ignore' = 'full'
/** 未识别的行不超过这么多时配候选按钮；每行最多给几个候选 */
export const UNRESOLVED_BUTTON_LINES = 3
export const UNRESOLVED_CANDIDATES = 5
/** 运费最多显示几条路线 */
export const MAX_FREIGHT_ROUTES = 2
/** 「没有计入合计」最多列几行，再多只写个数（也只给这几行找「是不是：X」） */
export const MAX_WARNING_LINES = 15
/** 拆成几条时，每条明细给标题和说明留的长度 */
export const SPLIT_PART_RESERVE = 300

// ------------------------------------------------------------------ 市场

/** NPC 空间站的收购价：station 只算挂在本站的买单；range 算射程覆盖本站的买单 */
export const BUY_SCOPE: 'station' | 'range' = 'station'
/** range 模式下星门 BFS 最远算几跳 */
export const RANGE_MAX_JUMPS = 40
/** 全宇宙统一交易的物品（PLEX）和它们的市场星域 */
export const GLOBAL_MARKET_TYPES: readonly number[] = [44992]
export const GLOBAL_MARKET_REGION = 19000001
/** 建筑市场授权异常时不显示旧价格 */
export const SHOW_STALE_ON_AUTH_ERROR = false

// ------------------------------------------------------------------ ESI 与 SSO

export const ESI_BASE = 'https://esi.evetech.net'
export const SSO_BASE = 'https://login.eveonline.com'
export const SSO_AUTHORIZE_PATH = '/v2/oauth/authorize'
export const SSO_TOKEN_PATH = '/v2/oauth/token'
export const SSO_REVOKE_PATH = '/v2/oauth/revoke'
export const SSO_SCOPES: readonly string[] = [
  'esi-markets.structure_markets.v1',
  'esi-universe.read_structures.v1',
  'esi-search.search_structures.v1',
]
/** 按名字搜建筑的权限（名字待核实）：缺了只影响管理页的搜索，建筑市场同步照常 */
export const SSO_SEARCH_SCOPE = 'esi-search.search_structures.v1'
/** access token（JWT）的签发者和受众（待核实）。只解码、不验签，所以不取 JWKS */
export const SSO_JWT_ISSUERS: readonly string[] = ['login.eveonline.com', 'https://login.eveonline.com']
export const SSO_JWT_AUDIENCE = 'EVE Online'
/** SSO 回调的路由路径（固定，不是配置） */
export const SSO_CALLBACK_PATH = '/eve-market/sso/callback'
export const ADMIN_PAGE_PATH = '/eve-market/admin'
/** 授权 state：10 分钟有效，最多同时 5 个 */
export const SSO_STATE_TTL_MIN = 10
export const SSO_STATE_MAX = 5
/** access token 剩不到这么多秒就先刷新 */
export const TOKEN_REFRESH_MARGIN_SEC = 60
/** 档案 DEGRADED（网络错误、5xx）时的重试间隔；AUTH_ERROR 每小时最多试一次 */
export const AUTH_RETRY_MINUTES: readonly number[] = [1, 5, 15, 60]
export const AUTH_ERROR_RETRY_MINUTES = 60

/** X-Compatibility-Date，随插件版本固定，改它算一次明确的变更 */
export const COMPATIBILITY_DATE = '2026-08-18'
export const PROJECT_URL = 'https://github.com/yilifaer/koishi-plugin-eve-market'
export const USER_AGENT_PRODUCT = 'koishi-plugin-eve-market'
export const ESI_TIMEOUT_MS = 10000
export const ESI_BACKGROUND_TIMEOUT_MS = 30000
/** 两个独立的并发池：交互请求、后台任务 */
export const INTERACTIVE_POOL = 12
export const BACKGROUND_POOL = 3
/** 翻页时第 2..N 页的并发 */
export const ESI_PAGE_CONCURRENCY = 4
/** 网络错误和 502/503/504 重试一次，随机等 0.5–1.5 秒 */
export const ESI_RETRY_DELAY_MS = { min: 500, max: 1500 }
/** 限流组剩余低于这个百分比时暂停这个组的后台任务 */
export const RATELIMIT_BACKGROUND_PAUSE_PCT = 10
/** 错误额度剩余低于这个数时暂停非交互请求 */
export const ERROR_LIMIT_PAUSE_REMAIN = 20

// ------------------------------------------------------------------ 缓存

/** 星域订单：没有过期头时缓存 300 秒；出错时最多用 60 分钟前的 */
export const REGION_ORDERS_DEFAULT_SEC = 300
export const REGION_ORDERS_STALE_MIN = 60
/** 建筑市场：两次同步至少隔 5 分钟，再加 0–30 秒随机；24 小时没人查就暂停；同步异常时旧数据最多显示 60 分钟 */
export const STRUCTURE_SYNC_MIN_INTERVAL_MIN = 5
export const STRUCTURE_SYNC_JITTER_SEC = 30
export const STRUCTURE_IDLE_PAUSE_HOURS = 24
export const STRUCTURE_STALE_MIN = 60
/** 暂停后第一次被查：超过这么久的旧数据不显示，写「正在同步」 */
export const STRUCTURE_STALE_HIDE_HOURS = 24
/** 建筑 403 时的退避 */
export const STRUCTURE_FORBIDDEN_BACKOFF_MIN: readonly number[] = [15, 30, 60]
/** 建筑信息（/universe/structures） */
export const STRUCTURE_INFO_HOURS = 24
export const STRUCTURE_INFO_STALE_DAYS = 7

export const HISTORY_CACHE_HOURS = 6
export const HISTORY_STALE_HOURS = 48
export const INDUSTRY_INDICES_CACHE_MIN = 60
export const ADJUSTED_PRICES_CACHE_MIN = 60
export const INDUSTRY_STALE_HOURS = 24
export const STATUS_CACHE_SEC = 30
/** 服务器状态、入侵请求失败以后，这么久之内直接回答「取不到」，不再请求 */
export const FAILURE_MEMO_SEC = 30
export const STATUS_STALE_MIN = 5
export const INCURSIONS_CACHE_MIN = 5
export const INCURSIONS_STALE_MIN = 60
export const MAP_CACHE_MIN = 60
export const BR_CACHE_MIN = 10
export const CHART_LRU_SIZE = 50

// ------------------------------------------------------------------ 数据

/** 插件支持的数据格式版本 */
export const DATA_SCHEMA = 1
export const DATA_FILES = ['types.json', 'industry.json', 'universe.json'] as const
/** 启动后多久第一次在线检查，之后每隔几小时（±10% 抖动） */
export const DATA_FIRST_CHECK_SEC = 20
export const DATA_REFRESH_HOURS = 6
export const DATA_REFRESH_JITTER = 0.1
/** 物品数据的生成时间超过这么多天时提醒 */
export const DATA_STALE_WARN_DAYS = 14
/** 单个数据文件的大小上限和下载超时 */
export const DATA_MAX_BYTES = 20 * 1024 * 1024
export const DATA_TIMEOUT_MS = 60000
/** 新数据每张表的行数至少是当前的 80%；黑话表的可用词条至少是自带快照的 50% */
export const DATA_MIN_ROW_RATIO = 0.8
export const GLOSSARY_MIN_RATIO = 0.5
/** 新物品兜底的结果（含「查不到」）缓存几天；查询长度 */
export const REMOTE_ITEM_CACHE_DAYS = 7
export const REMOTE_QUERY_MIN_CHARS = 2
export const REMOTE_QUERY_MAX_CHARS = 100
/** 查价时新物品兜底最多等多久；没等到就按「没有找到」回答，查询在后台做完、结果进缓存 */
export const REMOTE_LOOKUP_MS = 3000
export const USE_GLOSSARY = true

// ------------------------------------------------------------------ 图片

/** 走势图：CSS 像素，2 倍分辨率出图；月 / 季 / 年的天数 */
export const CHART_WIDTH = 800
export const CHART_HEIGHT = 450
export const CHART_SCALE = 2
export const CHART_FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif'
export const TREND_DAYS = { month: 30, quarter: 90, year: 365 } as const
/** 深色主题 */
export const CHART_COLORS = {
  background: '#14171c',
  panel: '#1b1f26',
  grid: '#2a2f38',
  text: '#d7dce3',
  muted: '#8a93a0',
  line: '#4aa3ff',
  band: 'rgba(74, 163, 255, 0.18)',
  volume: '#3b4452',
  up: '#36c46b',
  down: '#ef5350',
} as const
/** 成交日少于这么多天时不画图 */
export const TREND_MIN_DAYS = 3
/** 最高最低价的阴影带裁到 average 中位数的 [0.5×, 2×]；纵轴上下留 3% */
export const TREND_BAND_CLAMP = { min: 0.5, max: 2 }
export const TREND_PADDING = 0.03
/** 没有图时的文字走势条分成几段 */
export const SPARKLINE_SEGMENTS = 15
/** 浅色主题：QQ 聊天里缩小显示时比深色清楚 */
export const CHART_COLORS_LIGHT = {
  background: '#fcfcfb',
  panel: '#fcfcfb',
  grid: '#e1e0d9',
  text: '#0b0b0b',
  muted: '#52514e',
  line: '#2a78d6',
  band: 'rgba(42, 120, 214, 0.12)',
  volume: '#86b6ef',
  up: '#006300',
  down: '#d03b3b',
} as const
/** 走势图用哪套配色（深色那套是 CHART_COLORS） */
export const CHART_THEME: 'light' | 'dark' = 'light'
/** 走势图单次渲染最多多久（不算排队），超时就只发文字卡片 */
export const CHART_RENDER_TIMEOUT_MS = 20000

/** 浏览器页面最多同时几个，其中战报最多占 1 个 */
export const BROWSER_PAGES = 2
export const BR_PAGES = 1
export const BR_VIEWPORT_WIDTH = 1440
export const BR_SEGMENT_HEIGHT = 4000
export const BR_MAX_HEIGHT = 8000
export const BR_JPEG_QUALITY = 85
export const BR_RENDER_TIMEOUT_MS = 60000
/** 页面加载完再等一会儿让它稳定 */
export const BR_SETTLE_MS = 1500
/** 入队时估算（已过去的时间 + 前面任务数 × 60 秒）超过 240 秒就直接回复「截图繁忙」 */
export const BR_QUEUE_TASK_SEC = 60
export const BR_QUEUE_REJECT_SEC = 240
/** 战报页面的视口高度（截图高度按页面实际高度，比这个矮的页面截出来就是这么高） */
export const BR_VIEWPORT_HEIGHT = 900
/** 战报截图缓存最多几个链接（每个最多 2 张图） */
export const BR_CACHE_MAX = 6

/** 势力图下载：超时和大小上限；超过 IMAGE_MAX_BYTES 的图片不发 */
export const MAP_TIMEOUT_MS = 30000
export const MAP_MAX_BYTES = 20 * 1024 * 1024
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024

// ------------------------------------------------------------------ 工业（0.2.0）

export const MAX_ME = 10
export const MAX_TE = 20
/** 制造比价不写 ME/TE 时用 */
export const COMPARE_ME_TE = { me: 10, te: 20 }
/** T2 产品第 2 步的 ME/TE 选项 */
export const T2_ME_TE_CHOICES: ReadonlyArray<{ me: number; te: number }> = [
  { me: 2, te: 4 },
  { me: 3, te: 6 },
  { me: 4, te: 8 },
]
/** 满技能的时间系数（Industry V × Advanced Industry V；Reactions V） */
export const MAX_SKILL_MANUFACTURING_MULT = 0.68
export const MAX_SKILL_REACTION_MULT = 0.8
export const SHOW_MAX_SKILL_TIME = true
export const MAX_RUNS = 10000
export const MULTIBUY_SEPARATOR = '\t'
export const MATERIALS_COPY_BLOCK = true
/** 基础卡片「主要材料」列几种 */
export const TOP_MATERIALS = 5

// ------------------------------------------------------------------ EVE 授权页面（§7.4、§8.4）

/** 其余几个路由（管理页和回调的路径在「ESI 与 SSO」一节） */
export const ADMIN_SEARCH_PATH = '/eve-market/admin/search'
export const ADMIN_DELETE_PATH = '/eve-market/admin/delete'
export const SSO_START_PATH = '/eve-market/sso/start'
/** 页面上「授权」「删除」「搜索」的一次性令牌：多久有效、最多同时几个 */
export const ADMIN_ACTION_TTL_MIN = 30
export const ADMIN_ACTION_MAX = 50
/** 输对口令以后多久不用再输 */
export const ADMIN_SESSION_HOURS = 12
/** 按名字搜建筑至少几个字、最多几个字 */
export const STRUCTURE_SEARCH_MIN_CHARS = 3
export const STRUCTURE_SEARCH_MAX_CHARS = 100
