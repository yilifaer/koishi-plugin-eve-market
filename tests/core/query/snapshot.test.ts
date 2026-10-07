// 完整快照上的查询回归：名字里有数字的物品很多（「1000 Aurum Token」「10MN Afterburner I」），
// 末尾的数量不能让打错的物品名变成「未知市场」。

import { describe, expect, it } from 'vitest'
import { createMarketRegistry } from '../../../src/core/market'
import { createQueryParser } from '../../../src/core/parse'
import { loadSnapshotData, staticDataService } from '../../fixtures/data/load'
import { snapshotResolver } from '../items/helpers'
import { PUBLIC, settingsOf } from '../market/helpers'
import { failed, parsed, summary } from './helpers'

function snapshotParser() {
  const items = snapshotResolver()
  const markets = createMarketRegistry(settingsOf(), staticDataService(loadSnapshotData()))
  const parser = createQueryParser({ items, markets })
  return (text: string) => parser.query(text, { scope: 'market', access: PUBLIC, market: true })
}

describe('QueryParser on the full snapshot', () => {
  const query = snapshotParser()

  it('a misspelled name with a quantity gets candidates or suggestions, not an unknown market', async () => {
    for (const text of ['Tritanum 1000', '乌鸦机 10', 'Ravn 2', 'Raevn 5', 'Ravenx 10']) {
      const res = parsed(await query(text)).resolution
      const offered = res.kind === 'none' ? res.suggestions.length : res.kind === 'confirm' ? res.candidates.length : 0
      expect(offered, text).toBeGreaterThan(0)
    }
    expect(summary(parsed(await query('乌鸦机 10')).resolution)).toMatch(/^none:Raven\|/)
  })

  it('a word in front of a real item is still an unknown market', async () => {
    expect(failed(await query('TEST 乌鸦级 10'))).toMatchObject({ code: 'UNKNOWN_MARKET', token: 'TEST', rest: '乌鸦级 10' })
    expect(failed(await query('jiat Raven*2'))).toMatchObject({ code: 'UNKNOWN_MARKET', token: 'jiat' })
  })
})
