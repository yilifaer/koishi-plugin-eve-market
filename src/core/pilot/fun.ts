// 把一张 KB 卡上的「整活儿」部分一次组好：标题、导语、近况、称号、锐评、读者来信、今日运势、分类广告。
// 全部按「人物 ID + UTC 日期」固定挑选（同一个人同一天不变，隔天换），整张卡共用一个 used 集合，保证没有重复的句子。
// 战绩暂缺（zKill 没取到）的人不开涮：没有近况、称号、锐评、读者来信；战绩为零的人没有近况、称号、锐评。

import type { KbToneMode, PilotFortune, PilotLetter } from '../types'
import { pickAd, pickFortune, pickLetter } from './extras'
import type { CardFacts } from './facts'
import { composeCopy, pickMood } from './persona'
import type { CopyValues, MoodInput } from './persona'
import { pickRemarks } from './remarks'
import { pickTitles } from './titles'

export interface FunInput {
  characterId: number
  /** UTC 日期 YYYY-MM-DD */
  dayKey: string
  tone: KbToneMode
  facts: CardFacts
  values: CopyValues
  mood: MoodInput
}

export interface FunCopy {
  headline: string
  lede: string
  mood: string | null
  titles: string[]
  remarks: string[]
  letter: PilotLetter | null
  fortune: PilotFortune
  ad: string | null
}

export function composeFun(input: FunInput): FunCopy {
  const { facts, values, tone } = input
  const seed = `${input.characterId}:${input.dayKey}`
  const used = new Set<string>()
  const quiet = facts.persona === 'ghost' || facts.persona === 'unknown'
  const titles = pickTitles(facts)
  const { headline, lede } = composeCopy(facts.persona, input.characterId, input.dayKey, values, tone, used)
  const mood = quiet ? null : pickMood(input.mood, values, tone, seed, used)
  const remarks = pickRemarks(facts, titles, { values, tone, seed, used })
  const ctx = { values, tone, seed, used }
  return {
    headline,
    lede,
    mood,
    titles: titles.map((t) => t.label),
    remarks,
    letter: facts.persona === 'unknown' ? null : pickLetter(ctx),
    fortune: pickFortune(ctx),
    ad: pickAd(ctx),
  }
}
