// 从一行的几种读法里选一个（§6.5.2）。识别交给调用方（judge），这里只管规则：
// 1. 先看整行的读法；都认不出时才看去掉表头参数的读法（第一行「Jita Raven*2」）；
// 2. 分列行的数量列、末尾乘号这种明确的写法，能认出就用；
// 3. 否则取识别得最好的（不带 ≈ 的优先），一样好时取名字最长的（Cap Booster 800 100 → Cap Booster 800 ×100）；
// 4. 压平的分列行只接受 0–2 档（不带 ≈），免得半个名字被当成前缀命中。

import type { PasteHeader, PasteLine, PasteParse } from '../types'
import type { Hypothesis } from './quantity'

/** judge 的结果：approx = 唯一前缀命中（显示时加 ≈）；认不出（含要用户确认的档位）返回 null */
export interface Judged<R> {
  approx: boolean
  value: R
}

export type Judge<R> = (name: string) => Judged<R> | null

export interface Choice<R> {
  hypothesis: Hypothesis
  value: R
  approx: boolean
}

const PREFERRED = new Set(['columns', 'explicit'])

function better<R>(a: Choice<R>, b: Choice<R>): boolean {
  if (a.approx !== b.approx) return !a.approx
  return a.hypothesis.name.length > b.hypothesis.name.length
}

function chooseInGroup<R>(group: readonly Hypothesis[], judged: (name: string) => Judged<R> | null): Choice<R> | undefined {
  let best: Choice<R> | undefined
  for (const hypothesis of group) {
    const result = judged(hypothesis.name)
    if (!result) continue
    if (hypothesis.kind === 'flattened' && result.approx) continue
    const choice = { hypothesis, value: result.value, approx: result.approx }
    if (hypothesis.kind && PREFERRED.has(hypothesis.kind)) return choice
    if (!best || better(choice, best)) best = choice
  }
  return best
}

/** 同一个名字只问一次 judge */
function memoize<R>(judge: Judge<R>): Judge<R> {
  const cache = new Map<string, Judged<R> | null>()
  return (name) => {
    if (!cache.has(name)) cache.set(name, judge(name))
    return cache.get(name) ?? null
  }
}

export function chooseHypothesis<R>(hypotheses: readonly Hypothesis[], judge: Judge<R>): Choice<R> | undefined {
  const judged = memoize(judge)
  return chooseInGroup(hypotheses.filter((h) => !h.stripped), judged)
    ?? chooseInGroup(hypotheses.filter((h) => h.stripped), judged)
}

/** 认不出时拿来找「是不是：X」的读法：第一行开头有参数时用去掉参数的那种，否则用最可能的那种 */
export function primaryHypothesis(line: Pick<PasteLine, 'hypotheses'>): Hypothesis | undefined {
  const hypotheses: readonly Hypothesis[] = line.hypotheses
  return hypotheses.find((h) => h.stripped) ?? hypotheses[0]
}

export interface LineSelection<R> {
  line: PasteLine
  /** 没有能接受的读法时没有（这一行进「未识别」） */
  choice?: Choice<R>
  primary?: Hypothesis
}

export interface PasteSelection<R> {
  /** 第一行开头的参数只在那一行用了去掉参数的读法（或者整行都认不出）时才算数 */
  header: PasteHeader
  lines: Array<LineSelection<R>>
}

/** 给每一行选一个读法，顺带算出最终的表头 */
export function selectHypotheses<R>(parse: Pick<PasteParse, 'header' | 'lines'>, judge: Judge<R>): PasteSelection<R> {
  let header = parse.header
  const judged = memoize(judge)
  const lines = parse.lines.map((line) => {
    const choice = chooseHypothesis(line.hypotheses, judged)
    const hypotheses: readonly Hypothesis[] = line.hypotheses
    if (choice && !choice.hypothesis.stripped && hypotheses.some((h) => h.stripped)) header = {}
    return { line, choice, primary: primaryHypothesis(line) }
  })
  return { header, lines }
}
