// 本机的假图片服务（images.evetech.net 的替身）：真实的 HTTP 服务，测试把 imageBase 指过来。
// 返回 1×1 的 PNG / JPEG；可以注入 HTML（应被拒）、超大文件、404、卡住的请求；记录收到的路径和同时在处理的请求数。

import http from 'node:http'
import type { AddressInfo } from 'node:net'

/** 1×1 透明 PNG */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
/** 文件头是 JPEG 就够了（只看文件头） */
export const JPEG_STUB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0fake-jpeg-body'), Buffer.from([0xff, 0xd9])])

export type ImageFault = 'html' | 'huge' | 'not-found' | 'hang' | 'text-as-png'

export class FakeImages {
  server!: http.Server
  base = ''
  readonly requests: Array<{ path: string; userAgent: string | undefined }> = []
  /** 路径（含查询）匹配 → 故障 */
  faults: Array<{ pattern: RegExp; fault: ImageFault }> = []
  /** 回应前多等几毫秒（看并发用） */
  delayMs = 0
  inFlight = 0
  peakInFlight = 0
  private held: http.ServerResponse[] = []

  async start() {
    this.server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  stop() {
    this.held.splice(0).forEach((r) => r.destroy())
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  count(pattern: RegExp) {
    return this.requests.filter((r) => pattern.test(r.path)).length
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = req.url ?? ''
    this.requests.push({ path, userAgent: req.headers['user-agent'] })
    this.inFlight++
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight)
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
      const fault = this.faults.find((f) => f.pattern.test(path))?.fault
      switch (fault) {
        case 'hang':
          this.held.push(res)
          return
        case 'not-found':
          res.statusCode = 404
          return void res.end('Not found')
        case 'html':
          res.setHeader('Content-Type', 'image/png')
          return void res.end('<!DOCTYPE html><html><body>captive portal</body></html>')
        case 'text-as-png':
          res.setHeader('Content-Type', 'image/png')
          return void res.end('this is not an image')
        case 'huge':
          res.setHeader('Content-Type', 'image/png')
          return void res.end(Buffer.concat([PNG_1X1.subarray(0, 8), Buffer.alloc(2 * 1024 * 1024)]))
      }
      // 头像是 JPEG，其他是 PNG（和真实服务一致）
      const jpeg = /\/portrait/.test(path)
      res.setHeader('Content-Type', jpeg ? 'image/jpeg' : 'image/png')
      res.end(jpeg ? JPEG_STUB : PNG_1X1)
    } finally {
      this.inFlight--
    }
  }
}
