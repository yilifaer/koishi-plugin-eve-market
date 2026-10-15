// JaniceService：假 Janice（真实 HTTP，本机）+ 假时钟。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JaniceClient, createJaniceService } from '../../../src/core/janice'
import { createModuleStore } from '../../../src/core/ports'
import { isFailure } from '../../../src/core/types'
import type { CoreFailure, ItemInfo, JaniceService, JaniceView } from '../../../src/core/types'
import { FakeJanice, rawJanice } from '../../fakes/fake-janice'
import type { FakeItem } from '../../fakes/fake-janice'
import { FakeTime } from '../../fakes/fake-time'
import { NodeHttpClient } from '../../fakes/node-http-client'
import { MemoryLogger } from '../esi/helpers'

const KEY = 'test-janice-key-0000'
const UA = 'koishi-plugin-eve-market/0.0.1 (+https://example.test/project; me@example.test)'
const T0 = Date.UTC(2026, 9, 14, 12, 0)
const HOUR = 3_600_000

let fake: FakeJanice
let time: FakeTime
let logger: MemoryLogger
let client: JaniceClient
let service: JaniceService

const ZH: Record<number, string> = { 34: '三钛合金' }
const items = { byId: (id: number) => (ZH[id] === undefined ? undefined : ({ typeId: id, en: '', zh: ZH[id] } as ItemInfo)) }

function build(options: { apiKey?: string; minIntervalMs?: number } = {}) {
  client = new JaniceClient(
    { http: new NodeHttpClient(), clock: time, scheduler: time, logger, store: createModuleStore() },
    { base: fake.base, apiKey: KEY, userAgent: UA, minIntervalMs: 0, ...options },
  )
  service = createJaniceService({ client, items, clock: time, scheduler: time, logger })
}

const view = (r: JaniceView | CoreFailure): JaniceView => {
  if (isFailure(r)) throw new Error(`${r.code} ${r.message}`)
  return r
}
const fail = (r: JaniceView | CoreFailure): CoreFailure => {
  if (!isFailure(r)) throw new Error('应该失败')
  return r
}

beforeEach(async () => {
  fake = await new FakeJanice().start()
  time = new FakeTime(T0)
  logger = new MemoryLogger()
  build()
})

afterEach(async () => {
  client.stop()
  await fake.stop()
})

describe('get: the view', () => {
  it('reads an appraisal into a view, in whole ISK, with Chinese names where the dictionary has them', async () => {
    fake.add('AbC123')
    const v = view(await service.get('AbC123'))
    expect(v).toMatchObject({
      code: 'AbC123',
      market: 'Jita 4-4',
      pricing: 'buy',
      variant: 'immediate',
      designation: 'appraisal',
      percentage: 1,
      percentageGuessed: false,
      totals: { sell: 10000, buy: 8000, split: 9000 },
      itemTypes: 2,
      units: 1250,
      packagedVolume: 12.5,
      datasetAt: Date.UTC(2026, 9, 14, 9, 50),
      expiresAt: Date.UTC(2026, 9, 21, 10, 0),
      failedLines: 0,
    })
    expect(v.items.map((i) => [i.typeId, i.en, i.zh, i.amount])).toEqual([[34, 'Tritanium', '三钛合金', 1000], [35, 'Pyerite', null, 250]])
    expect(v.items[0].prices).toEqual({ sell: 6000, buy: 5000, split: 5500 })
  })

  it('sends the key header, Accept and the shared User-Agent; only the code goes in the path', async () => {
    fake.add('AbC123')
    await service.get('AbC123')
    expect(fake.requests).toEqual([{ path: '/api/rest/v2/appraisal/AbC123', apiKey: KEY, userAgent: UA, accept: 'application/json' }])
  })

  it('never keeps the pasted text or the comment', async () => {
    fake.add('AbC123', { input: 'SECRET-PASTE-TEXT', comment: 'visit evil.example for ads' })
    const v = view(await service.get('AbC123'))
    expect(JSON.stringify(v)).not.toMatch(/SECRET-PASTE-TEXT|evil\.example|made-up/)
  })

  it('counts failed lines and does not keep their text', async () => {
    fake.add('AbC123', { failures: 'Mystery thing 5\n\nOther junk 2\r\n  \n' })
    const v = view(await service.get('AbC123'))
    expect(v.failedLines).toBe(2)
    expect(JSON.stringify(v)).not.toContain('Mystery')
  })

  it('leaves unknown enum values and a missing market as null', async () => {
    fake.add('AbC123', { pricing: 'weird', pricingVariant: 'x', designation: 5 as never, market: undefined as never })
    expect(view(await service.get('AbC123'))).toMatchObject({ pricing: null, variant: null, designation: null, market: null })
  })

  it('compares enum values case-insensitively', async () => {
    fake.add('AbC123', { pricing: 'Buy', pricingVariant: 'Top5Percent', designation: 'WTB' })
    expect(view(await service.get('AbC123'))).toMatchObject({ pricing: 'buy', variant: 'top5percent', designation: 'wtb' })
  })

  it('skips malformed item rows instead of failing', async () => {
    fake.add('AbC123', { items: [{ amount: 5 }, null, 'x', { amount: 0, itemType: { eid: 34, name: 'Tritanium' } }, ...rawJanice('AbC123').items] })
    expect(view(await service.get('AbC123')).items).toHaveLength(2)
  })
})

