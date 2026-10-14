// core/killmail 对外的接口：击杀链接识别、zKill + 欧服接口的击杀摘要、战报地址。

export { findKillLink, parseKillArg } from './link'
export type { KillLink, KillLinkSource } from './link'
export { createKillService } from './service'
export type { KillServiceDeps } from './service'
export { parseZkillKill, zkillKillPath } from './zkill'
export type { ZkillKill } from './zkill'
