// EVE 每天的例行维护（UTC 11:00–11:30）。这段时间里 ESI 出错时卡片写「DT 维护中，显示维护前数据」。

import { DT_END_UTC, DT_START_UTC } from '../../constants'

const minutesOf = (t: { hour: number; minute: number }) => t.hour * 60 + t.minute

export function inDowntime(ms: number): boolean {
  const date = new Date(ms)
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  return minute >= minutesOf(DT_START_UTC) && minute < minutesOf(DT_END_UTC)
}
