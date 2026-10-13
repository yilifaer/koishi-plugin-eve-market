import { describe, expect, it } from 'vitest'
import { checkShrink, DataError, loadDataSet, tableCounts } from '../../../src/core/data'
import type { DataErrorKind } from '../../../src/core/data'
import { NO_ID } from '../../../src/core/types'
import { itemByName, loadFixtureData } from '../../fixtures/data/load'
import { makeVersion } from './helpers'
import type { Json, Version } from './helpers'

const load = (v: Version) => loadDataSet(v.manifest, v.files, 'online', 1)

function failure(v: Version): { kind: DataErrorKind; message: string } {
  try {
    load(v)
  } catch (e) {
    if (e instanceof DataError) return { kind: e.kind, message: e.message }
    throw e
  }
  throw new Error('没有抛错')
}

/** 把一张列表的列换个顺序、再加一列（模拟以后的数据加列） */
function shuffleColumns(file: Json, columnsKey: string, rowsKey: string) {
  const columns: string[] = file[columnsKey]
  const order = [...columns.keys()].reverse()
  file[columnsKey] = ['futureColumn', ...order.map((i) => columns[i])]
  file[rowsKey] = file[rowsKey].map((row: unknown[]) => ['x', ...order.map((i) => row[i])])
}

describe('types table', () => {
  const data = loadFixtureData()

  it('looks items up by id and builds ItemInfo', () => {
    const raven = itemByName(data, 'Raven')
    expect(data.types.rowOf(638)).toBeGreaterThanOrEqual(0)
    expect(raven).toEqual({
      typeId: 638, en: 'Raven', zh: '乌鸦级', groupId: 27, categoryId: 6, marketGroupId: 80, metaGroupId: 1, techLevel: 1,
      volume: 470000, packagedVolume: 50000, portionSize: 1, capacity: 830, variationParent: null,
    })
    expect(data.types.item(data.types.rowOf(638))).toBe(raven)
    expect(Object.isFrozen(raven)).toBe(true)
    expect(data.types.rowOf(1)).toBe(-1)
    expect(() => data.types.item(data.types.size)).toThrow(RangeError)
  })

  it('fills packaged volume, empty columns and pinyin', () => {
    const trit = itemByName(data, 'Tritanium')
    expect(trit.packagedVolume).toBe(trit.volume)
    expect(trit.capacity).toBeNull()
    expect(trit.metaGroupId).toBeNull()
    const row = data.types.rowOf(trit.typeId)
    expect(data.types.metaGroup[row]).toBe(NO_ID)
    expect(Number.isNaN(data.types.capacity[row])).toBe(true)
    expect(data.types.py[row]).toBe('santaihejin sthj')
    const blueprint = data.types.rowOf(itemByName(data, 'Cruise Missile Launcher II Blueprint').typeId)
    expect(data.types.py[blueprint]).toBe('')
    expect(data.types.marketGroup[blueprint]).toBe(NO_ID)
  })

  it('links variants to their base type and fills group tables', () => {
    expect(itemByName(data, 'Raven Navy Issue').variationParent).toBe(638)
    expect(data.groups.get(27)).toMatchObject({ en: 'Battleship', categoryId: 6, published: true })
    expect(data.categories.get(91)?.en).toBe('SKINs')
    expect(data.metaGroups.get(2)?.zh).toBe('二级科技')
    const mg = data.marketGroups.get(80)
    expect(mg?.parentId).not.toBeNull()
    expect(data.marketGroups.has(mg!.parentId!)).toBe(true)
  })
})

