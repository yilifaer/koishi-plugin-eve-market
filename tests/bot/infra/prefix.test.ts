import type { Context, Session } from 'koishi'
import { afterEach, describe, expect, it } from 'vitest'
import { helpRewrite, normalizeIncoming, requiredPrefix, textOnly } from '../../../src/bot/prefix'
import type { ListProbe } from '../../../src/bot/prefix'
import type { CommandName } from '../../../src/bot/register'
import { HELP_COMMAND } from '../../../src/constants'
import { MEMBER, MEMBER2, startHarness } from '../../harness'
import type { Harness, HarnessOptions } from '../../harness'
import { wirePlugin } from './wiring'
import type { Wiring, WiringOptions } from './wiring'

const NAMES: CommandName[] = [
  { name: '查价', args: true, needsArgs: true },
  { name: '批量查价', args: true, needsArgs: true },
  { name: '制造', args: true, needsArgs: true },
  { name: '制造比价', args: true, needsArgs: true },
  { name: '入侵', args: false, needsArgs: false },
  { name: '势力图', args: false, needsArgs: false },
  { name: '联盟势力图', args: false, needsArgs: false },
  { name: '本群id', args: false, needsArgs: false },
  { name: '翻译', args: true, needsArgs: true },
  { name: '中英对照', args: true, needsArgs: true },
]

const norm = (content: string, isCommand?: (word: string) => boolean) => normalizeIncoming(content, { names: NAMES, isCommand })

