// 人物参数：纯数字 ID、zKill 人物链接、英文名；英文名 → ID（精确，或授权搜索的候选）。
// 链接的主机规则和 killmail/link.ts 一样严格：主机名必须正好是 zkillboard.com / www.zkillboard.com，只取出数字 ID，
// 用户给的网址本身永远不会被请求。

import { KB_CANDIDATES_MAX, KB_NAME_PATTERN, PILOT_ID_MAX_DIGITS } from '../../constants'
import { isEsiError } from '../esi'
import type { EsiApi } from '../esi'
import type { Logger } from '../ports'
import type { AuthService, CoreFailure, PilotArg, PilotRef, PilotResolution } from '../types'
import { describeError } from '../util'

const START = String.raw`(?<![\w.@:/-])(?:https?:\/\/)?`
const ZKILL_CHARACTER = new RegExp(`${START}(?:www\\.)?zkillboard\\.com\\/character\\/(\\d{1,${PILOT_ID_MAX_DIGITS}})(?!\\d)`, 'i')
const PLAIN_ID = new RegExp(`^\\d{1,${PILOT_ID_MAX_DIGITS}}$`)
/** 中文、日文假名、韩文：欧服人物名都是英文，这些一律不查 */
const NON_LATIN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** 一段文字里最靠前的 zKill 人物链接的人物 ID（@机器人 带链接自动出卡用）；没有时 null */
export function findPilotLink(text: string): number | null {
  const m = ZKILL_CHARACTER.exec(text)
  const id = m ? Number(m[1]) : 0
  return id > 0 ? id : null
}

/** 命令参数 → ID、名字或错误。只解析，不联网 */
export function parsePilotArg(input: string): PilotArg {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return { kind: 'error', error: 'empty' }
  if (PLAIN_ID.test(text)) {
    const id = Number(text)
    return id > 0 ? { kind: 'id', id, source: 'id' } : { kind: 'error', error: 'bad' }
  }
  const link = ZKILL_CHARACTER.exec(text)
  if (link && link.index === 0) {
    const rest = text.slice(link[0].length)
    const id = Number(link[1])
    if (id > 0 && (!rest || /^[/?#]\S*$/.test(rest))) return { kind: 'id', id, source: 'link' }
  }
  if (NON_LATIN.test(text)) return { kind: 'error', error: 'cjk' }
  return KB_NAME_PATTERN.test(text) ? { kind: 'name', name: text } : { kind: 'error', error: 'bad' }
}

function failure(code: CoreFailure['code'], message: string, extra: Partial<CoreFailure> = {}): CoreFailure {
  return { ok: false, code, message, ...extra }
}

export interface PilotResolverDeps {
  esi: Pick<EsiApi, 'ids' | 'names'>
  auth: Pick<AuthService, 'profiles' | 'searchCharacters'>
  logger: Logger
}

/** 候选的排序：名字以输入开头的在前，然后名字短的在前，最后按字母 */
export function sortCandidates(query: string, refs: PilotRef[]): PilotRef[] {
  const q = query.toLowerCase()
  const prefix = (r: PilotRef) => (r.name.toLowerCase().startsWith(q) ? 0 : 1)
  return [...refs].sort((a, b) => prefix(a) - prefix(b) || a.name.length - b.name.length || a.name.localeCompare(b.name) || a.id - b.id)
}

export class PilotResolver {
  constructor(private readonly deps: PilotResolverDeps) {}

  async resolve(name: string, opts: { deadlineMs?: number } = {}): Promise<PilotResolution | CoreFailure> {
    const arg = parsePilotArg(name)
    if (arg.kind === 'id') return failure('BAD_ARGUMENT', '应该是名字')
    if (arg.kind === 'error') return failure('BAD_ARGUMENT', '名字不对', { reason: arg.error === 'cjk' ? 'cjk-name' : 'bad-name' })
    const query = arg.name
    const { esi, auth, logger } = this.deps
    const call = opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs }
    try {
      const hits = (await esi.ids([query], 'en', call)).value.characters
      const exact = hits.find((h) => h.name.toLowerCase() === query.toLowerCase()) ?? hits[0]
      if (exact) return { id: exact.id, name: exact.name }
    } catch (e) {
      return this.esiFailure(e)
    }

    // 名字不完整：有可用的市场授权才能模糊搜索
    const profile = auth.profiles().find((p) => p.status === 'OK')
    if (!profile) return failure('PILOT_NOT_FOUND', '没有这个名字的人物，也没有做过市场授权没法模糊搜索', { reason: 'need-full-name' })
    const found = await auth.searchCharacters(profile.profile, query)
    if (!Array.isArray(found)) {
      // 档案不能用、没有搜索权限：和没授权一样请用户写完整
      if (found.code === 'NOT_CONFIGURED') return failure('PILOT_NOT_FOUND', found.message ?? '市场授权不能搜索', { reason: 'need-full-name' })
      return found
    }
    if (!found.length) return failure('PILOT_NOT_FOUND', '没有找到名字相近的人物')
    try {
      const names = (await esi.names(found.slice(0, 1000), call)).value
      const refs = names.filter((n) => n.category === 'character').map((n): PilotRef => ({ id: n.id, name: n.name }))
      if (!refs.length) return failure('PILOT_NOT_FOUND', '没有找到名字相近的人物')
      return { candidates: sortCandidates(query, refs).slice(0, KB_CANDIDATES_MAX) }
    } catch (e) {
      logger.debug('候选人物的名字查不到：%s', describeError(e))
      return this.esiFailure(e)
    }
  }

  private esiFailure(e: unknown): CoreFailure {
    if (isEsiError(e) && e.kind === 'deadline') return failure('DEADLINE', e.message)
    return failure('UPSTREAM_UNAVAILABLE', describeError(e))
  }
}
