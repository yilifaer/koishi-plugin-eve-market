// DataService：三级来源（模块级存储 / 缓存 / 自带快照）、在线检查（条件请求、备用网址、sha256、格式和版本规则）、
// 原子替换、定时、最近确认最新的时间、黑话表。网络、缓存、时间全部是假的。

import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DATA_FIRST_CHECK_SEC } from '../../../src/constants'
import { createDataService, DataNotReadyError, dataKey } from '../../../src/core/data'
import { createModuleStore, NetworkError } from '../../../src/core/ports'
import type { ModuleStore } from '../../../src/core/ports'
import type { DataSet } from '../../../src/core/types'
import { FakeTime, flush } from '../../fakes/fake-time'
import { fixtureFiles, itemByName } from '../../fixtures/data/load'
import { bundledDir, cleanupDirs, FakeHttp, makeVersion, MemoryCache, MemoryLogger, renameItem } from './helpers'
import type { Version } from './helpers'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const PRIMARY_DIR = 'https://primary.test/official/data/'
const MIRROR_DIR = 'https://mirror.test/gh/official/data/'
const PRIMARY = `${PRIMARY_DIR}manifest.json`
const MIRROR = `${MIRROR_DIR}manifest.json`
const G1 = 'https://primary.test/glossary.yaml'
const G2 = 'https://mirror.test/gh/glossary.yaml'

const base = makeVersion()
const BUILD = base.manifest.buildNumber
const newer = makeVersion({ build: BUILD + 1, edit: renameItem(638, '新乌鸦级') })

interface Setup {
  bundled?: Version | null
  bundledGlossary?: Buffer | null
  cache?: MemoryCache
  store?: ModuleStore
  http?: FakeHttp
  time?: FakeTime
  manifestUrls?: string[]
  glossaryUrls?: string[]
  useGlossary?: boolean
}

function setup(opts: Setup = {}) {
  const time = opts.time ?? new FakeTime()
  const http = opts.http ?? new FakeHttp()
  const cache = opts.cache ?? new MemoryCache()
  const store = opts.store ?? createModuleStore()
  const logger = new MemoryLogger()
  const bundled = opts.bundled === undefined ? base : opts.bundled
  const dir = bundled ? bundledDir(bundled, opts.bundledGlossary) : path.join(os.tmpdir(), 'eve-market-no-such-dir')
  const service = createDataService(
    { http, clock: time, scheduler: time, logger, cache, store, bundledDataDir: dir, version: '0.0.1' },
    {
      manifestUrls: opts.manifestUrls ?? [PRIMARY, MIRROR],
      glossaryUrls: opts.glossaryUrls ?? [],
      useGlossary: opts.useGlossary,
      random: () => 0.5,
    },
  )
  const updates: Array<{ data: DataSet; glossary: string | null }> = []
  service.onUpdate((data, glossary) => updates.push({ data, glossary: glossary?.origin ?? null }))
  return { service, time, http, cache, store, logger, updates }
}

const zhOf = (data: DataSet, id: number) => data.types.zh[data.types.rowOf(id)]

afterEach(cleanupDirs)

