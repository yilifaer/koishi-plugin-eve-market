// 拆到原料要拆的东西太多：只回一句话，不发卡片，也不去取价。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { card } from './plugin-env'
import type { PluginEnv } from './plugin-env'
import { HOUND, startChain } from './industry-chain-env'

vi.mock('../../../src/constants', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/constants')>(),
  CHAIN_MAX_TYPES: 20,
}))

let env: PluginEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

describe('拆到原料：东西太多', () => {
  it('says so in one sentence and suggests buying a layer; buying the components makes it small enough', async () => {
    env = await startChain()
    expect(card(await env.h.group(`制造 ${HOUND} XX-1 拆到原料`))).toBe('要拆的东西太多了（超过 20 种），拆不了。可以加「组件:买」或「反应:买」少拆几层再试。')
    expect(card(await env.h.group(`制造 ${HOUND} XX-1 组件:买`))).toContain('**猎犬级 Hound · 拆到原料**')
  })
})
