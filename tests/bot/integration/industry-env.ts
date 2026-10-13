// 制造、制造比价、反应的集成测试共用：工业地点和建筑的配置、假 ESI 上的报价、星系成本指数和调整价。
// 地点名、建筑名、税率、价格、指数都是编造的（XX-1、联盟工业点A、大厂……）；星系、空间站、物品是公共数据。

import { GROUP } from '../../harness'
import type { FakeEsi } from '../../fakes/fake-esi'
import { THE_FORGE, addOrders, jitaOrders, startPlugin } from './plugin-env'
import type { EnvOptions, PluginEnv } from './plugin-env'

export const NIH_02 = 30000900
export const TAMA = 30002813
export const PERIMETER = 30000144

export const RAVEN = 638
export const TUNGSTEN_CARBIDE = 16672
export const DAMAGE_CONTROL_II = 2048

/** 乌鸦级的材料和成品在 Jita 4-4 的出售价 */
export const RAVEN_SELL: Record<number, number> = {
  34: 4, 35: 20, 36: 95, 37: 160, 38: 820, 39: 1450, 40: 2600, 57478: 6500, 57479: 3_200_000, 57486: 41_000, [RAVEN]: 258_400_000,
}

/** 碳化钨的材料和产物 */
export const CARBIDE_SELL: Record<number, number> = { 4051: 18_000, 16657: 3_000, 16661: 650, [TUNGSTEN_CARBIDE]: 52 }

/** 损伤控制 II 的材料和成品（莫尔石故意没有卖单） */
export const DC2_SELL: Record<number, number> = {
  11553: 30_000, 3689: 1_200, 11695: 40_000, 11475: 9_000, 3828: 1_500, 11542: 35_000, 11540: 25_000, 2046: 60_000, [DAMAGE_CONTROL_II]: 900_000,
}

export const ADJUSTED: Record<number, number> = {
  34: 4, 35: 10, 36: 50, 37: 300, 38: 1000, 39: 2500, 40: 2500, 57478: 10_000, 57479: 350_000, 57486: 12_000,
  4051: 15_000, 16657: 2_500, 16661: 600,
}

export const LOCATIONS = [
  { name: 'XX-1', aliases: '联盟工业点A', system: 'NIH-02', visibility: 'allowed', isDefault: true },
  { name: 'XX-2', system: 'Tama', visibility: 'public', defaultME: 8, defaultTE: 16 },
  { name: 'XX-3', system: 'Perimeter', visibility: 'public' },
]

export const STRUCTURES = [
  { location: 'XX-1', name: '大厂', structureType: 'Sotiyo', rigs: '37180', facilityTaxPct: 1, isDefault: true },
  { location: 'XX-1', name: '小厂', structureType: 'Raitaru', facilityTaxPct: 0.5 },
  { location: 'XX-1', name: '反应塔', structureType: 'Athanor', activities: 'reaction', rigs: '46484', facilityTaxPct: 1.5 },
  { location: 'XX-2', name: '中厂', structureType: 'Azbel', facilityTaxPct: 2, extraFeePct: 1, extraFeeLabel: '联盟管理费' },
  { location: 'XX-2', name: '反应厂', structureType: 'Athanor', activities: 'reaction', facilityTaxPct: 1 },
  { location: 'XX-3', name: '高安厂', structureType: 'Raitaru', facilityTaxPct: 1, rigs: '37146' },
]

export const INDUSTRY = { locations: LOCATIONS, structures: STRUCTURES }
export const ALLOWED = { allowedGroups: [{ groupId: GROUP, enabled: true }] }

/** 星域订单（Jita 4-4）、星系成本指数、调整价 */
export function industryEsi(fake: FakeEsi, extra?: (fake: FakeEsi) => void) {
  const sells = { ...RAVEN_SELL, ...CARBIDE_SELL, ...DC2_SELL }
  for (const [id, price] of Object.entries(sells)) addOrders(fake, THE_FORGE, jitaOrders(Number(id), price, null, { volume_remain: 1e9 }))
  fake.industrySystems = [
    { solar_system_id: NIH_02, cost_indices: [{ activity: 'manufacturing', cost_index: 0.0231 }, { activity: 'reaction', cost_index: 0.0185 }] },
    { solar_system_id: TAMA, cost_indices: [{ activity: 'manufacturing', cost_index: 0.012 }, { activity: 'reaction', cost_index: 0.01 }] },
    { solar_system_id: PERIMETER, cost_indices: [{ activity: 'manufacturing', cost_index: 0.0302 }] },
  ]
  fake.prices = Object.entries(ADJUSTED).map(([id, adjusted]) => ({ type_id: Number(id), adjusted_price: adjusted }))
  extra?.(fake)
}

export interface IndustryEnvOptions extends EnvOptions {
  /** 控制台「工业」分组（默认三个地点、六座建筑） */
  industry?: Record<string, unknown>
}

export function startIndustry(options: IndustryEnvOptions = {}): Promise<PluginEnv> {
  const { industry, config, esi, ...rest } = options
  return startPlugin({
    ...rest,
    config: { access: ALLOWED, industry: industry ?? INDUSTRY, ...config },
    esi: (fake) => industryEsi(fake, esi),
  })
}
