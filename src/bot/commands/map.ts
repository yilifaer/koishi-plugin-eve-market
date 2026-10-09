// 势力图、联盟势力图（§2.10）：发本地缓存里的图片原样（不转码）。缓存是空的、3 秒内下载不完时先发一次慢提示
// （单聊额度少 1 条，留不出图片时不发）。下载失败但有旧图时发旧图；连旧图都没有回一句「暂时获取不到」。
// 图片下面的说明文字（和图片合成一条）要等样式自检确认客户端会显示以后才打开（常量 MAP_CAPTION）。

import { IMAGE_MAX_BYTES, MAP_CAPTION } from '../../constants'
import type { CommandId } from '../../constants'
import { formatAgo } from '../../core/format'
import { isFailure } from '../../core/types'
import type { CoreFailure, InfluenceMap, InfluenceMapKind } from '../../core/types'
import { invoke } from './context'
import type { CommandContext, Invocation } from './context'
import { startSlowHint } from './slow'
import { MAP, SAY } from './text'

const COMMANDS: Record<InfluenceMapKind, CommandId> = { influence: 'influenceMap', coalition: 'coalitionMap' }

export function registerMaps(commands: CommandContext): void {
  for (const kind of ['influence', 'coalition'] as const) {
    const id = COMMANDS[kind]
    commands.registry.register(id, { description: `${MAP.name[kind]}：欧服${kind === 'influence' ? '主权' : '联盟'}影响力图（来源 Verite）` })
      ?.action(async ({ session }) => {
        if (!session) return
        await invoke(commands, id, session, (inv) => runMap(inv, kind))
      })
  }
}

async function runMap(inv: Invocation, kind: InfluenceMapKind): Promise<void> {
  const name = MAP.name[kind]
  const hint = inv.core.maps.cached(kind) ? undefined : startSlowHint(inv, 1, () => MAP.hint(name))
  const map = await inv.core.maps.get(kind).finally(() => hint?.stop())
  await hint?.sent()
  if (isFailure(map)) return mapFailure(inv, kind, map)
  if (map.body.length > IMAGE_MAX_BYTES) {
    await inv.reply.text(MAP.tooLarge(name))
    return
  }
  const sent = await inv.reply.image(map.body, map.mime, MAP_CAPTION ? caption(inv, map) : undefined)
  if (!sent) await inv.reply.text(MAP.sendFailed(name))
}

/** 欧服势力图 · 来源 Verite · 图片更新于 10/07 08:00；更新失败、发的是旧图时写多久以前 */
export function caption(inv: Pick<Invocation, 'core' | 'commands'>, map: InfluenceMap): string {
  const name = MAP.name[map.kind]
  if (map.stale) return MAP.staleCaption(name, formatAgo((inv.commands.clock.now() - map.updatedAt) / 1000))
  return MAP.caption(name, inv.core.format.clock(map.updatedAt))
}

async function mapFailure(inv: Invocation, kind: InfluenceMapKind, failure: CoreFailure): Promise<void> {
  const name = MAP.name[kind]
  switch (failure.code) {
    case 'NOT_CONFIGURED':
      await inv.reply.text(MAP.notConfigured(name))
      return
    case 'DATA_NOT_READY':
      await inv.reply.text(SAY.loading)
      return
    default:
      await inv.reply.text(failure.reason === 'too-large' ? MAP.tooLarge(name) : MAP.unavailable(name))
  }
}