describe('startup', () => {
  it('starts from the bundled snapshot and schedules the first online check', async () => {
    const { service, time, updates, http } = setup()
    expect(() => service.current()).toThrow(DataNotReadyError)
    expect(service.status().ready).toBe(false)
    await service.start()
    await service.ready
    const data = service.current()
    expect(data.origin).toBe('bundled')
    expect(data.key).toBe(dataKey(base.manifest))
    expect(updates).toHaveLength(1)
    expect(service.status()).toMatchObject({ ready: true, origin: 'bundled', buildNumber: BUILD, lastCheckAt: null, lastConfirmedAt: null })
    expect(time.pending).toBe(1)
    expect(http.requests).toHaveLength(0)
  })

  it('prefers a newer cache, and the cache when versions are equal', async () => {
    const cache = new MemoryCache()
    cache.putVersion(newer)
    const a = setup({ cache })
    await a.service.start()
    expect(a.service.current().origin).toBe('cache')
    expect(zhOf(a.service.current(), 638)).toBe('新乌鸦级')

    const sameVersion = new MemoryCache()
    sameVersion.putVersion(makeVersion({ edit: renameItem(638, '缓存里的乌鸦级') }))
    const b = setup({ cache: sameVersion })
    await b.service.start()
    expect(b.service.current().origin).toBe('cache')
    expect(zhOf(b.service.current(), 638)).toBe('缓存里的乌鸦级')
  })

  it('uses the bundled snapshot when the cache is older', async () => {
    const cache = new MemoryCache()
    cache.putVersion(makeVersion({ build: BUILD - 1 }))
    const { service } = setup({ cache })
    await service.start()
    expect(service.current().origin).toBe('bundled')
  })

  it('throws away a damaged cache', async () => {
    const cache = new MemoryCache()
    cache.putVersion(newer)
    cache.entries.get('data/types.json')!.body = Buffer.from('{}')
    const { service, logger } = setup({ cache })
    await service.start()
    expect(service.current().origin).toBe('bundled')
    expect(cache.entries.has('data/manifest.json')).toBe(false)
    expect(logger.at('warn').join('\n')).toContain('sha256')
  })

  it('skips a cached version that lacks a needed column or has another schema', async () => {
    const noColumn = new MemoryCache()
    noColumn.putVersion(makeVersion({
      build: BUILD + 1,
      edit: (j) => {
        const t = j['types.json']
        const i = t.columns.indexOf('capacity')
        t.columns.splice(i, 1)
        for (const row of t.types) row.splice(i, 1)
      },
    }))
    const a = setup({ cache: noColumn })
    await a.service.start()
    expect(a.service.current().origin).toBe('bundled')
    expect(a.logger.at('warn').join('\n')).toContain('缺少列：capacity')

    const otherSchema = new MemoryCache()
    otherSchema.putVersion(makeVersion({ build: BUILD + 5, schema: 2 }))
    const b = setup({ cache: otherSchema })
    await b.service.start()
    expect(b.service.current().origin).toBe('bundled')
    expect(otherSchema.entries.has('data/manifest.json')).toBe(false)
  })

  it('with no URLs uses only the bundled data: no cache, no network, no timers', async () => {
    const cache = new MemoryCache()
    cache.putVersion(newer)
    const { service, time, http } = setup({ cache, manifestUrls: [], glossaryUrls: [] })
    await service.start()
    expect(service.current().origin).toBe('bundled')
    expect(cache.reads).not.toContain('data/manifest.json')
    expect(time.pending).toBe(0)
    expect(await service.refresh()).toEqual({ changed: false, glossaryChanged: false, checked: false })
    expect(http.requests).toHaveLength(0)
  })

  it('reuses the data set from the module store after a plugin reload', async () => {
    const store = createModuleStore()
    const cache = new MemoryCache()
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, newer)
    const first = setup({ store, cache, http })
    await first.service.start()
    await first.service.refresh()
    const online = first.service.current()
    expect(online.origin).toBe('online')
    first.service.stop()

    cache.reads.length = 0
    const second = setup({ store, cache, http })
    await second.service.start()
    expect(second.service.current()).toBe(online)
    expect(cache.reads.filter((k) => k.endsWith('types.json'))).toEqual([])
    expect(second.updates).toHaveLength(1)

    // 重启 Koishi（模块级存储没了）：从缓存读出同一个版本
    const third = setup({ cache, http })
    await third.service.start()
    expect(third.service.current()).not.toBe(online)
    expect(third.service.current()).toMatchObject({ origin: 'cache', key: online.key })
  })

  it('keeps a newer data set from the module store even when the cache write failed', async () => {
    const store = createModuleStore()
    const cache = new MemoryCache()
    cache.failWrites = true
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, newer)
    const first = setup({ store, cache, http })
    await first.service.start()
    expect((await first.service.refresh()).changed).toBe(true)
    expect(first.logger.at('warn').join('\n')).toContain('没写进缓存')
    first.service.stop()

    const second = setup({ store, cache, http })
    await second.service.start()
    expect(second.service.current().manifest.buildNumber).toBe(BUILD + 1)
  })

  it('waits for online data when nothing local is usable', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, base)
    const { service, logger } = setup({ bundled: null, http })
    await service.start()
    expect(service.status().ready).toBe(false)
    expect(logger.at('error').join('\n')).toContain('没有可用的物品数据')
    let ready = false
    void service.ready.then(() => { ready = true })
    expect((await service.refresh()).changed).toBe(true)
    await flush()
    expect(ready).toBe(true)
    expect(service.current().origin).toBe('online')
  })
})

