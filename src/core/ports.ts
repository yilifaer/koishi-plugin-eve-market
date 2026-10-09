// core 的全部外部依赖。由 bot 层（Koishi）实现，测试里用假的实现。
// core 里不直接用 setTimeout、Date.now()、process.env，也不 import koishi。

export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  /** 调用方自己序列化（JSON / x-www-form-urlencoded） */
  body?: string
  timeoutMs?: number
  /** 响应体超过这个字节数时中止并抛 NetworkError('too-large') */
  maxBytes?: number
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  /** 名字不区分大小写；没有这个头时返回 undefined */
  header(name: string): string | undefined
  body: Buffer
}

/** 非 2xx 不抛异常；只有网络错误、超时、超大小、被中止才抛 NetworkError */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>
}

export type NetworkErrorKind = 'network' | 'timeout' | 'too-large' | 'aborted'

export class NetworkError extends Error {
  readonly kind: NetworkErrorKind

  constructor(kind: NetworkErrorKind, message?: string, options?: { cause?: unknown }) {
    super(message ?? kind, options)
    this.name = 'NetworkError'
    this.kind = kind
  }
}

export interface Clock {
  now(): number
}

export interface Scheduler {
  /** 返回取消函数。插件停用时 bot 层负责清掉所有还没触发的定时器 */
  timeout(fn: () => void, ms: number): () => void
}

export interface Logger {
  debug(...a: unknown[]): void
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
  error(...a: unknown[]): void
}

/**
 * BlobCache 的键：用 `/` 分隔的相对路径，每段只能有字母、数字和 `. _ -`，不能以 `.` 开头，
 * 例如 `data/types.json`、`structures/1000000000001/page-3`。实现方只接受符合这个格式的键。
 */
export const BLOB_KEY_PATTERN = /^(?!\.)[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/(?!\.)[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/

/** <实例>/data/eve-market/cache 下的原子文件缓存（先写临时文件再改名） */
export interface BlobCache {
  read(key: string): Promise<{ body: Buffer; meta: Record<string, unknown> } | null>
  write(key: string, body: Buffer, meta: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

/** AES-256-GCM。密文格式 `v1:<keyId>:<iv>:<tag>:<data>`（base64url）；keyId 对不上或密文被改过时 open() 抛错 */
export interface SecretBox {
  readonly keyId: string
  seal(plain: string): string
  open(sealed: string): string
}

export type AuthStatus = 'NEEDS_AUTH' | 'OK' | 'DEGRADED' | 'AUTH_ERROR'

export interface AuthRecord {
  profile: string
  characterId: string
  characterName: string
  /** JWT 的 owner；角色转手后会变 */
  ownerHash: string
  scopes: string[]
  /** 密文（SecretBox.seal 的结果） */
  refreshToken: string
  keyId: string
  status: AuthStatus
  /** 只写原因，不写 token */
  lastError: string
  lastErrorAt: number | null
  lastRefreshAt: number | null
  lastSuccessAt: number | null
  authorizedAt: number | null
}

export interface AuthStore {
  list(): Promise<AuthRecord[]>
  get(profile: string): Promise<AuthRecord | undefined>
  upsert(rec: AuthRecord): Promise<void>
  remove(profile: string): Promise<void>
}

/**
 * 模块级存储：控制台保存配置（插件重载）后还在，重启 Koishi 才丢。放数据集和索引、ESI 响应缓存、
 * 限流和错误额度的暂停窗口、估价编号。bot 在模块顶层建一个；测试每次新建，互不影响。
 */
export interface ModuleStore {
  /** 没有时用 create() 建一个放进去；同一个 key 总是返回同一个对象 */
  get<T>(key: string, create: () => T): T
}

export function createModuleStore(): ModuleStore {
  const values = new Map<string, unknown>()
  return {
    get<T>(key: string, create: () => T): T {
      if (!values.has(key)) values.set(key, create())
      return values.get(key) as T
    },
  }
}

export interface CorePorts {
  http: HttpClient
  clock: Clock
  scheduler: Scheduler
  logger: Logger
  cache: BlobCache
  auth: AuthStore
  secrets: SecretBox
  store: ModuleStore
  /** 随插件发布的数据快照目录（包里的 data/） */
  bundledDataDir: string
  /** 插件版本，写进 User-Agent */
  version: string
  /**
   * EVE SSO 的换 token、刷新、撤销用：插件停用时不中止（刷新请求发出去以后 SSO 可能已经换了 refresh token，
   * 半路放弃就丢了新的）。不写 = http
   */
  ssoHttp?: HttpClient
}
