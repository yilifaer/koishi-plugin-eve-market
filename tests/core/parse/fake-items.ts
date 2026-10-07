// 测试用的物品识别：只认一小份真实的物品名（中英文）。名字的 key 去掉大小写、空白和标点；
// key 完全相同 = 精确，只有一个物品以它开头 = 唯一前缀（≈），其余认不出。够用来测「选哪种读法」。

import type { Judge } from '../../../src/core/parse'

const NAMES: Array<[string, string]> = [
  ['Raven', '乌鸦级'],
  ['Raven Navy Issue', '乌鸦级海军型'],
  ['Raven Blueprint', '乌鸦级蓝图'],
  ['Rifter', '裂谷级'],
  ['Dominix', '多米尼克斯级'],
  ['Dominix Blueprint', '多米尼克斯级蓝图'],
  ['Amarr Shuttle', '艾玛穿梭机'],
  ['Tritanium', '三钛合金'],
  ['Pyerite', '类晶体胶矿'],
  ['Mexallon', '类银超金属'],
  ['Isogen', '同位聚合体'],
  ['Nocxium', '超新星诺克石'],
  ['Zydrine', '晶状石英核岩'],
  ['Megacyte', '超噬矿'],
  ['Morphite', '莫尔石'],
  ['Large Shield Extender I', '大型护盾扩展装置 I'],
  ['Large Shield Extender II', '大型护盾扩展装置 II'],
  ['Medium Shield Extender II', '中型护盾扩展装置 II'],
  ['Ballistic Control System I', '弹道控制系统 I'],
  ['Ballistic Control System II', '弹道控制系统 II'],
  ['Drone Damage Amplifier II', '无人机伤害增效装置 II'],
  ['Multispectrum Shield Hardener II', '多谱式护盾增强器 II'],
  ['Pithum C-Type Multispectrum Shield Hardener', '皮特姆多谱式护盾增强器 C型'],
  ['Cruise Missile Launcher II', '巡航导弹发射器 II'],
  ['Scourge Cruise Missile', '鞭挞巡航导弹'],
  ['Inferno Cruise Missile', '炼狱巡航导弹'],
  ['Hobgoblin I', '地精灵 I'],
  ['Hobgoblin II', '地精灵 II'],
  ['Hammerhead II', '战锤 II'],
  ['Warrior I', '武士 I'],
  ['Warrior II', '武士 II'],
  ['Cap Booster 100', '电容注电器装料 100'],
  ['Cap Booster 800', '电容注电器装料 800'],
  ['Navy Cap Booster 400', '海军电容注电器装料 400'],
  ['Navy Cap Booster 800', '海军电容注电器装料 800'],
  ['Damage Control II', '损伤控制 II'],
  ['Large Micro Jump Drive', '大型微型跳跃引擎'],
  ['Mobile Tractor Unit', '移动式牵引装置'],
  ['Nanite Repair Paste', '纳米体修复粘合剂'],
  ['X-Large Ancillary Shield Booster', '超大型辅助护盾回充增量器'],
  ['Entropic Radiation Sink II', '熵辐射槽 II'],
  ['Exotic Dancers, Male', '男性异族舞者'],
  ['10MN Afterburner II', '10MN加力燃烧器 II'],
  ['PLEX', '伊甸币'],
  ['Construction Blocks', '建筑模块'],
  ['Robotics', '机器人技术'],
]

const key = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[\s\-_.,:;()[\]/\\'"]/g, '')

const ITEMS = NAMES.flatMap(([en, zh]) => [{ en, key: key(en) }, { en, key: key(zh) }])

/** 识别结果：英文官方名 */
export const judge: Judge<string> = (name) => {
  const k = key(name)
  if (!k) return null
  const exact = ITEMS.filter((item) => item.key === k)
  if (exact.length) return new Set(exact.map((i) => i.en)).size === 1 ? { approx: false, value: exact[0].en } : null
  const prefix = new Set(ITEMS.filter((item) => item.key.startsWith(k)).map((i) => i.en))
  return prefix.size === 1 ? { approx: true, value: [...prefix][0] } : null
}

/** 本群能看到的市场（key 是规范化的名字）；隐藏的联盟市场返回 null */
export function matchMarket(phrase: string): string | null {
  const markets: Record<string, string> = {
    'jita': 'jita',
    'jita 4-4': 'jita',
    '吉他': 'jita',
    'amarr': 'amarr',
    'xx-1': 'xx-1',
    'xx': 'xx-1',
  }
  return markets[phrase.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')] ?? null
}
