// 物品名和查询共用的规范化（§6.1.2）。同一套规则得到：
// - key：去掉空白和标点，用于精确、别名、前缀匹配（「Raven Navy Issue」「ravennavyissue」「乌鸦级 海军型」各得同一个 key）；
// - tokens：拉丁单词、连续数字、单个汉字，用于「包含」档。

/** 零宽字符和引号类的符号（' ’ ‘ " “ ” 「 」 『 』）一起去掉 */
const STRIP = /[\u200b-\u200d\u2060\ufeff'"\u2018\u2019\u201c\u201d\u300c-\u300f]/g
const NON_ASCII = /[^\x00-\x7f]/
/** 各种破折号（‐ ‑ ‒ – — ― − －） */
const DASHES = /[\u2010-\u2015\u2212\uff0d]/g
/** 间隔号（· ・ •） */
const DOTS = /[\u00b7\u30fb\u2022]/g
/** 只换真正需要换的空白：单个普通空格不动，省得每个名字都复制一遍 */
const SPACES = /\s{2,}|[^\S ]/g
const KEY_STRIP = /[\s\-_.,:;()[\]/\\]/g
const HAN = /\p{Script=Han}/u
const HAN_ALL = /\p{Script=Han}/gu
const TOKEN = /\p{Script=Han}|\d+|(?:(?!\p{Script=Han})\p{L})+/gu
const ROMAN_TAIL = /(?<=[\s\p{Script=Han}])(III|II|I)$/u

function clean(text: string, lower: boolean): string {
  let s = text.normalize('NFKC')
  if (lower) s = s.toLowerCase()
  s = s.replace(STRIP, '')
  if (NON_ASCII.test(s)) s = s.replace(DASHES, '-').replace(DOTS, ' ')
  return s.replace(SPACES, ' ').trim()
}

/** NFKC、小写、破折号统一、去引号、间隔号变空格、合并空白 */
export function normalizeName(text: string): string {
  return clean(text, true)
}

export function nameKey(text: string): string {
  return keyOf(normalizeName(text))
}

/** 已经规范化过的文字 → key */
export function keyOf(normalized: string): string {
  return normalized.replace(KEY_STRIP, '')
}

/** 不转小写的 key：黑话表里 3 个字母以内的英文别名只认大小写完全一致的写法 */
export function caseKey(text: string): string {
  return clean(text, false).replace(KEY_STRIP, '')
}

/** 规范化以后的文字切成 tokens（去重） */
export function tokensOf(normalized: string): string[] {
  return [...new Set(normalized.match(TOKEN) ?? [])]
}

export function hasHan(text: string): boolean {
  return HAN.test(text)
}

/** 不重复的汉字 */
export function hanChars(text: string): string[] {
  return [...new Set(text.match(HAN_ALL) ?? [])]
}

/** 英文字母个数（黑话表的大小写规则按它算） */
export function letterCount(text: string): number {
  let n = 0
  for (const ch of text) if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) n++
  return n
}

/** 末尾的 ` I` / ` II` / ` III`（中文名里可以紧跟在汉字后面）换成 1 / 2 / 3；没有时返回 null */
export function romanToDigit(name: string): string | null {
  const m = ROMAN_TAIL.exec(name)
  if (!m) return null
  return name.slice(0, m.index) + String(m[1].length)
}

/** 黑话表写法末尾括号里的说明（「毁电（也常指本地中立玩家）」）不算写法的一部分 */
export function stripNote(text: string): string {
  return text.replace(/\s*[（(][^（()）]*[）)]\s*$/, '').trim()
}
