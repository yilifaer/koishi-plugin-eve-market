#!/usr/bin/env node
// 从插件自带的数据快照（data/）抽一小份前后一致的数据，写进 tests/fixtures/data/，给单测用。
// 格式和 eve-cn-slang 的 official/data 完全一样（一行一条），manifest 里的 sha256 / bytes / rows 按抽出来的文件重算，
// 所以测试可以把它当「在线数据」下载校验。黑话表原样复制。
//
// 用法：node scripts/make-fixture.mjs [--from data] [--out tests/fixtures/data]
// 选了哪些东西见下面的列表；数据里找不到某个名字时直接失败（说明上游改名了，要同步改测试）。

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_FILES, GLOSSARY_FILE, isMain, ROW_TABLES, readSnapshot, sha256, writeAtomic } from './snapshot.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 物品（英文名）：查价、别名、黑话表、拼音、相关物品、工业的测试用 */
const TYPES = [
  // 舰船：乌鸦级和变体、两个都叫「救赎级」的、无畏、跳货、黑话表的「海万王」
  'Raven', 'Raven Navy Issue', 'Raven State Issue', 'Megathron', 'Megathron Navy Issue', 'Absolution', 'Salvation',
  'Naglfar', 'Revelation', 'Ark', 'Rhea',
  // 建筑（黑话表的 fort、工业建筑）
  'Fortizar', 'Astrahus', 'Keepstar', 'Raitaru', 'Azbel', 'Sotiyo', 'Athanor', 'Tatara',
  // 矿物、PLEX、液化臭氧
  'Tritanium', 'Pyerite', 'Mexallon', 'Isogen', 'Nocxium', 'Zydrine', 'Megacyte', 'Morphite', 'PLEX', 'Liquid Ozone',
  // 装备：T1 / T2 / 势力，护盾扩展装置小中大，注盾
  'Cruise Missile Launcher I', 'Cruise Missile Launcher II', 'Damage Control I', 'Damage Control II',
  'Small Shield Extender I', 'Small Shield Extender II', 'Medium Shield Extender I', 'Medium Shield Extender II',
  'Large Shield Extender I', 'Large Shield Extender II', 'Caldari Navy Large Shield Extender',
  'Large Ancillary Shield Booster', 'X-Large Ancillary Shield Booster', '1MN Afterburner I', '5MN Microwarpdrive I',
  // 无人机、弹药（装填弹药、Cap Booster 800 这类带数字的名字）
  'Warrior I', 'Warrior II', 'Hammerhead I', 'Hammerhead II', 'Scourge Cruise Missile', 'Cap Booster 800', 'Navy Cap Booster 800',
  // 技能：黑话表里容易误接的 AB、caps、reactions
  'Afterburner', 'Capital Ships', 'Reactions',
  // 蓝图（T2 蓝图不能上市场）和反应
  'Raven Blueprint', 'Megathron Blueprint', 'Cruise Missile Launcher II Blueprint', 'Warrior II Blueprint',
  'Large Shield Extender II Blueprint', 'Damage Control II Blueprint', 'Tungsten Carbide Reaction Formula', 'Tungsten Carbide',
]

/** 能力测试用的舰船：超旗舰、泰坦、航母、货舰、虎鲸、逆戟鲸 */
const CAPABILITY_SHIPS = ['Aeon', 'Erebus', 'Thanatos', 'Charon', 'Orca', 'Rorqual']

/** 整条制造链（拆到原料用）：从产品往下，把每层的蓝图和材料都收进来。Hound 是 T2 护卫舰，Unrefined Ferrofluid 是炼金术的例子 */
const CHAIN_PRODUCTS = ['Hound', 'Unrefined Ferrofluid']

