// 入侵（§2.9）：当前所有入侵，按集结星系的安全等级排（高安 → 低安 → 00）。名字全部来自星图数据，
// 数据里缺的 ID 显示 ID 本身；被入侵星系逐个列出（太长时截断）。所有入侵是同一个势力时写在页脚，
// 不是时写在每处的小标题后面。没有按钮；没有入侵时一句话。

import { INCURSION_LIST_SYSTEMS, SERVER_LABEL } from '../../constants'
import { displaySec, roundHalfAway } from '../../core/format'
import { isFailure } from '../../core/types'
import type { Incursion, IncursionsResult, NamePair, SecClass } from '../../core/types'
import type { Card, Section } from '../view/card'
import { escapeMarkdown } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { INCURSION, SAY, SEC_CLASS } from './text'

export function registerIncursion(commands: CommandContext): void {
  commands.registry.register('incursion', { description: '入侵：当前所有入侵的位置、状态和影响力' })
    ?.action(async ({ session }) => {
      if (!session) return
      await invoke(commands, 'incursion', session, runIncursion)
    })
}

async function runIncursion(inv: Invocation): Promise<void> {
  const result = await inv.core.universe.incursions()
  if (isFailure(result)) {
    if (result.code === 'DATA_NOT_READY') {
      await inv.reply.text(SAY.loading)
      return
    }
    if (result.code !== 'UPSTREAM_UNAVAILABLE') inv.commands.logger.warn(`入侵失败：${result.code} ${result.message ?? ''}`)
    await inv.reply.text(INCURSION.esiDown)
    return
  }
  if (!result.incursions.length) {
    await inv.reply.text(INCURSION.none)
    return
  }
  await sendCard(inv, incursionCard(inv, result))
}

/** 被入侵星系连成一行时默认最多这么多字，再多写「…」 */
export const INCURSION_SYSTEMS_MAX_CHARS = 200

/** 影响力 0–1 → 「64.0%」：总是 1 位小数 */
export function formatInfluence(influence: number): string {
  const pct = Number.isFinite(influence) ? Math.min(1, Math.max(0, influence)) * 100 : 0
  return `${roundHalfAway(pct, 1).toFixed(1)}%`
}

/** 被入侵星系连成一行（「、」分隔）。超过 maxChars 时只列放得下的整个名字，后面接「、…」；至少列一个 */
export function joinSystems(names: readonly string[], maxChars = INCURSION_SYSTEMS_MAX_CHARS): string {
  const all = names.join('、')
  if (all.length <= maxChars) return all
  const tail = '、…'
  let line = names[0] ?? ''
  for (const name of names.slice(1)) {
    if (line.length + 1 + name.length + tail.length > maxChars) break
    line += `、${name}`
  }
  return line + tail
}

/** 中文名，没有时（代号星系、数据里缺的 ID）用英文 */
const nameOf = (pair: NamePair) => escapeMarkdown(pair.zh || pair.en)

/** 安斯拉 0.9；安全等级不知道时只写名字 */
function systemText(system: NamePair & { security: number }): string {
  const sec = displaySec(system.security)
  return sec ? `${nameOf(system)} ${sec}` : nameOf(system)
}

/** 高安 1 · 低安 1 · 00 1（没有的不写） */
function classSummary(list: readonly Incursion[]): string {
  const order: SecClass[] = ['high', 'low', 'null']
  return order
    .map((c) => [c, list.filter((i) => i.secClass === c).length] as const)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${SEC_CLASS[c]} ${n}`)
    .join(' · ')
}

/** 所有入侵是同一个势力时返回它 */
function commonFaction(list: readonly Incursion[]): NamePair | null | undefined {
  const first = list[0]?.faction ?? null
  return list.every((i) => (i.faction?.id ?? null) === (first?.id ?? null)) ? first : undefined
}

export function incursionCard(inv: Pick<Invocation, 'core'>, result: IncursionsResult): Card {
  const list = result.incursions
  const card = emptyCard(INCURSION.title(list.length, classSummary(list)))
  const common = commonFaction(list)
  list.forEach((incursion, i) => card.sections.push(incursionSection(incursion, i + 1, common === undefined)))
  const time = result.dataTime === null ? '' : `更新于 ${inv.core.format.clock(result.dataTime)}${result.stale ? INCURSION.cached : ''}`
  const faction = common ? INCURSION.faction(nameOf(common)) : ''
  card.footer = [SERVER_LABEL, faction, time].filter(Boolean).join(' · ')
  return card
}

function incursionSection(incursion: Incursion, no: number, withFaction: boolean): Section {
  const badge = [
    incursion.region ? nameOf(incursion.region) : '',
    SEC_CLASS[incursion.secClass],
    withFaction && incursion.faction ? nameOf(incursion.faction) : '',
  ].filter(Boolean).join(' · ')
  const lines = []
  if (incursion.staging) lines.push({ text: INCURSION.staging(systemText(incursion.staging)) })
  lines.push({ text: INCURSION.state(INCURSION.stateNames[incursion.state], formatInfluence(incursion.influence), incursion.hasBoss) })
  const systems = incursion.systems
  if (systems.length) {
    lines.push({
      text: INCURSION_LIST_SYSTEMS
        ? INCURSION.systems(systems.length, joinSystems(systems.map(nameOf)))
        : INCURSION.systemCount(systems.length),
    })
  }
  return { heading: `${no}. ${nameOf(incursion.constellation)}`, badge, lines }
}
