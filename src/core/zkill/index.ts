// core/zkill 对外的接口：zKill 的 HTTP 客户端（击杀转战报、KB 人物卡共用）。

export { ZkillClient } from './client'
export type {
  ZkillClientOptions,
  ZkillFailure,
  ZkillFailureKind,
  ZkillGetOptions,
  ZkillPorts,
  ZkillResult,
} from './client'
export { emptyZkillStats, parseZkillStats, zkillCharKillsPath, zkillCharLossesPath, zkillStatsPath } from './stats'
export type { ZkillGroupStat, ZkillLabelStat, ZkillMonth, ZkillStats } from './stats'
