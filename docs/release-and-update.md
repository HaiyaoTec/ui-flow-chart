# 发布与自动更新方案

面向 GitHub 开源发布的完整方案：许可证、打包、发布流水线、应用内更新、以及与探索会话的协同。

**当前状态**：一至六节均已落地（许可证 MIT、electron-builder 打包、两条 GitHub Actions、
electron-updater 接入、数据迁移框架）。唯一没做的是第七节第 5 步——真实的跨版本升级验证，
它需要先发出两个相邻版本，只能在仓库推上 GitHub 之后做。

---

## 一、许可证

已采用 **MIT**（`LICENSE`）。

依赖链全部兼容：Electron / React / zustand / zod 为 MIT，lucide-react 为 ISC，二者都允许闭源再分发，不会反向约束本项目。若希望额外获得**专利授权与商标条款**（企业采用时更常被法务接受），选 **Apache-2.0**，代价是需要保留 `NOTICE` 并在修改文件中标注变更。

两者都不要求使用者开源自己的产物，符合「工具类桌面应用」的常见预期。GPL 系不建议：会传染到把本工具嵌入自有流程的使用者。

需要落地的文件：

- `LICENSE`（选定后放仓库根）
- `package.json` 增加 `"license": "MIT"`、`"repository"`、`"author"`
- `README.md` 底部注明许可证与第三方依赖许可证清单

---

## 二、打包

配置见 `electron-builder.yml`。几个选择的理由：

- `files` 只收 `out/**` 与 `package.json`：源码、测试、内置测试站不进安装包
- NSIS 而非 oneClick：允许用户选安装目录；`perMachine: false` 走单用户安装，免 UAC
- `publish.provider: github` 不写 owner/repo：CI 与本地都从 git remote 推断，fork 后无需改配置
- `releaseType: draft`：产物先进草稿，人工确认齐全再 Publish，避免半成品被用户拉走

- `mac.target` 同时出 dmg 与 zip，各含 x64 与 arm64：dmg 供手动下载，zip 是 electron-updater 在 macOS 上唯一能用的更新包格式
- `mac.icon` 直接给 512×512 的 png，electron-builder 自己转 icns，不必另存一份 `.icns`

**产物**：

| 平台 | 文件 |
|---|---|
| Windows | `Flow Chart-1.2.3-setup.exe`、`latest.yml`（更新元数据，必须一并发布） |
| macOS | `Flow Chart-1.2.3.dmg`、`Flow Chart-1.2.3-arm64.dmg`、对应的两个 `.zip`、`latest-mac.yml` |

**macOS 的双架构必须在同一次 electron-builder 调用里出齐**（`--mac --x64 --arm64`）：`latest-mac.yml` 不带架构后缀，两次调用会互相覆盖，只剩一个架构的条目——另一半用户要么拿不到更新（Intel 端直接报 `ERR_UPDATER_ZIP_FILE_NOT_FOUND`），要么被塞一个跑在 Rosetta 下的包。

**mac 目标只能在 macOS 主机上打**：electron-builder 在其他平台构建 mac 目标会直接抛 `Build for macOS is supported only on macOS`。

**本地打包的一个坑**：`signAndEditExecutable: true`（给 exe 写图标与版本信息）会让 electron-builder 解压 winCodeSign 工具包，包里含 macOS 的符号链接。Windows 未开「开发者模式」时创建符号链接需要管理员权限，本地 `npm run dist` 会卡在解压这一步；CI 的 runner 有该权限，不受影响。本地要打包就先开开发者模式，或用管理员终端跑一次把缓存落地。

**关键约束**：`latest.yml` / `latest-mac.yml` 是 electron-updater 的唯一事实源，缺了它自动更新就不工作。

---

## 三、发布流水线（GitHub Actions）

触发方式：推 `v*` 标签。

