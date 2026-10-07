import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)

// Koishi 4.18 的 ESM 入口在 Node 22 下无法加载；Koishi Desktop 实际走的是 CommonJS，测试也用 CommonJS 入口。
const cjs = (name: string) => ({ find: new RegExp(`^${name.replace(/[/]/g, '\\/')}$`), replacement: require.resolve(name) })

export default defineConfig({
  resolve: {
    alias: [
      cjs('koishi'),
      cjs('@koishijs/plugin-http'),
      cjs('@koishijs/plugin-database-memory'),
      cjs('@koishijs/plugin-help'),
      cjs('@satorijs/adapter-qq'),
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    // 故意用一个不是 UTC+8 的时区（半小时时差、还有夏令时），证明显示时间不依赖本机时区
    env: { TZ: 'America/St_Johns' },
  },
})
