// 拆到原料的集成测试共用：小数据集里的猎犬级（T2）一路拆到月矿元素，数据里每一种物品都在 Jita 4-4 挂单。
// 地点、建筑名是编造的（XX-1 …），星系和物品是公共数据。

import { expect } from 'vitest'
import { MAX_BUTTON_COMMAND_CHARS, MAX_BUTTON_LABEL, MAX_MESSAGE_CHARS } from '../../../src/constants'
import { labelWidth } from '../../../src/bot/view/clickable'
import { loadFixtureData } from '../../fixtures/data/load'
import type { Sent } from '../../harness'
import { THE_FORGE, addOrders, jitaOrders } from './plugin-env'
import type { PluginEnv } from './plugin-env'
import { startIndustry } from './industry-env'
import type { IndustryEnvOptions } from './industry-env'

export const HOUND = '猎犬级'

/** 配方里出现的每一种物品（材料和产物） */
function recipeItems(): number[] {
  const { industry } = loadFixtureData()
  const ids = new Set<number>()
  for (const bp of [...industry.manufacturing.values(), ...industry.reactions.values()]) {
    for (const m of bp.materials) ids.add(m.typeId)
    for (const p of bp.products) ids.add(p.typeId)
  }
  return [...ids]
}

/** 每种物品一个略有不同的出售价（免得合计恰好相等），调整价同理 */
export const priceOf = (id: number) => 100 + (id % 17)
export const adjustedOf = (id: number) => 50 + (id % 13)

export function startChain(options: IndustryEnvOptions = {}): Promise<PluginEnv> {
  const { esi, ...rest } = options
  return startIndustry({
    ...rest,
    esi: (fake) => {
      const ids = recipeItems()
      for (const id of ids) addOrders(fake, THE_FORGE, jitaOrders(id, priceOf(id), null, { volume_remain: 1e9 }))
      fake.prices = ids.map((id) => ({ type_id: id, adjusted_price: adjustedOf(id) }))
      esi?.(fake)
    },
  })
}

/** QQ 的限制：每条 ≤ 3,500 字，按钮 ≤ 4 行、标签 ≤ 8 个字宽、命令 ≤ 100 字 */
export function expectLimits(sent: Sent[]) {
  for (const s of sent) {
    expect((s.markdown ?? s.text).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(s.rows.length).toBeLessThanOrEqual(4)
    for (const row of s.rows) {
      for (const b of row) {
        expect(labelWidth(b.label)).toBeLessThanOrEqual(MAX_BUTTON_LABEL)
        expect(b.text.length).toBeLessThanOrEqual(MAX_BUTTON_COMMAND_CHARS)
      }
    }
  }
}
