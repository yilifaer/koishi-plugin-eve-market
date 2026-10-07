// 插件自带的完整快照和测试小数据集：能加载、数字和 manifest 对得上、脚本的 --check 和抽取结果是最新的。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { GLOBAL_MARKET_TYPES } from '../../../src/constants'
import { loadDataSet, tableCounts } from '../../../src/core/data'
import {
  FIXTURE_DIR, FIXTURE_LOADED_AT, itemByName, loadFixtureData, loadFixtureGlossary, loadSnapshotData, loadSnapshotGlossary,
  SNAPSHOT_DIR, snapshotFiles, staticDataService,
} from '../../fixtures/data/load'

const ROOT = path.resolve(__dirname, '../../..')
const tmpDirs: string[] = []

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-market-data-'))
  tmpDirs.push(dir)
  return dir
}

function runScript(script: string, args: string[]) {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', stdio: 'pipe' })
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('bundled snapshot (data/)', () => {
  it('loads completely and matches the manifest row counts', () => {
    const started = performance.now()
    const data = loadSnapshotData()
    const elapsed = performance.now() - started
    const { manifest } = data
    expect(data.types.size).toBe(manifest.files['types.json'].rows)
    expect(data.industry.blueprints.length).toBe(manifest.files['industry.json'].rows)
    expect(data.universe.systems.size).toBe(manifest.files['universe.json'].rows)
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    // 宽松阈值：开发机上约 0.3 秒，CI 慢的机器也不应超过这个数
    expect(elapsed).toBeLessThan(10000)
  })

  it('has the public facts the plugin relies on', () => {
    const data = loadSnapshotData()
    const raven = itemByName(data, 'Raven')
    expect(raven).toMatchObject({ typeId: 638, zh: '乌鸦级', categoryId: 6, packagedVolume: 50000 })
    expect(data.universe.stations.get(60003760)?.systemId).toBe(30000142)
    expect(data.universe.systems.get(30000142)).toMatchObject({ en: 'Jita', zh: '吉他', regionId: 10000002 })
    for (const id of GLOBAL_MARKET_TYPES) expect(data.types.rowOf(id)).toBeGreaterThanOrEqual(0)
    expect(data.industry.manufacturing.get(638)?.blueprintId).toBe(688)
    const counts = tableCounts(data)
    expect(counts.structures).toBeGreaterThanOrEqual(14)
    expect(counts.factions).toBeGreaterThanOrEqual(27)
  })

  it('ships a usable glossary', () => {
    const glossary = loadSnapshotGlossary()
    expect(glossary.entries.length).toBeGreaterThan(300)
    expect(glossary.entries.find((e) => e.zh === '海万王')?.en).toBe('Megathron Navy Issue')
  })

  it('passes snapshot.mjs --check, and the check notices a damaged file', () => {
    expect(runScript('snapshot.mjs', ['--check'])).toContain('快照完整')

    const copy = tmpDir()
    for (const name of fs.readdirSync(SNAPSHOT_DIR)) fs.copyFileSync(path.join(SNAPSHOT_DIR, name), path.join(copy, name))
    const types = snapshotFiles().files['types.json']
    const damaged = Buffer.from(types.toString('utf8').replace('"Raven"', '"Rave0"'))
    fs.writeFileSync(path.join(copy, 'types.json.gz'), zlib.gzipSync(damaged))
    let failed: { status?: number; stderr?: string } | undefined
    try {
      runScript('snapshot.mjs', ['--check', '--dir', copy])
    } catch (e) {
      failed = e as { status?: number; stderr?: string }
    }
    expect(failed?.status).toBe(1)
    expect(failed?.stderr).toContain('types.json 的 sha256 和 manifest 不一致')
  })
})

describe('test fixture (tests/fixtures/data)', () => {
  it('is what make-fixture.mjs produces from the current snapshot', () => {
    const out = tmpDir()
    runScript('make-fixture.mjs', ['--out', out])
    for (const name of ['manifest.json', 'types.json', 'industry.json', 'universe.json', 'glossary.yaml']) {
      expect(fs.readFileSync(path.join(out, name)).equals(fs.readFileSync(path.join(FIXTURE_DIR, name))), name).toBe(true)
    }
  })

  it('is a consistent data set with the items the other tests need', () => {
    const data = loadFixtureData()
    const names = [
      'Raven', 'Raven Navy Issue', 'Tritanium', 'PLEX', 'Absolution', 'Salvation', 'Warrior II', 'Cruise Missile Launcher II',
      'Small Shield Extender II', 'Medium Shield Extender II', 'Large Shield Extender II', 'Raven Blueprint',
      'Cruise Missile Launcher II Blueprint', 'High-grade Crystal Alpha', 'Low-grade Wedge Omega', 'Megathron Navy Issue',
      'Liquid Ozone', 'Fortizar', 'Naglfar', 'Ark', 'Afterburner', 'Tungsten Carbide',
    ]
    for (const name of names) expect(itemByName(data, name).en).toBe(name)
    expect(itemByName(data, 'Raven').zh).toBe('乌鸦级')
    // T2 蓝图不能上市场
    expect(itemByName(data, 'Cruise Missile Launcher II Blueprint').marketGroupId).toBeNull()
    const skins = [...data.types.category].filter((c) => c === 91)
    expect(skins.length).toBeGreaterThanOrEqual(4)

    const systems = [...data.universe.systems.values()]
    for (const hub of ['Jita', 'Amarr', 'Dodixie', 'Rens', 'Hek']) expect(systems.some((s) => s.en === hub)).toBe(true)
    for (const station of [60003760, 60008494, 60011866, 60004588, 60005686]) expect(data.universe.stations.has(station)).toBe(true)
    expect(systems.filter((s) => s.zh === '' && /^[A-Z0-9]+-[A-Z0-9]+$/.test(s.en)).length).toBeGreaterThanOrEqual(3)
    expect(data.universe.factions.size).toBe(27)
    expect(loadFixtureGlossary().entries.length).toBeGreaterThan(300)
  })

  it('loads through the same validation as online data', () => {
    const data = loadFixtureData()
    expect(data.loadedAt).toBe(FIXTURE_LOADED_AT)
    expect(() => loadDataSet(data.manifest, {
      'types.json': fs.readFileSync(path.join(FIXTURE_DIR, 'types.json')),
      'industry.json': fs.readFileSync(path.join(FIXTURE_DIR, 'industry.json')),
      'universe.json': fs.readFileSync(path.join(FIXTURE_DIR, 'universe.json')),
    }, 'online', 0)).not.toThrow()
  })
})

describe('staticDataService', () => {
  it('serves fixed data and notifies listeners on update', async () => {
    const service = staticDataService()
    expect(service.current()).toBe(loadFixtureData())
    expect(service.status()).toMatchObject({ ready: true, origin: 'bundled' })
    const seen: string[] = []
    service.onUpdate((data) => seen.push(data.key))
    service.update(loadSnapshotData())
    expect(seen).toEqual([loadSnapshotData().key])
    expect(await service.refresh()).toMatchObject({ changed: false })
  })
})
