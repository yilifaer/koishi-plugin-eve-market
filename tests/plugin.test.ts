import { promises as fs } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
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

// koishi 走 CommonJS 入口，server 插件也用 CommonJS，保证是同一份 cordis
const requireCjs = createRequire(__filename)
const serverModule = requireCjs('@koishijs/plugin-server') as { default?: unknown; Server?: unknown }
const Server = (serverModule.default ?? serverModule.Server ?? serverModule) as any

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
  })
}

async function boot(config: unknown, withHelp = false, serverPort?: number) {
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
  const server = serverPort ? app.plugin(Server, { host: '127.0.0.1', port: serverPort }) : undefined
  app.plugin(plugin as any, config)
  await app.start()
  const stop = async () => {
    // 先停 server（它停用时要写日志）
    server?.dispose()
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
    // 最上面是授权页面的相对链接：和控制台同源，经 SSH 隧道也能直接点开
    expect(plugin.usage).toContain('测试版')
    expect(plugin.usage.trim().split('\n')[0]).toContain('[打开 EVE 授权页面](/eve-market/admin)')
    expect(plugin.usage).toContain('「市场状态」「市场授权」')
    expect(plugin.usage).not.toContain('0.0.2')
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

  it('with the server plugin the admin page answers on 127.0.0.1 and the auth table exists', async () => {
    const port = await freePort()
    const env = await boot({}, false, port)
    try {
      let page = await get(`http://127.0.0.1:${port}/eve-market/admin`)
      // 页面等插件准备好（读自带数据）才渲染
      for (let i = 0; i < 50 && page.status !== 200; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        page = await get(`http://127.0.0.1:${port}/eve-market/admin`)
      }
      expect(page.status).toBe(200)
      expect(page.body).toContain('EVE 授权')
      expect(page.body).toContain(`http://127.0.0.1:${port}/eve-market/sso/callback`)
      expect(await env.app.database.get('eve_market_auth', {})).toEqual([])
      expect(env.records.filter((r) => r.name === 'eve-market' && problem(r))).toEqual([])
    } finally {
      await env.stop()
    }
  })
})
