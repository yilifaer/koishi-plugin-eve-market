// 命令回复里共用的中文文字。物品名、市场名、用户的原话由调用方先转义（回显用户的文字一律经过 safeEcho）。

import type { PriceSide } from '../../core/types'

export const SAY = {
  loading: '数据加载中，请稍后再试',
  imageOnly: '图片里的字我看不到，请在游戏里复制后粘贴',
  failed: '出了点问题，请稍后再试',
  badQuantity: '数量要是正整数',
  twoMarkets: '一次只能选一个市场',
  modifierRange: '要打 95 折请写 -5%、95% 或 95折',
  expired: '这份估价已过期，请重新粘贴清单',
  noMarket: '没有可以查价的市场，请管理员检查控制台的「市场」表格',
  multiLine: '多行内容已按批量查价处理',
  newItem: '（新物品，数据还没收录）',
  via: (name: string) => `按「${name}」查询`,
  unknownMarket: (token: string) => `未知市场：${token}`,
  marketsHere: (names: string) => `当前可用市场：${names}`,
  noMarketsHere: '当前没有可用的市场',
  notTradable: (name: string, note: string) => `${name} 不能在市场上交易${note}。`,
  t2Blueprint: '（T2 蓝图一般通过发明获得）',
  confused: (text: string) => `没看懂「${text}」。你是想查价吗？`,
  maybeIndustry: (text: string, command: string) => `没看懂「${text}」。是不是想用「${command}」？`,
  chat: (help: string) => `发「${help}」看我能做什么`,
} as const

export const SIDE_LABEL: Record<PriceSide, string> = { sell: '出售价', mid: '中间价', buy: '收购价' }

/** 报价状态的说法（§2.2.7） */
export const QUOTE = {
  cached: (ago: string) => `${ago}（缓存）`,
  downtimeCached: 'DT 维护中，显示维护前数据',
  syncError: (ago: string) => `⚠ ${ago}（同步异常）`,
  refreshing: (ago: string) => `⚠ ${ago}（正在刷新）`,
  esiDown: '⚠ ESI 暂时没有响应',
  downtime: '⚠ 暂时取不到价格',
  /** 卡片上取不到价格、又正好在每日维护时间里时的一句话（不带 ⚠，警告行统一加） */
  downtimeNotice: 'EVE 每日维护中（北京时间 19:00 左右），价格暂时取不到，15 分钟后再试',
  syncDown: '⚠ 市场数据暂时不可用（同步异常）',
  authDown: '⚠ 市场数据暂时不可用（ESI 授权或建筑访问权限异常）',
  firstSync: '⏳ 首次同步中，请稍后再查',
  resyncing: '⏳ 正在同步，请稍后再查',
  timeout: '⚠ 查询超时，暂时取不到价格',
  noSell: '暂无卖单',
  noBuy: '暂无买单',
} as const

/** 走势（§2.4） */
export const TREND = {
  title: (item: string, place: string, days: number) => `📈 **${item} · ${place} · 近 ${days} 天**`,
  latest: '最近日均价',
  range: (days: number, high: string, low: string) => `${days} 天最高 ${high} · 最低 ${low}`,
  volume: (qty: string, unit: string, turnover: string) => `日均成交 ${qty} ${unit} · 日均成交额 ${turnover}`,
  spark: (bars: string) => `走势 ${bars}`,
  regionNote: (region: string) => `数据是整个${region}星域的成交，每天更新一次`,
  globalNote: '数据是全宇宙统一市场的成交，每天更新一次',
  stale: '⚠ ESI 暂时没有响应，这是之前缓存的数据',
  missing: (n: number) => `其中 ${n} 件没有成交记录，没有算进去`,
  thin: (days: number) => `近 ${days} 天成交太少，无法绘图`,
  noHistory: (item: string, place: string) => `${item}在${place}没有成交记录`,
  structure: (market: string) => `${market} 是玩家建筑市场，ESI 不提供成交历史`,
  structureButton: (market: string) => `看${market}走势`,
  noMarket: '没有可以看走势的 NPC 市场，请管理员检查控制台的「市场」表格',
  esiDown: '⚠ ESI 暂时没有响应，取不到成交历史，请稍后再试',
  downtime: '⚠ DT 维护中，暂时取不到成交历史，请稍后再试',
  hint: '⏳ 正在画走势图…',
  rangeLabel: { month: '月度走势', quarter: '季度走势', year: '年度走势' },
  global: '全局市场',
  unitShip: '艘',
  unitSet: '件',
  unitItem: '个',
} as const

/** 入侵（§2.9） */
export const INCURSION = {
  title: (count: number, classes: string) => `**当前入侵** · ${count} 处${classes ? `（${classes}）` : ''}`,
  none: '当前欧服没有进行中的入侵。',
  staging: (name: string) => `集结星系 ${name}`,
  state: (state: string, influence: string, boss: boolean) => `状态 ${state} · 影响力 ${influence} · Boss ${boss ? '已出现' : '未出现'}`,
  systems: (count: number, list: string) => `被入侵星系（${count}）${list}`,
  systemCount: (count: number) => `被入侵星系 ${count} 个`,
  stateNames: { established: '立足', mobilizing: '动员', withdrawing: '撤退' },
  faction: (name: string) => `入侵势力 ${name}`,
  cached: '（缓存）',
  esiDown: '⚠ 暂时取不到入侵信息（ESI 没有响应），请稍后再试',
} as const

