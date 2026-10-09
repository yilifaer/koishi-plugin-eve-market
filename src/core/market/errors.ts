// 出错原因：只留脱敏后的结构（路由、状态码、说明），给日志、「市场状态」和管理员看。

import { isEsiError } from '../esi'
import type { SafeErrorInfo } from '../types'
import { safeError } from '../util'

export function errorInfo(error: unknown): SafeErrorInfo {
  return isEsiError(error) ? error.info() : safeError(error)
}

/** 一行：「GET /markets/{region_id}/orders HTTP 503: …」；说明和状态码重复时只写一次 */
export function errorDetail(info: SafeErrorInfo): string {
  const status = info.status === undefined ? '' : `HTTP ${info.status}`
  const head = [info.route, status].filter(Boolean).join(' ')
  if (!head) return info.message
  // ESI 客户端的说明本身以「HTTP 503: 」开头
  const message = status && info.message.startsWith(`${status}: `) ? info.message.slice(status.length + 2) : info.message
  return message && message !== status ? `${head}: ${message}` : head
}