/** 植入体套装：[等级, 英文套装名]（§6.1.5 的测试：高级水晶、高级九头蛇、中级仿生、低级强势、低级分裂、低级圣杯；水晶三个等级） */
const IMPLANT_SETS = [
  ['High', 'Crystal'], ['Mid', 'Crystal'], ['Low', 'Crystal'], ['High', 'Hydra'], ['Mid', 'Mimesis'],
  ['Low', 'Edge'], ['Low', 'Wedge'], ['Low', 'Grail'],
]
const SET_PARTS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Omega']

/** 涂装：这些船名开头、名字里有 SKIN 的前几个 */
const SKINS = { Raven: 3, Megathron: 1 }
const SKIN_CATEGORY = 91

/** 改装件：制造材料/时间、XL 舰船、Thukker（不同产品不同百分比）、反应、实验室（过滤器为 null） */
const RIGS = [37146, 37147, 37148, 37180, 45548, 46484, 37182]

/** 星系：五个交易中心、Jita 的邻居、低安、0.45 两侧、显示成 0.0 的低安 */
const SYSTEMS = [
  'Jita', 'Perimeter', 'New Caldari', 'Amarr', 'Dodixie', 'Rens', 'Hek', 'Tama', 'Aunenen', 'Iosantin', 'Egbinger', 'Thera',
]
/** 代号星系：这个星域按 id 取前几个；再加一个 J 开头的虫洞星系 */
const CODE_NAME_REGION = 'Great Wildlands'
const CODE_NAME_SYSTEMS = 3
const WORMHOLE_REGION_MIN = 11000000

