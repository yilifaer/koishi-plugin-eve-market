// DataService：物品、工业、星图数据和黑话表的版本管理（§5.9）。
//
// 启动：模块级存储里的那份（插件重载前在用的）、缓存、插件自带快照里按 (buildNumber, dataRevision) 取新的，
//       相同时依次优先模块级存储、缓存；版本 key 和模块级存储里的一样就直接复用，不再解析。
// 在线：启动 DATA_FIRST_CHECK_SEC 秒后检查一次，之后每 DATA_REFRESH_HOURS 小时（带抖动）。
//       manifest 用条件请求；有新版本时三个文件一起下载，整份校验通过才写缓存、原子替换。
//       任何一步失败都继续用手上的版本，连续失败只写一条日志。
// 网址列表为空 = 只用插件自带的数据（不读缓存、不联网）。

import {
  DATA_FILES, DATA_FIRST_CHECK_SEC, DATA_REFRESH_HOURS, DATA_REFRESH_JITTER, PROJECT_URL, USE_GLOSSARY, USER_AGENT_PRODUCT,
} from '../../constants'
import type { CorePorts, HttpResponse } from '../ports'
import type { DataManifest, DataOrigin, DataService, DataSet, DataStatus, GlossaryData, RefreshResult } from '../types'
import { jitter } from '../util'
import type { Random } from '../util'
import {
  dataValidatorFor, emptyCheckState, glossaryValidatorFor, loadCheckState, saveCheckState,
} from './check-state'
import type { CheckState } from './check-state'
import { checkShrink, loadDataSet } from './dataset'
import type { DataFiles } from './dataset'
import { checkGlossarySize, parseGlossary } from './glossary'
import type { ParsedGlossary } from './glossary'
import { compareVersion, DataError, dataKey, describeVersion, parseManifest } from './shapes'
import {
  clearCachedData, dirOf, downloadFile, getConditional, hostOf, readBundledFiles, readBundledGlossary, readBundledManifest,
  readCachedFiles, readCachedGlossary, readCachedManifest, reasonOf, validatorOf, writeCachedData, writeCachedGlossary,
} from './source'
import type { Downloader } from './source'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
/** 模块级存储里的键 */
export const DATA_STORE_KEY = 'core/data'

export type DataPorts = Pick<CorePorts, 'http' | 'clock' | 'scheduler' | 'logger' | 'cache' | 'store' | 'bundledDataDir' | 'version'>

export interface DataServiceOptions {
  /** 按顺序尝试；空数组 = 只用插件自带的数据 */
  manifestUrls: readonly string[]
  glossaryUrls: readonly string[]
  /** 默认 USE_GLOSSARY */
  useGlossary?: boolean
  /** 抖动用，测试里固定 */
  random?: Random
}

export interface ManagedDataService extends DataService {
  /** 第一次有数据（快照、缓存或在线）时完成 */
  readonly ready: Promise<void>
  /** 读模块级存储、缓存或快照 → ready → 排定在线检查。重复调用返回同一个 Promise，不会失败 */
  start(): Promise<void>
  /** 取消定时器和进行中的下载 */
  stop(): void
}

export class DataNotReadyError extends Error {
  constructor() {
    super('物品数据还没加载好')
    this.name = 'DataNotReadyError'
  }
}

/** 插件重载后还在的部分 */
interface DataMemory {
  data: DataSet | null
  glossary: GlossaryData | null
  state: CheckState | null
  lastCheckAt: number | null
  dataError: string
  glossaryError: string
  /** 正在连续失败：只写第一条日志 */
  dataFailing: boolean
  glossaryFailing: boolean
  /** 已经写过日志的「数据格式不一致」提示 */
  schemaWarned: string
}

interface CheckOutcome<T> {
  /** 校验通过、要换上的新版本 */
  next?: T
  /** 拿到了在线的 manifest / 黑话表（含 304） */
  checked: boolean
  error?: string
  /** 数据格式和插件不一致（只写一次日志） */
  schema?: boolean
}

interface LocalCandidate {
  origin: DataOrigin
  manifest: DataManifest
  /** 已经建好的（模块级存储里的） */
  built?: DataSet
  files?: () => Promise<DataFiles>
}

const NOT_CHECKED: CheckOutcome<never> = { checked: false }

const ORIGIN_LABEL: Record<DataOrigin, string> = { online: '在线', cache: '缓存', bundled: '插件自带' }

export function createDataService(ports: DataPorts, options: DataServiceOptions): ManagedDataService {
  return new DataServiceImpl(ports, options)
}

