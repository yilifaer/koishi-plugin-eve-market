// 卡片模型：所有结果类消息先拼成 Card，再由 view 分别输出成 QQ Markdown、纯文字和按钮。
//
// 文本字段（title、meta、heading、label、text、footer 等）是 Markdown 片段：只允许 **粗体**，
// 纯文字渲染时去掉。物品名、用户输入等动态内容由生成卡片的一方先转义（回显用户的文字一律经过 safeEcho）。

import type { CommandId } from '../../constants'
import type { Clickable, FormattedPrice, NumberStyle } from '../../core/types'

/** 「哪个命令 + 参数」；命令名在渲染时从已注册的 Command 取，所有者在指令管理里改名后按钮跟着变 */
export interface CommandRef {
  id: CommandId
  /** 命令名后面的部分，例如「乌鸦级 月」；可以含换行以外的任何字符 */
  args?: string
}

export interface Card {
  /** **乌鸦级** Raven · 战列舰 */
  title: string
  /** 元信息行、「按「X」查询」 */
  meta: string[]
  sections: Section[]
  /** 警告行，不带警告符号（view 统一加） */
  warnings: string[]
  /** 欧服 · 更新于 14:20 · …；空字符串 = 没有页脚（也不画分割线） */
  footer: string
  /** 告示，最多 2 条 */
  notices: string[]
  /** 选项型（编号按钮 + 编号待办） */
  choices?: Choice[]
  /** 动作型，按行分组（最多 4 行，每行 ≤ 4 个） */
  actions: Action[][]
  /** 紧跟着单独发的纯文本（本群ID、多买清单） */
  copyBlocks?: string[]
}

export interface Section {
  heading?: string
  /** 小标题后面的说明，例如「18 分钟前」「1 小时前（同步异常）」 */
  badge?: string
  /** bullet（默认）= 无序列表；ordered = 1. 2. 3.；plain = 不是列表，逐行普通文字 */
  style?: 'bullet' | 'ordered' | 'plain'
  lines: Line[]
}

/** indent 1 = 嵌套一层（Markdown 里缩进 4 个空格）；count = 价格后面的数量说明（在售约 5 个），永远是普通文字，不进粗体 */
export type Line =
  | { label: string; price?: FormattedPrice; extra?: string; count?: string; indent?: 0 | 1 }
  | { text: string; indent?: 0 | 1 }

export interface Choice {
  no: number
  label: string
  detail?: string
  command: CommandRef
  /** 按钮上写的字（纯文字）；不给时按钮上是编号 */
  button?: string
}

export interface Action {
  label: string
  command: CommandRef
  /** 蓝色按钮 */
  primary?: boolean
  /** 只填命令名加一个空格，让用户接着输入（忽略 args） */
  fillOnly?: boolean
}

/** 发给适配器的一个按钮：type input（指令按钮），点了把 text 填进输入框 */
export interface KeyboardButton {
  label: string
  text: string
  primary?: boolean
}

export type KeyboardRow = KeyboardButton[]

export interface CardRenderOptions {
  numberStyle: NumberStyle
  clickable: Clickable
  /** 列表项写成 <qqbot-cmd-input>（常量 CMD_INPUT_IN_LISTS） */
  cmdInputInLists: boolean
  /**
   * 命令当前的名字（已注册的 Command 主名）。help 例外：注册的是隐藏命令 HELP_COMMAND，这里返回 HELP_WORDS[0]，
   * 由前置中间件改写。「帮助 查价」这种 args 里的命令名也要用这个函数取
   */
  commandName(id: CommandId): string
}
