import { describe, expect, it } from 'vitest'
import { compareVersion, DataError, dataKey, parseManifest } from '../../../src/core/data'
import { openObjects, openTable } from '../../../src/core/data/shapes'
import { makeVersion } from './helpers'

function errorOf(fn: () => unknown): DataError {
  try {
    fn()
  } catch (e) {
    if (e instanceof DataError) return e
    throw e
  }
  throw new Error('没有抛错')
}

describe('parseManifest', () => {
  it('reads the published format and keeps the snapshot source commit', () => {
    const { manifestBody } = makeVersion({ extra: { sourceCommit: 'a'.repeat(40), unknownKey: 1 } })
    const m = parseManifest(manifestBody)
    expect(m.schema).toBe(1)
    expect(m.files['types.json'].rows).toBeGreaterThan(0)
    expect(m.sourceCommit).toBe('a'.repeat(40))
    expect(m).not.toHaveProperty('unknownKey')
  })

  it('rejects another schema with an upgrade hint', () => {
    const newer = errorOf(() => parseManifest(makeVersion({ schema: 2 }).manifestBody))
    expect(newer.kind).toBe('schema')
    expect(newer.message).toContain('请升级插件')
    expect(errorOf(() => parseManifest(makeVersion({ schema: 0 }).manifestBody)).kind).toBe('schema')
  })

  it('rejects missing files, bad hashes and non-JSON', () => {
    const noFile = makeVersion().manifest
    delete (noFile.files as Record<string, unknown>)['universe.json']
    expect(errorOf(() => parseManifest(JSON.stringify(noFile))).kind).toBe('format')
    const badHash = makeVersion().manifest
    badHash.files['types.json'].sha256 = 'XYZ'
    expect(errorOf(() => parseManifest(JSON.stringify(badHash))).message).toContain('files.types.json')
    expect(errorOf(() => parseManifest('<html>')).kind).toBe('format')
    expect(errorOf(() => parseManifest('[1]')).kind).toBe('format')
  })
})

describe('versions', () => {
  it('compares build first, then dataRevision', () => {
    expect(compareVersion({ buildNumber: 2, dataRevision: 1 }, { buildNumber: 1, dataRevision: 9 })).toBeGreaterThan(0)
    expect(compareVersion({ buildNumber: 1, dataRevision: 2 }, { buildNumber: 1, dataRevision: 1 })).toBeGreaterThan(0)
    expect(compareVersion({ buildNumber: 1, dataRevision: 1 }, { buildNumber: 1, dataRevision: 1 })).toBe(0)
  })

  it('derives the data key from the three file hashes', () => {
    const a = makeVersion().manifest
    const b = makeVersion({ build: a.buildNumber + 1 }).manifest
    expect(dataKey(a)).toBe(dataKey(b))
    const c = makeVersion({ edit: (j) => { j['universe.json'].factions.pop() } }).manifest
    expect(dataKey(c)).not.toBe(dataKey(a))
    expect(dataKey(a).split('.')).toHaveLength(3)
  })
})

describe('openTable', () => {
  const spec = { columns: 'columns', rows: 'rows', need: { id: 'int', name: 'str', size: 'num?' } } as const

  it('reads by column name, whatever the order, and ignores extra columns', () => {
    const t = openTable('x.json', { columns: ['extra', 'size', 'id', 'name'], rows: [[true, null, 7, 'a'], [false, 1.5, 8, 'b']] }, spec)
    expect(t.rows[1][t.col.name]).toBe('b')
    expect(t.rows[0][t.col.size]).toBeNull()
    expect(t.col.id).toBe(2)
  })

  it('names the missing columns', () => {
    const e = errorOf(() => openTable('x.json', { columns: ['id'], rows: [] }, spec))
    expect(e.kind).toBe('columns')
    expect(e.message).toBe('x.json 的 rows 缺少列：name、size')
  })

  it('checks every row: length and cell types', () => {
    const short = errorOf(() => openTable('x.json', { columns: ['id', 'name', 'size'], rows: [[1, 'a']] }, spec))
    expect(short.message).toContain('第 1 行的列数')
    const wrong = errorOf(() => openTable('x.json', { columns: ['id', 'name', 'size'], rows: [[1, 'a', 2], [2.5, 'b', 1]] }, spec))
    expect(wrong.kind).toBe('format')
    expect(wrong.message).toContain('第 2 行的 id 应该是整数')
    const nullName = errorOf(() => openTable('x.json', { columns: ['id', 'name', 'size'], rows: [[1, null, 2]] }, spec))
    expect(nullName.message).toContain('name 应该是字符串')
    expect(errorOf(() => openTable('x.json', { columns: ['id', 'name', 'size'] }, spec)).message).toContain('没有 rows 表')
    expect(errorOf(() => openTable('x.json', { rows: [] }, spec)).kind).toBe('columns')
  })
})

describe('openObjects', () => {
  it('requires the declared fields with the right types', () => {
    const need = { id: 'int', sec: 'obj' } as const
    expect(openObjects('i.json', { rigs: [{ id: 1, sec: {}, extra: 'ok' }] }, 'rigs', need)).toHaveLength(1)
    expect(errorOf(() => openObjects('i.json', { rigs: [{ id: 1 }] }, 'rigs', need)).kind).toBe('columns')
    expect(errorOf(() => openObjects('i.json', { rigs: [{ id: 1, sec: [] }] }, 'rigs', need)).kind).toBe('format')
    expect(errorOf(() => openObjects('i.json', { rigs: [3] }, 'rigs', need)).message).toContain('不是对象')
  })
})
