// createEveCore 里入侵、服务器状态、势力图的接线：ESI 指向本机的假 ESI，图片地址指向假的图片网站。

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeConfig } from '../../../src/config/normalize'
import { createEveCore } from '../../../src/core'
import { createModuleStore } from '../../../src/core/ports'
import type { HttpClient, HttpRequest, HttpResponse } from '../../../src/core/ports'
import type { EveCore } from '../../../src/core/types'
import { FakeEsi, rawIncursion } from '../../fakes/fake-esi'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { bundledDir, cleanupDirs, makeVersion, MemoryCache, MemoryLogger } from '../data/helpers'
import { ManualClock, realScheduler } from '../esi/helpers'

const PNG = fs.readFileSync(path.join(__dirname, 'fixtures/influence.png'))
const MAP_URL = 'https://maps.example.test/influence.png'

/** ESI 交给假 ESI，图片地址回一张 PNG */
class RoutedHttp implements HttpClient {
  readonly images: HttpRequest[] = []
  constructor(private readonly esi: FakeEsi, private readonly node = new NodeHttpClient()) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    if (req.url.startsWith(this.esi.base)) return this.node.request(req)
    this.images.push(req)
    if (req.url !== MAP_URL) return { status: 404, header: () => undefined, body: Buffer.alloc(0) }
    return { status: 200, header: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : undefined), body: Buffer.from(PNG) }
  }
}

const cores: EveCore[] = []
const fakes: FakeEsi[] = []

afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()))
  await Promise.all(fakes.splice(0).map((f) => f.stop()))
  cleanupDirs()
})

describe('createEveCore: incursions, server status and maps', () => {
  it('are wired to ESI and the configured image addresses; maps wait a moment before warming up', async () => {
    const fake = new FakeEsi()
    fake.incursions = [rawIncursion()]
    await fake.start()
    fakes.push(fake)
    const clock = new ManualClock()
    fake.clock = () => clock.now()
    const http = new RoutedHttp(fake)
    const { settings } = normalizeConfig({
      advanced: { manifestUrl: '', glossaryUrl: '' },
      render: { influenceMapUrl: MAP_URL, coalitionMapUrl: '' },
    })
    const unused = () => { throw new Error('这个测试用不到') }
    const core = createEveCore({
      http,
      clock,
      scheduler: realScheduler,
      logger: new MemoryLogger(),
      cache: new MemoryCache(),
      auth: { list: async () => [], get: async () => undefined, upsert: unused, remove: unused },
      secrets: { keyId: 'test', seal: unused, open: unused },
      store: createModuleStore(),
      bundledDataDir: bundledDir(makeVersion()),
      version: '0.0.3',
    }, settings, { esiBase: fake.base, random: () => 0.5 })
    cores.push(core)
    await core.start()
    await core.ready
    expect(http.images).toEqual([])

    const map = await core.maps.get('influence')
    expect(map).toMatchObject({ kind: 'influence', mime: 'image/png', stale: false })
    expect('body' in map && map.body.equals(PNG)).toBe(true)
    expect(await core.maps.get('coalition')).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })

    const incursions = await core.universe.incursions()
    expect('incursions' in incursions && incursions.incursions.map((i) => [i.constellation.zh, i.staging?.zh, i.faction?.zh]))
      .toEqual([['木本呂', '吉他', '萨沙共和国']])
    expect(await core.universe.serverStatus()).toMatchObject({ players: 23456, serverVersion: '3000001', vip: false })
  })
})