describe('get: pricePercentage', () => {
  const ITEMS: FakeItem[] = [{ eid: 34, name: 'Tritanium', amount: 10, sell: 1000, buy: 1000, split: 1001 }]

  it('uses the API numbers as they are at 93%, only reporting the percentage', async () => {
    fake.add('AbC123', { pricePercentage: 0.93 }, ITEMS)
    const v = view(await service.get('AbC123'))
    expect(v.percentage).toBe(0.93)
    expect(v.totals).toEqual({ sell: 1000, buy: 1000, split: 1001 })
    expect(v.items[0].prices).toEqual({ sell: 1000, buy: 1000, split: 1001 })
    expect(v.percentageGuessed).toBe(false)
  })

  it('does not lose a whole ISK to float error', async () => {
    fake.add('AbC123', { pricePercentage: 0.29 }, [{ eid: 34, name: 'Tritanium', amount: 1, sell: 28.999999999999996, buy: 29, split: 29 }])
    expect(view(await service.get('AbC123')).totals.sell).toBe(29)
  })

  it('keeps the exact integer for totals of hundreds of billions', async () => {
    // 几项相加后差一点点：固定 1e-6 的容差会少 1 ISK
    const big = (n: number) => [{ eid: 34, name: 'Tritanium', amount: 1, sell: n, buy: n, split: n }]
    fake.add('AbC123', { pricePercentage: 0.93 }, big(209591521109.99997))
    expect(view(await service.get('AbC123')).totals).toEqual({ sell: 209591521110, buy: 209591521110, split: 209591521110 })
    fake.add('AbC124', { pricePercentage: 0.93 }, big(307457321843.99994))
    expect(view(await service.get('AbC124')).totals.sell).toBe(307457321844)
  })

  it('still floors a real fraction at large totals', async () => {
    fake.add('AbC123', { pricePercentage: 1 }, [{ eid: 34, name: 'Tritanium', amount: 1, sell: 289505045780.9973, buy: 1, split: 1 }])
    expect(view(await service.get('AbC123')).totals.sell).toBe(289505045780)
  })

  it('floors fractions, never rounds up', async () => {
    fake.add('AbC123', { pricePercentage: 0.5 }, [{ eid: 34, name: 'Tritanium', amount: 1, sell: 101.9, buy: 101, split: 101 }])
    expect(view(await service.get('AbC123')).totals.sell).toBe(101)
  })

  it('accepts a percentage up to 10 (1000%) without scaling', async () => {
    fake.add('AbC123', { pricePercentage: 10 }, ITEMS)
    const v = view(await service.get('AbC123'))
    expect(v.percentage).toBe(10)
    expect(v.totals.sell).toBe(1000)
  })

  for (const [name, value] of [['missing', undefined], ['0', 0], ['11', 11], ['negative', -1], ['a string', '0.9'], ['null', null], ['NaN-ish', 1e999]] as const) {
    it(`uses 100% and flags it when pricePercentage is ${name}`, async () => {
      const raw = rawJanice('AbC123', { pricePercentage: value }, ITEMS)
      if (value === undefined) delete raw.pricePercentage
      fake.appraisals.set('AbC123', raw)
      const v = view(await service.get('AbC123'))
      expect(v.percentage).toBe(1)
      expect(v.percentageGuessed).toBe(true)
      expect(v.totals.sell).toBe(1000)
    })
  }
})

