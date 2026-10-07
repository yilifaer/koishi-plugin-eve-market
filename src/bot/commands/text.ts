// 命令回复里共用的中文文字。物品名、市场名、用户的原话由调用方先转义（回显用户的文字一律经过 safeEcho）。

import type { PriceSide } from '../../core/types'

export const SAY = {
  loading: '数据加载中，请稍后再试',
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
  downtime: '⚠ DT 维护中，暂时取不到价格',
  syncDown: '⚠ 市场数据暂时不可用（同步异常）',
  authDown: '⚠ 市场数据暂时不可用（ESI 授权或建筑访问权限异常）',
  firstSync: '⏳ 首次同步中，请稍后再查',
  resyncing: '⏳ 正在同步，请稍后再查',
  timeout: '⚠ 查询超时，暂时取不到价格',
  noSell: '暂无卖单',
  noBuy: '暂无买单',
} as const