function parseArgs(argv) {
  const args = { from: join(ROOT, 'data'), out: join(ROOT, 'tests/fixtures/data') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} 需要一个参数`)
      return v
    }
    if (a === '--from') args.from = resolve(next())
    else if (a === '--out') args.out = resolve(next())
    else throw new Error(`不认识的参数：${a}`)
  }
  return args
}

/** 按列名把行变成取值函数 */
function columns(json, key) {
  const index = Object.fromEntries(json[key].map((name, i) => [name, i]))
  return (row, name) => row[index[name]]
}

function byName(rows, col, label) {
  const map = new Map(rows.map((row) => [col(row, 'en'), row]))
  return (name) => {
    const row = map.get(name)
    if (!row) throw new Error(`快照里找不到${label}「${name}」`)
    return row
  }
}

// ------------------------------------------------------------------ 物品和工业

function pickTypeIds(types) {
  const col = columns(types, 'columns')
  const groupCol = columns(types, 'groupColumns')
  const categoryOfGroup = new Map(types.groups.map((g) => [groupCol(g, 'id'), groupCol(g, 'category')]))
  const find = byName(types.types, col, '物品')
  const ids = new Set([...TYPES, ...CAPABILITY_SHIPS].map((name) => col(find(name), 'id')))
  for (const [grade, set] of IMPLANT_SETS) {
    for (const part of SET_PARTS) ids.add(col(find(`${grade}-grade ${set} ${part}`), 'id'))
  }
  for (const [ship, count] of Object.entries(SKINS)) {
    const skins = types.types.filter((row) => categoryOfGroup.get(col(row, 'group')) === SKIN_CATEGORY
      && col(row, 'en').startsWith(`${ship} `) && col(row, 'en').includes('SKIN'))
    if (skins.length < count) throw new Error(`${ship} 的涂装不够 ${count} 个`)
    for (const row of skins.slice(0, count)) ids.add(col(row, 'id'))
  }
  return ids
}

/** 选中的蓝图（按物品 id）的全部活动，加上它们的材料和产品 */
function pickBlueprints(industry, typeIds) {
  const col = columns(industry, 'blueprintColumns')
  const rows = industry.blueprints.filter((row) => typeIds.has(col(row, 'blueprint')))
  for (const row of rows) {
    for (const [id] of [...col(row, 'products'), ...col(row, 'materials')]) typeIds.add(id)
  }
  return rows
}

/** 沿制造和反应蓝图一路往下收：产品、材料、蓝图本身（拆到原料的测试要完整的一条链） */
function addChains(industry, typeIds, types) {
  const col = columns(types, 'columns')
  const bcol = columns(industry, 'blueprintColumns')
  const find = byName(types.types, col, '物品')
  const byProduct = new Map()
  for (const row of industry.blueprints) {
    if (bcol(row, 'activity') !== 'm' && bcol(row, 'activity') !== 'r') continue
    for (const [id] of bcol(row, 'products')) byProduct.set(id, row)
  }
  const walk = (id) => {
    if (typeIds.has(id)) return
    typeIds.add(id)
    const row = byProduct.get(id)
    if (!row) return
    typeIds.add(bcol(row, 'blueprint'))
    for (const [material] of bcol(row, 'materials')) walk(material)
  }
  for (const name of CHAIN_PRODUCTS) {
    // 已经在表里的（例如被别的链先收进来）也要往下走，所以先拿掉
    typeIds.delete(col(find(name), 'id'))
    walk(col(find(name), 'id'))
  }
}

/** 提炼表只留产出的是选中物品的行，并把这些行的材料也收进来 */
function pickReprocessing(industry, typeIds) {
  const rows = industry.reprocessing.filter((row) => typeIds.has(row.id))
  for (const row of rows) for (const [id] of row.materials) typeIds.add(id)
  return rows
}

/** 变体的基础型号也要在（相关物品） */
function addVariationParents(types, typeIds) {
  const col = columns(types, 'columns')
  const byId = new Map(types.types.map((row) => [col(row, 'id'), row]))
  let added = true
  while (added) {
    added = false
    for (const id of [...typeIds]) {
      const parent = col(byId.get(id), 'variationParent')
      if (parent !== null && !typeIds.has(parent)) {
        typeIds.add(parent)
        added = true
      }
    }
  }
}

/** 市场分组连同所有上级 */
function marketGroupClosure(types, typeRows) {
  const col = columns(types, 'columns')
  const mgCol = columns(types, 'marketGroupColumns')
  const parentOf = new Map(types.marketGroups.map((row) => [mgCol(row, 'id'), mgCol(row, 'parent')]))
  const ids = new Set()
  for (const row of typeRows) {
    let id = col(row, 'marketGroup')
    while (id !== null && !ids.has(id)) {
      ids.add(id)
      id = parentOf.get(id) ?? null
    }
  }
  return ids
}

function fixtureTypes(types, typeIds) {
  const col = columns(types, 'columns')
  const groupCol = columns(types, 'groupColumns')
  const mgCol = columns(types, 'marketGroupColumns')
  const typeRows = types.types.filter((row) => typeIds.has(col(row, 'id')))
  const groupIds = new Set(typeRows.map((row) => col(row, 'group')))
  const marketGroupIds = marketGroupClosure(types, typeRows)
  return {
    ...types,
    types: typeRows,
    groups: types.groups.filter((row) => groupIds.has(groupCol(row, 'id'))),
    marketGroups: types.marketGroups.filter((row) => marketGroupIds.has(mgCol(row, 'id'))),
  }
}

function fixtureIndustry(industry, blueprintRows, reprocessing) {
  return {
    ...industry,
    blueprints: blueprintRows,
    reprocessing,
    rigs: industry.rigs.filter((rig) => RIGS.includes(rig.id)),
  }
}

// ------------------------------------------------------------------ 星图

function pickSystems(universe) {
  const col = columns(universe, 'systemColumns')
  const regionCol = columns(universe, 'regionColumns')
  const find = byName(universe.systems, col, '星系')
  const ids = new Set(SYSTEMS.map((name) => col(find(name), 'id')))
  const region = universe.regions.find((row) => regionCol(row, 'en') === CODE_NAME_REGION)
  if (!region) throw new Error(`快照里找不到星域「${CODE_NAME_REGION}」`)
  const coded = universe.systems.filter((row) => col(row, 'region') === regionCol(region, 'id') && col(row, 'zh') === '')
  for (const row of coded.slice(0, CODE_NAME_SYSTEMS)) ids.add(col(row, 'id'))
  const wormhole = universe.systems.find((row) => col(row, 'region') >= WORMHOLE_REGION_MIN && /^J\d+$/.test(col(row, 'en')))
  if (wormhole) ids.add(col(wormhole, 'id'))
  return ids
}

function fixtureUniverse(universe) {
  const systemIds = pickSystems(universe)
  const col = columns(universe, 'systemColumns')
  const consCol = columns(universe, 'constellationColumns')
  const stationCol = columns(universe, 'stationColumns')
  const jumpCol = columns(universe, 'jumpColumns')
  const systems = universe.systems.filter((row) => systemIds.has(col(row, 'id')))
  const constellationIds = new Set(systems.map((row) => col(row, 'constellation')))
  return {
    ...universe,
    constellations: universe.constellations.filter((row) => constellationIds.has(consCol(row, 'id'))),
    systems,
    stations: universe.stations.filter((row) => systemIds.has(stationCol(row, 'system'))),
    jumps: universe.jumps.filter((row) => systemIds.has(jumpCol(row, 'a')) && systemIds.has(jumpCol(row, 'b'))),
  }
}

// ------------------------------------------------------------------ 输出（和 eve-cn-slang 一样：头部一个键一行，表一行一条）

function isTable(value) {
  return Array.isArray(value) && value.length > 0 && value.every((v) => v !== null && typeof v === 'object')
}

export function formatDataFile(json) {
  const parts = Object.entries(json).map(([key, value]) => isTable(value)
    ? `${JSON.stringify(key)}: [\n${value.map((row) => JSON.stringify(row)).join(',\n')}\n]`
    : `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  return `{\n${parts.join(',\n')}\n}\n`
}