class DataServiceImpl implements ManagedDataService {
  readonly ready: Promise<void>
  private resolveReady!: () => void
  private readonly memory: DataMemory
  private readonly listeners = new Set<(data: DataSet, glossary: GlossaryData | null) => void>()
  private readonly controllers = new Set<AbortController>()
  private readonly useGlossary: boolean
  private readonly random: Random
  private data: DataSet | null = null
  private gloss: GlossaryData | null = null
  /** 插件自带黑话表的可用词条数：新表至少要有它的一半 */
  private glossaryBaseline = 0
  private loading?: Promise<void>
  private inflight: Promise<RefreshResult> | null = null
  private cancelTimer?: () => void
  private stopped = false

  constructor(private readonly ports: DataPorts, private readonly options: DataServiceOptions) {
    this.ready = new Promise<void>((resolve) => { this.resolveReady = resolve })
    this.useGlossary = options.useGlossary ?? USE_GLOSSARY
    this.random = options.random ?? Math.random
    this.memory = ports.store.get<DataMemory>(DATA_STORE_KEY, () => ({
      data: null, glossary: null, state: null, lastCheckAt: null, dataError: '', glossaryError: '',
      dataFailing: false, glossaryFailing: false, schemaWarned: '',
    }))
  }

  // ---------------------------------------------------------------- 对外

  current(): DataSet {
    if (!this.data) throw new DataNotReadyError()
    return this.data
  }

  glossary(): GlossaryData | null {
    return this.gloss
  }

