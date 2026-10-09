import type { Context } from 'koishi'
import { installPlugin } from './bot/plugin'
import { Config } from './config/schema'

export const name = 'eve-market'

// database：授权档案和 Koishi 的权限等级；http：ESI、SSO、数据下载。
// puppeteer（走势图、战报截图）和 server（EVE 授权页面）没有时相应的功能不可用，其他照常
export const inject = { required: ['database', 'http'], optional: ['puppeteer', 'server'] }

export { Config }

export const usage = `
**[打开 EVE 授权页面](/eve-market/admin)**（联盟建筑市场用；只能在运行 Koishi 的电脑上打开，经 SSH 隧道也可以）

EVE Online 欧服市场助手（测试版），**只在 QQ 官方机器人上回复**（不会在 LLBot 等 OneBot 机器人上回复）。

- 先看一眼下面的「市场」表格：预置了 Jita 和另外四个 NPC 交易中心，可以改、删、加。
- 联盟建筑市场：先在下面的「EVE 授权」里填好 EVE 开发者网站上应用的 Client ID 和 Secret Key，再点上面的「打开 EVE 授权页面」用服务角色授权。
- 授权群和管理员的 ID：在群里或私聊里 @机器人 发「本群ID」查看。管理员可以发「市场状态」「市场授权」查看各市场和授权的情况。
- 走势图和战报截图要用 Koishi 的 **puppeteer** 插件（可以以后再装，装好就能用）：没有它时「走势」只发文字卡片，「战报」回复截图服务没有启动。
- 上线前，管理员在测试群里 @机器人 发「样式自检 1」「样式自检 2」，照每条消息里写的检查 QQ 上的显示。
- 配置写错的行会被跳过，Koishi 日志和「市场状态」里会写明是哪一行、哪里不对。

详细说明见 [README](https://github.com/yilifaer/koishi-plugin-eve-market#readme)，EVE 授权的步骤见 [EVE授权.md](https://github.com/yilifaer/koishi-plugin-eve-market/blob/main/docs/EVE%E6%8E%88%E6%9D%83.md)。
`

export function apply(ctx: Context, config: Config) {
  installPlugin(ctx, config)
}
