// KB 人物卡的固定文案：人设的名字、页脚、照片说明、作息一行、时区名。标题、导语、锐评、称号、运势、广告等有语气之分的文案在 copy/ 目录里。
// 文案红线：只调侃游戏里的战绩，不攻击人，不写性别、地域、族群、现实身份，不说脏话，不用性别代词（一律写名字）。
// tests/core/pilot/copy.test.ts 会扫一遍 copy/ 里的词和长度。
//
// 占位符（copy/ 里的句子可以用）：{name} 名字；{kills} 击毁；{losses} 损失；{solo} 单杀；{eff} 击毁价值占比（如 91%）；
// {isk} 击毁总价值（如 1.2T）；{iskLost} 损失总价值；{k7} 近 7 天击毁；{ship} 最常驾驶的船；{system} 最常出没的星系；
// {region} 它所在的星域；{years} 建号几年（不满 1 年没有）；{gang} 抱团度（如 85%）；{danger} 危险度（如 85%）；{avgGang} 平均几人一起打；
// {bigKill} {bigKillIsk} 近期最大击杀的船和价值；{bigLoss} {bigLossIsk} 近期最大损失；{dormant} 多久没有记录（「5 个月」或「一年多」，已带单位）；{peak} 最活跃时段（北京时间，如 21–24 点）。
// 句子里用到的数据缺了就跳过这一句，所以每个人设至少要有一条只用 {name} 的标题和一条只用 {name} 的导语。

import type { PersonaId, PilotZone } from '../types'

/** 人设的名字，卡片的横幅上写 */
export const PERSONA_LABEL: Record<PersonaId, string> = {
  ghost: '神秘人物',
  pacifist: '和平主义者',
  sleeper: '沉睡老号',
  rookie: '初出茅庐',
  capital: '旗舰巨头',
  industrial: '工业大亨',
  wormhole: '虫洞住民',
  ganker: '高安猎手',
  solo: '独狼猎手',
  fleet: '舰队老兵',
  reaper: '战场死神',
  underdog: '越挫越勇',
  pilot: '新伊甸战士',
  unknown: '战绩暂缺',
}

/** 页脚：数据来源和免责声明 */
export const FOOTER_TEXT = '数据：zKillboard / 欧服官方接口 · 本报纯属娱乐'

/** 照片说明 */
export const BIRTHPLACE_TEXT = {
  at: (station: string) => `摄于 ${station}`,
  fallback: '摄于新伊甸某处',
} as const

/** 作息一行 */
export const ACTIVITY_TEXT = {
  /** 北京时间在前，EVE 时间（UTC）在括号里：北京 20:00–23:00（EVE 12–15）；结束正好是 0 点的写 24 */
  peak: (beijingStart: number, beijingEnd: number, utcStart: number, utcEnd: number) =>
    `北京 ${String(beijingStart).padStart(2, '0')}:00–${String(beijingEnd || 24).padStart(2, '0')}:00（EVE ${utcStart}–${utcEnd || 24}）`,
  /** 只有时区标签：只列名字，前缀由卡片和文字版各自加 */
  zones: (names: string[]) => names.join(' / '),
  /** 卡片上没有 24 小时条时的前缀 */
  zonesPrefix: '主要活跃时段：',
} as const

export const ZONE_NAMES: Record<PilotZone, string> = {
  eu: '欧洲时段',
  ru: '莫斯科时段',
  use: '美东时段',
  usw: '美西时段',
  au: '澳洲时段',
}
