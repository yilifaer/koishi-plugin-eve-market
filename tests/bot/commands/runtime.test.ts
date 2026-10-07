// core 的生命周期（§3.7.3）：命令最多等 8 秒；启动失败、停用都不让插件出错。

import { describe, expect, it } from 'vitest'
import { CoreRuntime } from '../../../src/bot/commands/runtime'
import type { EveCore } from '../../../src/core/types'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function fakeCore() {
  let resolveReady!: () => void
  const calls: string[] = []
  const core = {
    ready: new Promise<void>((resolve) => { resolveReady = resolve }),
    start: async () => { calls.push('start') },
    stop: async () => { calls.push('stop') },
  } as unknown as EveCore
  return { core, calls, loaded: () => resolveReady() }
}

describe('CoreRuntime', () => {
  it('commands wait until the data is loaded', async () => {
    const runtime = new CoreRuntime(silent)
    const { core, calls, loaded } = fakeCore()
    const waiting = runtime.ready(1000)
    await runtime.start(async () => core)
    expect(calls).toEqual(['start'])
    expect(runtime.current()).toBeNull()
    loaded()
    expect(await waiting).toBe(core)
    expect(runtime.current()).toBe(core)
  })

  it('gives up after the wait and answers null', async () => {
    const runtime = new CoreRuntime(silent)
    const { core } = fakeCore()
    await runtime.start(async () => core)
    expect(await runtime.ready(20)).toBeNull()
  })

  it('a failed start is logged, and commands are told it is not ready', async () => {
    const errors: unknown[] = []
    const runtime = new CoreRuntime({ ...silent, error: (...a: unknown[]) => errors.push(a.join(' ')) })
    await runtime.start(async () => { throw new Error('disk full') })
    expect(await runtime.ready(1000)).toBeNull()
    expect(String(errors[0])).toContain('disk full')
  })

  it('stop before the core was built: the core is stopped right away and never started', async () => {
    const runtime = new CoreRuntime(silent)
    const { core, calls } = fakeCore()
    let release!: () => void
    const building = runtime.start(() => new Promise<EveCore>((resolve) => { release = () => resolve(core) }))
    await runtime.stop()
    release()
    await building
    expect(calls).toEqual(['stop'])
    expect(await runtime.ready(1000)).toBeNull()
  })

  it('stop after start stops the core', async () => {
    const runtime = new CoreRuntime(silent)
    const { core, calls, loaded } = fakeCore()
    await runtime.start(async () => core)
    loaded()
    await runtime.ready(1000)
    await runtime.stop()
    expect(calls).toEqual(['start', 'stop'])
    expect(runtime.current()).toBeNull()
  })
})
