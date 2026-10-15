// KB 人物卡的文案：全部是数据，想改说法改对应文件里的句子。
// personas = 人设的标题和导语；remarks = 锐评、读者来信、近况；titles = 称号；extras = 运势、广告。

export { AD_LINES, FORTUNE_LINES } from './extras'
export type { FortuneLines } from './extras'
export { PERSONA_LINES } from './personas'
export type { PersonaLines } from './personas'
export { LETTER_LINES, MOOD_LINES, REMARK_LINES } from './remarks'
export type { LetterLine, MoodKey } from './remarks'
export { TITLE_COPY } from './titles'
export type { TitleCopy } from './titles'
export type { ToneLines } from './types'
