// 控制台的默认值。只有公共信息：五个 NPC 交易中心、Jita 作为基准、公开的数据和地图网址。

import type { MarketRow, QuantityRow } from './schema'

export const DEFAULT_BASE_MARKET = 'Jita 4-4'

export const PRESET_MARKETS: MarketRow[] = [
  npcStation('Jita 4-4', '60003760', '4-4', 'auto', 0),
  npcStation('Amarr', '60008494', '', 'no', 10),
  npcStation('Dodixie', '60011866', '', 'no', 11),
  npcStation('Rens', '60004588', '', 'no', 12),
  npcStation('Hek', '60005686', '', 'no', 13),
]

function npcStation(name: string, location: string, aliases: string, inDefaultList: MarketRow['inDefaultList'], sortOrder: number): MarketRow {
  return {
    name,
    aliases,
    type: 'npc-station',
    location,
    system: '',
    enabled: true,
    inDefaultList,
    sortOrder,
    visibility: 'auto',
    authProfile: '',
    note: '',
  }
}

export const DEFAULT_QUANTITIES: QuantityRow[] = [{ item: 'PLEX', quantity: 500 }]

const SLANG_RAW = 'https://raw.githubusercontent.com/yilifaer/eve-cn-slang/main'
const SLANG_CDN = 'https://cdn.jsdelivr.net/gh/yilifaer/eve-cn-slang@main'

export const DEFAULT_MANIFEST_URL = `${SLANG_RAW}/official/data/manifest.json || ${SLANG_CDN}/official/data/manifest.json`
export const DEFAULT_GLOSSARY_URL = `${SLANG_RAW}/glossary.yaml || ${SLANG_CDN}/glossary.yaml`
export const DEFAULT_INFLUENCE_MAP_URL = 'https://www.verite.space/maps/influence/influence.png'
export const DEFAULT_COALITION_MAP_URL = 'https://www.verite.space/maps/coalition/coalitioninfluence.png'
export const DEFAULT_CALLBACK_URL = 'http://127.0.0.1:5140/eve-market/sso/callback'

export const DEFAULT_ME_TE_CHOICES = '10/20, 5/10, 0/0'
export const DEFAULT_EXTRA_FEE_LABEL = '其他费用'
