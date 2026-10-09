// 图片文件头：认 PNG、JPEG，读像素尺寸。只看文件头，不信响应头或调用方写的 MIME。

import type { ImageMime } from '../types'

export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 同一段字节的 Buffer（视图不复制） */
const bufferOf = (data: Uint8Array): Buffer => (Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength))

const isPng = (buf: Buffer) => buf.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => buf[i] === b)

/** 文件头 → MIME；不是 PNG 或 JPEG 时 null */
export function sniffImage(data: Uint8Array): ImageMime | null {
  const buf = bufferOf(data)
  if (isPng(buf)) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  return null
}

/** 从 PNG、JPEG 的文件头读像素尺寸；认不出时返回 null */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
  const buf = bufferOf(data)
  if (buf.length >= 24 && isPng(buf) && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // 逐个跳过 JPEG 段，找到 SOF（C0–CF，除去 C4 DHT、C8 JPG、CC DAC）
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null
      const marker = buf[i + 1]
      if (marker === 0xff) {
        i++
        continue
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const length = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
      }
      if (length < 2) return null
      i += 2 + length
    }
  }
  return null
}
