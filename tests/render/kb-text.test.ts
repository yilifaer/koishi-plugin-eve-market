// 人物卡文字版（没有浏览器时）

import { describe, expect, it } from 'vitest'
import { countText, iskShort, kbCardText } from '../../src/render'
import { ghost, rookie, soloHunter } from './kb-fixtures'

describe('kbCardText', () => {
  it('lists name, orgs, title, totals, top ships and places, hours and recent events', () => {
    expect(kbCardText(soloHunter()).split('\n')).toEqual([
      'Hanako Kisaragi｜独狼猎手',
      '军团 [MHL] Moonlit Harbor Logistics　联盟 <FICT> Fictional Federation',
      '头衔：Night Shift',
      '建号：EVE 2020-05-17（北京 2020-05-18）',
      '击毁 1,284 · 损失 312 · 单杀 331 · 效率 93%',
      '常驾舰船：乌鸦级 412 杀、毒蜥级 301 杀、Mystery Hull 198 杀',
      '常出没：Alpha-1 276、Beta-2 188、Gamma 94',
      '活跃时段：北京 02:00–05:00（EVE 18–21）',
      '近期大击杀：毒蜥级 3.2B · Alpha-1 · 10-12',
      '近期大损失：Mystery Hull 410M · Beta-2 · 10-09',
    ])
  })

  it('leaves out missing parts', () => {
    const text = kbCardText(rookie())
    expect(text).not.toContain('联盟')
    expect(text).not.toContain('近期')
    expect(text).toContain('活跃时段：主要时区：欧洲 / 美东')
    expect(kbCardText(ghost())).toBe('Ren Aoyagi｜神秘人物\n建号：EVE 2020-05-17（北京 2020-05-18）\n暂无击杀或损失记录')
    const failed = { ...ghost(), partial: ['zkill' as const] }
    expect(kbCardText(failed)).toContain('战绩暂时取不到')
  })
})

describe('number helpers', () => {
  it('formats counts and ISK', () => {
    expect(countText(1284)).toBe('1,284')
    expect([0, 999, 1500, 410e6, 3.2e9, 845.2e9, 2.5e12].map(iskShort)).toEqual(['0', '999', '1.5K', '410M', '3.2B', '845.2B', '2.5T'])
  })
})
