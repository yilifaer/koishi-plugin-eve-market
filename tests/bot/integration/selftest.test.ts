// 样式自检（§2.17）走完整个插件：只对管理员存在；每页最多 4 条测试消息，每条开头写清楚正常是什么样子；
// 单聊的额度少 1 条时怎么合并或省略。最后用真实的 adapter-qq 看第 2 页真正发出去的请求（图片 + 说明合成一条、
// 引用回复、Markdown 卡片上的引用和 @ 提醒、3,900 字的长消息）。

import { afterEach, describe, expect, it } from 'vitest'
import { sendState } from '../../../src/bot/send/replier'
import { SELFTEST_IMAGE, SELFTEST_LONG_CHARS } from '../../../src/bot/commands/selftest'
import { imageSize } from '../../../src/render'
import { GROUP2, MEMBER, MEMBER2, REAL_MEMBER, USER } from '../../harness'
import type { Sent } from '../../harness'
import { buttonRows, card, startPlugin, startRealPlugin } from './plugin-env'
import type { EnvOptions, PluginEnv, RealEnv } from './plugin-env'

let env: PluginEnv | undefined
let real: RealEnv | undefined

afterEach(async () => {
  await env?.stop()
  env = undefined
  await real?.stop()
  real = undefined
})

/** 管理员：群里的 MEMBER 和单聊的 USER（测试群不是授权群） */
const admins = { access: { admins: [MEMBER, `qq:${USER}`, REAL_MEMBER] } }

async function start(options: EnvOptions = {}): Promise<PluginEnv> {
  env = await startPlugin({ config: admins, ...options })
  return env
}

function pngOf(sent: Sent): Buffer {
  const m = /^data:image\/png;base64,(.*)$/.exec(sent.images[0]?.src ?? '')
  if (!m) throw new Error('不是 PNG')
  return Buffer.from(m[1], 'base64')
}

describe('样式自检: who can use it', () => {
  it('only admins, in any group (a test group is usually not an allowed group); others get nothing', async () => {
    const e = await start()
    expect(await e.h.group('样式自检', { userId: MEMBER2 })).toEqual([])
    expect(await e.h.group('样式自检 2', { userId: MEMBER2, channelId: GROUP2 })).toEqual([])
    expect(card(await e.h.group('帮助', { userId: MEMBER2 }))).not.toContain('样式自检')
    expect(await e.h.group('样式自检', { channelId: GROUP2 })).toHaveLength(4)
  })

  it('a page that does not exist', async () => {
    const e = await start()
    expect((await e.h.group('样式自检 3')).map((s) => s.text)).toEqual(['样式自检只有两页：发「样式自检 1」或「样式自检 2」'])
  })

  it('help explains it to admins', async () => {
    const e = await start()
    const out = card(await e.h.group('帮助 样式自检', { channelId: GROUP2 }))
    expect(out.split('\n')[0]).toBe('**样式自检**（管理员）')
  })
})

