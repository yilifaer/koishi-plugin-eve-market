// createEveCore 里的 pilots：ESI、zKill、图片主机都指向本机的假服务，物品和星系来自自带的数据快照。

import { afterEach, describe, expect, it } from 'vitest'
import { normalizeConfig } from '../../../src/config/normalize'
import { createEveCore } from '../../../src/core'
import { createModuleStore } from '../../../src/core/ports'
import type { HttpClient, HttpRequest } from '../../../src/core/ports'
import { isFailure } from '../../../src/core/types'
import type { EveCore } from '../../../src/core/types'
import { FakeEsi, rawCharacter } from '../../fakes/fake-esi'
import { FakeImages } from '../../fakes/fake-images'
import { FakeZkill, rawZkillKill } from '../../fakes/fake-zkill'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { bundledDir, cleanupDirs, FakeHttp, makeVersion, MemoryCache } from '../data/helpers'
import { ManualClock, MemoryLogger, realScheduler } from '../esi/helpers'

const HANAKO = 2119876543
const HASH = '0123456789abcdef0123456789abcdef01234567'
const cores: EveCore[] = []
const servers: Array<{ stop(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()))
  await Promise.all(servers.splice(0).map((s) => s.stop()))
  cleanupDirs()
})

class Routed implements HttpClient {
  private readonly node = new NodeHttpClient()
  constructor(private readonly bases: string[], private readonly other: FakeHttp) {}
  request(req: HttpRequest) {
    return this.bases.some((b) => req.url.startsWith(b)) ? this.node.request(req) : this.other.request(req)
  }
}

describe('createEveCore: pilots', () => {
  it('resolves a name, builds a profile and downloads its images through the three overrides', async () => {
    const esi = await new FakeEsi().start()
    const zkill = await new FakeZkill().start()
    const images = await new FakeImages().start()
    servers.push(esi, zkill, images)
    esi.idNames.en.set('hanako kisaragi', { category: 'characters', id: HANAKO, name: 'Hanako Kisaragi' })
    esi.characters.set(HANAKO, rawCharacter())
    esi.corporations.set(98000501, { name: 'Moonlit Harbor Logistics', ticker: 'MHL' })
    esi.alliances.set(99000501, { name: 'Fictional Federation', ticker: 'FICT' })
    esi.corpHistory.set(HANAKO, [])
    zkill.stats.set(HANAKO, { shipsDestroyed: 120, shipsLost: 30, iskDestroyed: 9e9, iskLost: 1e9, soloKills: 3, topAllTime: [{ type: 'ship', data: [{ kills: 50, shipTypeID: 638 }] }] })
    zkill.charKills.set(HANAKO, [rawZkillKill(131234567, HASH, { totalValue: 4e9 })])
    const clock = new ManualClock(Date.UTC(2026, 9, 14, 12, 40))
    esi.clock = () => clock.now()
    const { settings } = normalizeConfig({ advanced: { manifestUrl: '', glossaryUrl: '', esiContact: 'me@example.test' } })
    const unused = () => { throw new Error('这个测试用不到') }
    const core = createEveCore({
      http: new Routed([esi.base, zkill.base, images.base], new FakeHttp()),
      clock,
      scheduler: realScheduler,
      logger: new MemoryLogger(),
      cache: new MemoryCache(),
      auth: { list: async () => [], get: async () => undefined, upsert: unused, remove: unused },
      secrets: { keyId: 'test', seal: unused, open: unused },
      store: createModuleStore(),
      bundledDataDir: bundledDir(makeVersion()),
      version: '0.0.1',
    }, settings, { esiBase: esi.base, zkillBase: zkill.base, imageBase: images.base, random: () => 0.5 })
    cores.push(core)
    await core.start()

    expect(core.pilots.parse('Hanako Kisaragi')).toEqual({ kind: 'name', name: 'Hanako Kisaragi' })
    // 没有做过市场授权：精确名字能查到，不完整的名字请写完整
    expect(await core.pilots.resolve('hanako kisaragi')).toEqual({ id: HANAKO, name: 'Hanako Kisaragi' })
    expect(await core.pilots.resolve('Hanako')).toMatchObject({ ok: false, code: 'PILOT_NOT_FOUND', reason: 'need-full-name' })

    const p = await core.pilots.profile(HANAKO)
    if (isFailure(p)) throw new Error(`${p.code} ${p.message}`)
    expect(p).toMatchObject({ name: 'Hanako Kisaragi', partial: [], totals: { kills: 120, losses: 30 } })
    expect(p.ships[0]).toMatchObject({ typeId: 638, en: 'Raven' })
    expect(p.ships[0].zh).not.toBe('')
    expect(p.recentKill?.system?.en).toBe('Jita')

    const set = await core.pilots.images.forProfile(p)
    expect(set.portrait).toMatch(/^data:image\/jpeg;base64,/)
    expect(set.corporation).toMatch(/^data:image\/png;base64,/)
    expect(set.ships[638]).toMatch(/^data:image\/png;base64,/)
    expect(images.requests[0].userAgent).toContain('me@example.test')
    expect(zkill.requests[0].userAgent).toBe(esi.requests[0].headers['user-agent'])
  })
})
