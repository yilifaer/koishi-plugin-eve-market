// 市场名、别名的比较键。和配置规范化（config/normalize 的 nameKey）是同一套规则：
// NFKC、小写、破折号统一成 -、连续空白合成一个。core 不能引用 config，所以这里另写一份。

const DASHES = /[‐-―−]/g
const ZERO_WIDTH = /[​-‍⁠﻿]/g
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

export function marketKey(text: string): string {
  return text.replace(ZERO_WIDTH, '').normalize('NFKC').toLowerCase().replace(DASHES, '-').replace(/\s+/g, ' ').trim()
}

/** 再去掉空白：「jita4-4」也能认出「Jita 4-4」 */
export function compactMarketKey(text: string): string {
  return marketKey(text).replace(/ /g, '')
}

/** 按钮里的显示宽度：汉字这类全宽字符算 2 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1
  return width
}
