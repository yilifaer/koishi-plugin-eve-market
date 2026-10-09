// UniverseService：中英对照、星系信息、入侵、服务器状态（入侵和服务器状态没有接上时回复 NOT_CONFIGURED）。

import type { Clock, Logger, ModuleStore } from '../ports'
import type {
  CoreFailure, DataService, IncursionsResult, ItemResolver, ServerStatus, SystemView, TranslateResult, UniverseService,
} from '../types'
import type { IncursionsSource } from './incursions'
import { UniverseNames } from './names'
import type { NamesEsi } from './names'
import type { ServerStatusSource } from './status'
import { Translator } from './translate'

export interface UniverseServiceOptions {
  data: Pick<DataService, 'current' | 'glossary'>
  items: Pick<ItemResolver, 'resolve' | 'search' | 'aliasesOf'>
  store: ModuleStore
  clock: Clock
  /** 数据里没有的星图名字用 ESI 补；不给时只用数据 */
  esi?: NamesEsi
  logger?: Logger
  /** 默认 USE_GLOSSARY */
  useGlossary?: boolean
  /** 入侵（§2.9）；不给时回复 NOT_CONFIGURED */
  incursions?: Pick<IncursionsSource, 'get'>
  /** 服务器状态（§2.12）；不给时回复 NOT_CONFIGURED */
  status?: Pick<ServerStatusSource, 'get'>
}

export interface ManagedUniverseService extends UniverseService {
  /** 星域、星座、星系、势力的名字（入侵、建筑所在星系等处用） */
  readonly names: UniverseNames
}

function notYet(what: string): CoreFailure {
  return { ok: false, code: 'NOT_CONFIGURED', message: `${what}没有接上` }
}

class Service implements ManagedUniverseService {
  readonly names: UniverseNames
  private readonly translator: Translator

  constructor(private readonly o: UniverseServiceOptions) {
    this.names = new UniverseNames({ data: o.data, clock: o.clock, esi: o.esi, logger: o.logger })
    this.translator = new Translator({ data: o.data, items: o.items, store: o.store, useGlossary: o.useGlossary })
  }

  async incursions(): Promise<IncursionsResult | CoreFailure> {
    return this.o.incursions ? this.o.incursions.get() : notYet('入侵')
  }

  async serverStatus(): Promise<ServerStatus | CoreFailure> {
    return this.o.status ? this.o.status.get() : notYet('服务器状态')
  }

  translate(q: string, limit: number): TranslateResult {
    return this.translator.translate(q, limit)
  }

  system(id: number): SystemView | undefined {
    return this.names.system(id)
  }
}

export function createUniverseService(options: UniverseServiceOptions): ManagedUniverseService {
  return new Service(options)
}
