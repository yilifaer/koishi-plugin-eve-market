#!/usr/bin/env node
// 插件自带的数据快照（data/）：eve-cn-slang 某个提交的 official/data 三个数据文件和 glossary.yaml，
// 按 manifest 校验后 gzip 写进 data/，data/manifest.json 里加上来源提交 SHA 和黑话表的 sha256。
//
// 用法：
//   node scripts/snapshot.mjs                    下载 main 的最新提交（npm run snapshot）
//   node scripts/snapshot.mjs --ref <提交或分支>
//   node scripts/snapshot.mjs --check            不联网，按 data/manifest.json 核对快照（CI 用）
//   --dir <目录>                                 换一个快照目录（默认 data/）
//
// 联网用 Node 自带的 fetch；在代理后面时，Node 22.21 起可以加环境变量 NODE_USE_ENV_PROXY=1。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import yaml from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'yilifaer/eve-cn-slang'
export const DATA_FILES = ['types.json', 'industry.json', 'universe.json']
export const GLOSSARY_FILE = 'glossary.yaml'
/** manifest 的 rows 对应每个文件里的哪张表 */
export const ROW_TABLES = { 'types.json': 'types', 'industry.json': 'blueprints', 'universe.json': 'systems' }
const TIMEOUT_MS = 60000
const SHA_RE = /^[0-9a-f]{64}$/
const COMMIT_RE = /^[0-9a-f]{40}$/

/** 插件支持的数据格式版本，以 src/constants.ts 的 DATA_SCHEMA 为准 */
export function supportedSchema() {
  const source = readFileSync(join(ROOT, 'src/constants.ts'), 'utf8')
  const m = /export const DATA_SCHEMA = (\d+)/.exec(source)
  if (!m) throw new Error('src/constants.ts 里找不到 DATA_SCHEMA')
  return Number(m[1])
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 这个模块是不是被直接运行的（而不是被别的脚本 import） */
export function isMain(moduleUrl) {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

/** 先写临时文件再改名 */
export function writeAtomic(file, body) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, file)
}

/** 读快照目录：manifest 原文 + 解压后的各文件 */
export function readSnapshot(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const files = {}
  for (const name of [...DATA_FILES, GLOSSARY_FILE]) {
    const gz = join(dir, `${name}.gz`)
    files[name] = existsSync(gz) ? gunzipSync(readFileSync(gz)) : null
  }
  return { manifest, files }
}

/** 一个数据文件的内容问题；没问题返回 [] */
function checkDataFile(name, body, entry, schema) {
  if (!body) return [`${name}.gz 不存在`]
  const problems = []
  if (body.length !== entry.bytes) problems.push(`${name} 大小 ${body.length}，manifest 写的是 ${entry.bytes}`)
  if (sha256(body) !== entry.sha256) problems.push(`${name} 的 sha256 和 manifest 不一致`)
  let json
  try {
    json = JSON.parse(body.toString('utf8'))
  } catch (e) {
    return [...problems, `${name} 不是有效的 JSON：${e.message}`]
  }
  if (json.schema !== schema) problems.push(`${name} 的 schema 是 ${json.schema}，插件支持 ${schema}`)
  const rows = json[ROW_TABLES[name]]
  if (!Array.isArray(rows)) problems.push(`${name} 没有 ${ROW_TABLES[name]} 表`)
  else if (rows.length !== entry.rows) problems.push(`${name} 的 ${ROW_TABLES[name]} 有 ${rows.length} 行，manifest 写的是 ${entry.rows}`)
  return problems
}

function checkGlossary(body, entry) {
  if (!entry || typeof entry.sha256 !== 'string') return ['manifest 里没有 glossary 的 sha256']
  if (!body) return [`${GLOSSARY_FILE}.gz 不存在`]
  const problems = []
  if (body.length !== entry.bytes) problems.push(`${GLOSSARY_FILE} 大小 ${body.length}，manifest 写的是 ${entry.bytes}`)
  if (sha256(body) !== entry.sha256) problems.push(`${GLOSSARY_FILE} 的 sha256 和 manifest 不一致`)
  try {
    const list = yaml.load(body.toString('utf8'), { schema: yaml.CORE_SCHEMA })
    if (!Array.isArray(list) || !list.length) problems.push(`${GLOSSARY_FILE} 不是非空的列表`)
  } catch (e) {
    problems.push(`${GLOSSARY_FILE} 不是有效的 YAML：${e.message}`)
  }
  return problems
}

