// 样式自检用的长图（§2.17 第 2-1、2-4 项）：不用浏览器，直接编码一张 PNG。
// 从上到下几段颜色不同的色带，每段左边画一个很大的编号（3×5 点阵放大），点开以后能不能看清就一目了然。
// 调色板 PNG（每个像素 1 个字节），同一种颜色的大片区域压缩得很小。

import { deflateSync } from 'node:zlib'
import { PNG_SIGNATURE } from '../core/util'

/** 色带的颜色（RGB），依次是红、橙、黄、绿、青、蓝、紫、灰 */
export const BAND_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0xe5, 0x39, 0x35],
  [0xfb, 0x8c, 0x00],
  [0xfd, 0xd8, 0x35],
  [0x43, 0xa0, 0x47],
  [0x00, 0xac, 0xc1],
  [0x1e, 0x88, 0xe5],
  [0x8e, 0x24, 0xaa],
  [0x75, 0x75, 0x75],
]
export const BAND_NAMES = ['红', '橙', '黄', '绿', '青', '蓝', '紫', '灰'] as const

/** 0–9 的 3×5 点阵，每行 3 位 */
const DIGITS: Record<string, readonly string[]> = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(parts: readonly Buffer[]): number {
  let c = 0xffffffff
  for (const buf of parts) {
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32([head.subarray(4), data]), 0)
  return Buffer.concat([head, data, crc])
}

export interface BandsOptions {
  width: number
  height: number
  /** 几段（不超过 BAND_COLORS 的个数） */
  bands: number
}

/** 色带长图（PNG Buffer）。编号用黑色，画在每段左边、上下居中 */
export function bandsPng(options: BandsOptions): Buffer {
  const width = Math.max(1, Math.floor(options.width))
  const height = Math.max(1, Math.floor(options.height))
  const bands = Math.max(1, Math.min(BAND_COLORS.length, Math.floor(options.bands)))
  const black = BAND_COLORS.length
  const stride = width + 1
  const raw = Buffer.alloc(stride * height)
  const bandHeight = Math.ceil(height / bands)
  for (let y = 0; y < height; y++) raw.fill(Math.min(bands - 1, Math.floor(y / bandHeight)), y * stride + 1, (y + 1) * stride)
  // 编号：每个点放大成 scale × scale
  const scale = Math.max(1, Math.floor(Math.min(bandHeight / 8, width / 12)))
  for (let b = 0; b < bands; b++) {
    const glyph = DIGITS[String((b + 1) % 10)]
    const top = b * bandHeight + Math.floor((Math.min(bandHeight, height - b * bandHeight) - 5 * scale) / 2)
    const left = scale * 2
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < 3; gx++) {
        if (row[gx] !== '1') continue
        for (let dy = 0; dy < scale; dy++) {
          const y = top + gy * scale + dy
          if (y < 0 || y >= height) continue
          const start = y * stride + 1 + left + gx * scale
          raw.fill(black, start, Math.min(start + scale, (y + 1) * stride))
        }
      }
    })
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 3 // 调色板
  const palette = Buffer.from([...BAND_COLORS.flat(), 0, 0, 0])
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('PLTE', palette),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
