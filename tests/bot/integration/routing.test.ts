// 关键行为（§10.1）：帮助和 plugin-help 共存、编号回复、无空格命令、@ 要求、自我回声、去重、onebot 不受影响、
// 命令重名不让插件加载失败、命令处理函数不返回值、兜底回复（§2.18）。

import { afterEach, describe, expect, it } from 'vitest'
import { Channel, h, User } from 'koishi'
import type { Context, Session } from 'koishi'
import { GROUP, GROUP2, MEMBER, MEMBER2, QQ_SELF, dispatch, messageEvent } from '../../harness'
import { MARKETS_WITH_ALLIANCE, RAVEN, THE_FORGE, addOrders, buttonRows, buttons, card, jitaOrders, plainCmdInput, startPlugin } from './plugin-env'
import type { EnvOptions, PluginEnv } from './plugin-env'

let env: PluginEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
})

async function start(options: EnvOptions = {}): Promise<PluginEnv> {
  env = await startPlugin({ esi: (fake) => addOrders(fake, THE_FORGE, jitaOrders(RAVEN, 258_400_000, 249_000_000)), ...options })
  return env
}


describe('help next to plugin-help', () => {
  it('「/帮助」「帮助」「菜单」each get exactly one reply, our main card', async () => {
    const e = await start({ help: true })
    for (const input of ['/帮助', '帮助', '菜单', '／帮助']) {
      const sent = await e.h.group(input)
      expect(sent, input).toHaveLength(1)
      expect(sent[0].markdown, input).toMatch(/^\*\*EVE 市场助手 · 欧服\*\*\n\n\*\*价格\*\*\n\n- 查价 乌鸦级：默认市场的出售、中间、收购价/)
      expect(sent[0].markdown).toContain('数据：CCP hf.（非商业使用）· 黑话表：EVE Online 中文黑话表 eve-cn-slang（CC BY 4.0）')
    }
  })

  it('「帮助查价」「帮助 查价」get the price topic; 「帮助 help」stays with plugin-help', async () => {
    const e = await start({ help: true })
    for (const input of ['帮助查价', '帮助 查价', '/帮助 批量查价']) {
      const sent = await e.h.group(input)
      expect(sent, input).toHaveLength(1)
    }
    expect((await e.h.group('帮助查价'))[0].markdown).toMatch(/^\*\*查价\*\*\n\n- 查价 乌鸦级：查本群的默认市场/)
    expect((await e.h.group('帮助 批量查价'))[0].markdown).toMatch(/^\*\*批量查价\*\*/)
    const other = await e.h.group('帮助 help')
    expect(other).toHaveLength(1)
    expect(card(other)).not.toContain('EVE 市场助手')
  })

  it('the price topic names the market ▲▼ compares with; without a visible one it says the base market', async () => {
    const e = await start({
      config: { markets: MARKETS_WITH_ALLIANCE, price: { baseMarket: '联盟市场A' }, access: { allowedGroups: [{ groupId: GROUP, enabled: true }] } },
    })
    expect(card(await e.h.group('帮助 查价'))).toContain('- 中间：两者平均；▲▼ 是和 联盟市场A 相比')
    expect(card(await e.h.group('帮助 查价', { channelId: GROUP2 }))).toContain('- 中间：两者平均；▲▼ 是和基准市场相比')
    const plain = await startPlugin()
    try {
      expect(card(await plain.h.group('帮助 查价'))).toContain('▲▼ 是和 Jita 4-4 相比')
    } finally {
      await plain.stop()
    }
  })

  it('the main card lists only the commands of this version, with buttons to fill in and topics', async () => {
    const e = await start()
    const sent = await e.h.group('帮助')
    // 本群看不到工业地点：只写「制造」「反应」（基础参考不需要地点），不写「制造比价」
    expect(sent[0].markdown).toContain('**工业**\n\n- 制造 乌鸦级：材料成本和制造时间\n- 反应 富勒化合物：反应成本')
    expect(sent[0].markdown).not.toContain('制造比价')
    expect(sent[0].markdown).toContain('- 走势 乌鸦级：近 30 天价格图')
    expect(sent[0].markdown).toContain('**宇宙**\n\n- 入侵 · 势力图 · 联盟势力图 · 服务器状态\n- 战报 + BR 链接（直接 @我 发链接也行）')
    expect(sent[0].markdown).toContain('**其他**\n\n- 搜索 乌鸦 · 翻译 三钛合金 · 本群ID')
    expect(buttonRows(sent)).toEqual([
      ['查价=>查价 ', '批量查价=>批量查价 ', '走势=>走势 ', '制造=>制造 '],
      ['入侵=>入侵', '势力图=>势力图'],
      ['战报=>战报 ', '服务器状态=>服务器状态'],
      ['查价说明=>帮助 查价', '批量说明=>帮助 批量查价', '走势说明=>帮助 走势', '制造说明=>帮助 制造'],
    ])
  })
})

