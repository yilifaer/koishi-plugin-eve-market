// 人物卡里的小图：12 个月柱状图、24 小时作息条、占比条，以及图片下载失败时的剪影（头像、舰船、军团和联盟图标）。
// 全部输出内联的 SVG / HTML 片段，不带 xmlns、不引用任何外部资源。数字都是算出来的，不含用户文字。

const INK = '#1B1A17'
const RED = '#B3261E'

/** 保留 1 位小数，输出稳定 */
function n(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return String(rounded === 0 ? 0 : rounded)
}

export interface MonthBar {
  kills: number
  losses: number
}

/** 近 12 个月：击毁在基线上方（墨色），损失在下方（红色）；两个方向共用同一个比例。全 0 时返回 null */
export function monthsSvg(months: readonly MonthBar[]): string | null {
  const max = Math.max(0, ...months.map((m) => Math.max(m.kills, m.losses)))
  if (max <= 0) return null
  const step = 25
  const half = 56
  const bars = months.map((m, i) => {
    const x = i * step + 2
    const up = m.kills > 0 ? Math.max(1, Math.round((m.kills / max) * half)) : 0
    const down = m.losses > 0 ? Math.max(1, Math.round((m.losses / max) * half)) : 0
    return (up ? `<rect x="${x}" y="${60 - up}" width="19" height="${up}" fill="${INK}"/>` : '')
      + (down ? `<rect x="${x}" y="62" width="19" height="${down}" fill="${RED}"/>` : '')
  }).join('')
  const width = Math.max(1, months.length) * step
  return `<svg viewBox="0 0 ${width} 124" width="100%" style="display:block"><line x1="0" x2="${width}" y1="61" y2="61" stroke="${INK}"/>${bars}</svg>`
}

/** 24 小时作息条：每小时一格，墨色深浅表示次数。没有次数时返回 null */
export function hoursStrip(hours: readonly number[]): string | null {
  const max = Math.max(0, ...hours)
  if (max <= 0) return null
  return hours.map((v) => `<i style="background:rgba(27,26,23,${(0.08 + (0.92 * Math.max(0, v)) / max).toFixed(2)})"></i>`).join('')
}

/** 占比条宽度（CSS 像素）：占比 × 3.2，至少 2 */
export function shareBarWidth(sharePercent: number): number {
  return Math.max(2, Math.min(320, Math.round(sharePercent * 3.2)))
}

/** 头像剪影（没下载到头像时用） */
export function portraitSilhouette(): string {
  return '<svg viewBox="0 0 200 240" width="100%" height="100%" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="kbb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d7f93"/><stop offset="1" stop-color="#2d3948"/></linearGradient><radialGradient id="kbf" cx=".5" cy=".4" r=".6"><stop offset="0" stop-color="#f2cdb0"/><stop offset="1" stop-color="#b98062"/></radialGradient></defs><rect width="200" height="240" fill="url(#kbb)"/><path d="M20 240c4-52 36-76 80-76s76 24 80 76z" fill="#1d2630"/><path d="M82 150h36v26c-10 8-26 8-36 0z" fill="#c08c6e"/><ellipse cx="100" cy="98" rx="42" ry="52" fill="url(#kbf)"/><path d="M56 96c-8-52 24-70 50-68 34 2 48 30 38 70-6-24-14-34-30-38-20 8-44 6-58 36z" fill="#16171c"/><rect x="73" y="98" width="20" height="5" rx="2.5" fill="#2b2220"/><rect x="108" y="98" width="20" height="5" rx="2.5" fill="#2b2220"/><path d="M88 130q12 7 24 0" stroke="#7d4b3d" stroke-width="3" fill="none" stroke-linecap="round"/></svg>'
}

/** 舰船剪影（没下载到舰船图时用） */
export function shipSilhouette(): string {
  return `<svg viewBox="0 0 64 64" width="100%" height="100%"><path d="M32 6l8 18 18 6-12 8 2 18-16-8-16 8 2-18-12-8 18-6z" fill="#8c8678" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/><circle cx="32" cy="30" r="4" fill="${INK}"/></svg>`
}

/** 军团 / 联盟图标剪影 */
export function logoSilhouette(kind: 'corp' | 'alliance'): string {
  return kind === 'corp'
    ? '<svg viewBox="0 0 32 32" width="100%" height="100%"><circle cx="16" cy="16" r="14" fill="#555"/><path d="M8 20l8-12 8 12z" fill="#ddd"/></svg>'
    : '<svg viewBox="0 0 32 32" width="100%" height="100%"><rect x="3" y="3" width="26" height="26" rx="4" fill="#555"/><circle cx="16" cy="16" r="7" fill="none" stroke="#ddd" stroke-width="3"/></svg>'
}
