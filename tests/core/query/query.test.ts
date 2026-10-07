import { describe, expect, it } from 'vitest'
import { PRESET_MARKETS } from '../../../src/config/presets'
import { REMOTE_LOOKUP_MS } from '../../../src/constants'
import { DataNotReadyError } from '../../../src/core/data'
import { createMarketRegistry } from '../../../src/core/market'
import { createQueryParser } from '../../../src/core/parse'
import { strengthOf } from '../../../src/core/parse/query'
import { FakeTime } from '../../fakes/fake-time'
import { FakeRemoteEsi, ManualClock, MemoryBlobCache, esiType } from '../items/helpers'
import { ALLOWED, PUBLIC, STRUCTURE_ROWS, item, settingsOf } from '../market/helpers'
import { failed, parsed, setup, summary } from './helpers'

const ALL_MARKETS = { markets: [...PRESET_MARKETS, ...STRUCTURE_ROWS] }

/** 市场 key、名字、数量、识别结果，一行看清 */
async function read(q: ReturnType<typeof setup>['query'], text: string, opts = {}) {
  const r = parsed(await q(text, opts))
  return [r.market?.key ?? null, r.name, r.quantity, summary(r.resolution)]
}

describe('QueryParser: quantity', () => {
  const { query } = setup()

  it('takes the whole sentence as the name when it is an item', async () => {
    expect(await read(query, '乌鸦级')).toEqual([null, '乌鸦级', null, 'unique:exact:Raven'])
    // 名字里带数字的物品不拆
    expect(await read(query, 'Cap Booster 800')).toEqual([null, 'Cap Booster 800', null, 'unique:exact:Cap Booster 800'])
  })

  it('reads every way of writing a quantity', async () => {
    for (const text of ['乌鸦级*10', '乌鸦级 * 10', 'Raven x10', 'Raven X 10', 'Raven ×10', '10 Raven', '10x Raven', '乌鸦级*10艘']) {
      expect(await read(query, text), text).toEqual([null, /乌鸦级/.test(text) ? '乌鸦级' : 'Raven', 10, 'unique:exact:Raven'])
    }
    expect((await read(query, '乌鸦级*1万'))[2]).toBe(10_000)
    expect((await read(query, 'Raven*2.5k'))[2]).toBe(2_500)
    expect((await read(query, 'Raven*1,000,000'))[2]).toBe(1_000_000)
  })

  it('splits a trailing number only when the whole sentence is not an item', async () => {
    expect(await read(query, 'PLEX 500')).toEqual([null, 'PLEX', 500, 'unique:exact:PLEX'])
    expect(await read(query, 'Cap Booster 800 100')).toEqual([null, 'Cap Booster 800', 100, 'unique:exact:Cap Booster 800'])
    expect(await read(query, 'Cap Booster 800*3')).toEqual([null, 'Cap Booster 800', 3, 'unique:exact:Cap Booster 800'])
  })

  it('rejects a written quantity that is not a positive integer', async () => {
    for (const text of ['Raven*0', 'Raven*0.5', 'Raven x0', 'Jita Raven*0']) {
      expect(failed(await query(text)), text).toEqual({ ok: false, code: 'BAD_ARGUMENT', reason: 'quantity' })
    }
  })

  it('normalizes full-width input and keeps the quantity on prefix, set and confirm results', async () => {
    expect(await read(query, 'Ｊｉｔａ　乌鸦级＊１０')).toEqual(['jita 4-4', '乌鸦级', 10, 'unique:exact:Raven'])
    expect(await read(query, 'Raven Nav*2')).toEqual([null, 'Raven Nav', 2, 'unique:prefix:Raven Navy Issue'])
    expect(await read(query, '高级水晶*2')).toEqual([null, '高级水晶', 2, 'set:High-grade Crystal'])
    // 认不出时也按乘号读，候选按钮保留数量
    const extenders = parsed(await query('护盾扩展装置 II*4'))
    expect([extenders.name, extenders.quantity, extenders.resolution.kind]).toEqual(['护盾扩展装置 II', 4, 'confirm'])
    expect(await read(query, '乌鸦机*10')).toEqual([null, '乌鸦机', 10, 'none:Raven|Raven Navy Issue|Raven State Issue'])
  })

  it('without a written multiplication an unrecognized sentence stays whole', async () => {
    expect(await read(query, 'Booster 800')).toEqual([null, 'Booster 800', null, 'confirm:contains:Cap Booster 800|Navy Cap Booster 800'])
    expect((await read(query, '10 乌鸦机')).slice(1, 3)).toEqual(['10 乌鸦机', null])
  })

  it('passes out-of-scope items through for the "cannot be traded" reply', async () => {
    expect(await read(query, 'Damage Control II Blueprint')).toEqual([null, 'Damage Control II Blueprint', null, 'out-of-scope:Damage Control II Blueprint'])
  })
})

