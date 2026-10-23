// KB 人物卡配色：夜间版和日间版共用同一套版式，只换这里的颜色。
// 颜色通过 CSS 变量给样式用；小图（kb-svg）直接取同一份配色里的值。

import type { ImageTheme } from '../core/types'

export interface KbPalette {
  /** 纸色 */
  paper: string
  /** 正文墨色 */
  ink: string
  /** 墨色的 r,g,b（作息条按深浅叠透明度） */
  inkRgb: string
  /** 分隔线、边框 */
  rule: string
  /** 次要文字 */
  mute: string
  sub: string
  foot: string
  /** 红色横幅底色（两个主题相同） */
  banner: string
  /** 红色文字、印章、损失柱 */
  red: string
  /** 纸面纹理 */
  grain: string
  /** 栏目框底 */
  box: string
  /** 头像滤镜 */
  portraitFilter: string
  /** 舰船剪影 */
  shipFill: string
  /** 安全等级文字：高 / 低 / 负 */
  secHigh: string
  secLow: string
  secNull: string
}

export const KB_PALETTES: Record<ImageTheme, KbPalette> = {
  light: {
    paper: '#EFE6D2',
    ink: '#1B1A17',
    inkRgb: '27,26,23',
    rule: '#1B1A17',
    mute: '#5a564b',
    sub: '#3d3a31',
    foot: '#4a463c',
    banner: '#B3261E',
    red: '#B3261E',
    grain: 'rgba(80,60,20,.025)',
    box: 'rgba(255,255,255,.18)',
    portraitFilter: 'grayscale(1) sepia(.35) contrast(1.1)',
    shipFill: '#8c8678',
    secHigh: '#1f6b3a',
    secLow: '#8a6a00',
    secNull: '#b3261e',
  },
  dark: {
    paper: '#2B2A27',
    ink: '#E6E0D2',
    inkRgb: '230,224,210',
    rule: '#7C776A',
    mute: '#ABA595',
    sub: '#C2BCAD',
    foot: '#A39D8E',
    banner: '#B3261E',
    red: '#F0776C',
    grain: 'rgba(255,240,200,.02)',
    box: 'rgba(255,255,255,.04)',
    portraitFilter: 'grayscale(1) sepia(.35) contrast(1.1) brightness(1.18)',
    shipFill: '#6f6a5e',
    secHigh: '#62C28A',
    secLow: '#DDB74E',
    secNull: '#F0776C',
  },
}

export function paletteOf(theme: ImageTheme | undefined): KbPalette {
  return KB_PALETTES[theme === 'light' ? 'light' : 'dark']
}

/** :root 变量块 */
export function paletteVars(p: KbPalette): string {
  return `:root{--paper:${p.paper};--ink:${p.ink};--rule:${p.rule};--mute:${p.mute};--sub:${p.sub};--foot:${p.foot};--banner:${p.banner};--red:${p.red};--grain:${p.grain};--box:${p.box};--pf:${p.portraitFilter};--cell:rgba(${p.inkRgb},.25)}`
}