/** 安全等级分类的叫法 */
export const SEC_CLASS = { high: '高安', low: '低安', null: '00' } as const

/** 势力图、联盟势力图（§2.10） */
export const MAP = {
  name: { influence: '势力图', coalition: '联盟势力图' },
  hint: (name: string) => `⏳ 正在下载${name}…`,
  caption: (name: string, updated: string) => `欧服${name} · 来源 Verite · 图片更新于 ${updated}`,
  staleCaption: (name: string, ago: string) => `欧服${name} · 来源 Verite · 图片更新于 ${ago}（来源暂时无法访问）`,
  unavailable: (name: string) => `${name}暂时获取不到，请稍后再试。`,
  tooLarge: (name: string) => `${name}太大，暂时发不了。`,
  notConfigured: (name: string) => `${name}没有开启（控制台里没有填图片地址）。`,
  sendFailed: (name: string) => `${name}发送失败，请稍后再试。`,
} as const

/** 服务器状态（§2.12） */
export const SERVER = {
  online: `**欧服状态** · 🟢 在线`,
  vip: `**欧服状态** · 🟡 VIP 模式（只有开发人员能登录）`,
  players: '在线人数',
  started: (at: string, uptime: string) => `本次开服 ${at}（已运行 ${uptime}）`,
  nextDowntime: (at: string, eve: string) => `下次维护 ${at}（EVE 时间 ${eve}）`,
  version: (v: string) => `服务器版本 ${v}`,
  clocks: (eve: string, local: string) => `EVE 时间 ${eve} · 北京时间 ${local}`,
  stale: (ago: string) => `ESI 暂时没有响应，这是 ${ago}的状态`,
  down: (eve: string, local: string) => `🔴 连不上欧服。现在可能在例行维护（每天 EVE 时间 ${eve}，北京时间 ${local}，一般 15–30 分钟）。`,
} as const

/** 翻译（§2.13） */
export const TRANSLATE = {
  usageTitle: '**翻译用法**',
  found: (query: string, n: number) => `**「${query}」找到 ${n} 个**`,
  more: (n: number) => `还有 ${n} 个，关键词写具体一点`,
  none: (query: string) => `没有找到「${query}」的中英对照。`,
  aliases: (list: string) => `别名：${list}`,
  kind: { item: '物品', group: '分组', category: '大类', system: '星系', constellation: '星座', region: '星域', slang: '黑话' },
} as const

/** 战报（§2.11） */
export const BR = {
  usageTitle: '**战报用法**',
  badLink: '这个战报链接的格式不对：只支持 BR 工具的战报链接（br/ 加 24 位编号，或 related/ 加星系和时间）。',
  noBrowser: '截图服务没有启动，请联系管理员。',
  busy: '截图繁忙，请稍后再试。',
  hint: '⏳ 正在截取战报，一般要 10–30 秒…',
  ahead: (n: number) => `（前面还有 ${n} 个）`,
  truncated: (px: number) => `页面过长，已截取前 ${px} 像素`,
  timeout: '战报页面 60 秒内没有打开，链接可能失效，或者网站暂时访问不了。',
  http: (status: number) => `战报页面打不开（网站返回 ${status}），链接可能失效。`,
  unreachable: '战报网站暂时访问不了，请稍后再试。',
  failed: '战报截图失败，请稍后再试。',
  sendFailed: '战报图片发送失败，请稍后再试。',
  logNoBrowser: '战报截图需要 Koishi 的 puppeteer 插件，现在没有启用',
} as const

/** 网站截图（「截图」「截图测试」；BR 工具的链接沿用上面 BR 的文案，浏览器、繁忙、截断的说法所有网站共用 BR 里那几句） */
export const SHOT = {
  usageTitle: '**截图用法**',
  hint: '⏳ 正在截图，一般要 10–30 秒…',
  timeout: '截图超时，链接可能失效，或者网站暂时访问不了。',
  blocked: '这个网站不让自动截图。',
  redirect: '这个链接跳到了别的网站，没有截图。',
  http: (status: number) => `页面打不开（网站返回 ${status}），链接可能失效。`,
  unreachable: '网站暂时访问不了，请稍后再试。',
  failed: '截图失败，请稍后再试。',
  sendFailed: '截图发送失败，请稍后再试。',
  notListed: (names: string) => `这个网站不在截图名单里。能截的网站：${names}。`,
  badLink: (name: string, hint: string) => `这个${name}链接的格式不对：${hint}。`,
  notBattleReport: (shot: string) => `这不是战报链接。截别的网站请发「${shot} 网址」。`,
  brOff: '战报截图没有开启（控制台「截图」里关掉了）。',
} as const
