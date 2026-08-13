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

**产物**：`UI Flow Chart-1.2.3-setup.exe`、`latest.yml`（更新元数据，必须一并发布）、以及可选的 `*.zip` 便携版。

**本地打包的一个坑**：`signAndEditExecutable: true`（给 exe 写图标与版本信息）会让 electron-builder 解压 winCodeSign 工具包，包里含 macOS 的符号链接。Windows 未开「开发者模式」时创建符号链接需要管理员权限，本地 `npm run dist` 会卡在解压这一步；CI 的 runner 有该权限，不受影响。本地要打包就先开开发者模式，或用管理员终端跑一次把缓存落地。

**关键约束**：`latest.yml` 是 electron-updater 的唯一事实源，缺了它自动更新就不工作。

---

## 三、发布流水线（GitHub Actions）

触发方式：推 `v*` 标签。

```yaml
# .github/workflows/release.yml 要点
on: { push: { tags: ['v*'] } }
jobs:
  release:
    runs-on: windows-latest
    permissions: { contents: write }      # 创建 Release 需要
    steps:
      - actions/checkout
      - actions/setup-node (node 20, cache npm)
      - npm ci
      - npm run typecheck && npm test     # 单元测试进流水线；E2E 需要窗口环境，另设 workflow
      - npx electron-builder --win --publish always
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
```

版本号唯一来源是 `package.json`，标签只是触发器。建议脚本化：`npm version patch && git push --follow-tags`。

**发布流程**：先发 **draft release**（`--publish always` 会自动建），人工确认产物齐全（`setup.exe` + `latest.yml`）后再点 Publish。草稿状态下 electron-updater 不会看到它，避免半成品被用户拉走。

---

## 四、应用内更新

用 **electron-updater**（electron-builder 配套），GitHub 公开仓库无需自建服务器。

不选 Electron 内置 `autoUpdater` 的原因：Windows 上它要求 Squirrel.Windows 且必须代码签名，`update.electronjs.org` 同样有签名要求；electron-updater 的 NSIS 差量更新在未签名场景也能跑通。

### 更新时机

| 时机 | 行为 |
|---|---|
| 启动后 30 秒 | 静默检查（避开冷启动的资源竞争） |
| 之后每 4 小时 | 静默检查 |
| 设置页「检查更新」 | 手动检查，无论结果都给反馈 |

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
- 设置页有完整信息：当前版本、状态、手动检查、两个开关（自动检查 / 后台自动下载）

---

## 五、代码签名（需要你决策）

未签名的 Windows 安装包会触发 SmartScreen「未知发布者」警告，首次安装需用户点「更多信息 → 仍要运行」。三个选项：

| 方案 | 成本 | 效果 |
|---|---|---|
| 不签名 | 0 | 有警告；开源工具用户通常能接受，README 里说明即可 |
| OV 证书 | 约 ¥1000+/年 | 仍需积累 SmartScreen 信誉，前期仍可能告警 |
| EV 证书 | 约 ¥2500+/年，需硬件密钥 | 立即通过 SmartScreen，但 CI 签名要额外配置（云 HSM） |

**建议**：起步不签名，在 README 与首个 Release 说明里写清楚校验方式（提供 SHA256），用户量起来后再上 EV。

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
