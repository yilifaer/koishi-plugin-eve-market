# 发布到 npm

插件通过 GitHub Actions 里的「Publish to npm」工作流发布（`.github/workflows/publish.yml`）：检查版本号还没发布过 → typecheck、test、build、检查数据快照 → `npm publish` → 打上 `v<版本>` 标签。

## 第一次发布：用 NPM_TOKEN

第一次发布时 npm 上还没有这个包，没法设置受信任发布，只能用一次令牌。

1. 登录 npmjs.com → 右上角头像 → **Access Tokens** → **Generate New Token**，选 **Granular Access Token**。
2. 名称随便填（例如 `eve-market-first-publish`），有效期选 **7 天**；**Packages and scopes** 选 **Read and write**、**All packages**（包还不存在，没法只选它）。页面上如果有「绕过两步验证（bypass 2FA）」的选项，按页面说明勾上，否则工作流里没法输入验证码。
3. 点生成以后**马上复制**令牌：它只显示这一次。不要截图，不要发到任何聊天里。
4. 打开 GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，名字填 `NPM_TOKEN`，值粘贴刚才的令牌。
5. 打开仓库的 **Actions** → 左边选 **Publish to npm** → **Run workflow**，等它跑完（绿色勾）。
6. 发布成功后，在 npmjs.com 的包页面 → **Settings** → **Trusted Publisher** 里选 GitHub Actions，填：组织或用户 `yilifaer`、仓库 `koishi-plugin-eve-market`、工作流文件 `publish.yml`。
7. 回到 GitHub 删掉 `NPM_TOKEN` 这个 Secret，再到 npmjs.com 的 Access Tokens 里撤销（Delete）这个令牌。
8. 可选：包的 Settings 里把发布权限改成「需要两步验证、不允许用令牌发布」，以后只能经受信任发布。

## 以后每次发布

1. 改 `package.json` 里的 `version`（测试版是 0.0.x），和改动一起提交到 main。
2. 发版前先跑 `npm run snapshot` 更新自带的数据快照，一起提交。
3. **Actions** → **Publish to npm** → **Run workflow**。版本号已经发布过时工作流会直接失败，不会覆盖。

发布后 Koishi 的插件市场要过一段时间才收录新版本（通常几个小时）。
