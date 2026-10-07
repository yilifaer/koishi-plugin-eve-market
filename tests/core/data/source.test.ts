// 下载、缓存记录、按版本缓存派生结构这些小部件。

import { describe, expect, it } from 'vitest'
import { DATA_MAX_BYTES } from '../../../src/constants'
import { DataError, memoByKey, sha256 } from '../../../src/core/data'
import { dataValidatorFor, glossaryValidatorFor, loadCheckState, saveCheckState } from '../../../src/core/data/check-state'
import { dirOf, downloadFile, getConditional, hostOf, reasonOf } from '../../../src/core/data/source'
import type { Downloader } from '../../../src/core/data/source'
import { createModuleStore, NetworkError } from '../../../src/core/ports'
import { FakeHttp, makeVersion, MemoryCache } from './helpers'

function downloader(http: FakeHttp): Downloader {
  return { http, userAgent: 'test/1', signal: new AbortController().signal }
}

describe('urls', () => {
  it('finds the manifest directory and host', () => {
    expect(dirOf('https://a.test/x/official/data/manifest.json')).toBe('https://a.test/x/official/data/')
    expect(dirOf('https://a.test/data/manifest.json?v=2#top')).toBe('https://a.test/data/')
    expect(hostOf('https://cdn.example.test:8443/a')).toBe('cdn.example.test:8443')
    expect(hostOf('not a url')).toBe('not a url')
  })

  it('describes errors in one short line', () => {
    expect(reasonOf(new NetworkError('timeout'))).toBe('超时')
    expect(reasonOf(new NetworkError('too-large'))).toBe('文件太大')
    expect(reasonOf(new DataError('rows', 'types.json 有 1 行'))).toBe('types.json 有 1 行')
    expect(reasonOf(new Error('boom'))).toBe('boom')
  })
})

describe('getConditional', () => {
  it('sends the user agent, validators, size limit and timeout', async () => {
    const http = new FakeHttp().set('https://a.test/m', { status: 304 })
    const res = await getConditional(downloader(http), 'https://a.test/m', { etag: '"e"', lastModified: 'Tue, 06 Oct 2026 11:00:00 GMT' })
    expect(res.status).toBe(304)
    const req = http.requests[0]
    expect(req.headers).toEqual({ 'User-Agent': 'test/1', 'If-None-Match': '"e"', 'If-Modified-Since': 'Tue, 06 Oct 2026 11:00:00 GMT' })
    expect(req.maxBytes).toBe(DATA_MAX_BYTES)
    expect(req.timeoutMs).toBeGreaterThan(0)
  })
})

describe('downloadFile', () => {
  const v = makeVersion()
  const entry = v.manifest.files['types.json']

  it('returns the first body whose sha256 matches', async () => {
    const http = new FakeHttp()
      .set('https://a.test/types.json', { body: 'old' })
      .set('https://b.test/types.json', { body: v.files['types.json'] })
    const body = await downloadFile(downloader(http), ['https://a.test/', 'https://b.test/'], 'types.json', entry)
    expect(sha256(body)).toBe(entry.sha256)
  })

  it('reports every host when none has the right file', async () => {
    const http = new FakeHttp()
      .set('https://a.test/types.json', { fail: new NetworkError('network') })
      .set('https://b.test/types.json', { status: 503 })
    await expect(downloadFile(downloader(http), ['https://a.test/', 'https://b.test/'], 'types.json', entry))
      .rejects.toThrow('types.json 下载失败：a.test 网络错误；b.test HTTP 503')
  })

  it('refuses files the manifest says are too big, without downloading', async () => {
    const http = new FakeHttp()
    await expect(downloadFile(downloader(http), ['https://a.test/'], 'types.json', { ...entry, bytes: DATA_MAX_BYTES + 1 }))
      .rejects.toThrow('超过上限')
    expect(http.requests).toHaveLength(0)
  })
})

describe('check state', () => {
  it('survives a round trip and drops URLs no longer configured', async () => {
    const cache = new MemoryCache()
    const state = await loadCheckState(cache)
    state.data.confirmedAt = 123
    state.data.validators['https://a.test/m'] = { etag: '"a"', build: 5, revision: 1 }
    state.data.validators['https://old.test/m'] = { etag: '"o"', build: 5, revision: 1 }
    state.glossary.validators['https://a.test/g'] = { lastModified: 'x', key: 'k1' }
    await saveCheckState(cache, state, { data: ['https://a.test/m'], glossary: ['https://a.test/g'] })
    const again = await loadCheckState(cache)
    expect(again.data).toEqual({ confirmedAt: 123, validators: { 'https://a.test/m': { etag: '"a"', build: 5, revision: 1 } } })
    expect(again.glossary.validators['https://a.test/g']).toEqual({ lastModified: 'x', key: 'k1' })
  })

  it('starts empty from a missing or garbled record', async () => {
    const cache = new MemoryCache()
    cache.entries.set('data/state.json', { body: Buffer.from('{"data":{"confirmedAt":"x","validators":{"u":{"etag":5}}}}'), meta: {} })
    expect(await loadCheckState(cache)).toEqual({ data: { confirmedAt: null, validators: {} }, glossary: { confirmedAt: null, validators: {} } })
    cache.entries.set('data/state.json', { body: Buffer.from('not json'), meta: {} })
    expect((await loadCheckState(cache)).data.confirmedAt).toBeNull()
  })

  it('uses validators only for the version or content they were saved with', async () => {
    const state = await loadCheckState(new MemoryCache())
    state.data.validators.u = { etag: '"e"', build: 10, revision: 2 }
    state.glossary.validators.g = { etag: '"g"', key: 'k1' }
    expect(dataValidatorFor(state, 'u', { ...makeVersion().manifest, buildNumber: 10, dataRevision: 2 })).toBeDefined()
    expect(dataValidatorFor(state, 'u', { ...makeVersion().manifest, buildNumber: 10, dataRevision: 1 })).toBeUndefined()
    expect(dataValidatorFor(state, 'u', undefined)).toBeUndefined()
    expect(glossaryValidatorFor(state, 'g', 'k1')).toBeDefined()
    expect(glossaryValidatorFor(state, 'g', 'k2')).toBeUndefined()
  })
})

describe('memoByKey', () => {
  it('rebuilds only when the key changes and keeps one value per slot', () => {
    const store = createModuleStore()
    let builds = 0
    const build = () => ({ n: ++builds })
    const a = memoByKey(store, 'items', 'k1', build)
    expect(memoByKey(store, 'items', 'k1', build)).toBe(a)
    const b = memoByKey(store, 'items', 'k2', build)
    expect(b).not.toBe(a)
    expect(memoByKey(store, 'items', 'k1', build)).not.toBe(a)
    expect(memoByKey(store, 'other', 'k1', build).n).toBe(4)
    expect(builds).toBe(4)
  })
})
