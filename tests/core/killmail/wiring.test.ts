// createEveCore 里的 kills：zKill 指向假服务（zkillBase），ESI 指向假 ESI，物品和星系来自自带的数据快照。

import { afterEach, describe, expect, it } from 'vitest'
import { normalizeConfig } from '../../../src/config/normalize'
import { createEveCore } from '../../../src/core'
import { createModuleStore } from '../../../src/core/ports'
import type { HttpClient, HttpRequest } from '../../../src/core/ports'
import { isFailure } from '../../../src/core/types'
import type { EveCore } from '../../../src/core/types'
import { FakeEsi, rawKillmail } from '../../fakes/fake-esi'
import { FakeZkill, rawZkillKill } from '../../fakes/fake-zkill'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { bundledDir, cleanupDirs, FakeHttp, makeVersion, MemoryCache } from '../data/helpers'
import { ManualClock, MemoryLogger, realScheduler } from '../esi/helpers'

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

describe('createEveCore: kills', () => {
  it('builds a summary through zkillBase and esiBase, with the contact in the User-Agent', async () => {
    const esi = await new FakeEsi().start()
    const zkill = await new FakeZkill().start()
    servers.push(esi, zkill)
    esi.killmails.set(131234567, { hash: HASH, mail: rawKillmail() })
    zkill.kills.set(131234567, rawZkillKill(131234567, HASH))
    const clock = new ManualClock()
    esi.clock = () => clock.now()
    const { settings } = normalizeConfig({ advanced: { manifestUrl: '', glossaryUrl: '', esiContact: 'me@example.test' } })
    const unused = () => { throw new Error('这个测试用不到') }
    const core = createEveCore({
      http: new Routed([esi.base, zkill.base], new FakeHttp()),
      clock,
      scheduler: realScheduler,
      logger: new MemoryLogger(),
      cache: new MemoryCache(),
      auth: { list: async () => [], get: async () => undefined, upsert: unused, remove: unused },
      secrets: { keyId: 'test', seal: unused, open: unused },
      store: createModuleStore(),
      bundledDataDir: bundledDir(makeVersion()),
      version: '0.0.1',
    }, settings, { esiBase: esi.base, zkillBase: zkill.base, random: () => 0.5 })
    cores.push(core)
    await core.start()

    const s = await core.kills.summary(131234567)
    if (isFailure(s)) throw new Error(`${s.code} ${s.message}`)
    expect(s).toMatchObject({ killId: 131234567, systemId: 30000142, value: 452_000_000, attackers: 2 })
    expect(s.victim.shipTypeId).toBe(638)
    expect(core.kills.relatedBrUrl(s)).toBe(s.system?.region ? 'https://br.evetools.org/related/30000142/202610141200' : null)
    expect(zkill.requests[0].userAgent).toContain('me@example.test')
    expect(zkill.requests[0].userAgent).toBe(esi.requests[0].headers['user-agent'])
  })
})