describe('online check', () => {
  it('confirms freshness with 200 and then 304, without downloading', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, base)
    const { service, time, updates } = setup({ http })
    await service.start()
    expect(await service.refresh()).toEqual({ changed: false, glossaryChanged: false, checked: true })
    const confirmed = time.now()
    expect(http.requests.map((r) => r.url)).toEqual([PRIMARY])
    expect(http.requests[0].headers?.['If-None-Match']).toBeUndefined()

    await time.advance(HOUR)
    expect(await service.refresh()).toEqual({ changed: false, glossaryChanged: false, checked: true })
    expect(http.requests[1].headers?.['If-None-Match']).toMatch(/^"/)
    expect(service.status()).toMatchObject({ lastConfirmedAt: confirmed + HOUR, lastCheckAt: confirmed + HOUR, lastError: '' })
    expect(updates).toHaveLength(1)
  })

  it('downloads a newer version from the manifest directory, validates it and swaps it in at once', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, newer)
    const { service, cache, updates } = setup({ http })
    await service.start()
    const before = service.current()
    expect(await service.refresh()).toEqual({ changed: true, glossaryChanged: false, checked: true })
    const after = service.current()
    expect(after).not.toBe(before)
    expect(after.origin).toBe('online')
    expect(zhOf(after, 638)).toBe('新乌鸦级')
    expect(zhOf(before, 638)).toBe('乌鸦级')
    expect(updates.map((u) => u.data)).toEqual([before, after])
    expect(http.requests.map((r) => r.url)).toEqual([PRIMARY, `${PRIMARY_DIR}types.json`, `${PRIMARY_DIR}industry.json`, `${PRIMARY_DIR}universe.json`])
    // 数据文件先写，manifest 最后写
    expect(cache.writes.slice(0, 4)).toEqual(['data/types.json', 'data/industry.json', 'data/universe.json', 'data/manifest.json'])
    expect(service.status()).toMatchObject({ buildNumber: BUILD + 1, origin: 'online', lastError: '' })
  })

  it('tries the mirror when the first URL fails', async () => {
    const http = new FakeHttp()
      .set(PRIMARY, { fail: new NetworkError('timeout') })
      .serveVersion(MIRROR_DIR, newer)
    const { service } = setup({ http })
    await service.start()
    expect((await service.refresh()).changed).toBe(true)
    expect(http.count(`${MIRROR_DIR}types.json`)).toBe(1)
  })

  it('downloads from the other host when files do not match the new manifest (stale CDN)', async () => {
    const http = new FakeHttp().serveVersion(MIRROR_DIR, newer)
    http.set(PRIMARY, { body: newer.manifestBody })
    for (const name of ['types.json', 'industry.json', 'universe.json'] as const) http.set(PRIMARY_DIR + name, { body: base.files[name] })
    const { service } = setup({ http })
    await service.start()
    expect((await service.refresh()).changed).toBe(true)
    expect(http.count(`${PRIMARY_DIR}types.json`)).toBe(1)
    expect(http.count(`${MIRROR_DIR}types.json`)).toBe(1)
    expect(zhOf(service.current(), 638)).toBe('新乌鸦级')
  })

  it('keeps the current version when no host has matching files', async () => {
    const http = new FakeHttp().set(PRIMARY, { body: newer.manifestBody })
    for (const name of ['types.json', 'industry.json', 'universe.json'] as const) {
      http.set(PRIMARY_DIR + name, { body: base.files[name] })
      http.set(MIRROR_DIR + name, { status: 404 })
    }
    const { service, updates } = setup({ http })
    await service.start()
    const result = await service.refresh()
    expect(result).toMatchObject({ changed: false, checked: true })
    expect(result.error).toContain('sha256')
    expect(service.current().origin).toBe('bundled')
    expect(service.status().lastConfirmedAt).toBeNull()
    expect(service.status().lastError).toContain('没有更新成功')
    expect(updates).toHaveLength(1)
  })

  it('does not use an online manifest with another schema, and logs that once', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, makeVersion({ build: BUILD + 9, schema: 2 }), { etag: false })
    const { service, logger } = setup({ http })
    await service.start()
    const first = await service.refresh()
    await service.refresh()
    expect(first).toMatchObject({ changed: false, checked: true })
    expect(first.error).toContain('请升级插件')
    expect(service.current().origin).toBe('bundled')
    expect(logger.at('warn').filter((l) => l.includes('格式'))).toHaveLength(1)
    expect(http.count(`${PRIMARY_DIR}types.json`)).toBe(0)
    expect(service.status().lastError).toContain('请升级插件')
  })

  it('never goes back to an older or equal version', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, base)
    const { service } = setup({ http, bundled: makeVersion({ build: BUILD + 2 }) })
    await service.start()
    expect(await service.refresh()).toMatchObject({ changed: false, checked: true })
    expect(service.current().manifest.buildNumber).toBe(BUILD + 2)
    expect(http.requests).toHaveLength(1)
    // 同一个 build、dataRevision 也一样
    const same = new FakeHttp().serveVersion(PRIMARY_DIR, makeVersion({ edit: renameItem(638, 'X') }))
    const b = setup({ http: same })
    await b.service.start()
    expect((await b.service.refresh()).changed).toBe(false)
  })

  it('takes a new dataRevision of the same build (new columns for a newer plugin)', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, makeVersion({ revision: base.manifest.dataRevision + 1 }))
    const { service } = setup({ http })
    await service.start()
    expect((await service.refresh()).changed).toBe(true)
  })

  it('rejects a new version whose tables shrank too much', async () => {
    const shrunk = makeVersion({
      build: BUILD + 1,
      edit: (j) => { j['universe.json'].factions = j['universe.json'].factions.slice(0, 10) },
    })
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, shrunk)
    const { service } = setup({ http })
    await service.start()
    const result = await service.refresh()
    expect(result.changed).toBe(false)
    expect(result.error).toContain('factions 27 → 10')
  })

  it('rejects a new version with a missing column or broken reference', async () => {
    const broken = makeVersion({ build: BUILD + 1, edit: (j) => { j['industry.json'].rigs[0].effects[0][2] = 404 } })
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, broken)
    const { service } = setup({ http })
    await service.start()
    expect((await service.refresh()).error).toContain('过滤器 404 不存在')
    expect(service.current().origin).toBe('bundled')
  })

  it('sends validators only if the current version is not older than when they were saved', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, base, { etag: false })
    const state = (build: number) => Buffer.from(JSON.stringify({
      data: { confirmedAt: null, validators: { [PRIMARY]: { etag: '"x"', build, revision: 1 } } },
    }))
    const ahead = new MemoryCache()
    ahead.entries.set('data/state.json', { body: state(BUILD + 1), meta: {} })
    const a = setup({ http, cache: ahead })
    await a.service.start()
    await a.service.refresh()
    expect(http.requests.at(-1)?.headers?.['If-None-Match']).toBeUndefined()

    const same = new MemoryCache()
    same.entries.set('data/state.json', { body: state(BUILD), meta: {} })
    const b = setup({ http, cache: same })
    await b.service.start()
    await b.service.refresh()
    expect(http.requests.at(-1)?.headers?.['If-None-Match']).toBe('"x"')
  })

  it('shares one check between concurrent refresh calls', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, newer)
    const { service } = setup({ http })
    await service.start()
    const [a, b] = await Promise.all([service.refresh(), service.refresh()])
    expect(a).toBe(b)
    expect(http.count(PRIMARY)).toBe(1)
  })

  it('logs the first of consecutive failures as a warning and the recovery as info', async () => {
    const http = new FakeHttp().set(PRIMARY, { status: 500 }).set(MIRROR, { fail: new NetworkError('network') })
    const { service, logger } = setup({ http })
    await service.start()
    const first = await service.refresh()
    expect(first).toMatchObject({ changed: false, checked: false })
    expect(first.error).toBe('primary.test HTTP 500；mirror.test 网络错误')
    await service.refresh()
    expect(logger.at('warn').filter((l) => l.includes('在线更新失败'))).toHaveLength(1)
    expect(logger.at('debug').filter((l) => l.includes('仍然失败'))).toHaveLength(1)
    expect(service.status().lastError).toContain('HTTP 500')

    http.serveVersion(PRIMARY_DIR, base)
    await service.refresh()
    expect(logger.at('info').join('\n')).toContain('恢复正常')
    expect(service.status().lastError).toBe('')
  })

  it('a failing listener does not stop the others', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, newer)
    const { service, logger, updates } = setup({ http })
    service.onUpdate(() => { throw new Error('boom') })
    await service.start()
    await service.refresh()
    expect(updates).toHaveLength(2)
    expect(logger.at('warn').join('\n')).toContain('boom')
  })

  it('stops listening when unsubscribed', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, newer)
    const { service } = setup({ http })
    let calls = 0
    const off = service.onUpdate(() => { calls++ })
    await service.start()
    off()
    await service.refresh()
    expect(calls).toBe(1)
  })
})

