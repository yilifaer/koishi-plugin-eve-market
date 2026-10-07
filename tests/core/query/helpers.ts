// core/parse 的 QueryParser 测试共用：小数据集上真的物品识别器和市场注册表。

import { createMarketRegistry } from '../../../src/core/market'
import { createQueryParser } from '../../../src/core/parse'
import type { CoreFailure, ParsedQuery, QueryOptions, Resolution } from '../../../src/core/types'
import { staticDataService } from '../../fixtures/data/load'
import { fixtureResolver } from '../items/helpers'
import type { ResolverSetup } from '../items/helpers'
import { PUBLIC, settingsOf } from '../market/helpers'

export function setup(raw: Record<string, unknown> = {}, resolver: ResolverSetup = {}) {
  const settings = settingsOf(raw)
  const items = fixtureResolver({ aliases: settings.aliases, ...resolver })
  const markets = createMarketRegistry(settings, staticDataService())
  const parser = createQueryParser({ items, markets })
  const query = (text: string, opts: Partial<QueryOptions> = {}) => parser.query(text, { scope: 'market', access: PUBLIC, market: true, ...opts })
  return { settings, items, markets, parser, query }
}

export function parsed(result: ParsedQuery | CoreFailure): ParsedQuery {
  if ('ok' in result) throw new Error(`应该解析成功，实际是 ${result.code}`)
  return result
}

export function failed(result: ParsedQuery | CoreFailure): CoreFailure {
  if (!('ok' in result)) throw new Error('应该失败')
  return result
}

/** 识别结果的摘要：种类、档位、物品英文名 */
export function summary(res: Resolution): string {
  switch (res.kind) {
    case 'unique':
      return `unique:${res.tier}:${res.item.en}`
    case 'ambiguous':
    case 'confirm':
      return `${res.kind}:${res.tier}:${res.candidates.map((i) => i.en).join('|')}`
    case 'none':
      return `none:${res.suggestions.map((i) => i.en).join('|')}`
    case 'out-of-scope':
      return `out-of-scope:${res.item.en}`
    case 'set':
      return `set:${res.set.name.en}`
    case 'sets':
      return `sets:${res.sets.length}`
    case 'group':
      return `group:${res.groupName}`
  }
}
