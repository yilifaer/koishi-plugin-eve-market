// 读者来信、今日运势、分类广告：从 copy/ 里按语气取池子，按「人物 ID + UTC 日期」固定挑选，同一张卡不重复。

import type { KbToneMode, PilotFortune, PilotLetter } from '../types'
import { AD_LINES, FORTUNE_LINES, LETTER_LINES } from './copy'
import { chooseLine, fillTemplate, tonePool } from './persona'
import type { CopyValues } from './persona'

export interface ExtrasContext {
  values: CopyValues
  tone: KbToneMode
  /** 人物 ID + UTC 日期 */
  seed: string
  used: Set<string>
}

/** 读者来信一封；署名和正文一样填占位符，署名缺数据就跳过这封；署名不参与去重 */
export function pickLetter(ctx: ExtrasContext): PilotLetter | null {
  const pool = tonePool(ctx.tone, LETTER_LINES)
  // 正文和署名配成对再过滤，正文相同的只留第一封
  const pairs: PilotLetter[] = []
  for (const l of pool) {
    const body = fillTemplate(l.body, ctx.values)
    const sign = fillTemplate(l.sign, ctx.values)
    if (body !== null && sign !== null && !pairs.some((p) => p.body === body)) pairs.push({ body, sign })
  }
  const body = chooseLine(pairs.map((p) => p.body), {}, `${ctx.seed}:letter`, ctx.used)
  if (body === null) return null
  return pairs.find((p) => p.body === body) ?? null
}

/** 从一个池子里不重复地挑 n 句 */
function chooseMany(pool: readonly string[], n: number, ctx: ExtrasContext, key: string): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const line = chooseLine(pool, ctx.values, `${ctx.seed}:${key}:${i}`, ctx.used)
    if (line) out.push(line)
  }
  return out
}

/** 今日运势：宜 2、忌 2、点评 1 */
export function pickFortune(ctx: ExtrasContext): PilotFortune {
  const yi = tonePool(ctx.tone, { gentle: FORTUNE_LINES.gentle.yi, snarky: FORTUNE_LINES.snarky.yi })
  const ji = tonePool(ctx.tone, { gentle: FORTUNE_LINES.gentle.ji, snarky: FORTUNE_LINES.snarky.ji })
  const comments = tonePool(ctx.tone, { gentle: FORTUNE_LINES.gentle.comments, snarky: FORTUNE_LINES.snarky.comments })
  return {
    yi: chooseMany(yi, 2, ctx, 'yi'),
    ji: chooseMany(ji, 2, ctx, 'ji'),
    comment: chooseLine(comments, ctx.values, `${ctx.seed}:fortune`, ctx.used) ?? '',
  }
}

/** 分类广告一条 */
export function pickAd(ctx: ExtrasContext): string | null {
  return chooseLine(tonePool(ctx.tone, AD_LINES), ctx.values, `${ctx.seed}:ad`, ctx.used)
}

