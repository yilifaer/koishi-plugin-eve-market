import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context, Logger } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import Memory from '@koishijs/plugin-database-memory'
import * as Help from '@koishijs/plugin-help'
import QQ, { QQMessageEncoder } from '@satorijs/adapter-qq'
import * as plugin from '../src'
import { PRESET_MARKETS } from '../src/config/presets'

/** 启动时的说明（数据来源、生成密钥）是 info；这里只看警告和错误 */
const problem = (r: Logger.Record) => r.type === 'warn' || r.type === 'error'

async function boot(config: unknown, withHelp = false) {
  const records: Logger.Record[] = []
  const target: Logger.Target = { colors: 0, record: (r) => records.push(r) }
  Logger.targets.push(target)
  // 插件在 <实例>/data/eve-market 下写密钥和缓存：用临时目录，不写进仓库的 data/
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-market-plugin-'))
  const app = new Context()
  app.baseDir = dir
  app.plugin(HTTP as any)
  app.plugin(Memory as any)
  if (withHelp) app.plugin(Help as any)
  app.plugin(plugin as any, config)
  await app.start()
  const stop = async () => {
    await app.stop()
    Logger.targets.splice(Logger.targets.indexOf(target), 1)
    await fs.rm(dir, { recursive: true, force: true })
  }
  return { app, records, stop }
}

describe('plugin entry', () => {
  it('exports what Koishi needs', () => {
    expect(plugin.name).toBe('eve-market')
    expect(plugin.inject).toEqual({ required: ['database', 'http'], optional: ['puppeteer', 'server'] })
    expect(typeof plugin.apply).toBe('function')
    // 0.0.x 只写已经能用的：授权页面和「市场状态」从 0.0.2 起
    expect(plugin.usage).toContain('测试版')
    expect(plugin.usage).not.toContain('/eve-market/admin')
    expect(plugin.usage).toMatch(/「市场状态」从 0\.0\.2 起/)
    expect(() => plugin.Config({} as any)).not.toThrow()
  })

  it('loads in Koishi and logs each config problem once', async () => {
    const env = await boot({ markets: [...PRESET_MARKETS, { name: '坏位置', location: 'not-a-number' }] })
    try {
      const warns = env.records.filter((r) => r.name === 'eve-market' && r.type === 'warn').map((r) => r.content)
      expect(warns).toEqual(['配置问题：市场第 6 行「位置」不是数字（NPC 空间站填空间站 ID），已跳过'])
      expect(env.records.filter((r) => r.type === 'error')).toEqual([])
    } finally {
      await env.stop()
    }
  })

  // 这两个包只在 vitest.config.ts 的 CommonJS 别名下能加载，先在这里确认别名没坏
  it('loads next to plugin-help, and the QQ adapter imports', async () => {
    expect(typeof QQ).toBe('function')
    expect(typeof QQMessageEncoder).toBe('function')
    const env = await boot({}, true)
    try {
      expect(env.app.$commander.get('help')).toBeTruthy()
      expect(env.records.filter((r) => r.type === 'error' || (r.name === 'eve-market' && problem(r)))).toEqual([])
    } finally {
      await env.stop()
    }
  })

  it('a clean config logs no warnings or errors', async () => {
    const env = await boot({})
    try {
      expect(env.records.filter((r) => r.name === 'eve-market' && problem(r))).toEqual([])
    } finally {
      await env.stop()
    }
  })
})
