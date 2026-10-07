// 本机的假 QQ 开放平台（群聊和单聊的 v2 接口），给真实的 @satorijs/adapter-qq 用。
// 只做测试需要的部分：发消息、上传富媒体、/users/@me；按平台规则拒绝同一条消息的第 6 条（单聊第 5 条）被动回复
// 和重复的 msg_seq；可以注入故障。所有 ID 和名字都是编造的。

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const APP_ID = '102000001'
export const ACCESS_TOKEN = 'fake-access-token-0001'
export const BOT_USER_ID = '9000000000000000001'

/** 平台错误码（和 src/constants.ts 的 QQ_ERROR 对应；重复 msg_seq 的码是这里自己定的） */
export const FAKE_CODE = {
  REPLY_LIMIT: 40034128,
  DUPLICATE_SEQ: 40054005,
  UNAUTHORIZED: 11244,
} as const

export interface QQRequest {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  /** 发消息、上传富媒体时的请求体；GET 时是 null */
  json: QQRequestBody | null
}

export interface QQKeyboardButton {
  id: string
  render_data: { label: string; visited_label: string; style: number }
  action: { type: number; permission: { type: number }; data: string }
}

export interface QQMessageBody {
  content?: string
  msg_type: number
  msg_id?: string
  msg_seq?: number
  event_id?: string
  markdown?: { content: string }
  keyboard?: { content: { rows: Array<{ buttons: QQKeyboardButton[] }> } }
  media?: { file_info: string }
}

export type QQRequestBody = Partial<QQMessageBody> & { file_type?: number; file_data?: string }

export interface QQSentMessage {
  id: string
  scope: 'group' | 'user'
  openid: string
  body: QQMessageBody
}

export interface QQUpload {
  scope: 'group' | 'user'
  openid: string
  fileType: number
  /** base64 解码后的字节 */
  data: Buffer
  fileInfo: string
}

export interface Fault {
  status?: number
  code?: number
  message?: string
  /** 直接断开连接（网络错误） */
  destroy?: boolean
}

interface FaultRule {
  method: string
  pattern: RegExp
  when?: (req: QQRequest) => boolean
  fault: Fault
  times: number
}

const MESSAGE_PATH = /^\/v2\/(groups|users)\/([^/]+)\/messages$/
const FILE_PATH = /^\/v2\/(groups|users)\/([^/]+)\/files$/

export class FakeQQOpenApi {
  server!: http.Server
  base = ''
  requests: QQRequest[] = []
  /** 平台接受了的消息 */
  messages: QQSentMessage[] = []
  uploads: QQUpload[] = []
  /** 每条被动回复的 msg_id 用过的 msg_seq */
  private seqs = new Map<string, Set<number>>()
  private faults: FaultRule[] = []
  private nextId = 1

  /** 匹配的请求返回错误；when 可以按请求内容再筛一次 */
  fault(pattern: RegExp, fault: Fault, options: { method?: string; times?: number; when?: (req: QQRequest) => boolean } = {}) {
    this.faults.push({ method: options.method ?? 'POST', pattern, when: options.when, fault, times: options.times ?? 1 })
  }

  /** 发消息的请求（含被拒绝的），按顺序 */
  get sends(): QQRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && MESSAGE_PATH.test(r.path))
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks)))
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer) {
    const url = new URL(req.url ?? '/', this.base)
    const text = raw.toString('utf8')
    const request: QQRequest = { method: req.method ?? 'GET', path: url.pathname, headers: req.headers, json: text ? JSON.parse(text) as QQRequestBody : null }
    this.requests.push(request)
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }

    if (req.headers.authorization !== `QQBot ${ACCESS_TOKEN}` || req.headers['x-union-appid'] !== APP_ID) {
      return send(401, { code: FAKE_CODE.UNAUTHORIZED, message: 'token invalid' })
    }
    const rule = this.faults.find((f) => f.method === request.method && f.pattern.test(request.path) && (!f.when || f.when(request)))
    if (rule) {
      if (--rule.times <= 0) this.faults.splice(this.faults.indexOf(rule), 1)
      if (rule.fault.destroy) return req.socket.destroy()
      return send(rule.fault.status ?? 400, { code: rule.fault.code ?? 0, message: rule.fault.message ?? 'error' })
    }

    let m: RegExpExecArray | null
    if (request.method === 'GET' && request.path === '/users/@me') return send(200, { id: BOT_USER_ID, username: 'eve-market-test' })
    if (request.method === 'POST' && (m = MESSAGE_PATH.exec(request.path))) {
      return this.message(m[1] === 'groups' ? 'group' : 'user', m[2], request.json as QQMessageBody, send)
    }
    if (request.method === 'POST' && (m = FILE_PATH.exec(request.path))) {
      const fileInfo = `FILEINFO-${this.nextId++}`
      const body = request.json ?? {}
      this.uploads.push({
        scope: m[1] === 'groups' ? 'group' : 'user',
        openid: m[2],
        fileType: body.file_type ?? 0,
        data: Buffer.from(String(body.file_data ?? ''), 'base64'),
        fileInfo,
      })
      return send(200, { file_uuid: `uuid-${fileInfo}`, file_info: fileInfo, ttl: 3600 })
    }
    return send(404, { code: 0, message: 'not found' })
  }

  private message(scope: 'group' | 'user', openid: string, body: QQMessageBody, send: (status: number, body: unknown) => void) {
    if (body.msg_id) {
      const used = this.seqs.get(body.msg_id) ?? new Set<number>()
      if (used.has(body.msg_seq ?? 0)) return send(400, { code: FAKE_CODE.DUPLICATE_SEQ, message: '消息被去重，请检查请求msgseq' })
      const limit = scope === 'group' ? 5 : 4
      const replied = this.messages.filter((m) => m.body.msg_id === body.msg_id).length
      if (replied >= limit) return send(400, { code: FAKE_CODE.REPLY_LIMIT, message: '超过被动回复次数' })
      used.add(body.msg_seq ?? 0)
      this.seqs.set(body.msg_id, used)
    }
    const id = `ROBOT1.0_fake${this.nextId++}`
    this.messages.push({ id, scope, openid, body })
    send(200, { id, timestamp: new Date().toISOString() })
  }
}