/** 核对整个快照目录，返回问题列表 */
export function checkSnapshot(dir) {
  const schema = supportedSchema()
  let snapshot
  try {
    snapshot = readSnapshot(dir)
  } catch (e) {
    return [`读不了 manifest.json：${e.message}`]
  }
  const { manifest, files } = snapshot
  const problems = []
  if (manifest.schema !== schema) problems.push(`manifest 的 schema 是 ${manifest.schema}，插件支持 ${schema}`)
  if (!COMMIT_RE.test(manifest.sourceCommit ?? '')) problems.push('manifest 里没有来源提交 sourceCommit')
  for (const name of DATA_FILES) {
    const entry = manifest.files?.[name]
    if (!entry || !SHA_RE.test(entry.sha256 ?? '')) {
      problems.push(`manifest 里没有 ${name}`)
      continue
    }
    problems.push(...checkDataFile(name, files[name], entry, schema))
  }
  problems.push(...checkGlossary(files[GLOSSARY_FILE], manifest.glossary))
  if (!existsSync(join(dir, 'NOTICE.md'))) problems.push('缺少 NOTICE.md（数据许可说明）')
  return problems
}

async function fetchBody(url, accept) {
  const res = await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${url}：HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function resolveCommit(ref) {
  if (COMMIT_RE.test(ref)) return ref
  const body = await fetchBody(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`, 'application/vnd.github.sha')
  const sha = body.toString('utf8').trim()
  if (!COMMIT_RE.test(sha)) throw new Error(`${ref} 解析出的提交不对：${sha.slice(0, 80)}`)
  return sha
}

/** 下载、校验、写入 */
async function download(dir, ref) {
  const commit = await resolveCommit(ref)
  const base = `https://raw.githubusercontent.com/${REPO}/${commit}`
  console.log(`eve-cn-slang ${commit}`)
  const manifestBody = await fetchBody(`${base}/official/data/manifest.json`, 'application/json')
  const manifest = JSON.parse(manifestBody.toString('utf8'))
  const schema = supportedSchema()
  if (manifest.schema !== schema) throw new Error(`数据格式 schema ${manifest.schema} 和插件支持的 ${schema} 不一致`)

  const files = {}
  for (const name of DATA_FILES) {
    const entry = manifest.files?.[name]
    if (!entry) throw new Error(`manifest 里没有 ${name}`)
    files[name] = await fetchBody(`${base}/official/data/${name}`, 'application/json')
    const problems = checkDataFile(name, files[name], entry, schema)
    if (problems.length) throw new Error(problems.join('\n'))
  }
  const glossary = await fetchBody(`${base}/${GLOSSARY_FILE}`, 'text/plain')
  const glossaryEntry = { sha256: sha256(glossary), bytes: glossary.length }
  const glossaryProblems = checkGlossary(glossary, glossaryEntry)
  if (glossaryProblems.length) throw new Error(glossaryProblems.join('\n'))

  for (const name of [...DATA_FILES, GLOSSARY_FILE]) {
    const body = name === GLOSSARY_FILE ? glossary : files[name]
    writeAtomic(join(dir, `${name}.gz`), gzipSync(body, { level: 9 }))
  }
  const out = { ...manifest, sourceCommit: commit, glossary: glossaryEntry }
  writeAtomic(join(dir, 'manifest.json'), JSON.stringify(out, null, 2) + '\n')

  const problems = checkSnapshot(dir)
  if (problems.length) throw new Error(problems.join('\n'))
  console.log(`build ${manifest.buildNumber}（dataRevision ${manifest.dataRevision}）：` +
    DATA_FILES.map((n) => `${n} ${manifest.files[n].rows} 行`).join('，') + `，${GLOSSARY_FILE} ${glossary.length} 字节`)
}

function parseArgs(argv) {
  const args = { check: false, ref: 'main', dir: join(ROOT, 'data') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} 需要一个参数`)
      return v
    }
    if (a === '--check') args.check = true
    else if (a === '--ref') args.ref = next()
    else if (a === '--dir') args.dir = resolve(next())
    else if (a === '-h' || a === '--help') {
      console.log('用法：node scripts/snapshot.mjs [--ref <提交或分支>] [--dir <目录>] | --check [--dir <目录>]')
      process.exit(0)
    } else throw new Error(`不认识的参数：${a}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.check) {
    const problems = checkSnapshot(args.dir)
    if (problems.length) {
      for (const p of problems) console.error(`快照有问题：${p}`)
      process.exit(1)
    }
    const { manifest } = readSnapshot(args.dir)
    console.log(`快照完整：build ${manifest.buildNumber}（dataRevision ${manifest.dataRevision}），来源提交 ${manifest.sourceCommit}`)
    return
  }
  await download(args.dir, args.ref)
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
