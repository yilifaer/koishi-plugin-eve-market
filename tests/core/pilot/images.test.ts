import { afterEach, describe, expect, it } from 'vitest'
import { KB_IMAGE_CONCURRENCY } from '../../../src/constants'
import { PilotImages } from '../../../src/core/pilot'
import type { PilotProfile } from '../../../src/core/types'
import { FakeImages, JPEG_STUB, PNG_1X1 } from '../../fakes/fake-images'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { ManualClock, MemoryLogger, realScheduler } from '../esi/helpers'

const servers: FakeImages[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()))
})

async function make() {
  const fake = await new FakeImages().start()
  servers.push(fake)
  const clock = new ManualClock()
  const logger = new MemoryLogger()
  const images = new PilotImages({ http: new NodeHttpClient(), clock, scheduler: realScheduler, logger, userAgent: 'test-agent/1.0', base: fake.base })
  return { fake, clock, logger, images }
}

const pngUri = `data:image/png;base64,${PNG_1X1.toString('base64')}`
const jpegUri = `data:image/jpeg;base64,${JPEG_STUB.toString('base64')}`

describe('PilotImages', () => {
  it('downloads each kind from the fixed paths and returns data: URIs', async () => {
    const { fake, images } = await make()
    expect(await images.portrait(2119876543)).toBe(jpegUri)
    expect(await images.corporationLogo(98000501)).toBe(pngUri)
    expect(await images.allianceLogo(99000501)).toBe(pngUri)
    expect(await images.shipRender(17738)).toBe(pngUri)
    expect(fake.requests.map((r) => r.path)).toEqual([
      '/characters/2119876543/portrait?size=256',
      '/corporations/98000501/logo?size=64',
      '/alliances/99000501/logo?size=64',
      '/types/17738/render?size=128',
    ])
    expect(fake.requests[0].userAgent).toBe('test-agent/1.0')
  })

  it('caches successes (portrait 24 hours, others 7 days) and merges concurrent calls', async () => {
    const { fake, clock, images } = await make()
    fake.delayMs = 20
    const [a, b] = await Promise.all([images.portrait(2119876543), images.portrait(2119876543)])
    expect(a).toBe(b)
    expect(fake.requests).toHaveLength(1)
    await images.portrait(2119876543)
    await images.shipRender(17738)
    expect(fake.requests).toHaveLength(2)
    clock.advance(23 * 3_600_000)
    await images.portrait(2119876543)
    expect(fake.count(/portrait/)).toBe(1)
    clock.advance(2 * 3_600_000)
    await images.portrait(2119876543)
    expect(fake.count(/portrait/)).toBe(2)
    await images.shipRender(17738)
    expect(fake.count(/render/)).toBe(1)
    clock.advance(7 * 86_400_000)
    await images.shipRender(17738)
    expect(fake.count(/render/)).toBe(2)
  })

  it.each(['html', 'text-as-png', 'huge', 'not-found'] as const)('returns null for a %s response, and remembers the failure briefly', async (fault) => {
    const { fake, clock, images, logger } = await make()
    fake.faults.push({ pattern: /portrait/, fault })
    expect(await images.portrait(2119876543)).toBeNull()
    expect(await images.portrait(2119876543)).toBeNull()
    expect(fake.requests).toHaveLength(1)
    expect(logger.at('warn')).toHaveLength(1)
    // 过了负缓存时间再试，服务恢复就能拿到
    fake.faults = []
    clock.advance(61_000)
    expect(await images.portrait(2119876543)).toBe(jpegUri)
  })

  it('trusts the file header, not the content type', async () => {
    const { fake, images } = await make()
    fake.faults.push({ pattern: /logo/, fault: 'html' })
    expect(await images.corporationLogo(98000501)).toBeNull()
  })

  it('returns null for invalid ids without any request', async () => {
    const { fake, images } = await make()
    for (const id of [0, -1, 1.5, NaN, 2 ** 60]) expect(await images.portrait(id)).toBeNull()
    expect(fake.requests).toHaveLength(0)
  })

  it('returns null when the host is unreachable', async () => {
    const { fake, images } = await make()
    await fake.stop()
    expect(await images.portrait(2119876543)).toBeNull()
  })

  it('downloads at most 4 images at the same time', async () => {
    const { fake, images } = await make()
    fake.delayMs = 30
    await Promise.all(Array.from({ length: 12 }, (_, i) => images.shipRender(1000 + i)))
    expect(fake.requests).toHaveLength(12)
    expect(fake.peakInFlight).toBeLessThanOrEqual(KB_IMAGE_CONCURRENCY)
    expect(fake.peakInFlight).toBeGreaterThan(1)
  })

  it('forProfile collects portrait, logos and the ship renders, nulls for failures', async () => {
    const { fake, images } = await make()
    fake.faults.push({ pattern: /types\/587\//, fault: 'not-found' })
    const profile = {
      id: 2119876543,
      corporation: { id: 98000501, name: 'Moonlit Harbor Logistics' },
      alliance: { id: 99000501, name: 'Fictional Federation' },
      ships: [{ typeId: 17738 }, { typeId: 587 }],
      recentKill: { ship: { typeId: 11978 } },
      recentLoss: { ship: { typeId: 17738 } },
    } as unknown as PilotProfile
    const set = await images.forProfile(profile)
    expect(set.portrait).toBe(jpegUri)
    expect(set.corporation).toBe(pngUri)
    expect(set.alliance).toBe(pngUri)
    expect(set.ships).toEqual({ 17738: pngUri, 587: null, 11978: pngUri })
    // 17738 只下载一次
    expect(fake.count(/types\/17738\//)).toBe(1)
  })

  it('forProfile gives up at the deadline and leaves null for what is not done', async () => {
    const { fake, images } = await make()
    fake.faults.push({ pattern: /portrait/, fault: 'hang' })
    const profile = { id: 2119876543, corporation: null, alliance: null, ships: [{ typeId: 17738 }], recentKill: null, recentLoss: null } as unknown as PilotProfile
    const started = Date.now()
    const set = await images.forProfile(profile, { deadlineMs: 150 })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(set.portrait).toBeNull()
    expect(set.ships[17738]).toBe(pngUri)
  })

  it('defaults to the official image host and only requests that host', async () => {
    const urls: string[] = []
    const http = { request: async (req: { url: string }) => { urls.push(req.url); return { status: 404, header: () => undefined, body: Buffer.alloc(0) } } }
    const images = new PilotImages({ http, clock: new ManualClock(), scheduler: realScheduler, logger: new MemoryLogger(), userAgent: 'x' })
    await images.portrait(2119876543)
    await images.corporationLogo(98000501)
    expect(urls).toEqual([
      'https://images.evetech.net/characters/2119876543/portrait?size=256',
      'https://images.evetech.net/corporations/98000501/logo?size=64',
    ])
  })
})
