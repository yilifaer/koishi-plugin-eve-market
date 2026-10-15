// 金额、数量、体积共用的数字格式：在十进制上四舍五入（.5 远离 0），千分位可关。

import { DIFF_MIN_PCT } from '../../constants'

/** 在十进制字符串上移动小数点，避免 1.005 × 100 = 100.49999… 这类二进制误差 */
function shift(value: number, digits: number): number {
  const [mantissa, exponent = '0'] = String(value).split('e')
  return Number(`${mantissa}e${Number(exponent) + digits}`)
}

/** 四舍五入到 digits 位小数，.5 远离 0；结果是 0 时不带负号 */
export function roundHalfAway(value: number, digits: number): number {
  const rounded = Math.sign(value) * shift(Math.round(shift(Math.abs(value), digits)), -digits)
  return rounded === 0 ? 0 : rounded
}

/** 涨跌幅（百分数）→「4.0%」：保留 1 位小数，不带方向；绝对值不到 DIFF_MIN_PCT 时 undefined（算持平） */
export function formatChange(pct: number): string | undefined {
  if (!(Math.abs(pct) >= DIFF_MIN_PCT)) return undefined
  return `${roundHalfAway(Math.abs(pct), 1).toFixed(1)}%`
}

/** 取 3 位有效数字（35,000 → 3.5，1,234 → 1230） */
const sig3 = (value: number) => Number(value.toPrecision(3))

/**
 * 订单数量的中文写法。不到 1 万写整数（37 个）；1 万起用「万」，1 亿起用「亿」，最多 3 位有效数字，是约数（approx）。
 * 调用方按 approx 决定写「约」：「在售 37 个」「在售约 3.5 万个」
 */
export function formatCount(n: number): { approx: boolean; text: string } {
  const value = Math.max(0, Math.round(Number.isFinite(n) ? n : 0))
  if (value < 10_000) return { approx: false, text: `${value} 个` }
  const wan = sig3(value / 1e4)
  // 四舍五入后凑满 1 亿（9999.9 万）按亿写
  if (wan < 10_000) return { approx: true, text: `${wan} 万个` }
  return { approx: true, text: `${sig3(value / 1e8)} 亿个` }
}

export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 固定 digits 位小数；grouping 时整数部分加千分位 */
export function formatFixed(value: number, digits: number, grouping: boolean): string {
  const rounded = roundHalfAway(value, digits)
  const abs = Math.abs(rounded)
  // toFixed 到 1e21 以上会变成科学计数法
  const text = abs < 1e21 ? abs.toFixed(digits) : `${BigInt(Math.round(abs))}${digits > 0 ? `.${'0'.repeat(digits)}` : ''}`
  const [int, frac] = text.split('.')
  const body = `${grouping ? groupThousands(int) : int}${frac === undefined ? '' : `.${frac}`}`
  return rounded < 0 ? `-${body}` : body
}

/** 去掉小数末尾的 0（和多余的小数点）：1.50 → 1.5，2.00 → 2 */
export function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/** 最多 digits 位小数，末尾的 0 去掉 */
export function formatTrimmed(value: number, digits: number, grouping: boolean): string {
  return trimZeros(formatFixed(value, digits, grouping))
}