describe('numbered replies and glued commands', () => {
  it('「/1」picks a candidate; a number without anything pending says it expired', async () => {
    const e = await start()
    expect((await e.h.group('5'))[0].text).toBe('这个编号已经过期了，请重新查询')
    await e.h.group('查价 乌鸦机')
    expect(card(await e.h.group('/1'))).toContain('**乌鸦级 Raven · 战列舰')
    // 候选在有效期内一直可以选
    expect(card(await e.h.group('2'))).toContain('**乌鸦级海军型')
  })

  it('a number outside the list says which numbers exist', async () => {
    const e = await start()
    await e.h.group('查价 乌鸦机')
    expect((await e.h.group('7'))[0].text).toBe('没有第 7 项，请回复 1–3 之间的编号')
  })

  it('pending choices belong to one person in one channel', async () => {
    const e = await start()
    await e.h.group('查价 乌鸦机')
    expect((await e.h.group('1', { userId: MEMBER2 }))[0].text).toBe('这个编号已经过期了，请重新查询')
  })

  it('「查价乌鸦级」works without a space; commands without arguments must match exactly', async () => {
    const e = await start()
    expect(card(await e.h.group('查价乌鸦级'))).toContain('**乌鸦级 Raven · 战列舰')
    expect(card(await e.h.group('本群ID是多少'))).toBe('没看懂「本群ID是多少」。你是想查价吗？')
  })
})

