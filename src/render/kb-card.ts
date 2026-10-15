// KB 人物卡出图（样式「新伊甸日报 NEW EDEN NEWS」）：PilotProfile + 图片 → 自包含 HTML（纯函数）→ JPEG。
// 页面不引用任何外部资源（图片只能是 data: 地址，内容安全策略同走势图）；所有文字都过 HTML 转义；
// 没有 JS，所以标题字号由服务器按文字宽度算好写死，长名字再用省略号兜底；没有数据的栏整栏不输出。
// 成图放进内存 LRU（键 = 人物 ID + 资料时间），同一张正在出的时候后来的请求共用这一次。

import {
  KB_CARD_JPEG_QUALITY, KB_CARD_LRU_SIZE, KB_CARD_MIN_HEIGHT, KB_CARD_RENDER_TIMEOUT_MS, KB_CARD_SCALE, KB_CARD_WIDTH,
  KB_CACHE_MAX, KB_CARD_CACHE_MIN, KB_HEADLINE_FONT_MAX, KB_HEADLINE_FONT_MIN,
} from '../constants'
import { displaySec } from '../core/format'
import { ACTIVITY_TEXT } from '../core/pilot'
import type { PilotImageSet, PilotKill, PilotProfile } from '../core/types'
import { LruCache, SingleFlight } from '../core/util'
import { escapeXml, textWidth } from './chart-svg'
import { hoursStrip, logoSilhouette, monthsSvg, portraitSilhouette, shareBarWidth, shipSilhouette } from './kb-svg'
import { beijingDate, countText, iskShort, orgLine, percentText, shipName, utcDate, utcMinute, utcMonthDay } from './kb-text'
import type { RenderedImage, Renderer } from './renderer'