describe('QueryParser: market', () => {
  const aliases = [{ alias: 'Amarr Raven', target: 'Raven Navy Issue' }, { alias: 'Hek Special', target: 'Raven' }]
  const { query } = setup({ ...ALL_MARKETS, aliases })

  it('cuts a leading market by name or alias, longest first', async () => {
    expect(await read(query, 'Jita 乌鸦级*10')).toEqual(['jita 4-4', '乌鸦级', 10, 'unique:exact:Raven'])
    expect(await read(query, 'Jita 4-4 Raven')).toEqual(['jita 4-4', 'Raven', null, 'unique:exact:Raven'])
    expect(await read(query, '吉他 PLEX*500')).toEqual(['jita 4-4', 'PLEX', 500, 'unique:exact:PLEX'])
  })

  it('only a market: nothing to resolve, the command shows its usage', async () => {
    expect(await read(query, 'Jita')).toEqual(['jita 4-4', '', null, 'none:'])
    expect(await read(query, '   ')).toEqual([null, '', null, 'none:'])
  })

  it('does not look for a market when the command has none', async () => {
    expect(await read(query, 'Jita 乌鸦级', { market: false })).toEqual([null, 'Jita 乌鸦级', null, expect.stringMatching(/^(none|confirm)/)])
  })

  it('both readings exact: market first, the whole sentence as the alternative', async () => {
    const r = parsed(await query('Amarr Raven'))
    expect([r.market?.key, summary(r.resolution), r.alt?.en]).toEqual(['amarr', 'unique:exact:Raven', 'Raven Navy Issue'])
  })

  it('only the whole sentence is an item: no market', async () => {
    const r = parsed(await query('Hek Special'))
    expect([r.market, summary(r.resolution), r.alt]).toEqual([undefined, 'unique:alias:Raven', undefined])
  })

  it('unknown or hidden market: same failure, with the markets this group can see', async () => {
    const visible = ['jita 4-4', '公开建筑', 'amarr', 'dodixie', 'rens', 'hek']
    expect(failed(await query('TEST 乌鸦级*2'))).toEqual({ ok: false, code: 'UNKNOWN_MARKET', token: 'TEST', rest: '乌鸦级*2', markets: visible })
    expect(failed(await query('前线 乌鸦级'))).toEqual({ ok: false, code: 'UNKNOWN_MARKET', token: '前线', rest: '乌鸦级', markets: visible })
    expect(await read(query, '前线 乌鸦级', { access: ALLOWED })).toEqual(['联盟市场a', '乌鸦级', null, 'unique:exact:Raven'])
  })
})