function formatManifest(manifest) {
  const head = ['schema', 'dataRevision', 'buildNumber', 'sdeReleaseDate', 'generatedAt']
    .map((key) => `${JSON.stringify(key)}: ${JSON.stringify(manifest[key])}`)
  const files = Object.entries(manifest.files).map(([name, entry]) => `${JSON.stringify(name)}: ${JSON.stringify(entry)}`)
  return `{\n${head.join(',\n')},\n"files": {\n${files.join(',\n')}\n},\n"sourceCommit": ${JSON.stringify(manifest.sourceCommit)}\n}\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const { manifest, files } = readSnapshot(args.from)
  const full = Object.fromEntries(DATA_FILES.map((name) => [name, JSON.parse(files[name].toString('utf8'))]))

  const typeIds = pickTypeIds(full['types.json'])
  addChains(full['industry.json'], typeIds, full['types.json'])
  const blueprintRows = pickBlueprints(full['industry.json'], typeIds)
  const reprocessing = pickReprocessing(full['industry.json'], typeIds)
  addVariationParents(full['types.json'], typeIds)
  const out = {
    'types.json': fixtureTypes(full['types.json'], typeIds),
    'industry.json': fixtureIndustry(full['industry.json'], blueprintRows, reprocessing),
    'universe.json': fixtureUniverse(full['universe.json']),
  }

  const entries = {}
  for (const name of DATA_FILES) {
    const body = Buffer.from(formatDataFile(out[name]))
    writeAtomic(join(args.out, name), body)
    entries[name] = { sha256: sha256(body), bytes: body.length, rows: out[name][ROW_TABLES[name]].length }
  }
  writeAtomic(join(args.out, GLOSSARY_FILE), files[GLOSSARY_FILE])
  const fixtureManifest = { ...manifest, files: entries }
  writeAtomic(join(args.out, 'manifest.json'), formatManifest(fixtureManifest))
  console.log(DATA_FILES.map((name) => `${name} ${entries[name].rows} 行 ${entries[name].bytes} 字节`).join('，'))
}

if (isMain(import.meta.url)) {
  try {
    main()
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}