describe('industry', () => {
  const data = loadFixtureData()

  it('indexes blueprints by blueprint and by product', () => {
    const raven = data.industry.byBlueprint.get(688)
    expect(raven?.m?.products).toEqual([{ typeId: 638, quantity: 1 }])
    expect(raven?.i?.products[0].probability).toBeGreaterThan(0)
    expect(data.industry.manufacturing.get(638)?.blueprintId).toBe(688)
    expect(data.industry.reactions.get(16672)).toMatchObject({ blueprintId: 46207, activity: 'r' })
    expect(data.industry.manufacturing.has(16672)).toBe(false)
    for (const bp of data.industry.blueprints) {
      for (const m of bp.materials) expect(data.types.rowOf(m.typeId)).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps per-effect percentages for rigs and summarizes them', () => {
    const thukker = data.industry.rigs.get(45548)!
    expect(thukker.effects.filter((e) => e.kind === 'me').map((e) => e.pct)).toEqual([-2, -3.7, -2, -3.7])
    expect(thukker.bonus).toEqual({ me: -2, te: -20 })
    const lab = data.industry.rigs.get(37182)!
    expect(lab.effects.every((e) => e.filter === null)).toBe(true)
    expect(lab.bonus).toEqual({ te: -24, cost: -12 })
    const reaction = data.industry.rigs.get(46484)!
    expect(reaction.sec.h).toBeNull()
    expect(data.industry.filters.get(thukker.effects[0].filter!)).toBeDefined()
  })

  it('reads structure bonuses per activity', () => {
    expect(data.industry.structures.get(35825)).toMatchObject({ en: 'Raitaru', rigSize: 2, highsec: true, bonus: { m: { me: 0.99, te: 0.85, cost: 0.97 } } })
    expect(data.industry.structures.get(35827)?.highsec).toBe(false)
    expect(data.industry.structures.get(35835)?.bonus).toEqual({})
  })

  it('skips activities and effect kinds it does not know yet', () => {
    const v = makeVersion({
      edit: (j) => {
        j['industry.json'].blueprints.push([688, 'c', 100, 1, [], []])
        j['industry.json'].rigs[0].effects.push(['zz', 'me', null, -1], ['m', 'speed', null, -1])
        j['industry.json'].structures[0].bonus.zz = { me: 0.5 }
      },
    })
    const data2 = load(v)
    expect(data2.industry.blueprints).toHaveLength(data.industry.blueprints.length)
    expect(data2.industry.rigs.get(37146)?.effects).toHaveLength(1)
    expect(data2.industry.structures.get(35825)?.bonus).not.toHaveProperty('zz')
  })
})

describe('services and reprocessing tables', () => {
  const data = loadFixtureData()

  it('reads both tables from the fixture', () => {
    const services = data.industry.services!
    expect(services.map((s) => s.id)).toContain(35881)
    expect(services.find((s) => s.id === 35877)).toMatchObject({ key: 'supercapital', activity: 'm', fitTypes: [35827], sec: { h: false, l: false, n: true } })
    expect(services.find((s) => s.id === 35899)?.activity).toBe('rp')
    // 29663 的产出里 16669 是反应产物（主产物），16648 是副产品
    const row = data.industry.reprocessing!.get(29663)!
    expect(row).toMatchObject({ portion: 1, skill: null, main: 16669 })
    expect(row.materials).toEqual([{ typeId: 16648, quantity: 173 }, { typeId: 16669, quantity: 73 }])
  })

  it('has no main product unless exactly one output is a reaction product', () => {
    const none = load(makeVersion({ edit: (j) => { j['industry.json'].reprocessing[0].materials = [[16648, 1], [34, 1]] } }))
    expect(none.industry.reprocessing!.get(29663)?.main).toBeNull()
  })

  it('treats old data without the tables as null', () => {
    const old = load(makeVersion({ edit: (j) => { delete j['industry.json'].services; delete j['industry.json'].reprocessing } }))
    expect(old.industry.services).toBeNull()
    expect(old.industry.reprocessing).toBeNull()
    expect(tableCounts(old)).toMatchObject({ services: 0, reprocessing: 0 })
  })

  it('skips services with an unknown activity', () => {
    const v = load(makeVersion({ edit: (j) => { j['industry.json'].services.push({ ...j['industry.json'].services[0], id: 1, activity: 'zz' }) } }))
    expect(v.industry.services).toHaveLength(data.industry.services!.length)
  })

  it('rejects the whole data when a present table is malformed', () => {
    const badSec = makeVersion({ edit: (j) => { j['industry.json'].services[0].sec.h = 'yes' } })
    expect(failure(badSec)).toMatchObject({ kind: 'format', message: expect.stringContaining('sec.h') })
    const noField = makeVersion({ edit: (j) => { delete j['industry.json'].services[0].fitTypes } })
    expect(failure(noField).kind).toBe('columns')
    const notList = makeVersion({ edit: (j) => { j['industry.json'].reprocessing = {} } })
    expect(failure(notList).kind).toBe('format')
    const badMaterial = makeVersion({ edit: (j) => { j['industry.json'].reprocessing[0].materials = [[16648, 'x']] } })
    expect(failure(badMaterial).kind).toBe('format')
    const unknown = makeVersion({ edit: (j) => { j['industry.json'].reprocessing[0].materials = [[999999, 1]] } })
    expect(failure(unknown).kind).toBe('reference')
  })

  it('checkShrink rejects new data that lost the services table', () => {
    const lost = load(makeVersion({ edit: (j) => { delete j['industry.json'].services } }))
    expect(() => checkShrink(data, lost)).toThrow(/services/)
    // 手上的数据本来就没有时不受影响
    expect(() => checkShrink(lost, data)).not.toThrow()
    expect(() => checkShrink(lost, lost)).not.toThrow()
  })
})

describe('universe', () => {
  const data = loadFixtureData()

  it('has systems, stations and an undirected jump graph', () => {
    expect(data.universe.systems.get(30000142)).toMatchObject({ en: 'Jita', zh: '吉他', constellationId: 20000020, regionId: 10000002 })
    expect(data.universe.stations.get(60008494)?.systemId).toBe(30002187)
    expect(data.universe.jumps.get(30000142)).toContain(30000144)
    expect(data.universe.jumps.get(30000144)).toContain(30000142)
    expect(data.universe.regions.get(10000002)?.zh).toBe('伏尔戈')
    expect(data.universe.factions.get(500019)?.zh).toBeTruthy()
  })
})

describe('loadDataSet validation', () => {
  it('reads columns by name in any order', () => {
    const v = makeVersion({
      edit: (j) => {
        shuffleColumns(j['types.json'], 'columns', 'types')
        shuffleColumns(j['universe.json'], 'systemColumns', 'systems')
        shuffleColumns(j['industry.json'], 'blueprintColumns', 'blueprints')
      },
    })
    const shuffled = load(v)
    const original = loadFixtureData()
    expect(itemByName(shuffled, 'Raven')).toEqual(itemByName(original, 'Raven'))
    expect(shuffled.universe.systems.get(30000142)).toEqual(original.universe.systems.get(30000142))
    expect(shuffled.industry.manufacturing.get(638)).toEqual(original.industry.manufacturing.get(638))
  })

  it('skips a version that lacks a column the plugin needs', () => {
    const v = makeVersion({
      edit: (j) => {
        const t = j['types.json']
        const i = t.columns.indexOf('py')
        t.columns.splice(i, 1)
        for (const row of t.types) row.splice(i, 1)
      },
    })
    expect(failure(v)).toEqual({ kind: 'columns', message: 'types.json 的 types 缺少列：py' })
  })

  it('checks sha256 and the manifest row counts', () => {
    const v = makeVersion()
    v.files['universe.json'] = Buffer.from(v.files['universe.json'].toString().replace('Jita', 'Jitb'))
    expect(failure(v).kind).toBe('hash')
    const rows = makeVersion()
    rows.manifest.files['types.json'].rows += 1
    expect(failure(rows)).toMatchObject({ kind: 'rows' })
  })

  it('checks the schema in each file header', () => {
    const v = makeVersion({ edit: (j) => { j['industry.json'].schema = 2 } })
    expect(failure(v)).toMatchObject({ kind: 'schema' })
  })

  it('rejects broken references', () => {
    const material = makeVersion({ edit: (j) => { j['industry.json'].blueprints[0][5].push([999999999, 1]) } })
    expect(failure(material)).toMatchObject({ kind: 'reference' })
    expect(failure(material).message).toContain('材料 999999999')
    const filter = makeVersion({ edit: (j) => { j['industry.json'].rigs[0].effects[0][2] = 404 } })
    expect(failure(filter).message).toContain('过滤器 404 不存在')
    const region = makeVersion({ edit: (j) => { j['universe.json'].regions = j['universe.json'].regions.filter((r: number[]) => r[0] !== 10000002) } })
    expect(failure(region)).toMatchObject({ kind: 'reference' })
    const group = makeVersion({ edit: (j) => { j['types.json'].groups = j['types.json'].groups.filter((g: number[]) => g[0] !== 27) } })
    expect(failure(group).message).toContain('分组 27 不存在')
    const station = makeVersion({ edit: (j) => { j['universe.json'].stations.push([60999999, 30999999]) } })
    expect(failure(station).message).toContain('星系 30999999 不存在')
  })

  it('rejects unsorted or duplicate type ids and bad nested values', () => {
    const unsorted = makeVersion({ edit: (j) => { j['types.json'].types.reverse() } })
    expect(failure(unsorted).message).toContain('升序')
    const dupFaction = makeVersion({ edit: (j) => { j['universe.json'].factions.push(j['universe.json'].factions[0]) } })
    expect(failure(dupFaction).message).toContain('重复')
    const badMaterial = makeVersion({ edit: (j) => { j['industry.json'].blueprints[0][5][0] = [34] } })
    expect(failure(badMaterial)).toMatchObject({ kind: 'format' })
    const badSec = makeVersion({ edit: (j) => { j['industry.json'].rigs[0].sec.h = 'x' } })
    expect(failure(badSec).message).toContain('sec.h')
  })

  it('produces a frozen data set with a stable key', () => {
    const v = makeVersion()
    const a = load(v)
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(a.manifest)).toBe(true)
    expect(load(v).key).toBe(a.key)
    expect(a.origin).toBe('online')
  })
})

