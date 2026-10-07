// EFT 装配（§6.5.3）：
//   [Raven, 刷怪乌鸦]                          表头：船 1 件
//   [Empty High slot]                          方括号行跳过
//   Ballistic Control System II /OFFLINE       去掉离线标记
//   Cruise Missile Launcher II, Scourge Cruise Missile   模块 1 件 + 装填的弹药（数量由 appraise 按容量算）
//   Hobgoblin II x5                            无人机、弹药、货柜：名称 xN
//   Entropic Radiation Sink II [1]             突变装备：去掉 [n]，按基础型号估价
//   [1] Entropic Radiation Sink II             突变属性段：到下一个空行为止都跳过
// 这里只认单行，段落状态（属于哪个装配、是否在突变属性段里）由 paste 维护。

import { explicitQuantity } from './quantity'

const HEADER = /^\[([^,\]]+),\s*(.*)\]$/
const BRACKET_LINE = /^\[.*\]$/
const MUTATION_BLOCK = /^\[\d+\]\s*\S/
const MUTATED_SUFFIX = /\s*\[\d+\]$/
/** 行尾的离线标记（中文客户端的写法待实测，先认「离线」） */
const OFFLINE_SUFFIX = /\s*\/\s*(?:offline|离线)$/i

export function eftHeader(line: string): { ship: string; name: string } | undefined {
  const m = HEADER.exec(line)
  return m ? { ship: m[1].trim(), name: m[2].trim() } : undefined
}

/** [Empty High slot]、[空槽位] 这类方括号行 */
export function isBracketLine(line: string): boolean {
  return BRACKET_LINE.test(line)
}

/** 突变属性段的开头：[1] Entropic Radiation Sink II */
export function isMutationBlockStart(line: string): boolean {
  return MUTATION_BLOCK.test(line)
}

export type EftItem =
  | { role: 'module'; name: string; loadedCharge?: string; mutated: boolean }
  | { role: 'cargo'; name: string; quantity: number; mutated: boolean }
  | { role: 'bad-quantity' }

/** 装配里的一行物品（已经规范化，不是表头、方括号行或突变属性段） */
export function eftItem(line: string): EftItem {
  let text = line.replace(OFFLINE_SUFFIX, '')
  const mutated = MUTATED_SUFFIX.test(text)
  text = text.replace(MUTATED_SUFFIX, '')
  // 先认「名称 xN」：货柜里的物品名可能带逗号（Exotic Dancers, Male x10），不能当成装填弹药
  const cargo = explicitQuantity(text)
  if (cargo === 'bad') return { role: 'bad-quantity' }
  if (cargo) return { role: 'cargo', name: cargo.name, quantity: cargo.quantity, mutated }
  const comma = text.indexOf(',')
  if (comma > 0) {
    const name = text.slice(0, comma).trim()
    const charge = text.slice(comma + 1).trim()
    if (name) return charge ? { role: 'module', name, loadedCharge: charge, mutated } : { role: 'module', name, mutated }
  }
  return { role: 'module', name: text.trim(), mutated }
}
