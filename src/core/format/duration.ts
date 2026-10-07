// 时长：「1 小时 23 分」「57 分」「3 天 4 小时」；多久以前：「18 分钟前」「1 小时 12 分钟前」。

const MINUTE = 60
const HOUR = 3600
const DAY = 86400

/** 不到 1 分钟写秒；不到 1 天精确到分钟；更长精确到小时。四舍五入后进位（3599 秒 → 1 小时） */
export function formatDuration(sec: number): string {
  const total = Number.isFinite(sec) ? Math.max(0, sec) : 0
  if (Math.round(total) < MINUTE) return `${Math.round(total)} 秒`
  const minutes = Math.round(total / MINUTE)
  if (minutes < 60) return `${minutes} 分`
  if (minutes < 24 * 60) return joinParts(Math.floor(minutes / 60), '小时', minutes % 60, '分')
  const hours = Math.round(total / HOUR)
  return joinParts(Math.floor(hours / 24), '天', hours % 24, '小时')
}

/** 数据有多旧：不到 1 分钟写「刚刚」，其余向下取整到分钟 */
export function formatAgo(sec: number): string {
  const total = Number.isFinite(sec) ? Math.max(0, sec) : 0
  if (total < MINUTE) return '刚刚'
  if (total < HOUR) return `${Math.floor(total / MINUTE)} 分钟前`
  if (total < DAY) return `${joinParts(Math.floor(total / HOUR), '小时', Math.floor((total % HOUR) / MINUTE), '分钟')}前`
  return `${joinParts(Math.floor(total / DAY), '天', Math.floor((total % DAY) / HOUR), '小时')}前`
}

function joinParts(major: number, majorUnit: string, minor: number, minorUnit: string): string {
  return minor > 0 ? `${major} ${majorUnit} ${minor} ${minorUnit}` : `${major} ${majorUnit}`
}
