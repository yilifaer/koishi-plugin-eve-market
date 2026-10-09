# 发布到 npm

插件通过 GitHub Actions 里的「Publish to npm」工作流发布（`.github/workflows/publish.yml`）：检查版本号还没发布过 → typecheck、test、build、检查数据快照 → `npm publish` → 打上 `v<版本>` 标签。

发布时 npm 先试「受信任发布」（Trusted Publisher，不需要令牌），不行再用仓库里的 `NPM_TOKEN`。

## 第一次发布：用一次令牌

受信任发布要求包已经在 npm 上存在，所以第一个版本只能用令牌发。发完就删掉令牌，以后都用受信任发布。

1. 登录 npmjs.com（会要两步验证）→ 右上角头像 → **Access Tokens** → **Generate New Token**。
2. 按下面填写：
   - 名称：例如 `eve-market-first-publish`；
   - 有效期：**7 天**；
   - **Packages and scopes**：选 **Read and write**，再选 **publish and stage**（不要选 stage only，否则发布时报 `E_STAGE_REQUIRED`）；范围选 **All packages**（包还不存在，没法只选它）；
   - 勾上 **Bypass 2FA**（绕过两步验证）。不勾的话 GitHub 上没法输入验证码，发布会失败（报 `EOTP` 或 `E403`）。
3. 点生成以后**马上复制**令牌：它只显示这一次。不要截图，不要发到任何聊天里。
4. 打开 GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：名字填 `NPM_TOKEN`，值粘贴刚才的令牌。已经有一个旧的 `NPM_TOKEN` 时点它旁边的 **Update** 换成新的。
5. 打开仓库的 **Actions** → 左边选 **Publish to npm** → **Run workflow** → 分支选 `main` → 点绿色按钮，等它变成绿色的勾。
6. 打开 `https://www.npmjs.com/package/koishi-plugin-eve-market`，确认版本号出来了。
7. 当天收尾：在 npmjs.com 的 Access Tokens 里删掉这个令牌，再到 GitHub 的 Secrets 里删掉 `NPM_TOKEN`。

> npm 已经宣布，2027 年 1 月起这种令牌不能再直接发布（只能「暂存」一个版本，等本人批准）。按上面的做法令牌只用一次，以后不受影响。

## 改成受信任发布（下次要发新版本的那天做）

1. 先把新的版本号改好，提交到 main。
2. npmjs.com 的包页面 → **Settings** → **Trusted Publisher** → **GitHub Actions**，填：
   - 用户或组织：`yilifaer`
   - 仓库：`koishi-plugin-eve-market`
   - 工作流文件：`publish.yml`
   - Environment：留空
   - **Allowed actions 里勾上「npm publish」**（新建的设置默认只允许「暂存」）。
3. **设好以后 2 天内必须成功发布一次**，否则这个设置会过期，只能删掉重建。所以设好后马上做下一步。
4. 想先确认设置对不对：**Actions** → **Publish to npm** → **Run workflow**，勾上「只检查受信任发布有没有设置好（不发布）」再运行。看到「受信任发布已经设置好」就对了，这一步不会发布任何东西。
5. 再运行一次 **Publish to npm**（不勾那个选项），真正发布。成功后，新版本在 npm 上的发布者显示「GitHub Actions」。
6. 可选：包的 **Settings** → **Publishing access** 选「Require two-factor authentication and disallow tokens」，以后只能经受信任发布来发。

## 以后每次发布

1. 改 `package.json` 里的 `version`（测试版是 0.0.x），和改动一起提交到 main。
2. 发版前先跑 `npm run snapshot` 更新自带的数据快照，一起提交。
3. **Actions** → **Publish to npm** → **Run workflow**。版本号已经发布过时工作流会直接失败，不会覆盖。

发布后 Koishi 的插件市场要过一段时间才收录新版本（通常几个小时）。

## 常见报错

| 报错 | 原因 |
|---|---|
| `E_STAGE_REQUIRED` | 令牌选成了 stage only，重新生成一个选 publish and stage 的 |
| `EOTP` 或 `E403 … Two-factor authentication … is required` | 令牌没勾 Bypass 2FA |
| `ENEEDAUTH`、`Unable to authenticate`、`E404 Not Found - PUT …` | 没有令牌，或者令牌过期、删了；改成受信任发布以后出现，就是 Trusted Publisher 里填的信息和仓库对不上，或者没勾「npm publish」 |
| 「版本 X 已经发布过了」 | 先改 `package.json` 里的 `version` |