  onUpdate(listener: (data: DataSet, glossary: GlossaryData | null) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(): Promise<void> {
    this.loading ??= this.loadLocal().catch((e) => {
      this.ports.logger.error(`物品数据加载出错：${reasonOf(e)}`)
    })
    return this.loading
  }

  stop(): void {
    this.stopped = true
    this.cancelTimer?.()
    this.cancelTimer = undefined
    for (const controller of this.controllers) controller.abort()
  }

  refresh(): Promise<RefreshResult> {
    this.inflight ??= this.runRefresh().finally(() => { this.inflight = null })
    return this.inflight
  }

  status(): DataStatus {
    const d = this.data
    const state = this.memory.state ?? emptyCheckState()
    const g = this.gloss
    return {
      ready: !!d,
      origin: d?.origin ?? null,
      buildNumber: d?.manifest.buildNumber ?? null,
      dataRevision: d?.manifest.dataRevision ?? null,
      sdeReleaseDate: d?.manifest.sdeReleaseDate ?? null,
      generatedAt: d?.manifest.generatedAt ?? null,
      ageDays: d ? this.ageDays(d, state.data.confirmedAt) : null,
      lastCheckAt: this.memory.lastCheckAt,
      lastConfirmedAt: state.data.confirmedAt,
      lastError: this.memory.dataError,
      glossary: {
        origin: g?.origin ?? null,
        entries: g?.entries.length ?? 0,
        lastConfirmedAt: state.glossary.confirmedAt,
        lastError: this.memory.glossaryError,
      },
    }
  }

  // ---------------------------------------------------------------- 启动

  private get online(): boolean {
    return this.options.manifestUrls.length > 0
  }

  private get glossaryOnline(): boolean {
    return this.useGlossary && this.options.glossaryUrls.length > 0
  }

  private async state(): Promise<CheckState> {
    this.memory.state ??= await loadCheckState(this.ports.cache)
    return this.memory.state
  }

  private async loadLocal(): Promise<void> {
    await this.state()
    const data = await this.pickLocalData()
    const glossary = this.useGlossary ? await this.pickLocalGlossary() : null
    if (this.stopped) return
    if (glossary) this.setGlossary(glossary)
    if (data) {
      this.setData(data)
      this.ports.logger.info(`物品数据：${describeVersion(data.manifest)}，来自${ORIGIN_LABEL[data.origin]}`)
      this.emit()
    } else {
      this.ports.logger.error('没有可用的物品数据（插件自带的快照也读不了），等在线下载')
    }
    this.schedule(DATA_FIRST_CHECK_SEC * 1000)
  }

  private async localCandidates(): Promise<LocalCandidate[]> {
    const { cache, bundledDataDir } = this.ports
    const list: LocalCandidate[] = []
    const remembered = this.memory.data
    if (this.online) {
      if (remembered) list.push({ origin: remembered.origin, manifest: remembered.manifest, built: remembered })
      try {
        const manifest = await readCachedManifest(cache)
        if (manifest) list.push({ origin: 'cache', manifest, files: () => readCachedFiles(cache) })
      } catch (e) {
        this.ports.logger.warn(`缓存的物品数据不能用，已丢弃：${reasonOf(e)}`)
        await clearCachedData(cache).catch(() => undefined)
      }
    }
    try {
      const manifest = await readBundledManifest(bundledDataDir)
      list.push({ origin: 'bundled', manifest, files: () => readBundledFiles(bundledDataDir) })
    } catch (e) {
      this.ports.logger.error(`插件自带的物品数据读不了：${reasonOf(e)}`)
    }
    // 稳定排序：版本相同时保持上面的顺序（模块级存储 → 缓存 → 快照）
    return list.sort((a, b) => compareVersion(b.manifest, a.manifest))
  }

  private async pickLocalData(): Promise<DataSet | null> {
    const remembered = this.memory.data
    for (const candidate of await this.localCandidates()) {
      if (candidate.built) return candidate.built
      if (remembered && remembered.key === dataKey(candidate.manifest)) return remembered
      try {
        return loadDataSet(candidate.manifest, await candidate.files!(), candidate.origin, this.ports.clock.now())
      } catch (e) {
        this.ports.logger.warn(`${ORIGIN_LABEL[candidate.origin]}的物品数据不能用：${reasonOf(e)}`)
        if (candidate.origin === 'cache') await clearCachedData(this.ports.cache).catch(() => undefined)
      }
    }
    return null
  }

  /** 读一份本地的黑话表；没有返回 null，读不了或格式不对时写一条警告也返回 null */
  private async localGlossary(origin: DataOrigin, read: () => Promise<Buffer | null>): Promise<ParsedGlossary | null> {
    try {
      const body = await read()
      return body ? parseGlossary(body, origin, this.ports.clock.now()) : null
    } catch (e) {
      this.ports.logger.warn(`${ORIGIN_LABEL[origin]}的黑话表不能用：${reasonOf(e)}`)
      return null
    }
  }

  private async pickLocalGlossary(): Promise<GlossaryData | null> {
    const bundled = await this.localGlossary('bundled', () => readBundledGlossary(this.ports.bundledDataDir))
    this.glossaryBaseline = bundled?.data.entries.length ?? 0
    const remembered = this.memory.glossary
    const candidates: GlossaryData[] = []
    if (this.glossaryOnline) {
      if (remembered) candidates.push(remembered)
      const cached = await this.localGlossary('cache', () => readCachedGlossary(this.ports.cache))
      if (cached && this.bigEnough(cached.data)) candidates.push(cached.data)
    }
    if (bundled) candidates.push(bundled.data)
    const pick = candidates[0]
    if (!pick) return null
    return remembered && remembered.key === pick.key ? remembered : pick
  }

  private bigEnough(glossary: GlossaryData): boolean {
    try {
      checkGlossarySize(glossary.entries.length, this.glossaryBaseline)
      return true
    } catch (e) {
      this.ports.logger.warn(`${ORIGIN_LABEL[glossary.origin]}的黑话表不能用：${reasonOf(e)}`)
      return false
    }
  }

  // ---------------------------------------------------------------- 定时检查

  private schedule(ms: number) {
    if (this.stopped || !(this.online || this.glossaryOnline)) return
    this.cancelTimer?.()
    this.cancelTimer = this.ports.scheduler.timeout(() => {
      this.cancelTimer = undefined
      const next = () => this.schedule(jitter(DATA_REFRESH_HOURS * HOUR, DATA_REFRESH_JITTER, this.random))
      void this.refresh().then(next, next)
    }, ms)
  }

  private async runRefresh(): Promise<RefreshResult> {
    if (this.loading) await this.loading
    if (this.stopped) return { changed: false, glossaryChanged: false, checked: false, error: '已停止' }
    const controller = new AbortController()
    this.controllers.add(controller)
    try {
      const state = await this.state()
      const d: Downloader = { http: this.ports.http, userAgent: this.userAgent(), signal: controller.signal }
      const [data, glossary] = await Promise.all([
        this.guard(() => this.checkData(d, state)),
        this.glossaryOnline ? this.guard(() => this.checkGlossary(d, state)) : NOT_CHECKED,
      ])
      if (this.stopped) return { changed: false, glossaryChanged: false, checked: false, error: '已停止' }
      this.memory.lastCheckAt = this.ports.clock.now()
      this.noteData(data)
      this.noteGlossary(glossary)
      // 两样都检查完再一起换上、只通知一次
      if (data.next) this.setData(data.next)
      if (glossary.next) this.setGlossary(glossary.next)
      if (data.next || glossary.next) this.emit()
      await saveCheckState(this.ports.cache, state, { data: this.options.manifestUrls, glossary: this.options.glossaryUrls })
        .catch((e) => this.ports.logger.debug(`在线检查的记录没写进缓存：${reasonOf(e)}`))
      const error = data.error ?? (glossary.error ? `黑话表：${glossary.error}` : undefined)
      return { changed: !!data.next, glossaryChanged: !!glossary.next, checked: data.checked, ...error ? { error } : {} }
    } finally {
      this.controllers.delete(controller)
    }
  }

  /** 检查里任何没想到的异常都变成一条错误，不让定时检查断掉 */
  private async guard<T>(check: () => Promise<CheckOutcome<T>>): Promise<CheckOutcome<T>> {
    try {
      return await check()
    } catch (e) {
      return { checked: false, error: reasonOf(e) }
    }
  }

  private userAgent(): string {
    return `${USER_AGENT_PRODUCT}/${this.ports.version} (+${PROJECT_URL})`
  }

  // ---------------------------------------------------------------- 物品数据

  private async checkData(d: Downloader, state: CheckState): Promise<CheckOutcome<DataSet>> {
    const urls = this.options.manifestUrls
    if (!urls.length) return NOT_CHECKED
    const failures: string[] = []
    for (const url of urls) {
      let res: HttpResponse
      try {
        res = await getConditional(d, url, dataValidatorFor(state, url, this.data?.manifest))
      } catch (e) {
        if (d.signal.aborted) throw e
        failures.push(`${hostOf(url)} ${reasonOf(e)}`)
        continue
      }
      if (res.status === 304) return this.confirmData(state)
      if (res.status !== 200) {
        failures.push(`${hostOf(url)} HTTP ${res.status}`)
        continue
      }
      let manifest: DataManifest
      try {
        manifest = parseManifest(res.body, `${hostOf(url)} 的 manifest.json`)
      } catch (e) {
        if (e instanceof DataError && e.kind === 'schema') return { checked: true, error: e.message, schema: true }
        failures.push(reasonOf(e))
        continue
      }
      return this.useManifest(d, state, url, res, manifest)
    }
    return { checked: false, error: failures.join('；') }
  }

  /** 拿到了一份在线 manifest：不比手上的新就算确认最新；新就下载 */
  private async useManifest(d: Downloader, state: CheckState, url: string, res: HttpResponse, manifest: DataManifest): Promise<CheckOutcome<DataSet>> {
    const remember = () => {
      const v = validatorOf(res)
      if (v.etag || v.lastModified) state.data.validators[url] = { ...v, build: manifest.buildNumber, revision: manifest.dataRevision }
      else delete state.data.validators[url]
    }
    if (this.data && compareVersion(manifest, this.data.manifest) <= 0) {
      remember()
      return this.confirmData(state)
    }
    let next: DataSet
    try {
      next = await this.downloadVersion(d, url, manifest, res.body)
    } catch (e) {
      if (d.signal.aborted) throw e
      return { checked: true, error: `${describeVersion(manifest)} 没有更新成功：${reasonOf(e)}` }
    }
    remember()
    this.ports.logger.info(`物品数据已更新到 ${describeVersion(manifest)}`)
    return { ...this.confirmData(state), next }
  }

  private async downloadVersion(d: Downloader, url: string, manifest: DataManifest, manifestBody: Buffer): Promise<DataSet> {
    const dirs = [...new Set([dirOf(url), ...this.options.manifestUrls.map(dirOf)])]
    const files = {} as DataFiles
    for (const name of DATA_FILES) files[name] = await downloadFile(d, dirs, name, manifest.files[name])
    const next = loadDataSet(manifest, files, 'online', this.ports.clock.now())
    if (this.data) checkShrink(this.data, next)
    await writeCachedData(this.ports.cache, manifestBody, files)
      .catch((e) => this.ports.logger.warn(`新的物品数据没写进缓存（下次启动会重新下载）：${reasonOf(e)}`))
    return next
  }

  private confirmData(state: CheckState): CheckOutcome<never> {
    state.data.confirmedAt = this.ports.clock.now()
    return { checked: true }
  }

  private noteData(outcome: CheckOutcome<unknown>) {
    const { logger } = this.ports
    const m = this.memory
    if (outcome.schema) {
      m.dataError = outcome.error!
      if (m.schemaWarned !== outcome.error) logger.warn(`在线的物品数据格式和插件不一致，继续用手上的版本：${outcome.error}`)
      m.schemaWarned = outcome.error!
      return
    }
    if (outcome.error) {
      m.dataError = outcome.error
      if (m.dataFailing) logger.debug(`物品数据在线更新仍然失败：${outcome.error}`)
      else logger.warn(`物品数据在线更新失败，继续用手上的版本：${outcome.error}`)
      m.dataFailing = true
      return
    }
    if (!outcome.checked) return
    if (m.dataFailing) logger.info('物品数据在线检查恢复正常')
    m.dataFailing = false
    m.dataError = ''
  }

  // ---------------------------------------------------------------- 黑话表

  private async checkGlossary(d: Downloader, state: CheckState): Promise<CheckOutcome<GlossaryData>> {
    const failures: string[] = []
    for (const url of this.options.glossaryUrls) {
      let res: HttpResponse
      try {
        res = await getConditional(d, url, glossaryValidatorFor(state, url, this.gloss?.key))
      } catch (e) {
        if (d.signal.aborted) throw e
        failures.push(`${hostOf(url)} ${reasonOf(e)}`)
        continue
      }
      if (res.status === 304) return this.confirmGlossary(state)
      if (res.status !== 200) {
        failures.push(`${hostOf(url)} HTTP ${res.status}`)
        continue
      }
      let parsed: ParsedGlossary
      try {
        parsed = parseGlossary(res.body, 'online', this.ports.clock.now())
        checkGlossarySize(parsed.data.entries.length, this.glossaryBaseline)
      } catch (e) {
        failures.push(`${hostOf(url)} ${reasonOf(e)}`)
        continue
      }
      return this.useGlossaryBody(state, url, res, parsed.data)
    }
    return { checked: false, error: failures.join('；') }
  }

  private async useGlossaryBody(state: CheckState, url: string, res: HttpResponse, next: GlossaryData): Promise<CheckOutcome<GlossaryData>> {
    const v = validatorOf(res)
    if (v.etag || v.lastModified) state.glossary.validators[url] = { ...v, key: next.key }
    else delete state.glossary.validators[url]
    if (next.key === this.gloss?.key) return this.confirmGlossary(state)
    await writeCachedGlossary(this.ports.cache, res.body)
      .catch((e) => this.ports.logger.warn(`新的黑话表没写进缓存：${reasonOf(e)}`))
    this.ports.logger.info(`黑话表已更新：${next.entries.length} 条`)
    return { ...this.confirmGlossary(state), next }
  }

  private confirmGlossary(state: CheckState): CheckOutcome<never> {
    state.glossary.confirmedAt = this.ports.clock.now()
    return { checked: true }
  }

  private noteGlossary(outcome: CheckOutcome<unknown>) {
    const { logger } = this.ports
    const m = this.memory
    if (outcome.error) {
      m.glossaryError = outcome.error
      if (m.glossaryFailing) logger.debug(`黑话表在线更新仍然失败：${outcome.error}`)
      else logger.warn(`黑话表在线更新失败，继续用手上的版本：${outcome.error}`)
      m.glossaryFailing = true
      return
    }
    if (!outcome.checked) return
    if (m.glossaryFailing) logger.info('黑话表在线检查恢复正常')
    m.glossaryFailing = false
    m.glossaryError = ''
  }

  // ---------------------------------------------------------------- 替换与通知

  private setData(data: DataSet) {
    this.data = data
    this.memory.data = data
    this.resolveReady()
  }

  private setGlossary(glossary: GlossaryData) {
    this.gloss = glossary
    this.memory.glossary = glossary
  }

  private emit() {
    if (!this.data) return
    for (const listener of [...this.listeners]) {
      try {
        listener(this.data, this.gloss)
      } catch (e) {
        this.ports.logger.warn(`数据更新后的处理出错：${reasonOf(e)}`)
      }
    }
  }

  /**
   * 「N 天没更新」：按上次在线确认是最新的时间算（「实现后的更新」第 4 条，manifest 的 generatedAt 是内容上次变化的时间）；
   * 从来没确认过（例如只用自带数据）时按 generatedAt 算
   */
  private ageDays(data: DataSet, confirmedAt: number | null): number | null {
    const base = confirmedAt ?? Date.parse(data.manifest.generatedAt)
    if (!Number.isFinite(base)) return null
    return Math.max(0, Math.floor((this.ports.clock.now() - base) / DAY))
  }
}