describe('get: wrong key vs missing code', () => {
  const lastWarn = () => logger.at('warn').join('\n')

  it('a good key + unknown code: checks /markets once, says not found', async () => {
    fake.validKey = KEY
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_NOT_FOUND')
    expect(fake.count(/markets$/)).toBe(1)
    expect(fake.requests.every((r) => r.apiKey === KEY)).toBe(true)
    expect(service.status().lastError).toBeUndefined()
    expect(logger.at('warn')).toHaveLength(0)
  })

  it('a wrong key: the same 400 becomes JANICE_BAD_KEY, status is red, one warn without the key', async () => {
    fake.validKey = 'some-other-key'
    fake.add('AbC123')
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_BAD_KEY')
    expect(service.status().lastError?.code).toBe('JANICE_BAD_KEY')
    expect(logger.at('warn')).toHaveLength(1)
    expect(lastWarn()).toContain('400')
    expect(logger.text()).not.toContain(KEY)
  })

  it('caches the key check for 10 minutes', async () => {
    fake.validKey = KEY
    await service.get('AbC123')
    await service.get('Zz9Yx8')
    expect(fake.count(/markets$/)).toBe(1)
    await time.advance(10 * 60_000)
    await service.get('Qq7Ww6')
    expect(fake.count(/markets$/)).toBe(2)
  })

  it('a failed key check keeps JANICE_NOT_FOUND and only logs at debug', async () => {
    fake.faults = [{ kind: 'status', status: 400 }, { kind: 'status', status: 500 }]
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_NOT_FOUND')
    expect(logger.at('warn')).toHaveLength(0)
    expect(logger.at('debug').join('\n')).toContain('密钥校验')
  })

  it('logs every non-2xx appraisal answer at debug with code and status only', async () => {
    fake.faults = [{ kind: 'status', status: 500 }]
    await service.get('AbC123')
    expect(logger.at('debug').join('\n')).toMatch(/AbC123.*500/)
    expect(logger.text()).not.toContain(KEY)
  })
})

describe('get: failures', () => {
  it('404 -> JANICE_NOT_FOUND', async () => {
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_NOT_FOUND')
  })

  it('400 -> JANICE_NOT_FOUND', async () => {
    fake.faults = [{ kind: 'status', status: 400 }]
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_NOT_FOUND')
  })

  it('401 and 403 -> JANICE_BAD_KEY and show up in status', async () => {
    fake.faults = [{ kind: 'status', status: 401 }, { kind: 'status', status: 403 }]
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_BAD_KEY')
    expect(fail(await service.get('Zz9Yx8')).code).toBe('JANICE_BAD_KEY')
    expect(service.status()).toEqual({ configured: true, lastError: { code: 'JANICE_BAD_KEY', at: T0 } })
  })

  it('429 -> JANICE_BUSY with retryAt, then no requests during the cooldown', async () => {
    fake.faults = [{ kind: 'rate-limit', retryAfter: 90 }]
    expect(fail(await service.get('AbC123'))).toMatchObject({ code: 'JANICE_BUSY', retryAt: T0 + 90_000 })
    expect(fail(await service.get('Zz9Yx8'))).toMatchObject({ code: 'JANICE_BUSY', retryAt: T0 + 90_000 })
    expect(fake.count()).toBe(1)
  })

  it('429 without Retry-After cools down 60 s', async () => {
    fake.faults = [{ kind: 'rate-limit' }]
    expect(fail(await service.get('AbC123')).retryAt).toBe(T0 + 60_000)
  })

  it('500 -> JANICE_DOWN, remembered for 30 s', async () => {
    fake.faults = [{ kind: 'status', status: 500 }]
    fake.add('Zz9Yx8')
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_DOWN')
    expect(fail(await service.get('Zz9Yx8')).code).toBe('JANICE_DOWN')
    expect(fake.count()).toBe(1)
    await time.advance(30_000)
    expect(view(await service.get('Zz9Yx8')).code).toBe('Zz9Yx8')
    expect(service.status()).toEqual({ configured: true })
  })

  it('missing code or effectivePrices -> JANICE_BAD_RESPONSE', async () => {
    fake.appraisals.set('AbC123', { ...rawJanice('AbC123'), code: null })
    fake.appraisals.set('Zz9Yx8', { ...rawJanice('Zz9Yx8'), effectivePrices: undefined })
    fake.appraisals.set('Qq1Ww2', { ...rawJanice('Qq1Ww2'), effectivePrices: { totalBuyPrice: 1 } })
    fake.appraisals.set('Rr3Tt4', [1, 2])
    for (const code of ['AbC123', 'Zz9Yx8', 'Qq1Ww2', 'Rr3Tt4']) expect(fail(await service.get(code)).code, code).toBe('JANICE_BAD_RESPONSE')
    expect(service.status().lastError?.code).toBe('JANICE_BAD_RESPONSE')
  })

  it('an oversized or non-JSON response -> JANICE_BAD_RESPONSE', async () => {
    fake.faults = [{ kind: 'huge', bytes: 5 * 1024 * 1024 }, { kind: 'raw', body: 'not json' }]
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_BAD_RESPONSE')
    expect(fail(await service.get('Zz9Yx8')).code).toBe('JANICE_BAD_RESPONSE')
  })

  it('no key -> NOT_CONFIGURED without any request; status says not configured', async () => {
    build({ apiKey: '' })
    expect(fail(await service.get('AbC123')).code).toBe('NOT_CONFIGURED')
    expect(fake.count()).toBe(0)
    expect(service.status()).toEqual({ configured: false })
  })

  it('a malformed code -> BAD_ARGUMENT without any request', async () => {
    expect(fail(await service.get('../etc/passwd')).code).toBe('BAD_ARGUMENT')
    expect(fail(await service.get('abc')).code).toBe('BAD_ARGUMENT')
    expect(fake.count()).toBe(0)
  })

  it('a not-found appraisal is not a service error', async () => {
    await service.get('AbC123')
    expect(service.status()).toEqual({ configured: true })
  })

  it('a success clears the last error', async () => {
    fake.add('Zz9Yx8')
    fake.faults = [{ kind: 'status', status: 401 }]
    await service.get('AbC123')
    expect(service.status().lastError?.code).toBe('JANICE_BAD_KEY')
    await service.get('Zz9Yx8')
    expect(service.status()).toEqual({ configured: true })
  })
})

