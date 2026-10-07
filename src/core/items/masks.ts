// 线性扫描前的快速筛选：每行一个 32 位的「出现过哪些字」掩码。查询要的位这一行没有时不可能命中，
// 就不用逐字比较（「包含」和「容错」档不建倒排表，这样仍然在 5 ms 以内）。

/** a–z 各占一位，数字 0–9 折进剩下的 6 位 */
export function latinMask(text: string): number {
  let mask = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 97 && c <= 122) mask |= 1 << (c - 97)
    else if (c >= 48 && c <= 57) mask |= 1 << (26 + ((c - 48) % 6))
  }
  return mask
}

/** 常用汉字区（基本区、扩展 A、兼容区）；区外的字不进掩码，筛选时当作「可能有」 */
function isCommonHan(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)
}

/** 一个汉字按码点折进 32 位里的一位；区外的字是 0 */
export function hanBit(ch: string): number {
  const code = ch.charCodeAt(0)
  return isCommonHan(code) ? 1 << (code & 31) : 0
}

/** 文字里的常用汉字 */
export function hanMask(text: string): number {
  let mask = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (isCommonHan(code)) mask |= 1 << (code & 31)
  }
  return mask
}

/** 掩码里有 need 的全部位 */
export function covers(mask: number, need: number): boolean {
  return (mask & need) === need
}
