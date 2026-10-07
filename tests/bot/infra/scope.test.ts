import type { Session } from 'koishi'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MessageDedupe, authorityOf, buildAccess, inPlatform, isAddressed, isAdmin, isAllowed, isSandbox, isSelfEcho, messageDedupe,
  messageKey, unionIdOf,
} from '../../../src/bot/scope'
import type { AccessSession } from '../../../src/bot/scope'
import { EchoLog } from '../../../src/bot/send/echo'
import { createModuleStore } from '../../../src/core/ports'
import type { AccessSettings } from '../../../src/core/types'
import { GROUP, GROUP2, MEMBER, MEMBER2, USER, fakeBot, startHarness } from '../../harness'
import type { Harness } from '../../harness'
import { wirePlugin } from './wiring'
import type { Wiring, WiringOptions } from './wiring'

describe('platform and @', () => {
  it('answers only on qq, and on the sandbox when allowed', () => {
    expect(inPlatform('qq', { allowSandbox: false })).toBe(true)
    expect(inPlatform('onebot', { allowSandbox: true })).toBe(false)
    expect(inPlatform('qqguild', { allowSandbox: true })).toBe(false)
    expect(inPlatform('sandbox', { allowSandbox: false })).toBe(false)
    expect(inPlatform('sandbox', { allowSandbox: true })).toBe(true)
    expect(inPlatform('sandbox:x1y2', { allowSandbox: true })).toBe(true)
    expect(inPlatform(undefined, { allowSandbox: true })).toBe(false)
    expect(isSandbox('sandboxes')).toBe(false)
  })

  it('direct messages and @ messages are addressed to the bot', () => {
    expect(isAddressed({ isDirect: true, stripped: { appel: false } } as never)).toBe(true)
    expect(isAddressed({ isDirect: false, stripped: { appel: true } } as never)).toBe(true)
    expect(isAddressed({ isDirect: false, stripped: { appel: false } } as never)).toBe(false)
  })
})

describe('MessageDedupe', () => {
  it('lets each platform:messageId through once within 2 minutes', () => {
    let now = 0
    const dedupe = new MessageDedupe({ now: () => now })
    expect(dedupe.first('qq:M1')).toBe(true)
    expect(dedupe.first('qq:M1')).toBe(false)
    expect(dedupe.first('qq:M2')).toBe(true)
    now += 2 * 60_000 - 1
    expect(dedupe.first('qq:M1')).toBe(false)
    now += 1
    expect(dedupe.first('qq:M1')).toBe(true)
    expect(dedupe.first(undefined)).toBe(true)
    expect(dedupe.first(undefined)).toBe(true)
  })

  it('keys by platform and message ID; lives in the module store', () => {
    expect(messageKey({ platform: 'qq', messageId: 'ABC' })).toBe('qq:ABC')
    expect(messageKey({ platform: 'qq', messageId: undefined })).toBeUndefined()
    const store = createModuleStore()
    expect(messageDedupe(store)).toBe(messageDedupe(store))
  })
})

describe('self echo', () => {
  const session = (content: string, options: { appel?: boolean; isDirect?: boolean; channelId?: string } = {}) => ({
    platform: 'qq',
    channelId: options.channelId ?? GROUP,
    isDirect: !!options.isDirect,
    elements: [],
    content,
    stripped: { appel: !!options.appel, content },
  }) as unknown as Session

  it('drops a group message without @ that matches what we sent here in the last 60 s', () => {
    const echo = new EchoLog()
    echo.record(`qq:${GROUP}`, '查价 乌鸦级', 1000)
    expect(isSelfEcho(session('查价  乌鸦级'), echo, 2000)).toBe(true)
    expect(isSelfEcho(session('查价 乌鸦级'), echo, 1000 + 60_000)).toBe(false)
    expect(isSelfEcho(session('查价 乌鸦级', { channelId: GROUP2 }), echo, 2000)).toBe(false)
    expect(isSelfEcho(session('查价 乌鸦级', { appel: true }), echo, 2000)).toBe(false)
    expect(isSelfEcho(session('查价 乌鸦级', { isDirect: true }), echo, 2000)).toBe(false)
    expect(isSelfEcho(session('别的'), echo, 2000)).toBe(false)
  })
})