```yaml
# .github/workflows/release.yml 要点
on: { push: { tags: ['v*'] } }
permissions: { contents: write }          # 顶层声明，矩阵作业一并继承
jobs:
  build:
    strategy:
      fail-fast: false
      max-parallel: 1                     # 串行：并行时两个作业可能各建一个同名标签的草稿
      matrix:
        include:
          - { os: windows-latest, args: --win --x64 }
          - { os: macos-14, args: --mac --x64 --arm64 }
    runs-on: ${{ matrix.os }}
    steps:
      - actions/checkout
      - actions/setup-node (node 20, cache npm)
      - 校对标签与 package.json 版本      # 放在 npm ci 之前，对不上就别浪费时间拉依赖
      - npm ci
      - npm test                          # 单元测试进流水线；E2E 需要窗口环境，另设 workflow
      - npm run build                     # electron-builder 只装 out/，构建得自己先做
      - npx electron-builder ${{ matrix.args }} --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_IDENTITY_AUTO_DISCOVERY: false   # mac 暂不签名，免得找不到证书就中断
```

版本号唯一来源是 `package.json`，标签只是触发器。建议脚本化：`npm version patch && git push --follow-tags`。

**发布流程**：先发 **draft release**（`--publish always` 会自动建），人工确认产物齐全后再点 Publish。草稿状态下 electron-updater 不会看到它，避免半成品被用户拉走。

人工确认清单：

- Windows：`setup.exe` + `latest.yml`
- macOS：两个 `.dmg`（x64 / arm64）+ 两个 `.zip` + `latest-mac.yml`，且 `latest-mac.yml` 里两个架构的条目都在

`--mac --x64 --arm64` 产出的 `latest-mac.yml` 中 arm64 的 dmg 条目会重复出现一次（electron-builder 已知问题，对 electron-updater 无影响，它取 zip），核对时不要误判为构建失败。

---

## 四、应用内更新

用 **electron-updater**（electron-builder 配套），GitHub 公开仓库无需自建服务器。

不选 Electron 内置 `autoUpdater` 的原因：Windows 上它要求 Squirrel.Windows 且必须代码签名，`update.electronjs.org` 同样有签名要求；electron-updater 的 NSIS 差量更新在未签名场景也能跑通。

### 更新时机

| 时机 | 行为 |
|---|---|
| 启动后 30 秒 | 静默检查（避开冷启动的资源竞争） |
| 之后每 30 分钟 | 静默检查 |
| 自动下载失败后 | 同一版本按 10 分钟起步、逐次翻倍、封顶 4 小时退避，其间不再自动重试；手动点「下载」不受退避约束 |
| 设置 →「软件更新」里点「检查更新」 | 手动检查，无论结果都给反馈 |

检查本身很便宜：一次仓库 Atom 订阅源加一份几百字节的 `latest.yml`，都走 CDN，也不吃接口配额，所以间隔可以定得比较密。真正要防的是「发现新版本 → 自动下载失败 → 下次检查再下一遍」——那是个上百兆的包，网不稳或按流量计费的用户会被反复拉，所以有了上面那条退避。

macOS 上「检查」照常，但**下载与安装被关掉**（`UpdateState.manualOnly`），界面改为引导到 Release 页手动下载。原因见第五节。

### 状态机

```
idle → checking → (up-to-date | available)
available → downloading → downloaded → 等待重启
任一步出错 → error（记录日志，不打扰用户；手动检查时才弹提示）
```

### 与探索会话协同（本项目的特殊约束）

探索是长任务，且预览视图持有 CDP 连接与登录态。因此：

- **下载**可以随时进行（纯 IO，不影响会话）
- **重启安装**必须等会话进入终态。`SESSION_HOLDS_PREVIEW` 里的状态一律不允许自动重启
- 已下载但会话在跑时，界面显示「新版本已就绪，探索结束后可重启更新」，重启按钮置灰并说明原因
- 用户点「立即重启」时，若会话仍在跑，弹确认框说明会中断探索

### 界面（参考 Claude Code 桌面端的提示方式）

- 不弹窗、不抢焦点：只在界面底部出现一条窄的通知条（`UpdateBar`），说清「有新版本」与「怎么装」
- 随时可关；关掉之后**同一个版本不再打扰**，出了更新的版本才会再出现
- 探索进行中点「重启更新」会先弹确认，说明会中断探索
- 左下角「设置」→「软件更新」里有完整信息：当前版本、状态、手动检查、两个开关（自动检查 / 后台自动下载）