describe('get: caching', () => {
  it('serves a success from memory for 6 hours, then asks again', async () => {
    fake.add('AbC123')
    const first = view(await service.get('AbC123'))
    expect(await service.get('AbC123')).toBe(first)
    await time.advance(6 * HOUR - 1)
    expect(await service.get('AbC123')).toBe(first)
    expect(fake.count()).toBe(1)
    await time.advance(1)
    view(await service.get('AbC123'))
    expect(fake.count()).toBe(2)
  })

  it('caches by exact code: a different case is a different appraisal', async () => {
    fake.add('AbC123').add('abc123')
    await service.get('AbC123')
    await service.get('abc123')
    expect(fake.count()).toBe(2)
  })

  it('keeps at most 100 entries', async () => {
    const codes = Array.from({ length: 101 }, (_, i) => `Code${String(i).padStart(3, '0')}`)
    for (const c of codes) fake.add(c)
    for (const c of codes) await service.get(c)
    expect(fake.count()).toBe(101)
    await service.get(codes[100])
    expect(fake.count()).toBe(101)
    await service.get(codes[0])
    expect(fake.count()).toBe(102)
  })

  it('remembers a 404 for 10 minutes, then asks again (and finds it once it exists)', async () => {
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_NOT_FOUND')
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_NOT_FOUND')
    expect(fake.count(/appraisal/)).toBe(1)
    fake.add('AbC123')
    await time.advance(10 * 60_000 - 1)
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_NOT_FOUND')
    await time.advance(1)
    expect(view(await service.get('AbC123')).code).toBe('AbC123')
    expect(fake.count(/appraisal/)).toBe(2)
  })

  it('does not cache a bad key or a busy answer', async () => {
    fake.add('AbC123')
    fake.faults = [{ kind: 'status', status: 401 }]
    expect(fail(await service.get('AbC123')).code).toBe('JANICE_BAD_KEY')
    expect(view(await service.get('AbC123')).code).toBe('AbC123')
  })
})

describe('get: single flight and deadline', () => {
  it('shares one request between concurrent callers of one code', async () => {
    fake.add('AbC123')
    const [a, b, c] = await Promise.all([service.get('AbC123'), service.get('AbC123'), service.get('AbC123')])
    expect(fake.count()).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('returns DEADLINE when the wait runs out; the read finishes later and is cached', async () => {
    fake.add('AbC123')
    fake.faults = [{ kind: 'hang' }]
    const pending = service.get('AbC123', { deadlineMs: 3000 })
    await time.advance(3000)
    expect(fail(await pending).code).toBe('DEADLINE')
    expect(fake.count()).toBe(1)
  })

  it('a late result lands in the cache', async () => {
    build({ minIntervalMs: 1000 })
    fake.add('AbC123').add('Zz9Yx8')
    await service.get('Zz9Yx8')
    const pending = service.get('AbC123', { deadlineMs: 500 })
    await time.advance(500)
    expect(fail(await pending).code).toBe('DEADLINE')
    await time.advance(1000)
    await new Promise((r) => setTimeout(r, 50))
    expect(view(await service.get('AbC123')).code).toBe('AbC123')
    expect(fake.count()).toBe(2)
  })
})

describe('get: serial spacing', () => {
  it('sends different codes one at a time, at least 1 s apart', async () => {
    build({ minIntervalMs: 1000 })
    fake.add('AbC123').add('Zz9Yx8')
    const done = Promise.all([service.get('AbC123'), service.get('Zz9Yx8')])
    await time.advance(0)
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.count()).toBe(1)
    await time.advance(1000)
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.count()).toBe(2)
    expect((await done).every((r) => !isFailure(r))).toBe(true)
  })
})
