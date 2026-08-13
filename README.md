# UI Flow Chart

AI 驱动的网站功能路径分析工具。填入 AI 接口与目标网址，AI 会自主探索站点、逐屏截图建图，实时渲染成可缩放的交互流程画布；同一个窗口还是一个类 Figma 的真机模拟预览器，AI 遇到登录墙或验证码时可以直接接手操作。

## 安装

到 [Releases](../../releases) 下载 `UI Flow Chart-x.y.z-setup.exe`。

安装包目前**未做代码签名**，Windows 会提示「未知发布者」，需要点「更多信息 → 仍要运行」。介意的话可以先核对 SHA256（每个 Release 的说明里都附了）：

```bash
certutil -hashfile "UI Flow Chart-0.1.0-setup.exe" SHA256
```

应用会自动检查更新（可在设置里关掉），新版本从 GitHub Release 下载，重启后生效；探索进行中不会自动重启。

## 从源码运行

```bash
npm install
npm run dev
```

1. 在「AI 接口设置」里新建一个配置：填 Base URL、模型名与 API Key，点「测试连接」。
2. 在「项目」里新建项目：填目标网址、选模拟设备、写探索目标。
3. 打开项目进入工作台，点「开始探索」。左侧画布会随探索实时长出界面节点。
4. 需要真人操作时会自动暂停并提示，在右侧预览窗口里手动完成后点「结束接管」。
5. 随时可「导出 HTML」（自包含单文件，可直接转发）或「导出 PNG」。

## 能力

| 能力 | 说明 |
| --- | --- |
| AI 接口 | 内置 OpenAI 兼容与 Anthropic Messages 两种协议，自定义 Base URL / 模型 / 附加请求头 |
| 凭证安全 | API Key 经系统安全存储加密落盘，界面与 IPC 只出掩码 |
| 设备模拟 | iPhone 14 Pro Max / iPhone SE / Pixel 7 / iPad / 桌面多档，UA、视口、DPR、触摸、客户端提示一并模拟 |
| 真机预览 | 设备外框内实时交互预览，可切设备、导航、后退刷新 |
| 自动探索 | AI 每步看截图 + 控件清单决定下一步，逐屏命名、建边、标注操作类型 |
| 人工接管 | AI 卡住或你主动接手时转为被动录制，界面每变化一次自动截图入库 |
| 流程画布 | 泳道分组、曲线走线、标注自动避让、缩放平移、跟随新界面 |
| 导出 | 自包含 HTML（图片内联）与整幅 PNG |
| 后台运行 | 探索活在主进程，离开工作台照常继续；项目列表实时显示状态，需要人工时发系统通知并闪任务栏 |
| 主题 | 浅色 / 深色 / 跟随系统，默认跟随系统 |

## 命令

```bash
npm run dev          # 开发模式
npm run build        # 类型检查 + 三端构建
npm test             # 单元测试（vitest）
npm run test:e2e     # 端到端测试（Playwright 驱动 Electron）
npm run selfcheck    # 引擎自检：设备模拟、输入坐标、截图、探针
npm run test-site    # 单独起内置测试站
npm run mock-ai      # 单独起 mock AI 服务
```

全流程自检（测试站 + mock AI + 一整轮探索，全离线）：

```bash
powershell -File scripts/explore-check.ps1            # 注册流程
powershell -File scripts/explore-check.ps1 takeover   # 登录 → 验证码 → 人工接管
powershell -File scripts/explore-check.ps1 badjson    # AI 输出坏 JSON 的降级路径
```

## 架构

```
src/
├─ shared/           主与渲染进程共用：数据模型、IPC 契约、设备预设、画布几何内核
├─ main/
│  ├─ engine/        CDP 页面驱动、界面探针、探索状态机、人工录制、图谱存储
│  ├─ ai/            两种协议的 provider、提示词构造、动作解析
│  ├─ store/         设置、加密凭证、项目工程
│  └─ export/        单文件 HTML 与 PNG 导出
├─ preload/          contextBridge 强类型桥
└─ renderer/         React 界面：项目、工作台、画布、预览、设置
```

几个关键决定：

- **抓取与预览共用同一个 WebContentsView**。人工接管时不需要在两套环境之间切换，登录态天然连续。
- **状态机活在主进程**。渲染进程刷新或崩溃都不会打断正在跑的探索。
- **画布几何是纯函数**。实时画布与导出的 HTML 共用同一份布局、走线与标注避让代码，标注避让函数直接序列化进导出产物，两处渲染不会不一致。
- **每步 AI 请求相互独立**，不累积对话历史，状态靠摘要携带，token 可控且抗上下文漂移。

## 工程目录

每个项目在 `文档/UIFlowChart/projects/<id>/` 下：