describe('normalizeIncoming', () => {
  it('drops the leading / and ／ of the command panel', () => {
    expect(norm('/查价 乌鸦级')).toBe('查价 乌鸦级')
    expect(norm('／查价 乌鸦级')).toBe('查价 乌鸦级')
    expect(norm('/ 查价 乌鸦级')).toBe('查价 乌鸦级')
    expect(norm('//入侵')).toBe('入侵')
    expect(norm('/')).toBe('')
    expect(norm('  /查价 乌鸦级  ')).toBe('查价 乌鸦级')
  })

  it('applies NFKC to the command name only and turns the full-width space after it into a normal one', () => {
    expect(norm('本群ＩＤ')).toBe('本群ID')
    expect(norm('查价　ＲＡＶＥＮ')).toBe('查价 ＲＡＶＥＮ')
    expect(norm('／查价　乌鸦级')).toBe('查价 乌鸦级')
  })

  it('keeps the content escaped when NFKC produces < > &', () => {
    expect(norm('查价＜Ｒ＆Ｄ＞')).toBe('查价 &lt;R&amp;D&gt;')
    expect(norm('查价&amp;')).toBe('查价 &amp;')
  })

  it('leaves a message that starts with an element (image, face) exactly as it was', () => {
    const image = '<img src="https://example.invalid/a.png?x=1&amp;y=2"/>'
    expect(norm(image)).toBe(image)
    expect(norm(`${image} 查价乌鸦级`)).toBe(`${image} 查价乌鸦级`)
  })

  it('drops elements glued to a word, replacing each with a space', () => {
    const img = '<img width="849" src="https://example.com/x.png"/>'
    expect(norm(`制造 乌鸦级 XX-1 建筑:旗舰组件 高级${img}`)).toBe('制造 乌鸦级 XX-1 建筑:旗舰组件 高级')
    expect(norm(`查价${img}`)).toBe('查价')
    expect(norm(`入侵${img}`)).toBe('入侵')
    expect(norm(`查价乌鸦级${img}`)).toBe('查价 乌鸦级')
    expect(norm(`查价 乌鸦级${img}${img}`)).toBe('查价 乌鸦级')
    expect(norm(`制造 乌鸦级<face id="1"/>高级`)).toBe('制造 乌鸦级 高级')
    expect(norm(`制造 乌鸦级 <face id="1"/> 高级`)).toBe('制造 乌鸦级 高级')
  })

  it('keeps game markup that arrives escaped', () => {
    const text = '制造 &lt;localized hint="乌鸦级"&gt;Raven&lt;/localized&gt; 高级'
    expect(norm(text)).toBe(text)
    expect(norm(`${text}<img src="a"/>`)).toBe(text)
  })

  it('splits a command name glued to its argument, longest name first', () => {
    expect(norm('查价乌鸦级')).toBe('查价 乌鸦级')
    expect(norm('查价乌鸦级*10')).toBe('查价 乌鸦级*10')
    expect(norm('批量查价XX-1 -5%')).toBe('批量查价 XX-1 -5%')
    expect(norm('制造比价乌鸦级')).toBe('制造比价 乌鸦级')
    expect(norm('制造乌鸦级 ME10')).toBe('制造 乌鸦级 ME10')
    expect(norm('/中英对照三钛合金')).toBe('中英对照 三钛合金')
  })

  it('never splits commands without arguments', () => {
    expect(norm('入侵者是谁')).toBe('入侵者是谁')
    expect(norm('势力图呢')).toBe('势力图呢')
    expect(norm('入侵')).toBe('入侵')
    expect(norm('联盟势力图')).toBe('联盟势力图')
  })

  it('leaves names that are already exact, other text and other plugins\' commands alone', () => {
    expect(norm('查价')).toBe('查价')
    expect(norm('乌鸦级')).toBe('乌鸦级')
    expect(norm('查价格 乌鸦', (word) => word === '查价格')).toBe('查价格 乌鸦')
    expect(norm('查价格 乌鸦')).toBe('查价 格 乌鸦')
  })

  it('keeps line breaks and tabs after the command (paste format)', () => {
    expect(norm('批量查价\nRaven\t2\nTritanium\t1000')).toBe('批量查价\nRaven\t2\nTritanium\t1000')
    expect(norm('批量查价Jita\nRaven\t2')).toBe('批量查价 Jita\nRaven\t2')
  })

  it('stays fast on long input', () => {
    const long = `查价${'乌'.repeat(20_000)}`
    const started = Date.now()
    expect(norm(long).startsWith('查价 乌')).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('requiredPrefix', () => {
  type PrefixSession = Parameters<typeof requiredPrefix>[0]
  const session = (prefix: string | string[], opts: { direct?: boolean; appel?: boolean; strict?: boolean } = {}) => ({
    app: { config: { prefix, prefixMode: opts.strict ? 'strict' : 'auto' } },
    isDirect: !!opts.direct,
    stripped: { appel: !!opts.appel },
    resolve: <T>(value: T) => value,
  }) as unknown as PrefixSession

  it('needs none when the empty prefix is allowed, or when the bot was addressed', () => {
    expect(requiredPrefix(session(['']))).toBe('')
    expect(requiredPrefix(session(['', '/']))).toBe('')
    expect(requiredPrefix(session(['/'], { appel: true }))).toBe('')
    expect(requiredPrefix(session(['/'], { direct: true }))).toBe('')
  })

  it('otherwise gives a prefix Koishi accepts, / first', () => {
    expect(requiredPrefix(session(['/']))).toBe('/')
    expect(requiredPrefix(session(['!', '/']))).toBe('/')
    expect(requiredPrefix(session('!'))).toBe('!')
    expect(requiredPrefix(session(['/'], { appel: true, strict: true }))).toBe('/')
  })
})

describe('helpRewrite', () => {
  it('rewrites 帮助 and 菜单 to the hidden help command', () => {
    expect(helpRewrite('帮助', NAMES)).toBe(HELP_COMMAND)
    expect(helpRewrite('菜单', NAMES)).toBe(HELP_COMMAND)
  })

  it('keeps a topic that is one of this plugin\'s commands, with or without a space', () => {
    expect(helpRewrite('帮助 查价', NAMES)).toBe(`${HELP_COMMAND} 查价`)
    expect(helpRewrite('帮助查价', NAMES)).toBe(`${HELP_COMMAND} 查价`)
    expect(helpRewrite('菜单 批量查价', NAMES)).toBe(`${HELP_COMMAND} 批量查价`)
    expect(helpRewrite('帮助 中英对照', NAMES)).toBe(`${HELP_COMMAND} 中英对照`)
    expect(helpRewrite('帮助 本群ID', NAMES)).toBe(`${HELP_COMMAND} 本群ID`)
  })

  it('leaves help for other plugins\' commands and anything longer alone', () => {
    expect(helpRewrite('帮助 help', NAMES)).toBeNull()
    expect(helpRewrite('帮助 乌鸦', NAMES)).toBeNull()
    expect(helpRewrite('帮助 查价 Jita', NAMES)).toBeNull()
    expect(helpRewrite('帮助你', NAMES)).toBeNull()
    expect(helpRewrite('查价', NAMES)).toBeNull()
  })
})

// ------------------------------------------------------------------ 中间件（真实 Koishi + plugin-help）

describe('prefix middleware', () => {
  let h: Harness
  let w: Wiring
  /** 排在本插件后面的中间件（别的插件、兜底）收到的内容 */
  let later: string[]
  /** 别的插件的命令 */
  let echoed: string[]

  async function start(options: WiringOptions = {}, harness: HarnessOptions = {}) {
    later = []
    echoed = []
    let ref: { current: Wiring | null } = { current: null }
    h = await startHarness({
      help: true,
      ...harness,
      setup: (app: Context) => {
        ref = wirePlugin(app, options)
        app.command('echo [text:text]').action(async ({ session }, text) => {
          echoed.push(text ?? '')
          await session?.send(`echo:${text ?? ''}`)
        })
        app.middleware((session, next) => {
          later.push(session.stripped.content)
          return next()
        })
      },
    })
    w = ref.current!
  }

  afterEach(async () => {
    await h?.stop()
  })

  const texts = (sent: Array<{ text: string }>) => sent.map((s) => s.text)
  const key = (userId = MEMBER) => `qq:${'C0FFEE00000000000000000000000001'}:${userId}`

  it('/帮助, 帮助查价 and 菜单 each get exactly one reply, from this plugin', async () => {
    await start()
    expect(texts(await h.group('/帮助'))).toEqual(['help:'])
    expect(texts(await h.group('帮助查价'))).toEqual(['help:查价'])
    expect(texts(await h.group('菜单'))).toEqual(['help:'])
    expect(texts(await h.group('帮助 查价'))).toEqual(['help:查价'])
    expect(w.calls.map((c) => [c.id, c.arg])).toEqual([['help', ''], ['help', '查价'], ['help', ''], ['help', '查价']])
  })

  it('leaves 帮助 <another plugin\'s command> to plugin-help', async () => {
    await start()
    const sent = await h.group('帮助 echo')
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('echo')
    expect(w.calls).toEqual([])
  })

  it('splits glued commands and leaves argument-less look-alikes alone', async () => {
    await start()
    expect(texts(await h.group('查价乌鸦级*10'))).toEqual(['price:乌鸦级*10'])
    expect(texts(await h.group('／批量查价Jita'))).toEqual(['batch:Jita'])
    await h.group('入侵者是谁')
    expect(w.calls.map((c) => c.id)).toEqual(['price', 'batch'])
    expect(later).toContain('入侵者是谁')
    expect(texts(await h.group('本群ＩＤ'))).toEqual(['groupId:'])
    expect(texts(await h.group('查价＜Ｒ＆Ｄ＞ & <x>'))).toEqual(['price:<R&D> & <x>'])
  })

  it('handles the same message ID only once', async () => {
    await start()
    await h.group('入侵', { messageId: 'DUP-1' })
    expect(await h.group('入侵', { messageId: 'DUP-1' })).toEqual([])
    await h.group('入侵', { messageId: 'DUP-2' })
    expect(w.calls.map((c) => c.id)).toEqual(['incursion', 'incursion'])
  })

  describe('numbered replies', () => {
    const choices = [
      { no: 1, command: '查价 Jita 大型护盾扩展装置 II*4' },
      { no: 2, command: '查价 Jita 中型护盾扩展装置 II*4' },
    ]

    it('/1 runs the stored command, and the choice can be used again', async () => {
      await start()
      w.pending.setChoices(key(), choices, { quantity: true })
      expect(texts(await h.group('/1'))).toEqual(['price:Jita 大型护盾扩展装置 II*4'])
      expect(texts(await h.group('2*10'))).toEqual(['price:Jita 中型护盾扩展装置 II*10'])
      expect(texts(await h.group('２'))).toEqual(['price:Jita 中型护盾扩展装置 II*4'])
    })

    it('only for the person who got the list, in that channel', async () => {
      await start()
      w.pending.setChoices(key(), choices)
      expect(texts(await h.group('1', { userId: MEMBER2 }))).toEqual(['这个编号已经过期了，请重新查询'])
      expect(w.calls).toEqual([])
    })

    it('says so when the number is not in the list, and keeps the list', async () => {
      await start()
      w.pending.setChoices(key(), choices)
      expect(texts(await h.group('9'))).toEqual(['没有第 9 项，请回复 1–2 之间的编号'])
      expect(texts(await h.group('1'))).toEqual(['price:Jita 大型护盾扩展装置 II*4'])
    })

    it('a bare number without a pending list gets the expired reply, and nothing else answers', async () => {
      await start()
      expect(texts(await h.group('/3'))).toEqual(['这个编号已经过期了，请重新查询'])
      expect(later).toEqual([])
    })

    it('ME/TE continue the advanced manufacturing steps', async () => {
      await start({ commands: { price: { args: '[query:text]' }, search: { args: '[query:text]' } } })
      w.pending.setChoices(key(), [{ no: 1, command: '查价 乌鸦级 ME10 TE20' }], { meTe: '搜索 乌鸦级 XX-1 高级' })
      expect(texts(await h.group('ME7 te14'))).toEqual(['search:乌鸦级 XX-1 高级 ME7 TE14'])
      expect(texts(await h.group('1'))).toEqual(['price:乌鸦级 ME10 TE20'])
    })

    it('ME/TE without such a step is ordinary text', async () => {
      await start()
      w.pending.setChoices(key(), choices)
      expect(await h.group('ME7')).toEqual([])
      expect(later).toEqual(['ME7'])
    })

    it('stored commands are escaped before Koishi parses them', async () => {
      await start()
      w.pending.setChoices(key(), [{ no: 1, command: '查价 R&D <测试> &amp;' }])
      expect(texts(await h.group('1'))).toEqual(['price:R&D <测试> &amp;'])
    })

    it('a rewritten 帮助 command still becomes the hidden help', async () => {
      await start()
      w.pending.setChoices(key(), [{ no: 1, command: '帮助 查价' }])
      expect(texts(await h.group('1'))).toEqual(['help:查价'])
    })
  })

  describe('pasted lists after 批量查价 with only a header', () => {
    const probe: ListProbe = {
      isHeader: (line) => /^(?:jita|sell|buy|mid|-?\d+%|\s)+$/i.test(line),
      isItem: (line) => /^(?:raven|tritanium)\b/i.test(line),
    }

    it('turns the next multi-line message into 批量查价 <header>', async () => {
      await start({ probe })
      w.pending.setList(key(), 'XX-1 -5%')
      expect(texts(await h.group('Raven*2\nTritanium 1000'))).toEqual(['batch:XX-1 -5%\nRaven*2\nTritanium 1000'])
      expect(w.pending.get(key())).toBeUndefined()
    })

    it('a single line counts only when it is an item', async () => {
      await start({ probe })
      w.pending.setList(key(), 'Jita')
      await h.group('你好')
      expect(w.calls).toEqual([])
      expect(later).toEqual(['你好'])
      expect(texts(await h.group('Raven 2'))).toEqual(['batch:Jita\nRaven 2'])
    })

    it('without a header, or when the paste has its own header, the paste decides', async () => {
      await start({ probe })
      w.pending.setList(key(), '')
      expect(texts(await h.group('Raven\nTritanium'))).toEqual(['batch:Raven\nTritanium'])
      w.pending.setList(key(), 'XX-1 -5%')
      expect(texts(await h.group('Jita sell\nRaven\nTritanium'))).toEqual(['batch:Jita sell\nRaven\nTritanium'])
    })

    it('/查价 乌鸦 is still 查价, and another plugin\'s command is not swallowed', async () => {
      await start({ probe })
      w.pending.setList(key(), 'Jita')
      expect(texts(await h.group('/查价 乌鸦'))).toEqual(['price:乌鸦'])
      expect(texts(await h.group('echo 第一行\n第二行'))).toEqual(['echo:第一行\n第二行'])
      expect(echoed).toEqual(['第一行\n第二行'])
      expect(w.calls.map((c) => c.id)).toEqual(['price'])
      expect(w.pending.get(key())).toEqual({ kind: 'list', header: 'Jita' })
    })

    it('the list keeps its escaping and Tabs', async () => {
      await start({ probe })
      w.pending.setList(key(), 'A&B')
      expect(texts(await h.group('Raven\t2\nR&D <x>\t1'))).toEqual(['batch:A&B\nRaven\t2\nR&D <x>\t1'])
    })
  })

  describe('取消', () => {
    it('clears the pending and answers once', async () => {
      await start()
      w.pending.setList(key(), 'Jita')
      expect(texts(await h.group('取消'))).toEqual(['已取消。'])
      expect(w.pending.get(key())).toBeUndefined()
      expect(later).toEqual([])
    })

    it('without a pending it is passed on', async () => {
      await start()
      expect(await h.group('取消')).toEqual([])
      expect(later).toEqual(['取消'])
    })
  })

  describe('requireAt = false', () => {
    it('messages without @ get commands, but never take over pendings', async () => {
      await start({ general: { requireAt: false } })
      w.pending.setChoices(key(), [{ no: 1, command: '查价 乌鸦级' }])
      expect(texts(await h.group('查价乌鸦级', { at: false }))).toEqual(['price:乌鸦级'])
      expect(await h.group('1', { at: false })).toEqual([])
      expect(await h.group('取消', { at: false })).toEqual([])
      expect(later).toEqual(['1', '取消'])
      expect(w.pending.get(key())).toBeDefined()
    })
  })

  it('direct messages work without @', async () => {
    await start()
    expect(texts(await h.direct('/查价乌鸦级'))).toEqual(['price:乌鸦级'])
    const session: Session = w.calls[0].session
    expect(session.isDirect).toBe(true)
  })
})

describe('textOnly', () => {
  it('keeps text and its escapes, turns every other element into one space', () => {
    expect(textOnly('abc')).toBe('abc')
    expect(textOnly('a&amp;b&lt;c')).toBe('a&amp;b&lt;c')
    expect(textOnly('a<img src="x"/>b')).toBe('a b')
    expect(textOnly('a <at id="1"/> b')).toBe('a b')
    expect(textOnly('a\n<img src="x"/>\nb')).toBe('a\n\nb')
  })
})