describe('样式自检 1', () => {
  it('four messages: Markdown, buttons, clickable text, the report format; each says what normal looks like', async () => {
    const e = await start()
    const sent = await e.h.group('样式自检 1')
    expect(sent).toHaveLength(4)
    expect(sent[0].markdown).toBe([
      '**样式自检 1-1：Markdown 格式**',
      '每一项后面写了正常的样子；和写的不一样，就记下是哪一项。',
      '',
      '- 这一行前面应该是一个圆点，不是减号',
      '    - 这一行是嵌套列表：比上一行往右缩进一层',
      '- 行内代码 `258,400,000 ISK`：数字应该是灰底（或等宽）的字；数字两边多出小撇号就不正常',
      '- **这几个字应该是粗体**；两边多出星号就不正常',
      '',
      '> 这一行是引用：左边应该有一条竖线（或整行换了颜色）；看到 > 就不正常',
      '',
      '这一行和下一行之间只有一个换行，',
      '所以这一行应该紧挨着上一行，中间没有空行',
      '\u200b',
      '上面是一行看不见的空格：这一行和上一行之间应该空出一行',
      '',
      '***',
      '分割线：这一行上面应该有一条横线；看到 `***` 就不正常',
    ].join('\n'))
    expect(sent[1].markdown).toContain('下面应该有 4 行按钮：第 1 行 3 个、第 2 行 4 个、第 3 行 2 个、第 4 行 1 个，行和行之间没有空行')
    expect(sent[1].rows.map((row) => row.map((b) => `${b.label}=>${b.text}`))).toEqual([
      ['帮助=>帮助', '服务器状态=>服务器状态', '联盟势力图=>联盟势力图'],
      ['入侵=>入侵', '势力图=>势力图', '本群ID=>本群ID', '翻译 Hek=>翻译 Hek'],
      ['查价 PLEX=>查价 PLEX', '搜索 三钛合金=>搜索 三钛合金'],
      ['样式自检 2=>样式自检 2'],
    ])
    expect(sent[1].rows[0][0].primary).toBe(true)
    expect(sent[2].markdown).toContain('写法 A（不编码）：<qqbot-cmd-input text="帮助" show="点这里 A" reference="false" />')
    expect(sent[2].markdown).toContain('写法 B（编码）：<qqbot-cmd-input text="%E5%B8%AE%E5%8A%A9" show="点这里 B" reference="false" />')
    expect(sent[3].text).toBe([
      '样式自检第 1 页发完了。请照这个格式把结果告诉开发者（不正常的写上哪里不对）：',
      '1-1 正常 / 1-2 不正常（第 2 行没显示）/ 1-3 A 不带 @、B 正常',
      '看完以后再发「样式自检 2」',
    ].join('\n'))
  })

  it('1-1 carries no automatic quote or @; the next card does', async () => {
    const e = await start()
    const sent = await e.h.group('样式自检 1', { messageId: 'SELFTEST-1' })
    expect(sent[0].quote).toBeUndefined()
    expect(sent[0].mention).toBeUndefined()
    expect(sent[0].markdown?.startsWith('**样式自检 1-1')).toBe(true)
    expect(sent[1].quote).toBe('SELFTEST-1')
    expect(sent[1].mention).toBe(MEMBER)
    expect(sent[2].quote).toBeUndefined()
  })

  it('in a direct chat (3 messages) the report format goes into the third message', async () => {
    const e = await start()
    const sent = await e.h.direct('样式自检')
    expect(sent).toHaveLength(3)
    expect(sent[2].markdown).toContain('<qqbot-cmd-input text="帮助"')
    expect(sent[2].markdown).toContain('1-1 正常 / 1-2 不正常（第 2 行没显示）/ 1-3 A 不带 @、B 正常')
  })
})

