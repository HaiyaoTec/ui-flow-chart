import { app } from 'electron'
import { CH, type UpdateState } from '@shared/ipc-contract'
import { SESSION_HOLDS_PREVIEW } from '@shared/types'
import { sessions } from './engine/sessionManager'
import { getSettings } from './store/settings'
import { getUiContents } from './window'

/** 冷启动后延迟一会儿再查，避开与首屏、预览初始化抢资源 */
const FIRST_CHECK_DELAY = 30_000
const CHECK_INTERVAL = 4 * 60 * 60 * 1000

const RELEASE_PAGE = 'https://github.com/HaiyaoTec/ui-flow-chart/releases/latest'

/**
 * 这个安装包只能手动更新。
 *
 * macOS 的安装由 Squirrel.Mac 承担，它要先取运行中应用的代码签名、再校验新包是否
 * 满足同一 designated requirement；本项目的 mac 包未签名（需要 Apple Developer
 * Program），这一步必失败。失败形态还特别有迷惑性：错误在 dispatchUpdateDownloaded
 * 之前抛出，界面会停在「新版本已就绪」，点重启却毫无反应。
 *
 * 所以 macOS 上只关掉「下载 + 重启安装」，检查照常——用户仍需要知道有没有新版本，
 * 只是改由 Release 页手动下载。签名之后把这里改回 false 即可恢复完整链路。
 */
function manualOnly(): boolean {
  return process.platform === 'darwin'
}

/**
 * 应用内更新。
 *
 * 发布走 GitHub Release，electron-updater 从构建时写入的 app-update.yml 里
 * 取仓库地址，公开仓库不需要自建服务器。
 *
 * 与探索会话的关系是这里唯一的特殊约束：下载纯 IO，随时可做；
 * 但重启安装会掐断 CDP 连接与登录态，必须等会话进入终态。
 */
class Updater {
  private state: UpdateState = { phase: 'idle', version: '', notes: '', percent: 0, error: '' }
  private timer: NodeJS.Timeout | null = null
  private started = false

  current(): UpdateState {
    return {
      ...this.state,
      currentVersion: app.getVersion(),
      busy: this.sessionBusy(),
      manualOnly: manualOnly(),
      downloadUrl: RELEASE_PAGE,
    }
  }

  /** 会话占着预览时不能重启：探索会中断，页面登录态也会丢 */
  private sessionBusy(): boolean {
    const s = sessions.snapshot()
    return Boolean(s.projectId) && SESSION_HOLDS_PREVIEW.includes(s.state)
  }

  private emit(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    getUiContents()?.send(CH.evUpdateState, this.current())
  }

  /**
   * 打包后才有 app-update.yml，开发模式下 electron-updater 会直接抛错。
   * 动态引入，避免开发时把它的初始化代价也背上。
   */
  private async api(): Promise<typeof import('electron-updater').autoUpdater | null> {
    if (!app.isPackaged) return null
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = false // 先问过用户设置再下，避免占用带宽
    autoUpdater.autoInstallOnAppQuit = true
    return autoUpdater
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    const up = await this.api()
    if (!up) return

    up.on('update-available', (info) => {
      this.emit({
        phase: 'available',
        version: info.version,
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
        error: '',
      })
      if (!manualOnly() && getSettings().autoDownloadUpdate) void this.download()
    })
    up.on('update-not-available', () => this.emit({ phase: 'up-to-date', error: '' }))
    up.on('download-progress', (p) => this.emit({ phase: 'downloading', percent: Math.round(p.percent) }))
    up.on('update-downloaded', () => this.emit({ phase: 'downloaded', percent: 100 }))
    up.on('error', (e) => this.emit({ phase: 'error', error: e instanceof Error ? e.message : String(e) }))

    const tick = (): void => {
      if (getSettings().autoCheckUpdate) void this.check(false)
    }
    setTimeout(tick, FIRST_CHECK_DELAY)
    this.timer = setInterval(tick, CHECK_INTERVAL)
  }

  /** manual=true 时无论结果都要给用户反馈，自动检查则安静失败 */
  async check(manual: boolean): Promise<UpdateState> {
    const up = await this.api()
    if (!up) {
      // 开发模式没有 app-update.yml，明说比抛错好
      if (manual) this.emit({ phase: 'error', error: '开发模式下不检查更新，请使用打包后的版本' })
      return this.current()
    }
    if (this.state.phase === 'downloading') return this.current()
    this.emit({ phase: 'checking', error: '' })
    try {
      await up.checkForUpdates()
    } catch (e) {
      this.emit({ phase: 'error', error: e instanceof Error ? e.message : String(e) })
    }
    return this.current()
  }

  async download(): Promise<UpdateState> {
    // 未签名的 mac 包下载下来也装不上，界面上本就不给下载按钮，这里再兜一道
    if (manualOnly()) return this.current()
    const up = await this.api()
    if (!up || this.state.phase === 'downloading' || this.state.phase === 'downloaded') return this.current()
    this.emit({ phase: 'downloading', percent: 0, error: '' })
    try {
      await up.downloadUpdate()
    } catch (e) {
      this.emit({ phase: 'error', error: e instanceof Error ? e.message : String(e) })
    }
    return this.current()
  }

  /**
   * 重启安装。
   *
   * force=false 时会话在跑就拒绝——探索是长任务，重启等于前功尽弃。
   * 界面据此把按钮置灰并说明原因；用户执意要装时才带 force。
   */
  async install(force: boolean): Promise<UpdateState> {
    if (manualOnly()) {
      this.emit({ error: '当前安装包不支持应用内更新，请到 Release 页下载新版本' })
      return this.current()
    }
    if (this.state.phase !== 'downloaded') return this.current()
    // 先判会话再取 api：顺序反了的话，开发模式会在这里直接返回，
    // 用户永远看不到「为什么装不了」
    if (!force && this.sessionBusy()) {
      this.emit({ error: '探索进行中，结束后再重启更新' })
      return this.current()
    }
    const up = await this.api()
    if (!up) {
      this.emit({ error: '开发模式下不执行安装，请使用打包后的版本' })
      return this.current()
    }
    if (this.sessionBusy()) sessions.stop()
    setImmediate(() => up.quitAndInstall())
    return this.current()
  }

  /**
   * 测试专用：直接注入一个状态。
   *
   * 真更新链路要连 GitHub、要打包产物，自动化里跑不动；
   * 但「界面在各状态下的表现」「探索进行中不许重启」这些恰恰是最该守住的，
   * 所以留一个只在 UFC_TEST=1 下注册的入口。
   */
  injectForTest(patch: Partial<UpdateState>): UpdateState {
    this.emit(patch)
    return this.current()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export const updater = new Updater()