describe('@, echo, dedupe and other platforms', () => {
  it('requireAt: group messages without @ are ignored', async () => {
    const e = await start()
    expect(await e.h.group('查价 乌鸦级', { at: false })).toEqual([])
    expect(await e.h.group('乌鸦级', { at: false })).toEqual([])
    // 单聊不用 @
    expect(card(await e.h.direct('查价 乌鸦级'))).toContain('**乌鸦级')
  })

  it('requireAt off: commands work without @, but bare items, fallback and numbers still need @', async () => {
    const e = await start({ config: { general: { requireAt: false } } })
    expect(card(await e.h.group('查价 乌鸦级', { at: false }))).toContain('**乌鸦级')
    expect(await e.h.group('乌鸦级', { at: false })).toEqual([])
    expect(await e.h.group('随便聊聊', { at: false })).toEqual([])
    await e.h.group('查价 乌鸦机')
    expect(await e.h.group('1', { at: false })).toEqual([])
  })

  it('requireAt off: our own text coming back through the all-messages event does not trigger anything', async () => {
    const e = await start({ config: { general: { requireAt: false }, display: { output: 'text' } } })
    const [topic] = await e.h.group('帮助 查价')
    expect(topic.text.startsWith('查价\n')).toBe(true)
    expect(await e.h.group(topic.text, { at: false, userId: 'BOT-ECHO' })).toEqual([])
    // 别人发同样的命令照常回复（带 @ 的不算回声）
    expect(await e.h.group(topic.text)).toHaveLength(1)
  })

  it('a global prefix without the empty one: 「/」is kept, so every plugin\'s commands still parse without @', async () => {
    const e = await start({
      config: { general: { requireAt: false } },
      setup: (app: Context) => {
        app.config.prefix = ['/']
        app.plugin({ name: 'ping', apply: (ctx: Context) => { ctx.command('ping').action(() => 'pong') } })
      },
    })
    expect(card(await e.h.group('/ping', { at: false }))).toBe('pong')
    expect(card(await e.h.group('/查价 乌鸦级', { at: false }))).toContain('**乌鸦级 Raven')
    expect(card(await e.h.group('/查价乌鸦级', { at: false }))).toContain('**乌鸦级 Raven')
    expect(card(await e.h.group('/帮助', { at: false }))).toMatch(/^\*\*EVE 市场助手/)
    expect(await e.h.group('查价 乌鸦级', { at: false })).toEqual([])
    // @ 了机器人不用前缀，写了也行
    expect(card(await e.h.group('查价 乌鸦级'))).toContain('**乌鸦级 Raven')
    expect(card(await e.h.group('/ping'))).toBe('pong')
  })

  it('a message that starts with an image reaches other plugins unchanged and gets no reply from us', async () => {
    const seen: string[] = []
    const e = await start({
      before: (app: Context) => app.plugin({
        name: 'recorder',
        apply: (ctx: Context) => ctx.platform('qq').middleware((session, next) => {
          seen.push(session.stripped.content ?? '')
          return next()
        }),
      }),
    })
    const event = messageEvent(e.h.qq, '', false, {})
    event.message!.elements = [h.at(QQ_SELF), h.text(' '), h.image('https://example.invalid/a.png?x=1&y=2')]
    const sent = await dispatch(e.h.app, e.h.qq, e.h.qq.session(event), () => e.h.qq.sent)
    expect(seen).toEqual(['<img src="https://example.invalid/a.png?x=1&amp;y=2"/>'])
    expect(sent).toEqual([])
  })

  it('users and channels Koishi ignores get no reply from the pre-middleware either', async () => {
    const e = await start()
    await e.h.app.database.createUser('qq', MEMBER, { flag: User.Flag.ignore, authority: 1 })
    expect(await e.h.group('5')).toEqual([])
    expect(await e.h.group('查价 乌鸦级')).toEqual([])
    await e.h.app.database.createChannel('qq', GROUP2, { flag: Channel.Flag.ignore, assignee: QQ_SELF })
    expect(await e.h.group('5', { userId: MEMBER2, channelId: GROUP2 })).toEqual([])
    // 别人照常
    expect((await e.h.group('5', { userId: MEMBER2 }))[0].text).toBe('这个编号已经过期了，请重新查询')
  })

  it('the same message delivered twice is answered once', async () => {
    const e = await start()
    expect(await e.h.group('查价 乌鸦级', { messageId: 'DUP-1' })).toHaveLength(1)
    expect(await e.h.group('查价 乌鸦级', { messageId: 'DUP-1' })).toEqual([])
  })

  it('onebot messages reach the next onebot plugin untouched, and get no reply from us', async () => {
    const seen: string[] = []
    const e = await start({
      onebot: true,
      setup: (app: Context) => app.plugin({
        name: 'onebot-listener',
        apply: (ctx: Context) => ctx.platform('onebot').middleware((session, next) => {
          seen.push(session.content ?? '')
          return next()
        }),
      }),
    })
    for (const input of ['查价 乌鸦级', '批量查价 Jita', '帮助', '本群ID', '乌鸦级']) {
      expect(await e.h.onebotGroup(input), input).toEqual([])
    }
    expect(seen).toEqual(['查价 乌鸦级', '批量查价 Jita', '帮助', '本群ID', '乌鸦级'])
  })
})

describe('registration', () => {
  it('a name taken by another plugin is skipped and reported; the rest of the plugin works', async () => {
    const e = await start({
      // 在本插件之前注册：同名的「查价」归别的插件
      before: (app: Context) => app.plugin({ name: 'old-market', apply: (ctx: Context) => { ctx.command('查价 [q:text]').action(() => '旧插件的查价') } }),
    })
    expect(e.logger.at('warn')).toContain('命令冲突：「查价」和别的插件的命令重名，没有注册')
    expect(card(await e.h.group('查价 乌鸦级'))).toBe('旧插件的查价')
    expect(await e.h.group('本群ID')).toHaveLength(3)
    // 裸物品名不会转给别的插件的「查价」
    const bare = await e.h.group('乌鸦级')
    expect(card(bare)).toBe('没看懂「乌鸦级」。你是想查价吗？')
    expect(buttons(bare)).toEqual(['帮助=>帮助'])
    expect(e.logger.at('error')).toEqual([])
  })

  it('command handlers return nothing; everything goes through the replier', async () => {
    let captured: Session | undefined
    const e = await start({
      before: (app: Context) => app.plugin({ name: 'capture', apply: (ctx: Context) => ctx.middleware((session, next) => { captured = session; return next() }, true) }),
    })
    await e.h.direct('取消')
    for (const input of ['查价 乌鸦级', '批量查价\nRaven', '搜索 乌鸦', '本群ID', 'eve-market.help']) {
      expect(await captured!.execute(input, true), input).toEqual([])
    }
  })
})

