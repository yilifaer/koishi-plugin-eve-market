// 测试用的 HttpClient：直接用 node:http(s)，连本机的假服务。遵守 core 的端口约定：
// 非 2xx 不抛异常；网络错误、超时、超大小、被中止才抛 NetworkError。

import http from 'node:http'
import https from 'node:https'
import { NetworkError } from '../../src/core/ports'
import type { HttpClient, HttpRequest, HttpResponse } from '../../src/core/ports'

export class NodeHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = []

  request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req)
    return new Promise<HttpResponse>((resolve, reject) => {
      if (req.signal?.aborted) return reject(new NetworkError('aborted'))
      const url = new URL(req.url)
      const headers: Record<string, string | number> = { ...req.headers }
      if (req.body !== undefined) headers['Content-Length'] = Buffer.byteLength(req.body)
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        req.signal?.removeEventListener('abort', onAbort)
      }
      const fail = (error: NetworkError) => {
        if (settled) return
        settled = true
        cleanup()
        outgoing.destroy()
        reject(error)
      }
      const onAbort = () => fail(new NetworkError('aborted'))

      const outgoing = (url.protocol === 'https:' ? https : http).request(url, { method: req.method, headers }, (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (req.maxBytes && size > req.maxBytes) return fail(new NetworkError('too-large', `超过 ${req.maxBytes} 字节`))
          chunks.push(chunk)
        })
        res.on('error', (e) => fail(new NetworkError('network', e.message)))
        res.on('end', () => {
          if (settled) return
          settled = true
          cleanup()
          const raw = res.headers
          resolve({
            status: res.statusCode ?? 0,
            header: (name) => {
              const value = raw[name.toLowerCase()]
              return Array.isArray(value) ? value.join(', ') : value
            },
            body: Buffer.concat(chunks),
          })
        })
      })
      outgoing.on('error', (e) => fail(new NetworkError('network', e.message)))
      if (req.timeoutMs) timer = setTimeout(() => fail(new NetworkError('timeout', `${req.timeoutMs} 毫秒没有响应`)), req.timeoutMs)
      req.signal?.addEventListener('abort', onAbort, { once: true })
      outgoing.end(req.body)
    })
  }
}
