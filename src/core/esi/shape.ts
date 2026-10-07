// 校验 ESI 的 JSON：字段缺了或类型不对就抛 ShapeError（client 把它变成 bad-response），
// 不悄悄跳过——字段名变了时宁可报错用旧缓存，也不要把「没有订单」当成真的。

export class ShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShapeError'
  }
}

export type Row = Record<string, unknown>

export function list(json: unknown, what: string): unknown[] {
  if (!Array.isArray(json)) throw new ShapeError(`${what} 应该是数组`)
  return json
}

export function row(value: unknown, what: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ShapeError(`${what} 应该是对象`)
  return value as Row
}

/** 逐行转换，出错时带上行号 */
export function rows<T>(json: unknown, what: string, map: (r: Row) => T): T[] {
  return list(json, what).map((item, i) => {
    const at = `${what}[${i}]`
    try {
      return map(row(item, at))
    } catch (e) {
      if (e instanceof ShapeError && !e.message.startsWith(at)) throw new ShapeError(`${at} 的 ${e.message}`)
      throw e
    }
  })
}

export function num(r: Row, key: string): number {
  const v = r[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`${key} 应该是数字`)
  return v
}

export function int(r: Row, key: string): number {
  const v = num(r, key)
  if (!Number.isInteger(v)) throw new ShapeError(`${key} 应该是整数`)
  return v
}

export function optNum(r: Row, key: string): number | null {
  return r[key] === undefined || r[key] === null ? null : num(r, key)
}

export function optInt(r: Row, key: string): number | null {
  return r[key] === undefined || r[key] === null ? null : int(r, key)
}

export function str(r: Row, key: string): string {
  const v = r[key]
  if (typeof v !== 'string') throw new ShapeError(`${key} 应该是字符串`)
  return v
}

export function bool(r: Row, key: string, fallback?: boolean): boolean {
  const v = r[key]
  if (v === undefined && fallback !== undefined) return fallback
  if (typeof v !== 'boolean') throw new ShapeError(`${key} 应该是 true/false`)
  return v
}

/** ISO 时间 → 毫秒 */
export function time(r: Row, key: string): number {
  const ms = Date.parse(str(r, key))
  if (!Number.isFinite(ms)) throw new ShapeError(`${key} 不是有效的时间`)
  return ms
}

export function intList(r: Row, key: string): number[] {
  return list(r[key], key).map((v, i) => {
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new ShapeError(`${key}[${i}] 应该是整数`)
    return v
  })
}

export function oneOf<T extends string>(r: Row, key: string, values: readonly T[]): T {
  const v = str(r, key)
  if (!(values as readonly string[]).includes(v)) throw new ShapeError(`${key} 是未知的值 ${JSON.stringify(v).slice(0, 40)}`)
  return v as T
}
