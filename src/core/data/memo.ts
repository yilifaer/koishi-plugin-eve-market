// 按数据版本缓存派生结构（物品索引、别名层等）：放在模块级存储里，同一个版本在插件重载后直接复用。

import type { ModuleStore } from '../ports'

interface Slot<T> {
  key?: string
  value?: T
}

/**
 * key 和上次一样就返回上次建好的，否则调用 build 重建。每个 slot 只留最新的一份（旧版本随之释放）。
 * key 一般是 DataSet.key，依赖黑话表时再拼上 GlossaryData.key。
 */
export function memoByKey<T>(store: ModuleStore, slot: string, key: string, build: () => T): T {
  const box = store.get<Slot<T>>(`data-memo/${slot}`, () => ({}))
  if (box.key !== key || !('value' in box)) {
    box.value = build()
    box.key = key
  }
  return box.value as T
}