describe('fallback (§2.18)', () => {
  it('only @: a short help card', async () => {
    const e = await start()
    const sent = await e.h.group('')
    expect(sent).toHaveLength(1)
    expect(sent[0].markdown).toBe('**EVE 市场助手 · 欧服**\n\n**价格**\n\n- 查价 乌鸦级：默认市场的出售、中间、收购价\n- 查价 Jita PLEX*500：指定市场和数量\n- 批量查价：粘贴清单或装配，算总价\n- 估价 + Janice 估价链接：读出三个价格和物品清单（直接 @我 发链接也行）\n- 走势 乌鸦级：近 30 天价格图')
  })

  it('an exact item name is priced; a market and quantity in front work too', async () => {
    const e = await start()
    expect(card(await e.h.group('乌鸦级'))).toContain('**乌鸦级 Raven · 战列舰**\n\n**Jita 4-4**')
    expect(card(await e.h.group('Jita Raven*2'))).toContain('**乌鸦级 Raven ×2 · 战列舰')
    expect(card(await e.h.group('高级水晶'))).toContain('**高级水晶套装')
  })

  it('short unknown text asks whether it was a price query; long chat gets one line', async () => {
    const e = await start()
    const short = await e.h.group('护盾扩展')
    expect(short).toHaveLength(1)
    expect(card(short)).toBe('没看懂「护盾扩展」。你是想查价吗？')
    expect(buttons(short)).toEqual(['查价 护盾扩展=>查价 护盾扩展', '帮助=>帮助'])
    const chat = await e.h.group('今天晚上有没有人一起去刷异常空间，带上你的乌鸦级')
    expect(chat.map((s) => s.text)).toEqual(['发「帮助」看我能做什么'])
  })

  it('text that looks like a link is never put into a button', async () => {
    const e = await start()
    const sent = await e.h.group('evil.com')
    expect(card(sent)).toBe('没看懂「\\[链接\\]」。你是想查价吗？')
    expect(buttons(sent)).toEqual(['帮助=>帮助'])
  })

  it('no extra「您要找的是不是」from Koishi after our reply', async () => {
    const e = await start()
    expect(await e.h.group('查加 乌鸦级')).toHaveLength(1)
  })

  it('a pasted list while a batch is pending wins over the fallback', async () => {
    const e = await start()
    await e.h.group('批量查价')
    expect(card(await e.h.group('Raven*2'))).toContain('**批量估价')
  })
})

describe('本群ID (§2.15)', () => {
  it('in a group: the explanation, then the group ID and the user ID alone', async () => {
    const e = await start({ config: { access: { allowedGroups: [{ groupId: GROUP, enabled: true }] } } })
    const sent = await e.h.group('本群ID', { raw: { d: { author: { union_openid: 'UNION-0001' } } } })
    expect(sent.map((s) => s.markdown ?? s.text)).toEqual([
      [
        '**本群 ID**',
        '下面两条消息分别是本群的 ID 和你的 ID，长按就能复制。',
        '- 授权群一栏填：本群 ID（下一条）\n- 管理员一栏填：qq: 加上你的 ID（最后一条）\n- 本群现在：已授权',
        '你的跨群 ID：UNION-0001\n同一个人在不同群、在私聊里的 ID 可能不一样；管理员建议填私聊里拿到的 ID。',
      ].join('\n\n'),
      GROUP,
      sent[0].session?.userId,
    ])
  })

  it('in a direct chat: the explanation and your ID', async () => {
    const e = await start()
    const sent = await e.h.direct('本群ID')
    expect(sent).toHaveLength(2)
    expect(sent[0].markdown).toContain('管理员一栏填：qq: 加上下一条的 ID\n- 本私聊现在：未授权')
    expect(sent[1].text).toBe(sent[0].session?.userId)
  })
})