describe('scheduling', () => {
  it('checks 20 seconds after start, then every 6 hours with jitter', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, base)
    const { service, time } = setup({ http })
    await service.start()
    await time.advance(DATA_FIRST_CHECK_SEC * 1000 - 1)
    expect(http.count(PRIMARY)).toBe(0)
    await time.advance(1)
    expect(http.count(PRIMARY)).toBe(1)
    // random = 0.5 → 正好 6 小时
    await time.advance(6 * HOUR - 1)
    expect(http.count(PRIMARY)).toBe(1)
    await time.advance(1)
    expect(http.count(PRIMARY)).toBe(2)
    expect(time.pending).toBe(1)
  })

  it('keeps the jitter within ±10%', async () => {
    for (const [random, at] of [[0, 5.4 * HOUR], [1, 6.6 * HOUR]] as const) {
      const time = new FakeTime()
      const http = new FakeHttp().serveVersion(PRIMARY_DIR, base)
      const store = createModuleStore()
      const service = createDataService(
        { http, clock: time, scheduler: time, logger: new MemoryLogger(), cache: new MemoryCache(), store, bundledDataDir: bundledDir(base), version: 't' },
        { manifestUrls: [PRIMARY], glossaryUrls: [], random: () => random },
      )
      await service.start()
      await time.advance(DATA_FIRST_CHECK_SEC * 1000)
      await time.advance(at - 1)
      expect(http.count(PRIMARY)).toBe(1)
      await time.advance(1)
      expect(http.count(PRIMARY)).toBe(2)
      service.stop()
    }
  })

  it('stop() cancels the timer and aborts a download in progress', async () => {
    const http = new FakeHttp().set(PRIMARY, { hang: true })
    const { service, time } = setup({ http })
    await service.start()
    expect(time.pending).toBe(1)
    const pending = service.refresh()
    await flush()
    service.stop()
    expect(time.pending).toBe(0)
    expect(await pending).toMatchObject({ changed: false, checked: false })
    expect(http.requests[0].signal?.aborted).toBe(true)
    await time.advance(7 * HOUR)
    expect(http.count(PRIMARY)).toBe(1)
  })
})

