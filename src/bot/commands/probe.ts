// 批量清单待办要知道的两件事（前置中间件问）：这一行是不是全是表头参数、能不能识别成物品。
// core 还没准备好时一律「不是」，前置中间件只按行数判断。

import type { Session } from 'koishi'
import { normalizeLine, parseHeaderLine, readLine } from '../../core/parse'
import type { ListProbe } from '../prefix'
import { buildAccess } from '../scope'
import type { CommandContext } from './context'

export function listProbe(commands: Pick<CommandContext, 'core' | 'settings'>): ListProbe {
  return {
    isHeader(line: string, session: Session): boolean {
      const core = commands.core.current()
      if (!core) return false
      const access = buildAccess(session, commands.settings.access)
      const result = parseHeaderLine(normalizeLine(line), (phrase) => core.markets.match(phrase, access)?.key ?? null)
      return !('ok' in result) && result.kind === 'header'
    },
    isItem(line: string): boolean {
      const core = commands.core.current()
      if (!core) return false
      return readLine(normalizeLine(line), { flattened: false }).hypotheses.some((h) => 'item' in core.items.resolveLine(h.name))
    },
  }
}
