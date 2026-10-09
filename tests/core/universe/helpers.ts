// core/universe 测试共用：小数据集（含黑话表）上的物品识别器和中英对照。

import { createModuleStore } from '../../../src/core/ports'
import { createUniverseService } from '../../../src/core/universe'
import type { NamesEsi, UniverseServiceOptions } from '../../../src/core/universe'
import type { DataService, GlossaryData, ItemAliasSetting, TranslateEntry } from '../../../src/core/types'
import { loadFixtureData, loadFixtureGlossary, staticDataService } from '../../fixtures/data/load'
import { fixtureResolver, ManualClock } from '../items/helpers'

export interface UniverseSetup {
  glossary?: GlossaryData | null
  aliases?: ItemAliasSetting[]
  esi?: NamesEsi
  data?: Pick<DataService, 'current' | 'glossary'>
  useGlossary?: boolean
  incursions?: UniverseServiceOptions['incursions']
  status?: UniverseServiceOptions['status']
}

export function universe(setup: UniverseSetup = {}) {
  const glossary = setup.glossary === undefined ? loadFixtureGlossary() : setup.glossary
  const data = setup.data ?? staticDataService(loadFixtureData(), glossary)
  const items = fixtureResolver({ glossary, aliases: setup.aliases, useGlossary: setup.useGlossary })
  return createUniverseService({
    data, items, store: createModuleStore(), clock: new ManualClock(), esi: setup.esi, useGlossary: setup.useGlossary,
    incursions: setup.incursions, status: setup.status,
  })
}

/** 一项的摘要：种类、中文、英文 */
export const brief = (e: TranslateEntry) => `${e.kind}:${e.zh}|${e.en}`
