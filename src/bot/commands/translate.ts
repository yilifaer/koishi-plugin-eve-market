// 翻译 / 中英对照（§2.13）：物品、分组、大类、星系、星座、星域和黑话表的中英文名。
// 一个结果时写「**三钛合金 ⇄ Tritanium**」加一行说明（物品有别名时再写别名，这也是「物品别名」的查看入口）；
// 多个时列最多 10 个。没有按钮（翻译是查资料，不引导去查价）。

import { TRANSLATE_ALIAS, TRANSLATE_LIMIT } from '../../constants'
import { displaySec } from '../../core/format'
import type { TranslateEntry } from '../../core/types'
import type { Card } from '../view/card'
import { escapeMarkdown, safeEcho } from '../view/escape'
import { emptyCard, invoke, sendCard } from './context'
import type { CommandContext, Invocation } from './context'
import { TRANSLATE } from './text'

/** 别名最多列几个 */
const MAX_ALIASES = 10

export function registerTranslate(commands: CommandContext): void {
  commands.registry.register('translate', { args: '[query:text]', needsArgs: true, description: '翻译：物品、星系、黑话的中英文对照', aliases: [TRANSLATE_ALIAS] })
    ?.action(async ({ session }, query) => {
      if (!session) return
      await invoke(commands, 'translate', session, (inv) => runTranslate(inv, typeof query === 'string' ? query : ''))
    })
}

async function runTranslate(inv: Invocation, text: string): Promise<void> {
  const query = text.replace(/\s+/g, ' ').trim()
  if (!query) {
    await sendCard(inv, usageCard(inv))
    return
  }
  const result = inv.core.universe.translate(query, TRANSLATE_LIMIT)
  if (!result.entries.length) {
    // 回显的原话转义过：作为卡片发（纯文字渲染时会还原转义），不然反斜杠会显示出来
    await sendCard(inv, emptyCard(TRANSLATE.none(safeEcho(query))))
    return
  }
  await sendCard(inv, result.entries.length === 1 && result.total <= 1
    ? singleCard(result.entries[0])
    : listCard(query, result.entries, result.total))
}

/** 中文 ⇄ 英文；只有一种（代号星系没有中文名）时只写一个 */
function pair(entry: TranslateEntry): string {
  const zh = entry.zh.trim()
  const en = entry.en.trim()
  if (!zh || zh === en) return escapeMarkdown(en || zh)
  if (!en) return escapeMarkdown(zh)
  return `${escapeMarkdown(zh)} ⇄ ${escapeMarkdown(en)}`
}

const nameOf = (n: { zh: string; en: string } | undefined) => (n ? escapeMarkdown(n.zh || n.en) : '')

/** 第二行：材料 · 矿物 / 星系 · 伏尔戈 · 0.9 / 黑话 · 舰队 · 说明 */
function detail(entry: TranslateEntry): string {
  const kind = TRANSLATE.kind[entry.kind]
  switch (entry.kind) {
    case 'item':
      return [nameOf(entry.category), nameOf(entry.group)].filter(Boolean).join(' · ') || kind
    case 'group':
      return [kind, nameOf(entry.category)].filter(Boolean).join(' · ')
    case 'constellation':
      return [kind, nameOf(entry.region)].filter(Boolean).join(' · ')
    case 'system':
      return [kind, nameOf(entry.region), entry.security === undefined ? '' : displaySec(entry.security)].filter(Boolean).join(' · ')
    case 'slang':
      return [kind, escapeMarkdown(entry.slang?.category ?? ''), escapeMarkdown(entry.slang?.note ?? '')].filter(Boolean).join(' · ')
    default:
      return kind
  }
}

function singleCard(entry: TranslateEntry): Card {
  const card = emptyCard(`**${pair(entry)}**`)
  const lines = [{ text: detail(entry) }]
  const aliases = entry.aliases.filter((a) => a.trim())
  if (aliases.length) {
    const shown = aliases.slice(0, MAX_ALIASES).map(escapeMarkdown).join('、')
    lines.push({ text: TRANSLATE.aliases(aliases.length > MAX_ALIASES ? `${shown}…` : shown) })
  }
  card.meta.push(...lines.map((l) => l.text))
  return card
}

function listCard(query: string, entries: TranslateEntry[], total: number): Card {
  const card = emptyCard(TRANSLATE.found(safeEcho(query), total))
  card.sections.push({
    style: 'ordered',
    lines: entries.map((e) => ({ text: e.kind === 'item' ? pair(e) : `${pair(e)}（${TRANSLATE.kind[e.kind]}）` })),
  })
  if (total > entries.length) card.sections.push({ style: 'plain', lines: [{ text: TRANSLATE.more(total - entries.length) }] })
  return card
}

function usageCard(inv: Invocation): Card {
  const name = escapeMarkdown(inv.commands.registry.name('translate'))
  const card = emptyCard(TRANSLATE.usageTitle)
  card.sections.push({
    lines: [
      { text: `${name} 三钛合金：物品的中英文名（中文、英文、简称都可以）` },
      { text: `${name} Jita：星系、星座、星域` },
      { text: `${name} 打X：黑话表里的说法` },
    ],
  })
  return card
}