---

## 五、代码签名（需要你决策）

两个平台不签名的代价不是一个量级：Windows 是提示级，macOS 是功能级。

### Windows

未签名的安装包会触发 SmartScreen「未知发布者」警告，首次安装需用户点「更多信息 → 仍要运行」。三个选项：

| 方案 | 成本 | 效果 |
|---|---|---|
| 不签名 | 0 | 有警告；开源工具用户通常能接受，README 里说明即可 |
| OV 证书 | 约 ¥1000+/年 | 仍需积累 SmartScreen 信誉，前期仍可能告警 |
| EV 证书 | 约 ¥2500+/年，需硬件密钥 | 立即通过 SmartScreen，但 CI 签名要额外配置（云 HSM） |

**当前决策**：不签名，README 与 Release 说明里给出 SHA256 校验方式，用户量起来后再上 EV。

### macOS

未签名的后果有两条独立链路：

1. **Gatekeeper**：dmg 里的 app 拖进「应用程序」后首次打开会被拦，提示「已损坏」或「无法验证开发者」，用户要手动执行 `xattr -dr com.apple.quarantine`。Apple Silicon 更硬——arm64 二进制必须带签名才能执行，而 electron-builder 在没有证书时是完全跳过签名、不会退化成 ad-hoc 签名。
2. **应用内更新**：安装由 Squirrel.Mac 承担，它要先取运行中应用的代码签名再校验新包是否满足同一 designated requirement，未签名一律失败。失败形态还很有迷惑性：错误在 `dispatchUpdateDownloaded` 之前抛出，界面会停在「新版本已就绪」，点重启毫无反应。

**当前决策**：macOS 定位为「自动检查、手动更新」。

- `UpdateState.manualOnly` 标记这类安装包，界面上不出现「下载 / 重启更新」，改为「打开 Release 页」；主进程侧 `download()` 与 `install()` 也各兜一道，见 `src/main/updater.ts`
- 检查照常进行——用户仍需要知道有没有新版本
- CI 打包步骤设 `CSC_IDENTITY_AUTO_DISCOVERY: false`，避免 mac 作业因找不到证书而中断

要恢复完整链路，需要 Apple Developer Program（99 USD/年）：拿到 Developer ID Application 证书后，`electron-builder.yml` 的 mac 段补 `hardenedRuntime: true` 与 entitlements、接 notarytool 公证，release.yml 注入 `CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` 并去掉 `CSC_IDENTITY_AUTO_DISCOVERY: false`，最后把 `updater.ts` 里的 `manualOnly()` 改回 false。

---

## 六、数据兼容

自动更新意味着用户会跨版本升级，本地数据必须能向前兼容：

框架在 `src/main/store/migrate.ts`，已接到 `settings.json`（当前 `SETTINGS_SCHEMA = 1`）：

- 每个文件自带 `schemaVersion`，逐档迁移，不做跨版本的一步到位
- 动手前把原文件备份成 `*.bak`
- 失败停在最后一个成功的档位并带出原因，**不阻断启动**——升级完打不开应用是最糟的结果
- 版本比代码还新时原样放过，降级运行不会把数据改坏
- 单测覆盖以上五条（`tests/unit/migrate.test.ts`）

`profiles.json` 与 `graph.json` 尚未接入，等第一次真正需要改结构时再加，避免空跑一层。

---

## 七、落地顺序

1. 选定许可证 → 加 `LICENSE`、补 `package.json` 元信息
2. 引入 electron-builder，本地能产出可安装的 `setup.exe`
3. 加 `release.yml`，打一个 `v0.1.0` 验证流水线与产物
4. 接入 electron-updater：主进程更新模块 + IPC + 设置页界面
5. 用两个相邻版本做一次真实的端到端升级验证（装 0.1.0 → 发布 0.1.1 → 应用内升级）
6. 补数据迁移框架

第 5 步是唯一能证明方案成立的验证，不能省。