describe('Access', () => {
  const settings: AccessSettings = {
    admins: ['ADMIN1', 'sandbox:abc:ADMIN2', 'UNION-ADMIN'],
    allowedGroups: ['GROUP-OK', 'qq:GROUP-PREFIXED'],
    allowedUsers: ['FRIEND'],
  }
  const group = (userId: string, channelId: string, extra: Partial<AccessSession> = {}): AccessSession =>
    ({ platform: 'qq', userId, channelId, guildId: channelId, isDirect: false, ...extra })
  const direct = (userId: string, extra: Partial<AccessSession> = {}): AccessSession =>
    ({ platform: 'qq', userId, channelId: userId, isDirect: true, ...extra })
  const union = (id: string) => ({ event: { _data: { d: { author: { union_openid: id } } } } })

  it('admins: by ID (with or without platform prefix), union_openid, or Koishi authority ≥ 4', () => {
    expect(isAdmin(group('ADMIN1', 'G'), settings)).toBe(true)
    expect(isAdmin({ ...group('ADMIN2', 'G'), platform: 'sandbox:abc' }, settings)).toBe(true)
    expect(isAdmin(group('SOMEONE', 'G', union('UNION-ADMIN')), settings)).toBe(true)
    expect(isAdmin(group('SOMEONE', 'G', { user: { authority: 4 } }), settings)).toBe(true)
    expect(isAdmin(group('SOMEONE', 'G', { user: { authority: 3 } }), settings)).toBe(false)
    expect(isAdmin(group('SOMEONE', 'G'), settings)).toBe(false)
  })

  it('groups are allowed when listed; direct chats for listed users and admins', () => {
    expect(isAllowed(group('X', 'GROUP-OK'), settings)).toBe(true)
    expect(isAllowed(group('X', 'GROUP-PREFIXED'), settings)).toBe(true)
    expect(isAllowed(group('ADMIN1', 'GROUP-OTHER'), settings)).toBe(false)
    expect(isAllowed(direct('FRIEND'), settings)).toBe(true)
    expect(isAllowed(direct('ADMIN1'), settings)).toBe(true)
    expect(isAllowed(direct('STRANGER'), settings)).toBe(false)
  })

  it('builds the Access core uses', () => {
    expect(buildAccess(group('ADMIN1', 'GROUP-OK', union('U-1')), settings)).toEqual({
      platform: 'qq', userId: 'ADMIN1', channelId: 'GROUP-OK', unionId: 'U-1', isDirect: false, isAdmin: true, allowed: true,
    })
    expect(buildAccess(direct('STRANGER'), settings)).toEqual({
      platform: 'qq', userId: 'STRANGER', channelId: 'STRANGER', isDirect: true, isAdmin: false, allowed: false,
    })
  })

  it('reads union_openid only from qq events and tolerates odd shapes', () => {
    expect(unionIdOf({ platform: 'qq', ...union('U-2') })).toBe('U-2')
    expect(unionIdOf({ platform: 'onebot', ...union('U-2') })).toBeUndefined()
    expect(unionIdOf({ platform: 'qq', event: { _data: { d: { author: { union_openid: 5 } } } } })).toBeUndefined()
    expect(unionIdOf({ platform: 'qq', event: { _data: 'x' } })).toBeUndefined()
    expect(unionIdOf({ platform: 'qq' })).toBeUndefined()
    expect(authorityOf({ user: { authority: 5 } })).toBe(5)
    expect(authorityOf({ user: null })).toBe(0)
  })
})

// ------------------------------------------------------------------ 在真实 Koishi 里

