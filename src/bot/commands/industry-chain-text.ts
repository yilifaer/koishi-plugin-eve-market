// 拆到原料（0.0.5）用到的中文文字：总览卡、分层明细、原料清单、按钮。物品名、地点名由调用方先转义。
// 和 industry-text.ts 分开放，那边不动。

import { CHAIN_MAX_TYPES } from '../../constants'
import type { AlchemyMode, ChainNode, LayerMode } from '../../core/types'

/** 层的叫法 */
export const LAYER_NAME: Record<ChainNode['layer'], string> = {
  product: '成品', component: '组件', other: '其他', reaction2: '高级反应', reaction1: '低级反应',
}

export const MODE_NAME: Record<LayerMode, string> = { build: '造', buy: '买' }
export const ALCHEMY_NAME: Record<AlchemyMode, string> = { auto: '自动', normal: '不用', alchemy: '能用就用' }

export const CH = {
  // ---------------------------------------------------------------- 标题和按钮
  overviewTitle: '拆到原料',
  detailTitle: '分层明细',
  materialsTitle: (name: string) => `**${name} · 原料清单**`,
  btnDetails: '分层明细',
  btnMaterials: '原料清单',
  btnMore: '继续拆',
  btnOverview: '返回总览',
  btnLocation: '换地点',
  btnProductOnly: '只算成品',
  btnLayer: (layer: 'reaction' | 'component', mode: LayerMode) => `${layer === 'reaction' ? '反应' : '组件'}:${MODE_NAME[mode]}`,

  // ---------------------------------------------------------------- 总览卡
  noPlace: '没写地点，不计建筑加成和安装费',
  modes: (reaction: string, component: string, other: string, alchemy: string) => `${reaction} · 组件 ${component} · 其他 ${other} · 炼金 ${alchemy}`,
  modeReaction: (mode: string) => `反应 ${mode}`,
  modeReactionSplit: (low: string, high: string) => `低级反应 ${low} · 高级反应 ${high}`,
  productLine: (structure: string) => `成品 ${structure}`,
  jobFees: '安装费和税',
  noJobFees: '未计安装费用',
  layerLine: (name: string, count: number, build: string, buy: string | undefined, where: string) =>
    `${name} ${count} 种 · 自己造（材料按市价）${build}${buy ? `（直接买约 ${buy}）` : ''}${where ? ` · ${where}` : ''}`,
  // 反应、组件有切换按钮；「其他」层没有按钮，只能在命令里改
  layerTooSmall: (word: string, button: boolean) => `⚠ 量太少，整批造不划算，可以${button ? '点' : '改成'}「${word}:买」`,
  layerNoSum: '各层金额不能相加，总成本见下',
  layerUnused: (name: string, reasons: string) => `${name}（${reasons}直接买，没有用到）`,
  alchemyLine: (count: number, compare: string) => `炼金 ${count} 种${compare ? `：${compare}` : ''}`,
  alchemyAt: (building: string, place: string, pct: string) => `提炼：${building}（${place}）税 ${pct}`,
  alchemyNone: '炼金 0 种：都是正常路线更划算',
  alchemyMissing: '炼金缺价格，没法比',
  alchemyNoneSome: (normal: number, missing: number) => `炼金 0 种：${normal} 种是正常路线更划算，${missing} 种炼金缺价格，没法比`,
  alchemyCheaper: (diff: string) => `比正常省 ${diff}`,
  alchemyDearer: (diff: string) => `比正常贵 ${diff}`,
  alchemyMoreTime: (time: string) => `多 ${time}`,
  alchemyLessTime: (time: string) => `少 ${time}`,
  alchemyNoCompare: '正常路线缺价格，没法比',
  reactionAway: (place: string, asked: string) => `反应在 ${place}（${asked} 没有精炼厂）`,
  buyLine: (parts: string[]) => `直接买：${parts.join(' · ')}`,
  buyRaw: (n: number) => `原料 ${n} 种`,
  buyMiddle: (n: number, names: string) => `半成品 ${n} 种（${names}）`,
  buyCannot: (n: number) => `没地方造 ${n} 种`,
  noPrice: '缺价格',
  timeLine: (parts: string[]) => `时间（未计技能，每层一条线）：${parts.join(' · ')}`,
  timeNote: '按每层 1 条生产线算，多开可以更快',
  timeTotal: (time: string) => `合计 ${time}`,
  profitIncomplete: '价格不全，利润不计算',
  inventionNote: 'T2 发明成本不计入',
  scrapNote: (pct: string) => `炼金按废料 ${pct}% 规则计算`,

  // ---------------------------------------------------------------- 分层明细
  detailHead: (layer: string, where: string) => `${layer} · ${where}`,
  detailAway: (place: string, asked: string) => `反应在 ${place}（${asked} 没有精炼厂）`,
  detailMeTe: (me: number, te: number) => `ME${me} TE${te}`,
  detailBatches: (activity: 'manufacturing' | 'reaction', runs: string) => `${runs} ${activity === 'reaction' ? '批' : '流程'}`,
  detailLine: (name: string, need: string, how: string, surplus: string, cost: string) =>
    `${name} 需 ${need} · ${how}${surplus ? ` · 多出 ${surplus}` : ''} · ${cost}`,
  detailAlchemy: (runs: string) => `炼金 ${runs} 批`,
  detailNormal: (runs: string) => `正常 ${runs} 批`,
  detailAlchemyDearer: (diff: string) => `（炼金贵 ${diff}）`,
  detailAlchemyCheaper: (diff: string) => `（炼金省 ${diff}）`,
  detailNote: '都是整批生产，多出的不抵成本。',

  // ---------------------------------------------------------------- 原料清单
  offsetLine: (name: string, n: string) => `${name} −${n}（炼金副产品）`,
  offsetAll: (name: string, n: string) => `${name} −${n}（炼金副产品，不用买）`,
  surplusLine: (list: string) => `炼金多出（不计价）：${list}`,
  fallbackNote: (side: string) => `† 部分材料按备用市场${side}`,

  // ---------------------------------------------------------------- 提示和出错
  slow: '⏳ 正在拆到原料…',
  disabled: '拆到原料暂时关闭。',
  tooBig: `要拆的东西太多了（超过 ${CHAIN_MAX_TYPES} 种），拆不了。可以加「组件:买」或「反应:买」少拆几层再试。`,
} as const
