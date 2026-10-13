// 制造、制造比价、反应（§2.6–§2.8）用到的中文文字。物品名、地点名、用户的原话由调用方先转义（回显用户的文字经过 safeEcho）。

import { MAX_ME, MAX_RUNS, MAX_TE, PENDING_MINUTES } from '../../constants'
import type { FailureReason, IndustryActivity, PriceSide } from '../../core/types'

/** 活动的叫法 */
export const ACTIVITY: Record<IndustryActivity, string> = { manufacturing: '制造', reaction: '反应' }

/** 卡片上的「Jita 4-4 出售」 */
export const SIDE_SHORT: Record<PriceSide, string> = { sell: '出售', mid: '中间', buy: '收购' }

/** 某一边没有价格时 */
export const SIDE_NONE: Record<PriceSide, string> = { sell: '暂无卖单', mid: '—', buy: '暂无买单' }

/** 参数写错（BAD_ARGUMENT 的 reason） */
export const BAD_ARG: Partial<Record<FailureReason, string>> = {
  'quantity': '数量要是正整数',
  'me-range': `ME 只能是 0–${MAX_ME}`,
  'te-range': `TE 只能是 0–${MAX_TE}`,
  'runs-range': `流程数只能是 1–${MAX_RUNS}`,
  'tax-range': '税率要写成「税:1.5%」（0–100）',
  'rig-option': '改装件只能写「改装:默认」或「改装:无」',
  'chain-option': '炼金、正常、自动只能写在「反应:」或「低级反应:」后面',
}

