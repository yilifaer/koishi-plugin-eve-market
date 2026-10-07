import type { Context } from 'koishi'
import { installPlugin } from './bot/plugin'
import { Config } from './config/schema'

export const name = 'eve-market'

// database：授权档案和 Koishi 的权限等级；http：ESI、SSO、数据下载。
// puppeteer（走势图、战报截图）和 server（EVE 授权页面）没有时相应的功能不可用，其他照常
export const inject = { required: ['database', 'http'], optional: ['puppeteer', 'server'] }

export { Config }

export const usage = `
EVE Online 欧服市场助手（测试版），**只在 QQ 官方机器人上回复**（不会在 LLBot 等 OneBot 机器人上回复）。

- 先看一眼下面的「市场」表格：预置了 Jita 和另外四个 NPC 交易中心，可以改、删、加。
- 授权群和管理员的 ID：在群里或私聊里 @机器人 发「本群ID」查看。
- 配置写错的行会被跳过，Koishi 日志里会写明是哪一行、哪里不对。
- 联盟建筑市场（EVE 授权页面）和管理员命令「市场状态」从 0.0.2 起提供；在那之前建筑市场会显示「暂时不可用」。

详细说明见 [README](https://github.com/yilifaer/koishi-plugin-eve-market#readme)。
`

export function apply(ctx: Context, config: Config) {
  installPlugin(ctx, config)
}
