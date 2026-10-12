// 可点元素：按钮里的命令、按钮标签、键盘的行，以及不能点时写成文字的动作。
// 命令或标签里像网址的按钮一律不发（群里发网址会被拒绝，40054010）；生成卡片的一方本来就不该放进来，这里再兜一层。

import {
  MAX_ACTIONS_PER_ROW, MAX_BUTTON_COMMAND_CHARS, MAX_BUTTON_LABEL, MAX_CHOICES_PER_ROW,
  MAX_KEYBOARD_ROWS, PENDING_MINUTES, TEXT_ACTION_LINES,
} from '../../constants'
import type { Action, Card, CardRenderOptions, CommandRef, KeyboardButton, KeyboardRow } from './card'
import { hasUrl, stripMarkdown } from './escape'

export type CommandNamer = Pick<CardRenderOptions, 'commandName'>

/** 完整命令：当前的命令名 + 参数（参数里的换行换成空格） */
export function commandText(ref: CommandRef, opts: CommandNamer): string {
  const name = opts.commandName(ref.id)
  const args = ref.args?.replace(/[\r\n]+/g, ' ').trim()
  return args ? `${name} ${args}` : name
}

/** 动作按钮填进输入框的内容；fillOnly 只填命令名加一个空格 */
export function actionCommand(action: Action, opts: CommandNamer): string {
  return action.fillOnly ? `${opts.commandName(action.command.id)} ` : commandText(action.command, opts)
}

/** 按钮标签：纯文字，不超过 8 个汉字宽（英文数字算半个）；尖括号和 & 换成全角（适配器取标签时会把它们转义成实体） */
export function buttonLabel(label: string): string {
  const plain = stripMarkdown(label)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[<>&"]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0))
  if (labelWidth(plain) <= MAX_BUTTON_LABEL) return plain
  let out = ''
  for (const ch of plain) {
    if (labelWidth(out + ch) > MAX_BUTTON_LABEL - 1) break
    out += ch
  }
  return `${out.trimEnd()}…`
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size))
  return rows
}

/** 标签的显示宽度：汉字等全角字符算 1，其他算 0.5 */
export function labelWidth(label: string): number {
  let width = 0
  for (const ch of label) width += /[\u0000-\u00ff]/.test(ch) ? 0.5 : 1
  return width
}

/**
 * 一行能放几个按钮：QQ 上一行 4 个时每个大约只显示 4 个汉字宽，再长就被截断成「查价 PL…」。
 * 按这一行里最长的标签决定：≤ 4 宽放 4 个，≤ 6 宽放 3 个，再长放 2 个
 */
function perRow(buttons: KeyboardButton[], max: number): number {
  const widest = Math.max(0, ...buttons.map((b) => labelWidth(b.label)))
  const fit = widest <= 4 ? 4 : widest <= 6 ? 3 : 2
  return Math.min(max, fit)
}

/** 平均分成 k 行，前面的行多放一个 */
function split<T>(items: T[], k: number): T[][] {
  const base = Math.floor(items.length / k)
  const extra = items.length % k
  const rows: T[][] = []
  let start = 0
  for (let i = 0; i < k; i++) {
    const size = base + (i < extra ? 1 : 0)
    rows.push(items.slice(start, start + size))
    start += size
  }
  return rows
}

/** 按标签宽度切行：找最少的行数，平均分开后每行都放得下（不会剩一个孤零零的按钮） */
function chunkByWidth(buttons: KeyboardButton[], max: number): KeyboardButton[][] {
  for (let k = Math.ceil(buttons.length / max); k < buttons.length; k++) {
    const rows = split(buttons, k)
    if (rows.every((row) => row.length <= perRow(row, max))) return rows
  }
  return buttons.map((b) => [b])
}

/** 命令超过 100 字的按钮不发（生成卡片的一方应当先换成 #typeID）；像网址的也不发 */
const usable = (button: KeyboardButton) =>
  button.text.trim().length > 0 && button.text.length <= MAX_BUTTON_COMMAND_CHARS && !hasUrl(button.text) && !hasUrl(button.label)

/** 选项按钮都写了字（不是编号） */
const labeledChoices = (card: Card) => !!card.choices?.length && card.choices.every((c) => !!c.button && !!buttonLabel(c.button))

/**
 * 选项按钮在前（编号每行 ≤ 5；写了字的和动作按钮一样每行 ≤ 4，字长的少放几个），动作按钮在后，总共 ≤ 5 行；
 * clickable = none 时没有按钮
 */
export function keyboardRows(card: Card, opts: CardRenderOptions): KeyboardRow[] {
  if (opts.clickable === 'none') return []
  const labeled = labeledChoices(card)
  const choices = (card.choices ?? [])
    .map((c): KeyboardButton => ({ label: labeled ? buttonLabel(c.button!) : String(c.no), text: commandText(c.command, opts) }))
    .filter(usable)
  const actions = card.actions
    .flatMap((row) => chunkByWidth(
      row.map((a): KeyboardButton => ({ label: buttonLabel(a.label), text: actionCommand(a, opts), ...a.primary ? { primary: true } : {} }))
        .filter((b) => b.label && usable(b)),
      MAX_ACTIONS_PER_ROW,
    ))
  return [...(labeled ? chunkByWidth(choices, MAX_ACTIONS_PER_ROW) : chunk(choices, MAX_CHOICES_PER_ROW)), ...actions]
    .filter((row) => row.length)
    .slice(0, MAX_KEYBOARD_ROWS)
}

/** 不能点时写成文字的动作：最多 2 行，蓝色的优先，只填命令名的跳过 */
export function textActions(card: Card, opts: CommandNamer): Array<{ label: string; command: string }> {
  const all = card.actions.flat().filter((a) => !a.fillOnly && !hasUrl(a.label) && !hasUrl(commandText(a.command, opts)))
  const ordered = [...all.filter((a) => a.primary), ...all.filter((a) => !a.primary)]
  return ordered.slice(0, TEXT_ACTION_LINES).map((a) => ({ label: stripMarkdown(a.label).trim(), command: commandText(a.command, opts) }))
}

/**
 * 编号列表下面的提示（纯文字，Markdown 里由调用方转义）。
 * buttons：有编号按钮；none：Markdown 但不发按钮；text：纯文字（每项已经写成「回复 @我 1：…」）
 */
export function choiceHint(card: Card, opts: CommandNamer, mode: 'buttons' | 'none' | 'text'): string {
  const valid = `${PENDING_MINUTES} 分钟内有效`
  if (mode === 'buttons') return `${labeledChoices(card) ? '点按钮' : '点下面的编号'}，或者 @我 回复编号（${valid}）`
  const first = card.choices?.[0]
  const example = first ? `，也可以直接发送「${commandText(first.command, opts)}」` : ''
  return mode === 'none' ? `@我 回复编号（${valid}）${example}` : `编号 ${valid}${example}`
}
