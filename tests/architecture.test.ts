// 守住分层：core、render 里没有 Koishi；core 不碰 bot 层、不直接读时钟和环境变量；
// core 的模块之间只通过各自的 index.ts 引用。

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const CORE = path.join(SRC, 'core')
const RENDER = path.join(SRC, 'render')

function listTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTs(full))
    else if (/\.(c|m)?ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** 所有 import / export from / import() / require() 的目标 */
export function importsOf(source: string): string[] {
  const out: string[] = []
  const pattern = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of source.matchAll(pattern)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4])
  return out
}

/** 去掉注释（保留字符串里的 //，例如网址） */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

const FRAMEWORK = /^(koishi|@satorijs\/|@koishijs\/|@cordisjs\/|cordis$|schemastery$|minato$)/

export function frameworkImports(source: string): string[] {
  return importsOf(source).filter((target) => FRAMEWORK.test(target))
}

/** core 里禁止的全局：时钟、定时器、环境变量都要走端口 */
export function forbiddenGlobals(source: string): string[] {
  const code = stripComments(source)
  const rules: Array<[RegExp, string]> = [
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bnew\s+Date\s*\(\s*\)/, 'new Date()'],
    [/\b(?:setTimeout|setInterval|setImmediate)\s*\(/, 'setTimeout/setInterval'],
    [/\bprocess\.env\b/, 'process.env'],
    [/\bperformance\.now\s*\(/, 'performance.now()'],
  ]
  return rules.filter(([re]) => re.test(code)).map(([, name]) => name)
}

function resolveRelative(file: string, target: string): string | null {
  if (!target.startsWith('.')) return null
  return path.resolve(path.dirname(file), target)
}

/** core 里的一个相对引用是否违反分层；返回原因 */
export function coreImportViolation(file: string, target: string): string | null {
  const resolved = resolveRelative(file, target)
  if (!resolved) return null
  const rel = path.relative(SRC, resolved).split(path.sep).join('/')
  if (rel.startsWith('..')) return '引用了 src 以外的文件'
  if (!rel.startsWith('core/') && rel !== 'core') {
    // core 只能引用 src/constants（不依赖任何东西）
    return rel === 'constants' ? null : `引用了 src/${rel}`
  }
  const inside = rel.slice('core/'.length).split('/')
  if (inside.length === 1) return null // core/types、core/ports、core/index、core/<模块>（即模块的 index）
  const fromModule = path.relative(CORE, file).split(path.sep)[0]
  const [module, ...rest] = inside
  if (module === fromModule) return null
  if (rest.length === 1 && rest[0] === 'index') return null
  return `绕过 core/${module}/index.ts 引用了 core/${inside.join('/')}`
}

const read = (file: string) => fs.readFileSync(file, 'utf8')
const show = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')

describe('architecture', () => {
  const coreFiles = listTs(CORE)
  const renderFiles = listTs(RENDER)

  it('finds the core sources', () => {
    expect(coreFiles.map(show)).toContain('src/core/types.ts')
    expect(coreFiles.map(show)).toContain('src/core/ports.ts')
  })

  it('core and render never import Koishi or Satori', () => {
    const bad = [...coreFiles, ...renderFiles].flatMap((file) => frameworkImports(read(file)).map((t) => `${show(file)} → ${t}`))
    expect(bad).toEqual([])
  })

  it('core does not reach into bot, config, storage, web or the plugin entry, and uses module index files', () => {
    const bad = coreFiles.flatMap((file) => importsOf(read(file))
      .map((target) => [target, coreImportViolation(file, target)] as const)
      .filter(([, why]) => why)
      .map(([target, why]) => `${show(file)} → ${target}：${why}`))
    expect(bad).toEqual([])
  })

  it('render does not import the bot layer', () => {
    const bad = renderFiles.flatMap((file) => importsOf(read(file))
      .filter((target) => {
        const resolved = resolveRelative(file, target)
        return resolved && /^(bot|storage|web|index)(\/|$)/.test(path.relative(SRC, resolved).split(path.sep).join('/'))
      })
      .map((target) => `${show(file)} → ${target}`))
    expect(bad).toEqual([])
  })

  it('core reads time, timers and the environment only through ports', () => {
    const bad = coreFiles.flatMap((file) => forbiddenGlobals(read(file)).map((name) => `${show(file)}: ${name}`))
    expect(bad).toEqual([])
  })
})

describe('architecture checks themselves', () => {
  const coreFile = path.join(CORE, 'market', 'service.ts')

  it('spots framework imports in every syntax', () => {
    const sample = [
      "import { Context } from 'koishi'",
      "import type { Session } from 'koishi'",
      "export { h } from '@satorijs/core'",
      "import {\n  Schema,\n} from '@koishijs/core'",
      "const x = require('koishi')",
      "const y = await import('@satorijs/adapter-qq')",
      "import 'koishi'",
      "import { a } from './koishi-like'",
    ].join('\n')
    expect(frameworkImports(sample)).toEqual(['koishi', 'koishi', '@satorijs/core', '@koishijs/core', 'koishi', '@satorijs/adapter-qq', 'koishi'])
  })

  it('spots layer violations', () => {
    expect(coreImportViolation(coreFile, '../../bot/view/card')).toBe('引用了 src/bot/view/card')
    expect(coreImportViolation(coreFile, '../../config/normalize')).toBe('引用了 src/config/normalize')
    expect(coreImportViolation(coreFile, '../../index')).toBe('引用了 src/index')
    expect(coreImportViolation(coreFile, '../util/lru')).toBe('绕过 core/util/index.ts 引用了 core/util/lru')
    expect(coreImportViolation(coreFile, '../../../package.json')).toBe('引用了 src 以外的文件')
    for (const ok of ['../util', '../util/index', '../types', '../ports', './region', '../../constants', 'node:crypto', 'js-yaml']) {
      expect(coreImportViolation(coreFile, ok)).toBeNull()
    }
  })

  it('spots clock and env use but ignores comments and URLs', () => {
    expect(forbiddenGlobals('const t = Date.now()\nsetTimeout(f, 1)\nprocess.env.X\nnew Date()')).toEqual(['Date.now()', 'new Date()', 'setTimeout/setInterval', 'process.env'])
    expect(forbiddenGlobals('// 不直接用 Date.now()\n/* setTimeout( */\nconst u = "https://x//y"\nnew Date(ms)\nclock.now()')).toEqual([])
  })
})
