// core/pilot 对外的接口：KB 人物卡的资料（ESI + zKill）、人物参数解析、人设文案、图片下载。

import type { EsiApi } from '../esi'
import type { Clock, HttpClient, Logger, Scheduler } from '../ports'
import type { AuthService, CoreFailure, ItemInfo, PilotOptions, PilotProfile, PilotService, PriceFormatter, SystemView } from '../types'
import type { ZkillClient } from '../zkill'
import { PilotImages } from './images'
import { PilotProfiles } from './profile'
import { PilotResolver, parsePilotArg } from './resolve'

export { cleanTitle } from './clean'
export { PilotImages } from './images'
export type { PilotImagesDeps } from './images'
export { PERSONA_RULES, composeCopy, fillTemplate, hash32, pickMood, pickPersona } from './persona'
export type { CopyValues, MoodInput, PersonaInput } from './persona'
export { ACTIVITY_TEXT, BIRTHPLACE_TEXT, FOOTER_TEXT, MOOD_TEXT, PERSONA_COPY, ZONE_NAMES } from './persona-text'
export type { PersonaCopy } from './persona-text'
export { PilotProfiles } from './profile'
export type { PilotProfileDeps } from './profile'
export { PilotResolver, findPilotLink, parsePilotArg, sortCandidates } from './resolve'

export interface PilotServiceDeps {
  esi: EsiApi
  zkill: ZkillClient
  items: { byId(id: number): ItemInfo | undefined }
  universe: { system(id: number): SystemView | undefined }
  auth: Pick<AuthService, 'profiles' | 'searchCharacters'>
  format: Pick<PriceFormatter, 'compact'>
  http: HttpClient
  clock: Clock
  scheduler: Scheduler
  logger: Logger
  /** 图片主机，测试指向本机的假服务 */
  imageBase?: string
  recentDeadlineMs?: number
  birthplaceWaitMs?: number
}

export function createPilotService(deps: PilotServiceDeps): PilotService {
  const profiles = new PilotProfiles(deps)
  const resolver = new PilotResolver(deps)
  const images = new PilotImages({
    http: deps.http,
    clock: deps.clock,
    scheduler: deps.scheduler,
    logger: deps.logger,
    userAgent: deps.esi.client.userAgent,
    base: deps.imageBase,
  })
  return {
    parse: parsePilotArg,
    resolve: (name: string, opts?: { deadlineMs?: number }) => resolver.resolve(name, opts),
    profile: (id: number, opts?: PilotOptions): Promise<PilotProfile | CoreFailure> => profiles.profile(id, opts),
    images,
  }
}