/** 出图用的全部输入 */
export interface KbCardView {
  profile: PilotProfile
  images: PilotImageSet
  /** 报头日期用，毫秒 */
  now: number
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
/** 右栏宽度：720 - 2×24 边距 - 240 照片 - 18 间距 */
const HEADLINE_WIDTH = 414
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

const FONT_SERIF = '"Songti SC","STSong","Noto Serif CJK SC","Source Han Serif SC","SimSun","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","WenQuanYi Zen Hei","WenQuanYi Micro Hei",sans-serif'
const FONT_MASTHEAD = '"Didot","Bodoni 72","Baskerville","Times New Roman","Liberation Serif","DejaVu Serif",serif'
const FONT_NARROW = '"Impact","Haettenschweiler","Arial Narrow","Liberation Sans Narrow","DejaVu Sans Condensed",sans-serif'

const esc = escapeXml

/** 只放行 sniff 过的图片 data: 地址（再保险一道，防止任何别的字符串混进 src） */
function safeImage(uri: string | null | undefined): string | null {
  return uri && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(uri) ? uri : null
}

function image(uri: string | null | undefined, fallback: string, alt = ''): string {
  const src = safeImage(uri)
  return src ? `<img src="${src}" alt="${esc(alt)}" style="width:100%;height:100%;object-fit:cover;display:block">` : fallback
}

function secColor(security: number): string {
  return security >= 0.45 ? '#1f6b3a' : security > 0 ? '#8a6a00' : '#b3261e'
}

/** 标题最多几行，再长才用省略号 */
const HEADLINE_MAX_LINES = 2

/** 估算标题在 HEADLINE_WIDTH 里排几行：中文逐字、英文按词（太长的词按宽度拆） */
function headlineLines(text: string, size: number): number {
  let lines = 1
  let used = 0
  for (const token of text.match(/[\u2000-\u{10ffff}]|[^\s\u2000-\u{10ffff}]+\s*|\s+/gu) ?? []) {
    const width = textWidth(token.trimEnd(), size, true)
    if (used > 0 && used + width > HEADLINE_WIDTH) {
      lines++
      used = 0
    }
    if (width > HEADLINE_WIDTH) {
      lines += Math.floor(width / HEADLINE_WIDTH)
      used = width % HEADLINE_WIDTH
    } else used += textWidth(token, size, true)
  }
  return lines
}

/** 标题字号：两行放得下的最大值，夹在上下限之间；再放不下用省略号（CSS 的 line-clamp） */
export function headlineFontSize(text: string): number {
  for (let size = KB_HEADLINE_FONT_MAX; size > KB_HEADLINE_FONT_MIN; size--) {
    if (headlineLines(text, size) <= HEADLINE_MAX_LINES) return size
  }
  return KB_HEADLINE_FONT_MIN
}

function dateLine(now: number): string {
  const d = new Date(now)
  return `YC${d.getUTCFullYear() - 1898} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 星期${WEEKDAYS[d.getUTCDay()]}`
}

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${KB_CARD_WIDTH}px;min-height:${KB_CARD_MIN_HEIGHT}px;background:#EFE6D2}
body{font-family:${FONT_SERIF};color:#1B1A17;padding:24px;background:#EFE6D2 repeating-radial-gradient(circle at 30% 20%,rgba(80,60,20,.025) 0 2px,transparent 2px 5px)}
.mast{border-top:3px solid #1B1A17;padding-top:4px;text-align:center}
.mast:before{content:"";display:block;border-top:1px solid #1B1A17;margin-bottom:8px}
.en{font:bold 64px/1.05 ${FONT_MASTHEAD};letter-spacing:4px}
.zh{font-size:28px;letter-spacing:14px;margin:4px 0 8px;text-indent:14px}
.meta{display:flex;justify-content:space-between;font-size:17px;padding:6px 0;border-top:1px solid #1B1A17;border-bottom:1px solid #1B1A17;position:relative}
.meta:after{content:"";position:absolute;left:0;right:0;bottom:-6px;border-top:3px solid #1B1A17}
.banner{margin-top:14px;background:#B3261E;color:#fff;font-weight:bold;font-size:24px;padding:6px 14px;display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.banner span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.banner small{font-size:19px;font-weight:normal;flex:none}
.lead{display:flex;gap:18px;margin-top:16px}
.photo{width:240px;flex:none}
.pic{width:240px;height:280px;border:3px solid #1B1A17;filter:grayscale(1) sepia(.35) contrast(1.1);overflow:hidden}
.cap{font-size:17px;font-style:italic;margin-top:6px;line-height:1.35;overflow-wrap:anywhere}
.txt{flex:1;min-width:0}
h1{line-height:1.1;font-weight:900;letter-spacing:-1px;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${HEADLINE_MAX_LINES}}
.lede{font-size:20px;line-height:1.5;text-align:justify;margin-top:10px;overflow-wrap:anywhere}
.org{margin-top:10px;border-top:1px solid #1B1A17;padding-top:8px;display:flex;flex-direction:column;gap:6px;font-size:19px}
.org div{display:flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.org .gt{font-size:17px;color:#5a564b;letter-spacing:.5px}
.org i{width:28px;height:28px;display:block;flex:none;filter:grayscale(.6)}
.dos{margin-top:8px;font-size:17px;line-height:1.4;color:#3d3a31}
.dos div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sep{margin:18px 0 0;border-top:3px solid #1B1A17;border-bottom:1px solid #1B1A17;height:6px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);margin-top:12px;border-top:1px solid #1B1A17;border-left:1px solid #1B1A17}
.st{border-right:1px solid #1B1A17;border-bottom:1px solid #1B1A17;padding:6px 10px 8px;display:flex;flex-direction:column;min-width:0}
.st b{font:bold 38px/1.1 ${FONT_NARROW};font-stretch:condensed;letter-spacing:.5px;white-space:nowrap}
.st b.red{color:#B3261E}
.st span{font-size:19px}
h2{font-size:22px;letter-spacing:6px;border-bottom:2px solid #1B1A17;margin:18px 0 8px;padding-bottom:2px;display:flex;justify-content:space-between;align-items:baseline}
h2 small{font-size:17px;letter-spacing:0;font-weight:normal}
.ship{display:flex;align-items:center;gap:12px;height:62px;border-bottom:1px dotted #1B1A17}
.si{width:50px;height:50px;filter:grayscale(1);flex:none;overflow:hidden}
.sn{width:170px;flex:none;min-width:0}.sn b{display:block;font-size:24px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sn em{display:block;font:italic 18px "Liberation Serif",serif;color:#5a564b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sk{flex:1;display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.sk b{font:bold 26px/1 "Liberation Sans Narrow","Liberation Sans",sans-serif;font-stretch:condensed}
.sk u{display:block;height:12px;background:repeating-linear-gradient(45deg,#1B1A17 0 3px,transparent 3px 7px);border:1px solid #1B1A17}
.pc{width:52px;text-align:right;font-size:20px}
.two{display:flex;gap:20px}.two>div{flex:1;min-width:0}
ul{list-style:none;font-size:19px}
li{display:flex;gap:6px;align-items:baseline;padding:4px 0;border-bottom:1px dotted #1B1A17;white-space:nowrap}
li small{font-size:16px;color:#5a564b}li span{margin-left:auto;font-weight:bold}
li em{font-style:normal;overflow:hidden;text-overflow:ellipsis}
.ev{font-size:19px;line-height:1.35;margin-top:8px;overflow-wrap:anywhere}.ev b{color:#B3261E}
.hours{display:flex;gap:2px;margin-top:4px}.hours i{flex:1;height:34px;display:block;border:1px solid rgba(27,26,23,.25)}
.ax{display:flex;justify-content:space-between;font-size:16px;margin-top:2px}
.best{font-size:19px;margin-top:6px;line-height:1.35}
.titles{margin-top:12px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;font-size:17px}
.titles>span{letter-spacing:1px}
.titles b{display:inline-block;max-width:100%;border:2px solid #B3261E;color:#B3261E;padding:0 8px;line-height:1.5;font-size:17px;letter-spacing:1px;transform:rotate(-1.5deg);overflow-wrap:anywhere}
.titles b:nth-child(even){transform:rotate(1deg)}
.ed{margin:16px 4px 0;border:1px solid #1B1A17;outline:1px solid #1B1A17;outline-offset:3px;padding:8px 14px 10px}
.ed h3,.box h3{font-size:20px;letter-spacing:6px;display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #1B1A17;padding-bottom:2px;margin-bottom:6px}
.ed h3 small,.box h3 small{font-size:14px;letter-spacing:0;font-weight:normal;color:#5a564b}
.ed p{font-size:18px;line-height:1.45;padding:3px 0 3px 22px;position:relative;overflow-wrap:anywhere}
.ed p:before{content:"—";position:absolute;left:0;color:#B3261E;font-weight:bold}
.fun{display:flex;gap:16px;margin-top:16px;align-items:stretch}.fun>.box{flex:1;min-width:0}
.box{border:1px solid #1B1A17;padding:8px 12px 10px;background:rgba(255,255,255,.18)}
.letter q{display:block;quotes:none;font-style:italic;font-size:18px;line-height:1.5;overflow-wrap:anywhere}
.letter .sign{text-align:right;font-size:16px;margin-top:6px;overflow-wrap:anywhere}
.fort div{font-size:18px;line-height:1.4;display:flex;gap:8px;padding:2px 0;overflow-wrap:anywhere}
.fort div b{flex:none;font-size:18px;border:1px solid currentColor;width:24px;height:24px;line-height:22px;text-align:center}
.fort .yi{color:#1B1A17}.fort .ji{color:#B3261E}
.fort em{display:block;margin-top:6px;font-size:16px;color:#3d3a31;border-top:1px dotted #1B1A17;padding-top:5px;overflow-wrap:anywhere}
.ad{position:relative;margin-top:18px;border:1px dashed #1B1A17;padding:8px 12px 8px 54px;font-size:16px;line-height:1.45;overflow-wrap:anywhere}
.ad i{position:absolute;left:10px;top:9px;font-style:normal;font-size:12px;border:1px solid #1B1A17;padding:0 4px;letter-spacing:2px;color:#5a564b}
.foot{margin-top:18px;border-top:1px solid #1B1A17;padding-top:6px;font-size:15px;color:#4a463c;display:flex;justify-content:space-between;gap:10px}
`.trim()

function stat(label: string, value: string, red = false): string {
  return `<div class="st"><b${red ? ' class="red"' : ''}>${esc(value)}</b><span>${label}</span></div>`
}

function statsGrid(p: PilotProfile): string {
  const t = p.totals
  if (t.kills + t.losses <= 0) return ''
  const cells = [
    stat('击毁', countText(t.kills)),
    stat('损失', countText(t.losses), true),
    stat('单杀', countText(t.solo)),
    t.efficiency !== null ? stat('效率', percentText(t.efficiency)) : '',
    stat('击毁价值', iskShort(t.iskKilled)),
    stat('损失价值', iskShort(t.iskLost), true),
    t.danger !== null ? stat('危险度', percentText(t.danger)) : '',
    t.gang !== null ? stat('抱团度', percentText(t.gang)) : '',
  ]
  return `<div class="grid">${cells.join('')}</div>`
}

function shipsSection(p: PilotProfile, images: PilotImageSet): string {
  if (!p.ships.length) return ''
  const rows = p.ships.slice(0, 3).map((s) => {
    const zh = s.zh
    const main = zh || s.en
    const sub = zh && s.en && s.en !== zh ? `<em>${esc(s.en)}</em>` : ''
    return `<div class="ship"><div class="si">${image(images.ships[s.typeId], shipSilhouette())}</div>`
      + `<div class="sn"><b>${esc(main)}</b>${sub}</div>`
      + `<div class="sk"><b>${countText(s.kills)} 杀</b><u style="width:${shareBarWidth(s.share)}px"></u></div><span class="pc">${Math.round(s.share)}%</span></div>`
  })
  return `<h2><span>王牌座驾</span><small>按击杀数</small></h2>${rows.join('')}`
}

function bigEvent(label: string, kill: PilotKill | null): string {
  if (!kill) return ''
  const place = kill.system ? kill.system.en : `#${kill.systemId}`
  return `<div class="ev"><b>${label}</b><br>${esc(shipName(kill.ship))} ${iskShort(kill.value)} · ${esc(place)} · ${utcMonthDay(kill.time)}</div>`
}

function placesColumn(p: PilotProfile): string {
  const places = p.places.slice(0, 3)
  const events = bigEvent('近期大击杀', p.recentKill) + bigEvent('近期大损失', p.recentLoss)
  if (!places.length && !events) return ''
  const list = places.length
    ? `<h2><span>常出没</span></h2><ul>${places.map((pl) => {
      const sys = pl.system
      const name = sys ? sys.en : `#${pl.systemId}`
      const sec = sys ? `<small>${displaySec(sys.security)}</small>` : ''
      const region = sys?.region ? `<em>${esc(sys.region.zh || sys.region.en)}</em>` : ''
      const color = sys ? secColor(sys.security) : '#5a564b'
      return `<li><b style="color:${color}">${esc(name)}</b> ${sec} ${region}<span>${countText(pl.kills)}</span></li>`
    }).join('')}</ul>`
    : ''
  return `<div>${list}${events}</div>`
}

function activityColumn(p: PilotProfile): string {
  const a = p.activity
  const strip = a && a.source !== 'labels' ? hoursStrip(a.hoursBeijing) : null
  const months = monthsSvg(p.months)
  const text = a?.text ?? ''
  if (!strip && !text && !months) return ''
  let html = ''
  if (strip || text) {
    html += `<h2><span>作息</span>${strip ? '<small>北京时间</small>' : ''}</h2>`
    if (strip) html += `<div class="hours">${strip}</div><div class="ax"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>`
    if (text) html += `<div class="best">${strip ? '最活跃：' : ACTIVITY_TEXT.zonesPrefix}${esc(text)}</div>`
  }
  if (months) html += `<h2><span>近 12 个月</span><small>上击毁 下损失</small></h2>${months}`
  return `<div>${html}</div>`
}

function orgBlock(p: PilotProfile, images: PilotImageSet): string {
  const rows: string[] = []
  // 游戏里设置的军团头衔，原样写（保留开头的 #），放在军团行上面
  if (p.title) rows.push(`<div class="gt">${esc(p.title)}</div>`)
  if (p.corporation) rows.push(`<div><i>${image(images.corporation, logoSilhouette('corp'))}</i>${esc(orgLine(p.corporation, '[]'))}</div>`)
  if (p.alliance) rows.push(`<div><i>${image(images.alliance, logoSilhouette('alliance'))}</i>${esc(orgLine(p.alliance, '<>'))}</div>`)
  return rows.length ? `<div class="org">${rows.join('')}</div>` : ''
}

function dossier(p: PilotProfile): string {
  const rows: string[] = []
  if (p.birthday !== null) rows.push(`<div>建号：EVE ${utcDate(p.birthday)}（北京 ${beijingDate(p.birthday)}）</div>`)
  return rows.length ? `<div class="dos">${rows.join('')}</div>` : ''
}

/** 称号：横幅下面一行小印章；没有称号不输出 */
function titlesLine(p: PilotProfile): string {
  return p.titles.length ? `<div class="titles"><span>本报授予称号：</span>${p.titles.map((t) => `<b>${esc(t)}</b>`).join('')}</div>` : ''
}

/** 本报锐评：双线框社论，破折号开头 */
function remarksBox(p: PilotProfile): string {
  if (!p.remarks.length) return ''
  return `<div class="ed"><h3><span>本报锐评</span><small>社论</small></h3>${p.remarks.map((r) => `<p>${esc(r)}</p>`).join('')}</div>`
}

function letterBox(p: PilotProfile): string {
  const l = p.letter
  if (!l) return ''
  return `<div class="box letter"><h3><span>读者来信</span></h3><q>${esc(l.body)}</q><div class="sign">${esc(l.sign)}</div></div>`
}

function fortuneBox(p: PilotProfile): string {
  const f = p.fortune
  if (!f.yi.length && !f.ji.length && !f.comment) return ''
  const row = (cls: string, label: string, items: string[]) => (items.length ? `<div class="${cls}"><b>${label}</b><span>${items.map(esc).join('　')}</span></div>` : '')
  return `<div class="box fort"><h3><span>今日运势</span></h3>${row('yi', '宜', f.yi)}${row('ji', '忌', f.ji)}${f.comment ? `<em>${esc(f.comment)}</em>` : ''}</div>`
}

function funRow(p: PilotProfile): string {
  const boxes = letterBox(p) + fortuneBox(p)
  return boxes ? `<div class="fun">${boxes}</div>` : ''
}

function adBox(p: PilotProfile): string {
  return p.ad ? `<div class="ad"><i>广告</i>${esc(p.ad)}</div>` : ''
}

/** 页脚：资料里的来源句在最后一个「 · 」处断开，中间补上截至时间 */
function footer(p: PilotProfile): string {
  const cut = p.footer.lastIndexOf(' · ')
  const source = cut >= 0 ? p.footer.slice(0, cut) : p.footer
  const tail = cut >= 0 ? p.footer.slice(cut + 3) : ''
  return `<div class="foot"><span>${esc(source)} · 截至 EVE ${utcMinute(p.updatedAt)}</span>${tail ? `<span>${esc(tail)}</span>` : ''}</div>`
}

/** 卡片 HTML：纯函数，同样的输入得到同样的页面 */
export function kbCardHtml(view: KbCardView): string {
  const { profile: p, images } = view
  const size = headlineFontSize(p.headline)
  const two = [placesColumn(p), activityColumn(p)].join('')
  const parts = [
    '<!doctype html>',
    '<html lang="zh-CN"><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<title>新伊甸日报</title>',
    `<style>${STYLE}</style>`,
    '</head><body>',
    `<div class="mast"><div class="en">NEW EDEN NEWS</div><div class="zh">新伊甸日报</div>`
    + `<div class="meta"><span>${dateLine(view.now)}</span><span>欧服 TRANQUILITY 版</span><span>售价 1,000 ISK</span></div></div>`,
    `<div class="banner"><span>号外 · ${esc(p.personaLabel)}</span>${p.mood ? `<small>${esc(p.mood)}</small>` : ''}</div>`,
    titlesLine(p),
    `<div class="lead"><div class="photo"><div class="pic">${image(images.portrait, portraitSilhouette(), p.name)}</div>`
    + `<div class="cap">图：${esc(p.name)}，${esc(p.birthplace)}</div></div>`
    + `<div class="txt"><h1 style="font-size:${size}px">${esc(p.headline)}</h1><p class="lede">${esc(p.lede)}</p>${orgBlock(p, images)}${dossier(p)}</div></div>`,
    '<div class="sep"></div>',
    statsGrid(p),
    shipsSection(p, images),
    remarksBox(p),
    two ? `<div class="two">${two}</div>` : '',
    funRow(p),
    adBox(p),
    footer(p),
    '</body></html>',
  ]
  return parts.filter(Boolean).join('\n')
}

// ------------------------------------------------------------------ 出图和缓存

export interface KbCardShotOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface KbCards {
  /** 缓存里有就直接给（记为最近用过），没有就出图；同一张正在出的共用一次。失败时抛 RenderError */
  get(view: KbCardView, options?: KbCardShotOptions): Promise<RenderedImage>
  /** 只看缓存，不出图 */
  cached(view: KbCardView): RenderedImage | undefined
  clear(): void
}

export interface KbCardsOptions {
  max?: number
  now?: () => number
}

/** 缓存键：人物 ID + 资料时间 + 文案语气 + UTC 日期（整活儿文案按日期挑，过了 UTC 零点要换） */
export function kbCardKey(view: Pick<KbCardView, 'profile' | 'now'>): string {
  const { profile } = view
  return `${profile.id}:${profile.updatedAt}:${profile.tone}:${utcDate(view.now)}`
}

export function createKbCards(renderer: Renderer, options: KbCardsOptions = {}): KbCards {
  const now = options.now ?? Date.now
  const cache = new LruCache<string, RenderedImage>({
    max: Math.min(options.max ?? KB_CARD_LRU_SIZE, KB_CACHE_MAX),
    ttlMs: KB_CARD_CACHE_MIN * 60_000,
    now,
  })
  const flights = new SingleFlight<string, RenderedImage>()
  return {
    get(view, shot = {}) {
      const key = kbCardKey(view)
      const hit = cache.get(key)
      if (hit) return Promise.resolve(hit)
      return flights.run(key, async () => {
        const out = await renderer.screenshotHtml(kbCardHtml(view), {
          width: KB_CARD_WIDTH,
          height: KB_CARD_MIN_HEIGHT,
          scale: KB_CARD_SCALE,
          type: 'jpeg',
          quality: KB_CARD_JPEG_QUALITY,
          fullPage: true,
          timeoutMs: shot.timeoutMs ?? KB_CARD_RENDER_TIMEOUT_MS,
          signal: shot.signal,
        })
        // 头像没下载到时是剪影，下次可能就有了：不缓存
        if (safeImage(view.images.portrait)) cache.set(key, out)
        return out
      })
    },
    cached: (view) => cache.get(kbCardKey(view)),
    clear: () => cache.clear(),
  }
}
