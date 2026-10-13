// 新命令的分项帮助（§2.14）：「帮助 走势」「帮助 战报」「帮助 翻译」（别名也认）「帮助 入侵」等，每项 1 条，带按钮。

import { afterEach, describe, expect, it } from 'vitest'
import { buttonRows, card, startPlugin } from './plugin-env'
import type { PluginEnv } from './plugin-env'

let env: PluginEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

async function start(): Promise<PluginEnv> {
  env = await startPlugin({ help: true })
  return env
}

describe('help topics of 0.0.3', () => {
  it('the main help card says buttons only fill the input box', async () => {
    const e = await start()
    expect(card(await e.h.group('帮助'))).toContain('按钮只把命令填进输入框，要再按发送')
  })

  it('帮助 走势', async () => {
    const e = await start()
    const sent = await e.h.group('帮助 走势')
    expect(sent).toHaveLength(1)
    expect(card(sent)).toBe([
      '**走势**',
      '',
      '- 走势 乌鸦级：近 30 天的价格图，再加一张小卡片（最近均价、最高最低、日均成交）',
      '- 走势 乌鸦级 季：近 90 天；写「年」是近 365 天',
      '- 走势 Amarr 乌鸦级：指定 NPC 市场，按它所在的星域',
      '',
      '数据是 ESI 的星域成交历史，每天更新一次；玩家建筑市场没有成交历史。',
    ].join('\n'))
    expect(buttonRows(sent)).toEqual([['走势=>走势 ', '全部帮助=>帮助']])
  })

  it('帮助战报 (glued) and 帮助 中英对照 (the alias)', async () => {
    const e = await start()
    expect(card(await e.h.group('帮助战报')).split('\n')[0]).toBe('**战报**')
    const translate = card(await e.h.group('帮助 中英对照'))
    expect(translate.split('\n')[0]).toBe('**翻译**（也可以写「中英对照」）')
    expect(card(await e.h.group('/帮助 翻译'))).toBe(translate)
  })

  it('the universe commands share one topic with a button for each', async () => {
    const e = await start()
    const sent = await e.h.group('帮助 势力图')
    expect(card(sent).split('\n')[0]).toBe('**入侵 · 势力图 · 联盟势力图 · 服务器状态**')
    expect(buttonRows(sent)).toEqual([['入侵=>入侵', '势力图=>势力图'], ['联盟势力图=>联盟势力图', '服务器状态=>服务器状态'], ['全部帮助=>帮助']])
    expect(card(await e.h.group('帮助 服务器状态'))).toBe(card(sent))
  })
})
