// 截图网络守卫：用假页面和假请求测每条规则（第一个主框架请求放行、跳转只能去名单内、子资源不能打内网）。

import { describe, expect, it } from 'vitest'
import { installNetGuard } from '../../src/render/net-guard'
import type { PageRequest, RenderPage } from '../../src/render/renderer'

const MAIN = { name: 'main' }
const CHILD = { name: 'child' }

interface FakeReq extends PageRequest {
  actions: string[]
}

function req(url: string, opts: { nav?: boolean; frame?: unknown; type?: string; handled?: boolean; throws?: boolean } = {}): FakeReq {
  const actions: string[] = []
  const act = (name: string) => async () => {
    if (opts.throws) throw new Error('Target closed')
    actions.push(name)
  }
  return {
    actions,
    url: () => url,
    abort: async (code?: string) => act(`abort:${code ?? ''}`)(),
    continue: act('continue'),
    isInterceptResolutionHandled: () => opts.handled === true,
    isNavigationRequest: () => opts.nav === true,
    frame: () => opts.frame ?? MAIN,
    resourceType: () => opts.type ?? (opts.nav ? 'document' : 'image'),
  }
}

async function setup(allowHosts = ['janice.example.com', 'br.example.com']) {
  let handler: ((request: PageRequest) => void) | undefined
  let intercept = false
  const page = {
    setRequestInterception: async (on: boolean) => { intercept = on },
    on: (_event: 'request', h: (request: PageRequest) => void) => { handler = h },
    mainFrame: () => MAIN,
  } as unknown as RenderPage
  const guard = await installNetGuard(page, { allowHosts })
  const send = async (r: FakeReq) => {
    handler!(r)
    await new Promise<void>((resolve) => setImmediate(resolve))
    return r.actions
  }
  return { guard, send, intercepted: () => intercept }
}

describe('installNetGuard', () => {
  it('turns on request interception', async () => {
    expect((await setup()).intercepted()).toBe(true)
  })

  it('lets the first main-frame navigation through, even to a host outside the list', async () => {
    const { send, guard } = await setup()
    expect(await send(req('http://127.0.0.1:9/br/1', { nav: true }))).toEqual(['continue'])
    expect(guard.stats).toEqual({ blockedRedirects: 0, blockedPrivate: 0, closedPopups: 0 })
  })

  it('blocks a later main-frame navigation outside the list or not https', async () => {
    const { send, guard } = await setup()
    await send(req('https://br.example.com/br/1', { nav: true }))
    expect(await send(req('https://evil.example.net/', { nav: true }))).toEqual(['abort:blockedbyclient'])
    expect(await send(req('http://br.example.com/', { nav: true }))).toEqual(['abort:blockedbyclient'])
    expect(await send(req('https://br.example.com.evil.net/', { nav: true }))).toEqual(['abort:blockedbyclient'])
    expect(guard.stats.blockedRedirects).toBe(3)
  })

  it('lets a later navigation to a listed host or its subdomain through', async () => {
    const { send, guard } = await setup()
    await send(req('https://br.example.com/br/1', { nav: true }))
    expect(await send(req('https://janice.example.com/a/x', { nav: true }))).toEqual(['continue'])
    expect(await send(req('https://www.br.example.com/x', { nav: true }))).toEqual(['continue'])
    expect(guard.stats.blockedRedirects).toBe(0)
  })

  it('treats a document request without frame info as a main-frame navigation', async () => {
    const { send, guard } = await setup()
    const bare = (url: string): FakeReq => {
      const r = req(url, { nav: true, type: 'document' })
      delete r.frame
      return r
    }
    await send(bare('https://br.example.com/'))
    expect(await send(bare('https://evil.example.net/'))).toEqual(['abort:blockedbyclient'])
    expect(guard.stats.blockedRedirects).toBe(1)
  })

  it('does not count sub-frame navigations as redirects (only the private-network rule applies)', async () => {
    const { send, guard } = await setup()
    await send(req('https://br.example.com/', { nav: true }))
    expect(await send(req('https://ads.example.net/frame', { nav: true, frame: CHILD }))).toEqual(['continue'])
    expect(await send(req('http://10.0.0.5/frame', { nav: true, frame: CHILD }))).toEqual(['abort:blockedbyclient'])
    expect(guard.stats).toEqual({ blockedRedirects: 0, blockedPrivate: 1, closedPopups: 0 })
  })

  it('blocks sub-resources to local and private addresses and counts them', async () => {
    const { send, guard } = await setup()
    await send(req('https://br.example.com/', { nav: true }))
    for (const url of [
      'http://127.0.0.1:8080/x.png', 'http://10.1.2.3/x', 'http://localhost/x', 'http://intranet/x', 'http://[::1]/x',
      'http://192.168.0.1/x', 'http://169.254.169.254/latest', 'http://[::ffff:127.0.0.1]/x', 'http://100.64.0.1/x', 'http://x.local/x',
      'ws://127.0.0.1:5140/x',
    ]) {
      expect(await send(req(url)), url).toEqual(['abort:blockedbyclient'])
    }
    expect(guard.stats.blockedPrivate).toBe(11)
    expect(guard.stats.blockedRedirects).toBe(0)
  })

  it('lets public sub-resources, fake-ip range, data: and blob: through', async () => {
    const { send, guard } = await setup()
    await send(req('https://br.example.com/', { nav: true }))
    for (const url of ['https://cdn.example.net/a.js', 'http://93.184.216.34/x', 'http://198.18.0.1/x', 'data:image/png;base64,AAAA', 'blob:https://br.example.com/1']) {
      expect(await send(req(url)), url).toEqual(['continue'])
    }
    expect(guard.stats).toEqual({ blockedRedirects: 0, blockedPrivate: 0, closedPopups: 0 })
  })

  it('aborts other protocols and unparsable urls', async () => {
    const { send } = await setup()
    await send(req('https://br.example.com/', { nav: true }))
    expect(await send(req('file:///etc/passwd'))).toEqual(['abort:blockedbyclient'])
    expect(await send(req('not a url'))).toEqual(['abort:blockedbyclient'])
  })

  it('leaves requests that were already handled alone', async () => {
    const { send } = await setup()
    expect(await send(req('http://127.0.0.1/x', { handled: true }))).toEqual([])
  })

  it('ignores errors from a page that has already closed', async () => {
    const { send } = await setup()
    await send(req('https://br.example.com/', { nav: true }))
    expect(await send(req('https://cdn.example.net/a.js', { throws: true }))).toEqual([])
    expect(await send(req('http://127.0.0.1/x', { throws: true }))).toEqual([])
  })

  it('closes a popup and counts it as a closed popup, not a redirect', async () => {
    let popupHandler: ((popup: { close(): Promise<void> } | null) => void) | undefined
    const page = {
      setRequestInterception: async () => undefined,
      on: () => undefined,
      onPopup: (h: typeof popupHandler) => { popupHandler = h },
      mainFrame: () => MAIN,
    } as unknown as RenderPage
    const guard = await installNetGuard(page, { allowHosts: ['br.example.com'] })
    let closed = 0
    popupHandler!({ close: async () => { closed++ } })
    popupHandler!(null)
    expect(closed).toBe(1)
    expect(guard.stats).toMatchObject({ blockedRedirects: 0, closedPopups: 2 })
  })
})
