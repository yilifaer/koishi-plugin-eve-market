// 按指定时区显示时间。全插件只用 TIMEZONE（北京时间），不读本机时区；EVE 时间用 'UTC'。

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute }
}

const pad = (n: number) => String(n).padStart(2, '0')

const hourMinute = (at: ZonedParts) => `${pad(at.hour)}:${pad(at.minute)}`
const monthDay = (at: ZonedParts) => `${pad(at.month)}/${pad(at.day)}`

/** HH:MM（在这个时区里） */
export function formatTime(ms: number, timeZone: string): string {
  return hourMinute(zonedParts(ms, timeZone))
}

/** MM/DD HH:MM（在这个时区里） */
export function formatDateTime(ms: number, timeZone: string): string {
  const at = zonedParts(ms, timeZone)
  return `${monthDay(at)} ${hourMinute(at)}`
}

/** 和 now 同一天（在这个时区里）写 HH:MM，否则 MM/DD HH:MM */
export function formatClock(ms: number, now: number, timeZone: string): string {
  const at = zonedParts(ms, timeZone)
  const today = zonedParts(now, timeZone)
  const sameDay = at.year === today.year && at.month === today.month && at.day === today.day
  return sameDay ? hourMinute(at) : `${monthDay(at)} ${hourMinute(at)}`
}
