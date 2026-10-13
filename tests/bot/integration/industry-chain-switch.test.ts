// 拆到原料的总开关和大小上限：用 vi.mock 把常量改小 / 关掉，走完整个插件。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { card } from './plugin-env'
import type { PluginEnv } from './plugin-env'
import { HOUND, startChain } from './industry-chain-env'

vi.mock('../../../src/constants', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/constants')>(),
  CHAIN_ENABLED: false,
}))

let env: PluginEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

describe('拆到原料：总开关关着', () => {
  it('every chain word answers one plain sentence; the ordinary commands still work', async () => {
    env = await startChain()
    for (const words of ['拆到原料', '反应:买', '组件:造', '其他:造', '反应:炼金']) {
      expect(card(await env.h.group(`制造 ${HOUND} XX-1 ${words}`))).toBe('拆到原料暂时关闭。')
    }
    expect(card(await env.h.group(`制造 ${HOUND} XX-1`))).toContain('**猎犬级 Hound · 高级制造计算**')
  })

  it('the help leaves the chain section out', async () => {
    env = await startChain()
    expect(card(await env.h.group('帮助 制造'))).not.toContain('拆到原料')
  })
})