describe('freshness', () => {
  it('counts days since the last online confirmation, and remembers it across restarts', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, base)
    const cache = new MemoryCache()
    const first = setup({ http, cache })
    await first.service.start()
    await first.service.refresh()
    const confirmedAt = first.time.now()
    first.service.stop()

    const time = new FakeTime(confirmedAt + 15 * DAY + HOUR)
    const second = setup({ http, cache, time })
    await second.service.start()
    expect(second.service.status()).toMatchObject({ lastConfirmedAt: confirmedAt, ageDays: 15 })
  })

  it('falls back to generatedAt when the plugin never confirmed online', async () => {
    const generatedAt = Date.parse(base.manifest.generatedAt)
    const { service } = setup({ time: new FakeTime(generatedAt + 20 * DAY), manifestUrls: [] })
    await service.start()
    expect(service.status()).toMatchObject({ lastConfirmedAt: null, ageDays: 20, generatedAt: base.manifest.generatedAt })
  })
})

describe('glossary', () => {
  const bundledGlossary = fixtureFiles().glossary
  const bundledCount = bundledGlossary.toString().split('\n- en:').length
  const bigger = Buffer.from(`${bundledGlossary.toString()}\n- en: "test term"\n  zh: "测试词"\n  mode: hint\n  dir: both\n`)
  const tiny = Buffer.from('- en: "a"\n  zh: "甲"\n')

  it('starts from the bundled glossary', async () => {
    const { service, updates } = setup({ glossaryUrls: [G1] })
    await service.start()
    expect(service.glossary()?.origin).toBe('bundled')
    expect(service.glossary()?.entries.length).toBeGreaterThanOrEqual(bundledCount - 1)
    expect(updates[0].glossary).toBe('bundled')
  })

  it('downloads a changed glossary, caches it, and confirms with 304 later', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, base).serveGlossary(G1, bigger)
    const { service, cache, updates, time } = setup({ http, glossaryUrls: [G1, G2] })
    await service.start()
    const result = await service.refresh()
    expect(result).toEqual({ changed: false, glossaryChanged: true, checked: true })
    expect(service.glossary()?.origin).toBe('online')
    expect(service.glossary()?.entries.at(-1)?.zh).toBe('测试词')
    expect(cache.entries.has('data/glossary.yaml')).toBe(true)
    expect(updates.map((u) => u.glossary)).toEqual(['bundled', 'online'])

    await time.advance(HOUR)
    expect((await service.refresh()).glossaryChanged).toBe(false)
    expect(http.requests.filter((r) => r.url === G1).at(-1)?.headers?.['If-None-Match']).toMatch(/^"g-/)
    expect(service.status().glossary).toMatchObject({ origin: 'online', lastConfirmedAt: time.now(), lastError: '' })
  })

  it('rejects a glossary with less than half of the bundled entries and tries the mirror', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, base).serveGlossary(G1, tiny).serveGlossary(G2, bigger)
    const { service } = setup({ http, glossaryUrls: [G1, G2] })
    await service.start()
    expect((await service.refresh()).glossaryChanged).toBe(true)
    expect(service.glossary()?.entries.at(-1)?.zh).toBe('测试词')

    const onlyTiny = new FakeHttp().serveVersion(PRIMARY_DIR, base).serveGlossary(G1, tiny)
    const b = setup({ http: onlyTiny, glossaryUrls: [G1] })
    await b.service.start()
    const result = await b.service.refresh()
    expect(result.glossaryChanged).toBe(false)
    expect(result.error).toContain('黑话表')
    expect(b.service.glossary()?.origin).toBe('bundled')
    expect(b.service.status().glossary.lastError).toContain('至少要')
  })

  it('uses the cached glossary after a restart, but only in online mode', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, base).serveGlossary(G1, bigger)
    const cache = new MemoryCache()
    const first = setup({ http, cache, glossaryUrls: [G1] })
    await first.service.start()
    await first.service.refresh()
    first.service.stop()

    const second = setup({ http, cache, glossaryUrls: [G1] })
    await second.service.start()
    expect(second.service.glossary()?.origin).toBe('cache')

    const offline = setup({ http, cache, glossaryUrls: [] })
    await offline.service.start()
    expect(offline.service.glossary()?.origin).toBe('bundled')
  })

  it('ignores a cached glossary that does not match its recorded hash', async () => {
    const cache = new MemoryCache()
    cache.entries.set('data/glossary.yaml', { body: bigger, meta: { sha256: 'wrong' } })
    const { service } = setup({ cache, glossaryUrls: [G1] })
    await service.start()
    expect(service.glossary()?.origin).toBe('bundled')
  })

  it('can be switched off', async () => {
    const http = new FakeHttp().serveVersion(PRIMARY_DIR, base).serveGlossary(G1, bigger)
    const { service } = setup({ http, glossaryUrls: [G1], useGlossary: false })
    await service.start()
    await service.refresh()
    expect(service.glossary()).toBeNull()
    expect(http.count(G1)).toBe(0)
    expect(service.status().glossary).toMatchObject({ origin: null, entries: 0 })
  })

  it('still loads item data when the bundled glossary is missing', async () => {
    const { service } = setup({ bundledGlossary: null, glossaryUrls: [G1] })
    await service.start()
    expect(service.current().origin).toBe('bundled')
    expect(service.glossary()).toBeNull()
  })

  it('reloads reuse the same glossary object', async () => {
    const store = createModuleStore()
    const a = setup({ store, glossaryUrls: [G1] })
    await a.service.start()
    const g = a.service.glossary()
    a.service.stop()
    const b = setup({ store, glossaryUrls: [G1] })
    await b.service.start()
    expect(b.service.glossary()).toBe(g)
  })
})

describe('item data is the published format', () => {
  it('looks up items the same way from every source', async () => {
    const { service } = setup()
    await service.start()
    expect(itemByName(service.current(), 'Raven').zh).toBe('乌鸦级')
  })
})