describe('搜索 (§2.5)', () => {
  it('an exact name lists related items with prices; numbers price them; skins are offered', async () => {
    const e = await start()
    const sent = await e.h.group('搜索 乌鸦级')
    expect(plainCmdInput(sent[0].markdown!)).toBe([
      '**「乌鸦级」相关物品 · Jita 4-4 · 共 7 个**\n另有涂装 3 个',
      [
        '1. 乌鸦级 · Raven · 出售 258.40M · 收购 249.00M',
        '2. 乌鸦级海军型 · Raven Navy Issue · 出售 — · 收购 —',
        '3. 乌鸦级政府型 · Raven State Issue · 出售 — · 收购 —',
        '4. 乌鸦级蓝图 · Raven Blueprint · 出售 — · 收购 —',
        '',
        '点下面的编号后再按发送，或者 @我 回复编号（5 分钟内有效）',
      ].join('\n'),
    ].join('\n\n'))
    // 列表项本身可点（输入框里填「@机器人 查价 乌鸦级」）
    expect(sent[0].markdown).toContain('1. <qqbot-cmd-input text="查价 乌鸦级" show="乌鸦级" reference="false" /> · Raven')
    expect(buttons(sent)).toEqual(['1=>查价 乌鸦级', '2=>查价 乌鸦级海军型', '3=>查价 乌鸦级政府型', '4=>查价 乌鸦级蓝图', '涂装 3 个=>搜索 乌鸦级 涂装'])
    expect(card(await e.h.group('2'))).toContain('**乌鸦级海军型 Raven Navy Issue')
    // 按钮上的个数和点开以后列出的个数一样（不能上市场的涂装也列出，只是不写价格）
    const skins = await e.h.group('搜索 乌鸦级 涂装')
    expect(skins[0].markdown?.split('\n')[0]).toBe('**「乌鸦级」的搜索结果 · Jita 4-4 · 共 3 个**')
    expect(plainCmdInput(skins[0].markdown!)).toContain('乌鸦级YC117年涂装 · Raven Serenity YC117 SKIN\n')
  })

  it.each([
    ['compact_only', 'full_only', '出售 258.40M · 收购 249.00M'],
    ['inherit', 'full_only', '出售 258,400,000 ISK · 收购 249,000,000 ISK'],
    ['inherit', 'full_and_compact', '出售 258,400,000 ISK（258.40M） · 收购 249,000,000 ISK（249.00M）'],
    ['inherit', 'compact_only', '出售 258.40M · 收购 249.00M'],
  ])('row prices follow listPriceDisplayMode %s (priceDisplayMode %s)', async (list, mode, prices) => {
    const e = await start({ config: { display: { priceDisplayMode: mode, listPriceDisplayMode: list } } })
    expect(card(await e.h.group('搜索 乌鸦级'))).toContain(`1. 乌鸦级 · Raven · ${prices}\n`)
  })

  it('pages of 10 with a next-page button; a market in front is kept in the buttons', async () => {
    const e = await start()
    const first = await e.h.group('搜索 Amarr 护盾')
    expect(first[0].markdown?.split('\n').slice(0, 2)).toEqual([expect.stringMatching(/^\*\*「护盾」的搜索结果 · Amarr · 共 \d+ 个\*\*$/), expect.stringMatching(/^第 1\/\d 页$/)])
    expect(buttons(first)).toContain('下一页=>搜索 Amarr 护盾 第2页')
    expect(buttons(first)[0]).toMatch(/^1=>查价 Amarr /)
    expect(card(await e.h.group('搜索 Amarr 护盾 第2页'))).toMatch(/第 2\/\d 页/)
  })

  it('nothing found, unknown market, and the usage', async () => {
    const e = await start()
    expect(card(await e.h.group('搜索 zzzzqqqq'))).toBe('没有名字里包含「zzzzqqqq」的物品。')
    expect(card(await e.h.group('搜索 TEST 乌鸦级'))).toContain('未知市场：TEST')
    expect(card(await e.h.group('搜索'))).toMatch(/^\*\*搜索用法\*\*/)
  })
})
