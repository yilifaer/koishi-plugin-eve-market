// 人物卡用的图片：头像、军团 / 联盟图标、舰船渲染图。只从图片主机（EVE_IMAGE_BASE）下载，由插件下载后转成 data: 地址
// （出图的浏览器禁网）。文件头必须是 PNG / JPEG，大小、超时、并发都有上限；失败给 null，不影响出图。

import {
  EVE_IMAGE_BASE,
  KB_IMAGES_DEADLINE_MS,
  KB_IMAGE_CACHE_DAYS,
  KB_IMAGE_CACHE_MAX,
  KB_IMAGE_CONCURRENCY,
  KB_IMAGE_FAILURE_SEC,
  KB_IMAGE_MAX_BYTES,
  KB_IMAGE_TIMEOUT_MS,
  KB_LOGO_SIZE,
  KB_PORTRAIT_CACHE_HOURS,
  KB_PORTRAIT_SIZE,
  KB_SHIP_RENDER_SIZE,
} from '../../constants'
import { NetworkError } from '../ports'
import type { Clock, HttpClient, Logger, Scheduler } from '../ports'
import type { PilotImageService, PilotImageSet, PilotProfile } from '../types'
import { LruCache, Pool, SingleFlight, describeError, sniffImage, withDeadline } from '../util'

export interface PilotImagesDeps {
  http: HttpClient
  clock: Clock
  scheduler: Scheduler
  logger: Logger
  /** 和 ESI 用同一个 User-Agent */
  userAgent: string
  /** 测试指向本机的假图片服务 */
  base?: string
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

function validId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0
}

export class PilotImages implements PilotImageService {
  private readonly base: string
  private readonly pool = new Pool(KB_IMAGE_CONCURRENCY)
  private readonly flights = new SingleFlight<string, string | null>()
  /** 成功的是 data: 地址，失败的是 null（只记 KB_IMAGE_FAILURE_SEC 秒） */
  private readonly cache: LruCache<string, string | null>
  private warned = false

  constructor(private readonly deps: PilotImagesDeps) {
    this.base = (deps.base ?? EVE_IMAGE_BASE).replace(/\/+$/, '')
    this.cache = new LruCache({ max: KB_IMAGE_CACHE_MAX, now: () => deps.clock.now() })
  }

  portrait(characterId: number): Promise<string | null> {
    return this.fetch(`characters/${characterId}/portrait?size=${KB_PORTRAIT_SIZE}`, characterId, KB_PORTRAIT_CACHE_HOURS * HOUR_MS)
  }

  corporationLogo(corporationId: number): Promise<string | null> {
    return this.fetch(`corporations/${corporationId}/logo?size=${KB_LOGO_SIZE}`, corporationId, KB_IMAGE_CACHE_DAYS * DAY_MS)
  }

  allianceLogo(allianceId: number): Promise<string | null> {
    return this.fetch(`alliances/${allianceId}/logo?size=${KB_LOGO_SIZE}`, allianceId, KB_IMAGE_CACHE_DAYS * DAY_MS)
  }

  shipRender(typeId: number): Promise<string | null> {
    return this.fetch(`types/${typeId}/render?size=${KB_SHIP_RENDER_SIZE}`, typeId, KB_IMAGE_CACHE_DAYS * DAY_MS)
  }

  async forProfile(profile: PilotProfile, opts: { deadlineMs?: number } = {}): Promise<PilotImageSet> {
    const set: PilotImageSet = { portrait: null, corporation: null, alliance: null, ships: {} }
    const shipIds = [...new Set([
      ...profile.ships.map((s) => s.typeId),
      ...[profile.recentKill, profile.recentLoss].flatMap((k) => (k?.ship ? [k.ship.typeId] : [])),
    ])]
    const jobs: Array<Promise<void>> = [
      this.portrait(profile.id).then((v) => void (set.portrait = v)),
      ...(profile.corporation ? [this.corporationLogo(profile.corporation.id).then((v) => void (set.corporation = v))] : []),
      ...(profile.alliance ? [this.allianceLogo(profile.alliance.id).then((v) => void (set.alliance = v))] : []),
      ...shipIds.map((id) => this.shipRender(id).then((v) => void (set.ships[id] = v))),
    ]
    // 到时间没下完的留 null（下载在后台继续，写进缓存）；set 是引用，到时间时已完成的已经填好
    await withDeadline(Promise.all(jobs), opts.deadlineMs ?? KB_IMAGES_DEADLINE_MS, this.deps.scheduler)
    for (const id of shipIds) set.ships[id] ??= null
    return set
  }

  /** path 是主机之后的固定写法，id 只能是正整数（调用方传进来的数字不拼进别的地方） */
  private fetch(path: string, id: number, ttlMs: number): Promise<string | null> {
    if (!validId(id)) return Promise.resolve(null)
    const key = path
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key) ?? null)
    return this.flights.run(key, async () => {
      const data = await this.pool.run(() => this.download(path))
      if (data) this.cache.set(key, data, ttlMs)
      else this.cache.set(key, null, KB_IMAGE_FAILURE_SEC * 1000)
      return data
    })
  }

  private async download(path: string): Promise<string | null> {
    const { http } = this.deps
    try {
      const res = await http.request({
        method: 'GET',
        url: `${this.base}/${path}`,
        headers: { 'User-Agent': this.deps.userAgent, Accept: 'image/png,image/jpeg' },
        timeoutMs: KB_IMAGE_TIMEOUT_MS,
        maxBytes: KB_IMAGE_MAX_BYTES,
        // 不跟随跳转：3xx 不是 200，按失败处理
        redirect: 'manual',
      })
      if (res.status !== 200 || !res.body.length || res.body.length > KB_IMAGE_MAX_BYTES) return this.failed(path, `HTTP ${res.status}`)
      // 只信文件头，不信响应头
      const mime = sniffImage(res.body)
      if (!mime) return this.failed(path, '不是 PNG / JPEG')
      this.warned = false
      return `data:${mime};base64,${res.body.toString('base64')}`
    } catch (e) {
      if (e instanceof NetworkError && e.kind === 'aborted') return null
      return this.failed(path, describeError(e))
    }
  }

  /** 图片主机连不上只告警一次，之后写调试日志 */
  private failed(path: string, why: string): null {
    const text = `图片 ${path.split('?')[0]} 下载失败：${why}`
    if (this.warned) this.deps.logger.debug(text)
    else {
      this.warned = true
      this.deps.logger.warn(text)
    }
    return null
  }
}
