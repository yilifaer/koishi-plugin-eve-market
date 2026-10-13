// 消息里带图片：QQ 适配器把附件接在文字后面（不加空格），本插件的命令只看文字，图片不进参数也不回显。

import { afterEach, describe, expect, it } from 'vitest'
import { REAL_GROUP } from '../../harness'
import { INDUSTRY, industryEsi } from './industry-env'
import { RAVEN, THE_FORGE, addOrders, jitaOrders, startRealPlugin } from './plugin-env'
import type { RealEnv } from './plugin-env'

let env: RealEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

const allowed = { allowedGroups: [{ groupId: REAL_GROUP, enabled: true }] }

const body = (sent: Awaited<ReturnType<RealEnv['qq']['group']>>) => sent.map((m) => m.body.markdown?.content ?? m.body.content ?? '').join('\n----\n')

async function start(): Promise<RealEnv> {
  env = await startRealPlugin({
    config: { access: allowed, industry: INDUSTRY },
    esi: (fake) => {
      industryEsi(fake)
      addOrders(fake, THE_FORGE, jitaOrders(RAVEN, 258_400_000, 249_000_000))
      fake.incursions = []
    },
  })
  return env
}

describe('messages with an image', () => {
  it('制造 ... 高级 + image parses like the same text without the image', async () => {
    const { qq } = await start()
    const plain = body(await qq.group('制造 乌鸦级 XX-3 高级'))
    const withImage = body(await qq.group('制造 乌鸦级 XX-3 高级', { images: 1 }))
    expect(plain).toContain('乌鸦级')
    expect(withImage).toBe(plain)
    expect(withImage).not.toContain('<img')
    expect(withImage).not.toContain('没有找到')
  })

  it('全套制造命令（地点 + 建筑 + 高级）后接图片：用的是命令里的地点、建筑和高级流程', async () => {
    const { qq } = await start()
    const text = '制造 乌鸦级 XX-2 建筑:中厂 高级'
    const withImage = body(await qq.group(text, { images: 1 }))
    expect(withImage).toContain('高级制造计算')
    expect(withImage).toContain('XX-2')
    expect(withImage).toContain('中厂')
    expect(withImage).not.toContain('<img')
    // 换成别的地点和建筑，结果不一样，说明参数确实被用上了
    const other = body(await qq.group('制造 乌鸦级 XX-3 建筑:高安厂 高级', { images: 1 }))
    expect(other).toContain('XX-3')
    expect(other).not.toContain('中厂')
    expect(withImage).toBe(body(await qq.group(text)))
  })

  it('查价 with the image glued to the item still prices it, and 入侵 works', async () => {
    const { qq } = await start()
    expect(body(await qq.group('查价 乌鸦级', { images: 2 }))).toContain('**乌鸦级 Raven')
    expect(body(await qq.group('入侵', { images: 1 }))).toBe(body(await qq.group('入侵')))
  })

  it('取消 + image clears the pending list', async () => {
    const { qq } = await start()
    await qq.group('批量查价 Jita')
    expect(body(await qq.group('取消', { images: 1 }))).toBe('已取消。')
  })

  it('an unknown item is echoed without any image markup', async () => {
    const { qq } = await start()
    const text = body(await qq.group('查价 不存在的东西', { images: 1 }))
    expect(text).toContain('不存在的东西')
    expect(text).not.toContain('<img')
    expect(text).not.toContain('849')
  })

  it('批量查价 / 查价 with only an image: usage plus the hint; an image alone gets no reply', async () => {
    const { qq } = await start()
    const hint = '图片里的字我看不到，请在游戏里复制后粘贴'
    const batch = body(await qq.group('批量查价', { images: 1 }))
    expect(batch).toContain(hint)
    expect(batch).not.toContain('<img')
    const price = body(await qq.group('查价', { images: 1 }))
    expect(price).toContain('**查价用法**')
    expect(price).toContain(hint)
    // 不带图片时没有这一行；提示只补一次
    expect(body(await qq.group('查价'))).not.toContain(hint)
    expect(await qq.group('', { images: 1 })).toEqual([])
  })

  it('commands whose argument is optional do not get the hint', async () => {
    const { qq } = await start()
    const text = body(await qq.group('帮助', { images: 1 }))
    expect(text).not.toContain('图片里的字我看不到')
  })

  it('别的插件的命令或普通聊天带图片：stripped.content 原样交给后面的中间件', async () => {
    const seen: string[] = []
    env = await startRealPlugin({
      config: { access: allowed, industry: INDUSTRY },
      esi: (fake) => { fake.incursions = [] },
      setup: (app) => {
        app.platform('qq').middleware((session, next) => {
          seen.push(`mw:${session.stripped.content}`)
          return next()
        })
      },
    })
    await env.qq.group('/ping 参数', { images: 1 })
    await env.qq.groupAll('今天吃什么', { images: 2 })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatch(/^mw:\/ping 参数<img /)
    expect(seen[1]).toMatch(/^mw:今天吃什么<img .*<img /)
  })
})
