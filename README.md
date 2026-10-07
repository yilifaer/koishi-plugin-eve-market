# koishi-plugin-eve-market（测试版）

> 0.0.x 是测试版：功能还在陆续加入，配置项和命令的写法可能还会变。第一个正式版是 0.1.0。

EVE Online market helper for the official QQ bot, as a Koishi plugin (Tranquility server). It answers item price queries for the NPC trade hubs and configured markets, appraises pasted lists and EFT fittings, and searches items by Chinese or English name, pinyin or common slang. It only replies on the official QQ platform (adapter-qq) and leaves other platforms such as OneBot alone. All replies are in Chinese.

EVE Online 欧服（Tranquility）市场助手，Koishi 插件，**只在 QQ 官方机器人上回复**。

## 0.0.1 能做什么

| 命令 | 例子 | 说明 |
|---|---|---|
| 查价 | `查价 乌鸦级`、`查价 Jita PLEX*500` | 本群默认市场（或指定市场）的出售、中间、收购价，和 Jita 比较的涨跌 |
| 批量查价 | `批量查价` 换行后粘贴清单或 EFT 装配 | 合计、调整（`-5%`、`95%`、`95折`）、改用别的市场或价格类型、装配估价、运费 |
| 搜索 | `搜索 乌鸦`、`搜索 乌鸦级` | 按名字找物品，或者列出相关物品，每一行带价格 |
| 本群ID | `本群ID` | 查看本群和自己的完整 ID（填「授权群」「管理员」时用） |
| 帮助 | `帮助`、`帮助 批量查价` | 用法 |

- 群里先 @机器人 再输入；单聊直接发。
- 中文名、英文名、常用简称（黑话）、拼音都可以；有几个可能时会列出来让你点选，也可以 @机器人 回复编号。
- 走势图、联盟建筑市场（EVE 授权）、入侵、势力图、战报、服务器状态、翻译会在后面的测试版里加入；制造和反应在 0.2.0。

## 安装

1. 打开 Koishi 控制台的「插件市场」，搜索 `koishi-plugin-eve-market`，**确认作者是 yilifaer**，点安装。
2. 插件需要 `database`（任意一种数据库插件，例如 database-sqlite）和 `http` 服务（Koishi 自带）。
3. QQ 官方机器人用的是 adapter-qq；其他平台（例如 LLBot 的 OneBot）上的消息插件一律不碰。
4. 启用插件，先看一眼配置里的「市场」表格：预置了 Jita 和另外四个 NPC 交易中心，可以改、删、加。
5. 在群里 @机器人 发「本群ID」，把群 ID 填进「授权群」，把自己的 ID 填进「管理员」。

升级：插件市场里点更新。回滚：「依赖管理」里选回上一个版本。注意：安装、升级、卸载插件都会让 Koishi 整体重载一次，挑群里没人说话的时候做。

配置写错的行会被跳过（插件照常加载），Koishi 日志里会写明是哪一行、哪里不对。

## 数据从哪里来

- 物品、工业、星图数据：由 [eve-cn-slang](https://github.com/yilifaer/eve-cn-slang) 每周从 CCP 发布的静态数据（SDE）生成。插件启动后在线检查更新；下载不了时用本地缓存，再不行用包里自带的快照。
- 价格：EVE 的 ESI 接口（欧服），遵守 ESI 给的缓存时间和限流。
- 简称、黑话：EVE Online 中文黑话表（同一个仓库的 `glossary.yaml`）。

## 许可与致谢

- 代码：MIT，见 [LICENSE](LICENSE)。
- EVE 的数据（自带快照、在线下载的数据、ESI 返回的内容）按 EVE 开发者许可协议使用，只限非商业用途。© 2014 CCP hf. All rights reserved. "EVE", "EVE Online", "CCP", and all related logos and images are trademarks or registered trademarks of CCP hf.
- 黑话表：EVE Online 中文黑话表（github.com/yilifaer/eve-cn-slang），CC BY 4.0。
- 致谢 yyyhf：部分功能设计和 BR 链接匹配规则参考了 @yyyhf/koishi-plugin-evemarket2 0.1.5、eveonline-rq 0.0.4、eveonline-influence-map 1.0.5、eve-br 0.0.3（MIT License）。本插件是重新写的，没有复制它们的代码。

完整的许可说明见 [NOTICE.md](NOTICE.md) 和 [data/NOTICE.md](data/NOTICE.md)。

## 更新记录

- 0.0.1（测试版）：查价、批量查价（含装配估价、运费）、搜索、本群ID、帮助。
