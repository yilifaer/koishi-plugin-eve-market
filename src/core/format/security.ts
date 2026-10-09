// 安全等级的显示（§2.9、§6.7.3）：所有显示安全等级的地方都用这一个函数，免得低安星系显示成「0.0」。

import { roundHalfAway } from './number'

/** 1 位小数：0 < sec < 0.05 显示成 0.1（游戏里这样显示），其他四舍五入；不是数字时 '' */
export function displaySec(sec: number): string {
  if (!Number.isFinite(sec)) return ''
  if (sec > 0 && sec < 0.05) return '0.1'
  return roundHalfAway(sec, 1).toFixed(1)
}