export const IND = {
  // ---------------------------------------------------------------- 标题
  baseTitle: (activity: IndustryActivity) => `${ACTIVITY[activity]} · 基础参考`,
  resultTitle: (activity: IndustryActivity) => (activity === 'manufacturing' ? '高级制造计算' : '反应计算'),
  stepTitle: (name: string, activity: IndustryActivity) => `**${name} · 高级${ACTIVITY[activity]}计算**`,
  materialsTitle: (name: string) => `**${name} · 材料清单**`,
  compareTitle: (name: string) => `**${name} · 制造地点比价**`,
  usageTitle: (command: string) => `**${command}用法**`,

  // ---------------------------------------------------------------- 基础参考
  baseScope: '无建筑、无改装件 · 未计星系成本指数和税',
  baseNote: '> 仅供参考：没有计算星系的星系成本指数、建筑、改装件和税费。',
  topMaterials: (list: string) => `主要材料：${list}`,
  allMaterials: (n: number, button: string) => `共 ${n} 种，点「${button}」看全部`,
  perRunOutput: (n: string, unit: string) => `每流程产出 ${n} ${unit}`,
  materialsAt: (market: string, side: string) => `材料按 ${market} ${side}`,
  recipe: (name: string, time: string, n: string) => `配方 ${name} · 每流程 ${time}，产出 ${n} 个`,
  outputMaterials: (runs: number) => (runs === 1 ? '每流程材料' : `${runs} 流程材料`),
  outputValue: (runs: number) => (runs === 1 ? '每流程产出价值' : `${runs} 流程产出价值`),
  perUnit: (market: string, side: string, unit: string) => `${market} ${side} ${unit}/个`,

  // ---------------------------------------------------------------- 结果
  blueprint: (me: number, te: number) => `蓝图 ME ${me} / TE ${te}`,
  runs: (runs: string, n: string, unit: string) => `${runs} 流程（${n} ${unit}）`,
  noStructure: '无建筑加成',
  autoPicked: (name: string) => `自动选择：${name}`,
  rigsApplied: (list: string) => `改装件 ${list}`,
  rigEffect: (name: string, parts: string) => `${name}（${parts}）`,
  rigsNone: '改装件 不用（改装:无）',
  rigsNotInstalled: '改装件 未装',
  rigsNoMatch: (product: string) => `改装件：无适用（该建筑没有对${product}${/[\w)]$/.test(product) ? ' ' : ''}生效的改装件）`,
  sci: (pct: string) => `星系成本指数 ${pct}`,
  facilityTax: (pct: string) => `设施税 ${pct}`,
  scc: (pct: string) => `SCC 附加费 ${pct}`,
  defaulted: {
    location: '（本群唯一的地点）',
    meTe: '（地点默认）',
    meTeT2: '（T2 常见值）',
    structure: '（默认建筑）',
    structureOnly: '（该地点唯一）',
  },
  materialCost: '材料成本',
  eivCost: '基础物品成本',
  sciCost: (pct?: string) => (pct ? `星系成本指数 ${pct}` : '星系成本指数'),
  facilityCost: (pct?: string) => (pct ? `设施税 ${pct}` : '设施税'),
  sccCost: (pct?: string) => (pct ? `SCC 附加费 ${pct}` : 'SCC 附加费'),
  extraCost: '其他费用',
  totalCost: '**预计总成本**',
  incomplete: (n: number) => `（不完整，缺 ${n} 种材料价格）`,
  noJobCost: '（未计安装费用）',
  time: (activity: IndustryActivity) => (activity === 'manufacturing' ? '制造时间' : '反应时间'),
  timeBase: (max?: string) => (max ? `（未计技能；满技能约 ${max}）` : '（未计技能）'),
  timeMax: (max: string) => `（满技能约 ${max}）`,
  timeNoSkill: '（未计技能）',
  timeBlueprint: (te: number, pct: string) => `蓝图 TE ${te} ${pct}`,
  timeSkills: (pct: string) => `技能和植入体（按技能全 5 级，不算植入体）${pct}`,
  timeRigs: (pct: string) => `已安装的改装件 ${pct}`,
  timeStructure: (pct: string) => `建筑持有加成 ${pct}`,
  timeMaxSkill: (max: string) => `满技能约 ${max}`,
  timeLine: '一条生产线连续生产',
  reactionTime: (perRun: string, total: string) => `每流程 ${perRun} · 共 ${total}`,
  product: (market: string, side: string) => `成品 ${market} ${side}`,
  productNone: (market: string, none: string) => `成品 ${market} ${none}`,
  productEach: (n: string, unit: string, each: string) => `（${n} ${unit}，单价 ${each}）`,
  output: (n: string, market: string, side: string) => `产出 ${n} 个 · ${market} ${side}`,
  profit: (profit: string, margin: string) => `**预计利润 ${profit} · 利润率 ${margin}**`,
  profitNoFees: '（未计销售税和经纪费）',
  profitFees: (pct: string) => `（已扣销售税和经纪费 ${pct}）`,
  profitIncomplete: '（成本不完整）',
  missingPrices: (list: string, total: number, listed: number) =>
    `以下材料没有价格：${list}${total > listed ? ` 等 ${total} 种` : ''}，总成本不完整`,
  fallbackMark: '†',
  fallbackNote: (source: string) => `† 部分材料按 ${source}`,
  footerPrices: (at: string) => `价格更新于 ${at}`,
  footerIndices: (at: string) => `星系成本指数更新于 ${at}`,
  footerAdjusted: (at: string) => `调整价更新于 ${at}`,
  cached: '（缓存）',

  // ---------------------------------------------------------------- 材料清单
  materialsTotal: '**材料合计**',
  missingPrice: '缺价格',
  pasteNext: '下一条消息可以直接粘贴到游戏的「多重购买」窗口。',

  // ---------------------------------------------------------------- 逐步选择
  progress: (parts: string) => `进度：${parts}`,
  selected: (parts: string) => `已选：${parts}`,
  steps: { location: '地点', mete: 'ME/TE', structure: '建筑' },
  askLocation: (activity: IndustryActivity) => `请选择${ACTIVITY[activity]}地点：`,
  askMeTe: '请选择蓝图的材料效率 ME（满级 10，越高越省材料）和时间效率 TE（满级 20，越高越快）：',
  customMeTe: '其他组合：点「自定义」在末尾补上数字（例如 ME7 TE14）再发送，或者 @我 回复「ME7 TE14」',
  askStructure: (activity: IndustryActivity) => `请选择${ACTIVITY[activity]}建筑：`,

  // ---------------------------------------------------------------- 比价
  recommended: '（推荐）',
  autoMark: '（自动选择）',
  compareUnable: (count: number, need: string) => `另有 ${count} 个地点造不了（需要${need}）`,
  cheapest: '💰最低',
  fastest: '⚡最快',
  noRigsInstalled: '（未装改装件）',
  noRigsMatch: '（改装件对它不生效）',
  compareRigsOff: '不用改装件',
  compareDefaults: '不写时 ME 10 / TE 20，T2 产品按 ME 2 / TE 4',
  compareCost: '成本',
  compareIncomplete: '（不完整）',
  compareProfit: (profit: string, margin: string) => `利润 ${profit}（${margin}）`,
  compareProduct: (market: string, side: string, value: string) => `成品参考 ${market} ${side} ${value}`,
  compareNoFees: '利润未计销售税和经纪费',
  compareFees: (pct: string) => `利润已扣销售税和经纪费 ${pct}`,
  compareHint: `点按钮后再按发送看完整明细，或者 @我 回复编号（${PENDING_MINUTES} 分钟内有效）`,
  detail: (name: string) => `${name} 详情`,

  // ---------------------------------------------------------------- 按钮
  quick: '快速计算',
  advanced: '高级计算',
  materials: '查看材料',
  compare: '制造比价',
  compareAgain: '比较地点',
  changeLocation: '更换地点',
  changeMeTe: '修改ME/TE',
  changeStructure: '改建筑/改装件',
  rigsOff: '不用改装件',
  compareNoChain: '比价不拆到原料',
  rigsOn: '用改装件',
  changeTax: '改税率',
  custom: '自定义',
  restDefault: '其余默认',
  directResult: '默认直接出结果',
  costDetail: '成本明细',
  basic: '基础参考',
  enterItem: '输入物品',

  // ---------------------------------------------------------------- 错误和提示
  notManufacturable: (name: string) => `${name} 没有可用的制造蓝图。`,
  notReactable: (name: string) => `${name} 没有可用的反应配方。`,
  isReaction: (name: string, command: string) => `${name} 是反应产物，请用：${command}`,
  notReaction: (name: string, command: string) => `${name} 不是反应产物，请用：${command}`,
  unknownLocation: (token: string) => `${token} 尚未配置为工业地点。`,
  wrongActivity: (name: string, activity: IndustryActivity) => `${name} 没有可以${ACTIVITY[activity]}的建筑。`,
  highsec: (name: string) => `高安不能进行反应（${name} 在高安）。`,
  locationsHere: (activity: IndustryActivity, list: string) => `本群可以${ACTIVITY[activity]}的地点：${list}`,
  noLocationsHere: (activity: IndustryActivity) => `本群还没有可以${ACTIVITY[activity]}的工业地点。`,
  cannotBuild: (place: string, activity: IndustryActivity, name: string, need: string) =>
    `${place} ${activity === 'manufacturing' ? '造' : '反应'}不了${name}：需要${need}`,
  noCapable: (activity: IndustryActivity, name: string, need: string) =>
    `本群没有能${activity === 'manufacturing' ? '造' : '反应'}${name}的工业地点：需要${need}`,
  compareTooFew: '本群可比较的工业地点不足 2 个。',
  compareTooFewNeed: (need: string) => `本群可比较的工业地点不足 2 个（其余地点造不了：需要${need}）。`,
  slowCompare: '⏳ 正在比较各个地点…',
} as const
