// 命令的公共流程：数据没准备好时回「数据加载中」；命令出错时回一句话、写日志；编号选项记进待办。

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from 'koishi'
import { emptyCard, invoke, sendCard } from '../../../src/bot/commands/context'
import type { CommandContext, Invocation } from '../../../src/bot/commands/context'
import type { CoreHandle } from '../../../src/bot/commands/runtime'
import { PendingStore, pendingKey } from '../../../src/bot/pending'
import { koishiScheduler, systemClock } from '../../../src/bot/ports'
import { CommandRegistry } from '../../../src/bot/register'
import { normalizeConfig } from '../../../src/config/normalize'
import { DataNotReadyError } from '../../../src/core/data'
import { createModuleStore } from '../../../src/core/ports'
import type { EveCore } from '../../../src/core/types'
import { startHarness } from '../../harness'
import type { Harness } from '../../harness'

let h: Harness | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

const nothing: CoreHandle = { ready: async () => null, current: () => null }
const someCore: CoreHandle = { ready: async () => ({}) as EveCore, current: () => null }

async function harness(core: CoreHandle, run: (inv: Invocation) => Promise<void>) {
  const warnings: string[] = []
  const logger = { debug() {}, info() {}, warn: (...a: unknown[]) => warnings.push(a.join(' ')), error() {} }
  let commands: CommandContext | undefined
  h = await startHarness({
    setup: (app) => void app.plugin({
      name: 'invoke-test',
      apply: (c: Context) => {
        const registry = new CommandRegistry(c, { filter: () => true, logger })
        commands = {
          settings: normalizeConfig({}).settings, registry, pending: new PendingStore(), store: createModuleStore(), logger, core,
          clock: systemClock, scheduler: koishiScheduler(c),
        }
        registry.register('price', { args: '[q:text]' })?.action(async ({ session }) => {
          await invoke(commands!, 'price', session!, run)
        })
      },
    }),
  })
  return { h, warnings, commands: () => commands! }
}

describe('invoke', () => {
  it('answers「数据加载中」when the core is not ready in time', async () => {
    const { h } = await harness(nothing, async () => { throw new Error('should not run') })
    expect((await h.group('查价 乌鸦级')).map((s) => s.text)).toEqual(['数据加载中，请稍后再试'])
  })

  it('data unloaded halfway also answers「数据加载中」', async () => {
    const { h } = await harness(someCore, async () => { throw new DataNotReadyError() })
    expect((await h.group('查价 乌鸦级')).map((s) => s.text)).toEqual(['数据加载中，请稍后再试'])
  })

  it('other errors answer one line and are logged', async () => {
    const { h, warnings } = await harness(someCore, async () => { throw new Error('boom') })
    expect((await h.group('查价 乌鸦级')).map((s) => s.text)).toEqual(['出了点问题，请稍后再试'])
    expect(warnings).toEqual([expect.stringContaining('「查价」出错：')])
    expect(warnings[0]).toContain('boom')
  })

  it('cards with choices leave numbered choices for this person', async () => {
    const env = await harness(someCore, async (inv) => {
      const card = emptyCard('选一个')
      card.choices = [{ no: 1, label: '乌鸦级', command: { id: 'price', args: '乌鸦级*2' } }]
      await sendCard(inv, card, { quantity: true })
    })
    const [sent] = await env.h.group('查价 x')
    expect(env.commands().pending.get(pendingKey(sent.session!))).toEqual({ kind: 'choices', choices: [{ no: 1, command: '查价 乌鸦级*2' }], quantity: true })
  })
})