```
project.json      项目配置
graph.json        图谱（泳道 / 节点 / 连线）
screens/          每屏原图与缩略图
session.jsonl     逐步事件流，可审计可重放
events.jsonl      人工接管期的控件事件（只记控件标识，不含任何输入值）
```

## 实现中踩到并已处理的坑

这些都是实测撞出来的，不是理论推演：

- **全新的 `WebContentsView` 还没有渲染进程**，此时发 `Emulation.*` 会永久挂起。先载入 `about:blank` 拉起渲染进程再铺 override，仍早于目标站首个请求。
- **CDP 输入坐标是在缩放后的空间里解释的**，页面收到的是发送值除以 `scale`。派发前要把 CSS 坐标乘以 scale，否则缩放 0.7 时点击偏差近百像素。
- **`Input.setIgnoreInputEvents` 会连 CDP 派发的事件一起吞掉**，开启后自动点击全部失效且不报任何错。改用页内自动化时间窗来识别真实用户输入。
- **页面导航期间 `executeJavaScript` 与 CDP 命令都可能永不返回**，缺超时会让探索循环静默卡死。
- **`Sec-CH-UA` 系列只出现在子资源请求上**，顶层导航请求只带 UA 字符串，断言客户端提示要到子资源里取。
- **端口 4190 在 Chromium 受限端口黑名单里**（sieve），`fetch` 直接以 `bad port` 失败。
- **纯说明性的 `<label>` 不该报成可交互元素**，否则「手机号」会优先匹配到标签而不是输入框。
- **只按坐标填表会落到相邻字段上**，点击后要核对焦点身份再写入。
- **验证码启发式不要匹配正文关键词**。「验证码」「图形验证」在正常页面的说明文字里很常见，交给有视觉的 AI 判断更准；启发式只管 AI 看不见的跨域 iframe 与 URL 特征。
- **设备模拟只管客户端视口，不改请求身份**。`setDeviceMetricsOverride` 之类只影响页面内看到的 `innerWidth`/`devicePixelRatio`，服务器收到的仍是默认的 UA 与客户端提示；实测顶层导航请求默认**不带** `Sec-CH-UA` 系列（只有子资源带）。按客户端提示判端的站点因此照样回 PC 版 HTML，看起来就是「模拟没生效」。请求身份必须单独在 session 网络层钉死：`session.setUserAgent` 要抢在 `WebContentsView` 创建**之前**调用（它不影响已存在的 WebContents），再用 `webRequest.onBeforeSendHeaders` 对每个请求强制覆盖 UA 与 `Sec-CH-UA-*`。
- **不要把裸 CDP 换成 `webContents.enableDeviceEmulation`**。两者底层是同一套 Blink 模拟（都构造 `blink::DeviceEmulationParams`），但 Chromium 的 CDP `EmulationHandler` 会缓存参数并在渲染帧变更时自动重推，原生 API 不会——实测跨源导航后原生方案掉回视图真实尺寸（430×932 变 415×900、dpr 3 变 1.5）。而且 `DeviceEmulationParams` 里没有 touch 字段，原生 API 根本不模拟触摸。对照实验保留在 `src/main/emulation-lab.ts`（`UFC_EMULAB=... electron .` 可复跑）。
- **CDP 的 scale 与原生视图尺寸必须来自同一次计算**。布局切换时 ResizeObserver 会连发多次矩形，若两者取自不同快照，视图会比 `宽度×缩放` 窄，Chromium 把布局视口撑到视图宽度，页面就被裁掉两侧——而 `innerWidth` 仍然报 430，光看它查不出来。视口同步因此走串行队列，`open()` 期间也定住矩形快照。
- **设备外框不能只靠 `flex: 1` 撑开**。父级是 `align-items: center` 的 flex 时，高度会退化成内容高度，屏幕区塌成几十像素，人工接管时根本点不动。尺寸改为按可用空间与设备宽高比在 JS 里算。

## 已知限制

- Safari 档位底层仍是 Chromium，UA 字符串可以伪装但客户端提示无法完全仿真，指纹级检测可识破。遇到反爬硬墙一律走人工接管，不做绕过。
- 同一时刻只支持一个项目在探索。
- 安装包未做代码签名，首次安装会有 SmartScreen 提示。

## 发布与更新

打包与发版走 `electron-builder` + GitHub Actions，应用内更新走 `electron-updater`。
完整方案（含许可证选型、签名取舍、数据迁移）见 [docs/release-and-update.md](docs/release-and-update.md)。

```bash
npm run icon          # 由 scripts/make-icon.mjs 重新生成 build/icon.{svg,png,ico}
npm run dist          # 本地产出 release/ 下的安装包
npm version patch     # 版本号唯一来源是 package.json
git push --follow-tags  # 推标签触发 CI 打包并发草稿 Release
```

## 许可证

[MIT](LICENSE)。依赖链许可证：Electron / React / zustand / zod / electron-updater 为 MIT，lucide-react 为 ISC。