describe('checkShrink', () => {
  const current = loadFixtureData()

  it('accepts the same size and small drops', () => {
    expect(() => checkShrink(current, current)).not.toThrow()
    const fewer = load(makeVersion({ edit: (j) => { j['universe.json'].factions.pop() } }))
    expect(() => checkShrink(current, fewer)).not.toThrow()
  })

  it('rejects a table that lost more than 20%', () => {
    // 只留前 60% 的物品，并去掉引用到被删物品的蓝图，保证其他校验都能过
    const shrunk = load(makeVersion({
      edit: (j) => {
        const types = j['types.json'].types as number[][]
        const keep = new Set(types.slice(0, Math.floor(types.length * 0.6)).map((r) => r[0]))
        j['types.json'].types = types.filter((r) => keep.has(r[0]))
        j['industry.json'].blueprints = (j['industry.json'].blueprints as Array<[number, string, number, number, number[][], number[][]]>)
          .filter((b) => keep.has(b[0]) && [...b[4], ...b[5]].every(([id]) => keep.has(id)))
        j['industry.json'].reprocessing = []
      },
    }))
    expect(() => checkShrink(current, shrunk)).toThrow(/types/)
    expect(tableCounts(shrunk).types).toBeLessThan(tableCounts(current).types * 0.8)
  })
})
