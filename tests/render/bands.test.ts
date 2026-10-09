// 样式自检用的色带长图：真正的 PNG（每个块的校验和对、解压后大小对），尺寸从文件头读得出来。

import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { BAND_COLORS, bandsPng, imageSize } from '../../src/render'

/** 按块拆开 PNG，顺便检查 CRC */
function chunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  const out: Array<{ type: string; data: Buffer }> = []
  let i = 8
  while (i < png.length) {
    const length = png.readUInt32BE(i)
    const type = png.toString('latin1', i + 4, i + 8)
    out.push({ type, data: png.subarray(i + 8, i + 8 + length) })
    i += 12 + length
  }
  return out
}

describe('bandsPng', () => {
  it('a 1440×8000 palette PNG that decodes to one byte per pixel plus the row filters', () => {
    const png = bandsPng({ width: 1440, height: 8000, bands: 8 })
    expect(imageSize(png)).toEqual({ width: 1440, height: 8000 })
    const parts = chunks(png)
    expect(parts.map((p) => p.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND'])
    expect(parts[1].data.length).toBe((BAND_COLORS.length + 1) * 3)
    const raw = inflateSync(parts[2].data)
    expect(raw.length).toBe((1440 + 1) * 8000)
    // 第 1 段左上角是第 0 种颜色，最后一行是第 8 段
    expect(raw[1]).toBe(0)
    expect(raw[(1440 + 1) * 7999 + 1440]).toBe(7)
    // 小到可以随手发
    expect(png.length).toBeLessThan(200_000)
  })

  it('every chunk has a valid CRC', () => {
    const png = bandsPng({ width: 40, height: 80, bands: 4 })
    const table = Array.from({ length: 256 }, (_, n) => {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      return c >>> 0
    })
    const crc = (buf: Buffer) => {
      let c = 0xffffffff
      for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
    }
    let i = 8
    while (i < png.length) {
      const length = png.readUInt32BE(i)
      expect(png.readUInt32BE(i + 8 + length)).toBe(crc(png.subarray(i + 4, i + 8 + length)))
      i += 12 + length
    }
  })
})
