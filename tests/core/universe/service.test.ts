import { describe, expect, it } from 'vitest'
import { universe } from './helpers'

describe('UniverseService', () => {
  const u = universe()

  it('incursions and server status come with 0.0.3', async () => {
    expect(await u.incursions()).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
    expect(await u.serverStatus()).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
  })

  it('translate and system go through the same data', () => {
    expect(u.translate('吉他', 10).entries[0]).toMatchObject({ kind: 'system', id: 30000142 })
    expect(u.system(30000142)).toMatchObject({ en: 'Jita', secClass: 'high', region: { zh: '伏尔戈' } })
    expect(u.names.known('faction', 500001)).toEqual({ id: 500001, en: 'Caldari State', zh: '加达里合众国' })
  })

  it('a limit below 1 still returns one entry', () => {
    expect(u.translate('水晶', 0).entries).toHaveLength(1)
  })
})
