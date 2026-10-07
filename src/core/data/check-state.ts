// 在线检查的记录：上次确认是最新的时间、每个网址的 ETag / Last-Modified。存进 BlobCache，重启后还在。
// 校验头只在「手上的版本不比记下它时的版本旧」时才发：否则 304 会把旧版本误当成最新（例如缓存坏了退回快照）。

import type { BlobCache } from '../ports'
import type { DataManifest } from '../types'
import { compareVersion, isObject } from './shapes'
import { CACHE_KEYS, readCachedJson } from './source'
import type { Validator } from './source'

export interface DataValidator extends Validator {
  build: number
  revision: number
}

export interface GlossaryValidator extends Validator {
  /** 当时那份黑话表的 key */
  key: string
}

export interface CheckState {
  data: { confirmedAt: number | null; validators: Record<string, DataValidator> }
  glossary: { confirmedAt: number | null; validators: Record<string, GlossaryValidator> }
}

export function emptyCheckState(): CheckState {
  return { data: { confirmedAt: null, validators: {} }, glossary: { confirmedAt: null, validators: {} } }
}

const optText = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const optTime = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function readValidator(raw: unknown): Validator | null {
  if (!isObject(raw)) return null
  const v: Validator = {}
  const etag = optText(raw.etag)
  const lastModified = optText(raw.lastModified)
  if (etag) v.etag = etag
  if (lastModified) v.lastModified = lastModified
  return etag || lastModified ? v : null
}

function readValidators<T extends Validator>(raw: unknown, extra: (o: Record<string, unknown>) => Omit<T, keyof Validator> | null): Record<string, T> {
  const out: Record<string, T> = {}
  if (!isObject(raw)) return out
  for (const [url, value] of Object.entries(raw)) {
    const base = readValidator(value)
    const more = isObject(value) ? extra(value) : null
    if (base && more) out[url] = { ...base, ...more } as T
  }
  return out
}

/** 读不到或写坏了都从空的开始 */
export async function loadCheckState(cache: BlobCache): Promise<CheckState> {
  const raw = await readCachedJson(cache, CACHE_KEYS.state).catch(() => null)
  const state = emptyCheckState()
  if (!raw) return state
  const data = isObject(raw.data) ? raw.data : {}
  const glossary = isObject(raw.glossary) ? raw.glossary : {}
  state.data.confirmedAt = optTime(data.confirmedAt)
  state.data.validators = readValidators<DataValidator>(data.validators, (o) =>
    Number.isInteger(o.build) && Number.isInteger(o.revision) ? { build: o.build as number, revision: o.revision as number } : null)
  state.glossary.confirmedAt = optTime(glossary.confirmedAt)
  state.glossary.validators = readValidators<GlossaryValidator>(glossary.validators, (o) =>
    typeof o.key === 'string' ? { key: o.key } : null)
  return state
}

/** 只留现在还在用的网址 */
export function saveCheckState(cache: BlobCache, state: CheckState, urls: { data: readonly string[]; glossary: readonly string[] }): Promise<void> {
  const pick = <T>(all: Record<string, T>, keep: readonly string[]) =>
    Object.fromEntries(Object.entries(all).filter(([url]) => keep.includes(url)))
  const out: CheckState = {
    data: { confirmedAt: state.data.confirmedAt, validators: pick(state.data.validators, urls.data) },
    glossary: { confirmedAt: state.glossary.confirmedAt, validators: pick(state.glossary.validators, urls.glossary) },
  }
  return cache.write(CACHE_KEYS.state, Buffer.from(JSON.stringify(out)), {})
}

/** 这个网址能不能发条件请求：手上的版本不比记下校验头时的旧 */
export function dataValidatorFor(state: CheckState, url: string, current: DataManifest | undefined): Validator | undefined {
  const v = state.data.validators[url]
  if (!v || !current) return undefined
  return compareVersion(current, { buildNumber: v.build, dataRevision: v.revision }) >= 0 ? v : undefined
}

export function glossaryValidatorFor(state: CheckState, url: string, currentKey: string | undefined): Validator | undefined {
  const v = state.glossary.validators[url]
  return v && v.key === currentKey ? v : undefined
}
