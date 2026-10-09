// 解析前的规范化和切词。物品名本身的规范化（大小写、引号、key）由 items 模块做，这里只处理写法：
// NFKC（全角转半角，NBSP、全角空格变普通空格，「，」变「,」）、✕ 当乘号、去掉零宽字符。Tab 保留，它是列分隔符。

/** 汉字（含扩展 A 和兼容区） */
export const HAN = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff'

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g
const DASHES = /[‐‑‒–—―−]/g

export function normalizeLine(raw: string): string {
  return raw.replace(ZERO_WIDTH, '').normalize('NFKC').replace(/✕/g, '×').trim()
}

/** 参数词（表头里的 -5%）：再把各种破折号统一成 - */
export function normalizeWord(word: string): string {
  return word.replace(DASHES, '-')
}

export interface Token {
  text: string
  start: number
  end: number
}

/** 按空白切词，记下每个词在原文里的位置（取「某个词以后的原文」时不丢原来的空白） */
export function tokenize(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(/\S+/g)) {
    const start = m.index ?? 0
    out.push({ text: m[0], start, end: start + m[0].length })
  }
  return out
}

/** 有没有字母、数字或汉字（只有标点的行当空行） */
export function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}
