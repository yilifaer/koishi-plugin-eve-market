// Janice 估价卡片：编号、市场、计价方式、比例、三个价格、物品种类和件数、主要物品（有中文名的写中文）、体积、价格时间、到期、
// 没认出的行数；清单太长没发完的行数、「网页截图」按钮由调用方传进来。
// 回复里不写网址；Janice 给的市场名、物品名先过 safeEcho；备注（comment）和原始清单（input）core 里就没读，这里更不会有。

import type { JaniceDesignation, JaniceItem, JanicePricing, JanicePricingVariant, JaniceView } from '../../core/types'
import type { Card, Line } from '../view/card'
import { escapeMarkdown, safeEcho } from '../view/escape'
import { emptyCard } from './context'
import type { Invocation } from './context'
import { timeText } from './kill'
import { JANICE } from './text'

const PRICING: Record<JanicePricing, string> = { buy: '收购', sell: '出售', split: '中间', purchase: '采购' }
const VARIANT: Record<JanicePricingVariant, string> = { immediate: '即时价', top5percent: '前 5% 均价' }
const DESIGNATION: Record<JaniceDesignation, string | null> = { appraisal: null, wtb: '求购清单', wts: '出售清单' }

/** 卡片上最多列几种物品（按出售小计从高到低） */
const SHOWN_ITEMS = 5

export interface JaniceCardExtras {
  /** 因为回复条数放不下而没发的清单行数 */
  omitted: number
  /** 放「网页截图」按钮 */
  shotButton: boolean
}


/** 90% / 93.5%，最多两位小数 */
export function percentText(p: number): string {
  return `${Number((p * 100).toFixed(2))}%`
}

function itemLine(inv: Invocation, i: JaniceItem): Line {
  const name = i.zh && i.zh !== i.en ? `${safeEcho(i.zh)} ${safeEcho(i.en)}` : safeEcho(i.en)
  return { text: `${name} × ${inv.core.format.quantity(i.amount)}` }
}

function mainItems(inv: Invocation, view: JaniceView): Line[] {
  const top = [...view.items].sort((a, b) => b.prices.sell - a.prices.sell).slice(0, SHOWN_ITEMS)
  const lines = top.map((i) => itemLine(inv, i))
  if (view.items.length > top.length) lines.push({ text: `另有 ${view.items.length - top.length} 种` })
  return lines
}

export function janiceCard(inv: Invocation, view: JaniceView, extras: JaniceCardExtras): Card {
  const card = emptyCard(`**Janice 估价 ${escapeMarkdown(view.code)}**`)
  const how = [
    view.market ? safeEcho(view.market) : null,
    view.pricing ? PRICING[view.pricing] : null,
    view.variant ? VARIANT[view.variant] : null,
    view.designation ? DESIGNATION[view.designation] : null,
  ].filter((s): s is string => !!s)
  if (how.length) card.meta.push(how.join(' · '))
  if (view.percentageGuessed) card.meta.push(JANICE.guessed)
  else if (view.percentage !== 1) card.meta.push(`按这份估价设定的 ${percentText(view.percentage)}`)

  const fmt = inv.core.format
  const prices: Line[] = [
    { label: '出售', price: fmt.isk(view.totals.sell) },
    { label: '收购', price: fmt.isk(view.totals.buy) },
    { label: '中间', price: fmt.isk(view.totals.split) },
  ]
  card.sections.push({ lines: prices })

  const info: Line[] = [{ text: `物品：${view.itemTypes} 种，共 ${fmt.quantity(view.units)} 件` }]
  if (view.packagedVolume !== null) info.push({ text: `打包体积：${fmt.volume(view.packagedVolume)}` })
  if (view.datasetAt !== null) info.push({ text: `价格时间：${timeText(view.datasetAt)}` })
  if (view.expiresAt !== null) info.push({ text: `到期：${timeText(view.expiresAt)}` })
  if (view.failedLines > 0) info.push({ text: `有 ${view.failedLines} 行 Janice 没认出来` })
  if (extras.omitted > 0) info.push({ text: `清单太长，另有 ${extras.omitted} 行没发` })
  card.sections.push({ heading: '估价信息', lines: info })

  const items = mainItems(inv, view)
  if (items.length) card.sections.push({ heading: '主要物品', lines: items })

  if (extras.shotButton) card.actions.push([{ label: JANICE.shotButton, command: { id: 'shot', args: `janice ${view.code}` } }])
  return card
}