describe('scopes in Koishi', () => {
  let h: Harness
  let w: Wiring
  let later: string[]

  async function start(options: WiringOptions = {}) {
    later = []
    let ref: { current: Wiring | null } = { current: null }
    h = await startHarness({
      onebot: true,
      setup: (app) => {
        ref = wirePlugin(app, options)
        app.middleware((session, next) => {
          later.push(`${session.platform}:${session.stripped.content}`)
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

  it('with requireAt, group messages without @ are not ours; direct messages are', async () => {
    await start()
    expect(await h.group('入侵', { at: false })).toEqual([])
    expect(later).toEqual(['qq:入侵'])
    expect(texts(await h.group('入侵'))).toEqual(['incursion:'])
    expect(texts(await h.direct('入侵'))).toEqual(['incursion:'])
  })

  it('never answers on onebot, with or without @', async () => {
    await start()
    await h.onebotGroup('入侵')
    await h.onebotGroup('查价 乌鸦', { at: true })
    expect(h.onebot!.sent).toEqual([])
    expect(w.calls).toEqual([])
    expect(later).toEqual(['onebot:入侵', 'onebot:查价 乌鸦'])
  })

  it('answers in the sandbox only when allowSandbox is on', async () => {
    await start()
    const sandbox = fakeBot(h.app, { platform: 'sandbox:x1', selfId: 'sandbox-bot' })
    expect(await h.send(sandbox, '入侵', { direct: true, userId: 'tester' })).toEqual([])
    await h.stop()
    await start({ general: { allowSandbox: true } })
    const allowed = fakeBot(h.app, { platform: 'sandbox:x1', selfId: 'sandbox-bot' })
    expect(texts(await h.send(allowed, '入侵', { direct: true, userId: 'tester' }))).toEqual(['incursion:'])
  })

  it('with requireAt = false, our own text coming back is ignored, other text is handled', async () => {
    await start({ general: { requireAt: false } })
    const ours: string[] = []
    w.scopes.cmdCtx.middleware((session, next) => {
      ours.push(`${session.channelId}:${session.stripped.content}`)
      return next()
    })
    expect(texts(await h.group('查价 乌鸦级', { at: false }))).toEqual(['price:乌鸦级'])
    // 全量消息事件把机器人自己发的「price:乌鸦级」也送回来（作者是机器人在群里的 openid）
    expect(await h.group('price:乌鸦级', { at: false, userId: MEMBER2 })).toEqual([])
    expect(ours).toEqual([])
    // 别的插件照样看得到
    expect(later).toEqual(['qq:price:乌鸦级'])
    expect(texts(await h.group('查价 乌鸦级', { at: false, userId: MEMBER2 }))).toEqual(['price:乌鸦级'])
    // 别的群没发过，照常
    await h.group('price:乌鸦级', { at: false, channelId: GROUP2 })
    expect(ours).toEqual([`${GROUP2}:price:乌鸦级`])
  })

  it('the echo filter also keeps our commands from running on an echoed command line', async () => {
    await start({ general: { requireAt: false } })
    await w.say(await sessionFor(h), '入侵')
    expect(await h.group('入侵', { at: false, userId: MEMBER2 })).toEqual([])
    expect(w.calls).toEqual([])
    // @ 了机器人的不算回声
    expect(texts(await h.group('入侵', { userId: MEMBER2 }))).toEqual(['incursion:'])
  })

  it('Koishi itself ignores messages whose author is the bot', async () => {
    await start({ general: { requireAt: false } })
    expect(await h.self('入侵')).toEqual([])
    expect(w.calls).toEqual([])
  })

  it('commands get an Access built from the session', async () => {
    await start({ access: { admins: [USER], allowedGroups: [GROUP], allowedUsers: [] } })
    await h.group('入侵')
    await h.direct('入侵')
    await h.group('入侵', { channelId: GROUP2, raw: { d: { author: { union_openid: 'UNION-9' } } } })
    expect(w.calls.map((c) => c.access)).toEqual([
      { platform: 'qq', userId: MEMBER, channelId: GROUP, isDirect: false, isAdmin: false, allowed: true },
      { platform: 'qq', userId: USER, channelId: USER, isDirect: true, isAdmin: true, allowed: true },
      { platform: 'qq', userId: MEMBER, channelId: GROUP2, unionId: 'UNION-9', isDirect: false, isAdmin: false, allowed: false },
    ])
  })

  it('Koishi authority ≥ 4 makes an admin', async () => {
    await start()
    await h.authority(MEMBER, 4)
    await h.group('入侵')
    expect(w.calls[0].access.isAdmin).toBe(true)
  })
})

/** 拿一个群里的会话（给 say 用） */
async function sessionFor(h: Harness) {
  return h.qq.session({ type: 'message', channel: { id: GROUP, type: 0 }, guild: { id: GROUP }, user: { id: MEMBER }, message: { id: 'X', elements: [] } })
}
