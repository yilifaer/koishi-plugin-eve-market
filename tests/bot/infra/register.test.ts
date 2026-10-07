import { Command } from 'koishi'
import type { Context, Session } from 'koishi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandRegistry, describeConflict } from '../../../src/bot/register'
import { createScopes } from '../../../src/bot/scope'
import { EchoLog } from '../../../src/bot/send/echo'
import { HELP_COMMAND } from '../../../src/constants'
import { startHarness } from '../../harness'
import type { Harness } from '../../harness'
import { DEFAULT_COMMANDS, wirePlugin } from './wiring'
import type { Wiring, WiringOptions } from './wiring'

describe('safe registration', () => {
  let h: Harness
  let w: Wiring
  /** onebot 上排在本插件后面的中间件收到的内容 */
  let onebotSeen: string[]

  async function start(options: WiringOptions = {}, before?: (app: Context) => void) {
    onebotSeen = []
    let ref: { current: Wiring | null } = { current: null }
    h = await startHarness({
      help: true,
      onebot: true,
      setup: (app) => {
        before?.(app)
        ref = wirePlugin(app, options)
        app.platform('onebot').middleware((session, next) => {
          onebotSeen.push(session.stripped.content)
          return next()
        })
      },
    })
    w = ref.current!
  }

  afterEach(async () => {
    await h?.stop()
  })

  it('registers every command with the scope filter on each name and alias', async () => {
    await start()
    for (const id of Object.keys(DEFAULT_COMMANDS) as Array<keyof typeof DEFAULT_COMMANDS>) {
      const command = w.registry.get(id)!
      expect(command).toBeInstanceOf(Command)
      for (const alias of Object.values(command._aliases)) expect(alias.filter).toBe(w.scopes.filter)
    }
    expect(Object.keys(w.registry.get('translate')!._aliases)).toEqual(['翻译', '中英对照'])
    expect(w.registry.conflicts()).toEqual([])
  })

  it('an onebot 「入侵」 still reaches the onebot middleware after ours', async () => {
    await start()
    expect(await h.onebotGroup('入侵')).toEqual([])
    expect(await h.onebotGroup('中英对照 三钛合金')).toEqual([])
    expect(await h.onebotGroup('入侵', { at: true })).toEqual([])
    expect(onebotSeen).toEqual(['入侵', '中英对照 三钛合金', '入侵'])
    expect(w.calls).toEqual([])
    expect(h.onebot!.sent).toEqual([])
  })

  it('without the alias filter Koishi would swallow it (why the filter is there)', async () => {
    await start({ commands: {} }, (app) => {
      app.platform('qq').command('入侵').action(() => undefined)
    })
    await h.onebotGroup('入侵')
    expect(onebotSeen).toEqual([])
  })

  it('names added later (指令管理) get the filter too', async () => {
    await start()
    const price = w.registry.get('price')!
    price.alias('估价')
    expect(price._aliases['估价'].filter).toBe(w.scopes.filter)
    await h.onebotGroup('估价 乌鸦')
    expect(onebotSeen).toEqual(['估价 乌鸦'])
    expect((await h.group('估价 乌鸦')).map((s) => s.text)).toEqual(['price:乌鸦'])
  })

  it('a taken name skips the whole command, records the conflict, and the plugin still loads', async () => {
    let theirs = 0
    await start({}, (app) => {
      app.command('查价 [x:text]').action(() => {
        theirs++
      })
    })
    expect(w.registry.get('price')).toBeUndefined()
    expect(w.registry.has('price')).toBe(false)
    expect(w.registry.conflicts()).toEqual([{ id: 'price', name: '查价', kind: 'name' }])
    expect(w.logs).toEqual(['命令冲突：「查价」和别的插件的命令重名，没有注册'])
    await h.group('查价 乌鸦')
    expect(theirs).toBe(1)
    expect(w.calls).toEqual([])
    // 其他命令照常
    expect((await h.group('入侵')).map((s) => s.text)).toEqual(['incursion:'])
  })

  it('a taken alias skips only that alias', async () => {
    await start({}, (app) => {
      app.command('对照').alias('中英对照')
    })
    expect(Object.keys(w.registry.get('translate')!._aliases)).toEqual(['翻译'])
    expect(w.registry.conflicts()).toEqual([{ id: 'translate', name: '翻译', kind: 'alias', alias: '中英对照' }])
    expect(describeConflict(w.registry.conflicts()[0])).toBe('「翻译」的别名「中英对照」和别的插件重名，只跳过这个别名')
  })

  it('an exception while registering is caught and recorded', async () => {
    await start({ commands: {} })
    const registry = new CommandRegistry(w.scopes.cmdCtx, { filter: w.scopes.filter, logger: { debug() {}, info() {}, warn: (m) => w.logs.push(String(m)), error() {} } })
    const spy = vi.spyOn(w.scopes.cmdCtx, 'command').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(registry.register('incursion')).toBeUndefined()
    spy.mockRestore()
    expect(registry.conflicts()).toEqual([{ id: 'incursion', name: '入侵', kind: 'error' }])
    expect(w.logs).toEqual(['注册命令「入侵」时出错：boom'])
    expect(registry.register('incursion')).toBeInstanceOf(Command)
  })

  it('registering the same id twice returns the same command', async () => {
    await start()
    expect(w.registry.register('price', { args: '[query:text]' })).toBe(w.registry.get('price'))
  })

  it('text commands use strictOptions: 「批量查价 -5% jita」 keeps -5% in the argument; -h still shows help', async () => {
    await start()
    expect((await h.group('批量查价 -5% jita')).map((s) => s.text)).toEqual(['batch:-5% jita'])
    expect((await h.group('批量查价 -5% Jita\nRaven*2')).map((s) => s.text)).toEqual(['batch:-5% Jita\nRaven*2'])
    const help = await h.group('批量查价 -h')
    expect(help).toHaveLength(1)
    expect(help[0].text).toContain('批量查价')
    expect(w.registry.get('batch')!.config).toMatchObject({ strictOptions: true, captureQuote: false })
    expect(w.registry.get('incursion')!.config.strictOptions).toBeUndefined()
  })

  it('a quoted message is not pulled into the arguments', async () => {
    await start()
    expect((await h.group('查价', { quote: '乌鸦级' })).map((s) => s.text)).toEqual(['price:'])
    expect((await h.group('入侵', { quote: '乌鸦级' })).map((s) => s.text)).toEqual(['incursion:'])
  })

  it('admin commands and the internal help are hidden from plugin-help', async () => {
    await start()
    expect(w.registry.get('marketStatus')!.config).toMatchObject({ hidden: true })
    expect(w.registry.get('help')!.config).toMatchObject({ hidden: true })
    const [list] = await h.group('help')
    expect(list.text).toContain('查价')
    expect(list.text).toContain('入侵')
    expect(list.text).not.toContain('市场状态')
    expect(list.text).not.toContain('eve-market')
  })

  it('help is the hidden eve-market.help; its parent is hidden and filtered too', async () => {
    await start()
    expect(w.registry.get('help')!.name).toBe(HELP_COMMAND)
    const parent = h.app.$commander.get('eve-market')!
    expect(parent.config).toMatchObject({ hidden: true })
    expect(parent._aliases['eve-market'].filter).toBe(w.scopes.filter)
    await h.onebotGroup('eve-market')
    expect(onebotSeen).toEqual(['eve-market'])
  })

  it('name() follows renames and keeps the original spelling otherwise', async () => {
    await start()
    expect(w.registry.name('groupId')).toBe('本群ID')
    expect(w.registry.name('help')).toBe('帮助')
    expect(w.registry.name('reaction')).toBe('反应')
    w.registry.get('price')!.displayName = '估价'
    expect(w.registry.name('price')).toBe('估价')
    expect(w.registry.namer().commandName('price')).toBe('估价')
  })

  it('names() lists every user-visible name and whether it takes arguments', async () => {
    await start()
    const names = w.registry.names()
    expect(names).toContainEqual({ name: '查价', args: true })
    expect(names).toContainEqual({ name: '中英对照', args: true })
    expect(names).toContainEqual({ name: '入侵', args: false })
    expect(names).toContainEqual({ name: '本群id', args: false })
    expect(names.some((n) => n.name.includes('.'))).toBe(false)
  })

  it('commands go away with the plugin', async () => {
    await start()
    const fork = [...h.app.registry.values()].find((runtime) => runtime.name === 'eve-market-wiring')
    expect(fork).toBeTruthy()
    h.app.registry.delete(fork!.plugin)
    expect(h.app.$commander.get('查价')).toBeUndefined()
    expect(h.app.$commander.get(HELP_COMMAND)).toBeUndefined()
    expect(h.app.$commander.get('eve-market')).toBeUndefined()
  })
})

describe('registry outside a running app', () => {
  it('the filter on the names is the command context filter', async () => {
    const h = await startHarness()
    try {
      const scopes = createScopes(h.app, { general: { requireAt: true, allowSandbox: false }, echo: new EchoLog() })
      const registry = new CommandRegistry(scopes.cmdCtx, { filter: scopes.filter, logger: { debug() {}, info() {}, warn() {}, error() {} } })
      const command = registry.register('incursion')!
      const filter = command._aliases['入侵'].filter as (session: Session) => boolean
      const session = h.qq.session({ platform: 'onebot' })
      expect(filter(session)).toBe(false)
      command.dispose()
    } finally {
      await h.stop()
    }
  })
})