describe('样式自检 2', () => {
  it('long image with a caption, a quote reply, an @ reminder, then a long message of exactly 3,900 characters', async () => {
    const e = await start()
    const sent = await e.h.group('样式自检 2', { messageId: 'SELFTEST-2' })
    expect(sent).toHaveLength(4)
    // 2-1 + 2-4：一张 1440×8000 的 PNG，说明文字和图片在同一条消息里
    expect(imageSize(pngOf(sent[0]))).toEqual({ width: SELFTEST_IMAGE.width, height: SELFTEST_IMAGE.height })
    expect(sent[0].text).toMatch(/^样式自检 2-1：这行字应该紧贴在图片下面、和图片是同一条消息。2-4：这是 1440×8000 的长图/)
    // 2-2：引用用户的那条消息
    expect(sent[1].elements.map((el) => el.type)).toEqual(['quote', 'text'])
    expect(sent[1].elements[0].attrs.id).toBe('SELFTEST-2')
    expect(sent[1].text).toContain('样式自检 2-2：这条消息应该引用了你刚才发的「样式自检 2」')
    // 2-3：第一张 Markdown 卡片带引用和开头的 @ 提醒（由 Replier 加，写明正常的样子）
    expect(sent[2].markdown).toContain('正常：这张卡片引用了你刚发的那条消息，开头是 @你的名字')
    expect(sent[2].markdown).toContain('每次都会尝试带引用和 @，即使之前的回复已经不带了')
    expect(sent[2].quote).toBe('SELFTEST-2')
    expect(sent[2].mention).toBe(MEMBER)
    // 引用和提醒都只在这一张卡片上
    expect(sent[3].quote).toBeUndefined()
    expect(sent[3].mention).toBeUndefined()
    // 2-4：按发出去的 Markdown 正好 3,900 字，最后一行是结束标记
    expect(sent[3].markdown).toHaveLength(SELFTEST_LONG_CHARS)
    // 用一行数字补齐，句子后面不接一串「。」
    expect(sent[3].markdown).not.toContain('。。')
    expect(sent[3].markdown).toMatch(/\n补齐长度：\d*\n/)
    expect(sent[3].markdown?.endsWith('——样式自检 2-4 到这里结束——')).toBe(true)
    expect(sent[3].markdown).toContain('2-1 正常 / 2-2 不正常（没有引用）/ 2-3 正常 / 2-4 长消息正常、长图看不清')
    expect(buttonRows(sent)).toEqual([])
  })

  it('in a direct chat the @ reminder is left out (3 messages), and so is 2-3 in the report format', async () => {
    const e = await start()
    const sent = await e.h.direct('样式自检 2')
    expect(sent).toHaveLength(3)
    expect(sent.map((s) => s.mention)).toEqual([undefined, undefined, undefined])
    // 单聊没有 @ 提醒；2-2 已经带过引用，长消息不再重复引用
    expect(sent[1].quote).toBeTruthy()
    expect(sent[2].quote).toBeUndefined()
    expect(sent[2].markdown).toHaveLength(SELFTEST_LONG_CHARS)
    expect(sent[2].markdown).toContain('2-1 正常 / 2-2 不正常（没有引用）/ 2-4 长消息正常、长图看不清')
    expect(sent[2].markdown).not.toContain('2-3')
  })

  it('2-3 tries quote and @ again even when the platform refused them earlier', async () => {
    const e = await start()
    const first = await e.h.group('帮助')
    expect(first[0].quote).toBeTruthy()
    // 模拟之前的回复被平台拒绝过引用 / @ 以后记下的状态
    const state = sendState(e.store)
    for (const key of ['markdown:quote', 'markdown:mention', 'text:quote']) state.rejected.add(key)
    const plain = await e.h.group('帮助', { messageId: 'H2' })
    expect(plain[0].quote).toBeUndefined()
    const sent = await e.h.group('样式自检 2', { messageId: 'SELFTEST-2' })
    expect(sent[2].quote).toBe('SELFTEST-2')
    expect(sent[2].mention).toBe(MEMBER)
    expect(state.rejected.size).toBe(1)
  })

  it('a long image QQ refuses is said in one line, and the other checks still go out', async () => {
    const e = await start()
    e.h.qq.fail({ code: 40034004, status: 400, message: 'image too large' })
    const sent = await e.h.group('样式自检 2', { messageId: 'SELFTEST-2' })
    expect(sent).toHaveLength(3)
    expect(sent[0].elements.map((el) => el.type)).toEqual(['quote', 'text'])
    expect(sent[0].text.split('\n')).toEqual([
      '样式自检 2-1、2-4：长图没有发出去（QQ 没有接受这张 1440×8000 的图片，原因见日志），这两项的图片部分记成不正常',
      '样式自检 2-2：这条消息应该引用了你刚才发的「样式自检 2」（上面有一个小框显示那条消息）；没有引用就不正常',
    ])
    expect(sent[1].mention).toBe(MEMBER)
    expect(sent[2].markdown).toHaveLength(SELFTEST_LONG_CHARS)
    expect(e.logger.at('warn').join('\n')).toContain('40034004')
  })

  it('in a direct chat a refused image still leaves room for the quote and the long message', async () => {
    const e = await start()
    e.h.qq.fail({ code: 40034004, status: 400, message: 'image too large' })
    const sent = await e.h.direct('样式自检 2')
    expect(sent).toHaveLength(2)
    expect(sent[0].text).toContain('样式自检 2-1、2-4：长图没有发出去')
    expect(sent[1].markdown).toHaveLength(SELFTEST_LONG_CHARS)
  })
})

describe('样式自检 2 on the real QQ adapter', () => {
  it('image + caption is one media message, the quote is a message_reference, all four are passive replies', async () => {
    real = await startRealPlugin({ config: admins })
    const sent = await real.qq.group('样式自检 2', { messageId: 'REAL-SELFTEST-2' })
    expect(sent).toHaveLength(4)
    expect(sent.map((m) => m.body.msg_id)).toEqual(Array(4).fill('REAL-SELFTEST-2'))
    expect(sent.map((m) => m.body.msg_seq)).toEqual([1, 2, 3, 4])
    // 图片先上传，再和说明文字合成一条 msg_type 7
    expect(sent[0].body.msg_type).toBe(7)
    expect(sent[0].body.content).toContain('样式自检 2-1')
    const [upload] = real.qq.api.uploads
    expect(upload.fileType).toBe(1)
    expect(imageSize(upload.data)).toEqual({ width: 1440, height: 8000 })
    expect((sent[1].body as { message_reference?: { message_id: string } }).message_reference).toEqual({ message_id: 'REAL-SELFTEST-2' })
    expect(sent[2].body.msg_type).toBe(2)
    expect(sent[2].body.markdown?.content.startsWith(`<qqbot-at-user id="${REAL_MEMBER}" />\n`)).toBe(true)
    expect((sent[2].body as { message_reference?: unknown }).message_reference).toEqual({ message_id: 'REAL-SELFTEST-2' })
    expect(sent[3].body.markdown?.content).toHaveLength(SELFTEST_LONG_CHARS)
  })
})