describe('QueryParser: new items through ESI', () => {
  function remoteSetup() {
    const esi = new FakeRemoteEsi()
    esi.add(esiType({ typeId: 99_000_001, name: 'Fake Newship' }), { en: 'Fake Newship', zh: '编造新船' })
    const s = setup({}, { remote: { esi, cache: new MemoryBlobCache(), clock: new ManualClock() } })
    return { ...s, esi }
  }

  it('asks ESI only when nothing matched and the command allows it', async () => {
    const { query, esi } = remoteSetup()
    expect(summary(parsed(await query('Fake Newship')).resolution)).toBe('none:')
    expect(esi.calls).toEqual([])
    const r = parsed(await query('Fake Newship*3', { remote: true }))
    expect([r.name, r.quantity, summary(r.resolution)]).toEqual(['Fake Newship', 3, 'unique:remote:Fake Newship'])
  })

  it('tries the trailing-number reading too', async () => {
    const { query } = remoteSetup()
    const r = parsed(await query('Fake Newship 5', { remote: true }))
    expect([r.name, r.quantity, summary(r.resolution)]).toEqual(['Fake Newship', 5, 'unique:remote:Fake Newship'])
  })

  it('waits for ESI at most REMOTE_LOOKUP_MS, then answers from local data while the lookup fills the cache', async () => {
    const { items, markets, esi } = remoteSetup()
    const time = new FakeTime()
    const parser = createQueryParser({ items, markets, scheduler: time })
    let release = () => {}
    esi.hold = new Promise<void>((resolve) => { release = resolve })
    let done = false
    const pending = parser.query('Fake Newship 5', { scope: 'market', access: PUBLIC, market: true, remote: true }).then((r) => {
      done = true
      return r
    })
    await time.advance(REMOTE_LOOKUP_MS - 1)
    expect(done).toBe(false)
    await time.advance(1)
    expect(summary(parsed(await pending).resolution)).toBe('none:')
    // 查询在后台做完、进了缓存：下一次直接认出
    release()
    await time.advance(0)
    esi.hold = undefined
    const again = parsed(await parser.query('Fake Newship', { scope: 'market', access: PUBLIC, market: true, remote: true }))
    expect(summary(again.resolution)).toBe('unique:remote:Fake Newship')
  })

  it('never for candidates that need confirming or outside the market scope', async () => {
    const { query, esi } = remoteSetup()
    expect(parsed(await query('wuya', { remote: true })).resolution.kind).toBe('confirm')
    expect(parsed(await query('Fake Newship', { remote: true, scope: 'industry' })).resolution.kind).toBe('none')
    expect(esi.calls).toEqual([])
  })
})

describe('QueryParser: failures and placeholders', () => {
  it('data not loaded yet', async () => {
    const notReady = { current: () => { throw new DataNotReadyError() } }
    const markets = createMarketRegistry(settingsOf(), notReady)
    const unused = () => { throw new DataNotReadyError() }
    const items = {
      resolve: unused, resolveRemote: unused, resolveLine: unused, search: unused, byId: unused, related: unused,
      aliasesOf: unused, displayName: unused, commandName: unused, stats: unused,
    }
    const parser = createQueryParser({ items, markets })
    expect(await parser.query('Jita 乌鸦级', { scope: 'market', access: PUBLIC, market: true }))
      .toMatchObject({ ok: false, code: 'DATA_NOT_READY' })
  })

  it('industry arguments come with 0.2.0', () => {
    const { parser } = setup()
    expect(parser.industryArgs('乌鸦级', 'manufacturing', PUBLIC)).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
  })
})

describe('strengthOf', () => {
  const raven = item(638, 'Raven')
  it('ranks resolutions the way the market split does', () => {
    expect(strengthOf({ kind: 'unique', item: raven, tier: 'alias' })).toBe('exact')
    expect(strengthOf({ kind: 'unique', item: raven, tier: 'remote' })).toBe('exact')
    expect(strengthOf({ kind: 'ambiguous', tier: 'exact', candidates: [raven], total: 2 })).toBe('exact')
    expect(strengthOf({ kind: 'ambiguous', tier: 'prefix', candidates: [raven], total: 2 })).toBe('prefix')
    expect(strengthOf({ kind: 'sets', sets: [] })).toBe('exact')
    expect(strengthOf({ kind: 'group', groupName: 'Dreadnought', candidates: [], total: 0 })).toBe('exact')
    expect(strengthOf({ kind: 'confirm', tier: 'contains', candidates: [raven], total: 1 })).toBe('none')
    expect(strengthOf({ kind: 'none', suggestions: [] })).toBe('none')
  })
})
