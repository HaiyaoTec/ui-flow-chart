import { app } from 'electron'
import { CH, type UpdateState } from '@shared/ipc-contract'
import { sessions } from './engine/sessionManager'
import { log, updaterLogger } from './log'
import { getSettings } from './store/settings'
import { getUiContents } from './window'

/** 冷启动后延迟一会儿再查，避开与首屏、预览初始化抢资源 */
const FIRST_CHECK_DELAY = 30_000
/**
 * 自动检查的间隔。
 *
 * 检查本身很便宜：拉一次仓库的 Atom 订阅源加一份几百字节的 latest.yml，
 * 都走 CDN，也不吃接口配额，所以这个值可以定得比较密。
 * 真正要防的是「发现新版本 → 自动下载失败 → 下次检查再下一遍」——
 * 那是个上百兆的包，见 downloadBackoff。
 */
const CHECK_INTERVAL = 30 * 60 * 1000

/** 同一个版本下载失败后的首次退避 */
const RETRY_BASE_MS = 10 * 60 * 1000
/** 退避上限。退到这一档就相当于回到从前的检查节奏了 */
const RETRY_MAX_MS = 4 * 60 * 60 * 1000

/** 第 n 次失败之后要等多久再自动重试。10 分钟起步逐次翻倍，封顶 4 小时 */
export function retryDelay(attempts: number): number {
  const n = Math.max(1, attempts)
  return Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_MAX_MS)
}

/** 某个版本的自动下载失败记录 */
export interface DownloadFailure {
  version: string
  attempts: number
  /** 早于这个时刻不再自动重试 */
  nextAt: number
}

/**
 * 现在能不能自动下载这个版本。
 *
 * 只约束自动路径：用户手动点「下载」是明确的意图，任何时候都放行。
 * 换了版本就重新开始——新包与旧包失败与否没有关系。
 */
export function canAutoDownload(fail: DownloadFailure | null, version: string, now: number): boolean {
  if (!fail || fail.version !== version) return true
  return now >= fail.nextAt
}

/** 失败之后推进退避。同一个版本累加次数，换了版本从头算 */
export function bumpFailure(fail: DownloadFailure | null, version: string, now: number): DownloadFailure {
  const attempts = fail && fail.version === version ? fail.attempts + 1 : 1
  return { version, attempts, nextAt: now + retryDelay(attempts) }
}

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
  /** 更新模块加载失败：此时 api() 返回 null 的原因不是「开发模式」 */
  private loadFailed = false
  /**
   * 自动下载的失败退避。
   *
   * 下载失败后状态是 error，它拦不住下一次检查再触发一遍下载——
   * 检查间隔一缩短，网不稳的用户就会被反复拉上百兆的包。
   */
  private downloadFailure: DownloadFailure | null = null

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
  /** 任一会话还在跑就算忙。多会话之后「当前那个会话」这个说法不成立了 */
  private sessionBusy(): boolean {
    return sessions.activeProjectIds().length > 0
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
    try {
      /*
       * electron-updater 是 CJS，而主进程产物是 ESM。
       *
       * 开发模式下 Vite 会做互操作转换，`const { autoUpdater } = await import(...)`
       * 拿得到值；打包后这句原样交给 Node 的 ESM 加载器，具名导出分析不出来，
       * autoUpdater 是 undefined，于是 api() 抛 TypeError、IPC 直接 reject，
       * 界面永远停在「当前版本 —」——打包后的更新链路一直是坏的，开发模式看不出来。
       */
      const mod = await import('electron-updater')
      const autoUpdater = (mod.default ?? mod).autoUpdater
      if (!autoUpdater) throw new Error('electron-updater 未能加载')
      // 更新链路的内部日志默认走 console，打包版没有控制台等于全丢。
      // 而"更新装不上"恰恰是这类分发方式最高频的报障，日志是唯一线索
      autoUpdater.logger = updaterLogger
      autoUpdater.autoDownload = false // 先问过用户设置再下，避免占用带宽
      autoUpdater.autoInstallOnAppQuit = true
      return autoUpdater
    } catch (e) {
      // 初始化失败也要说出来：静默失败等于用户永远收不到更新，还看不出原因
      this.loadFailed = true
      this.emit({ phase: 'error', error: `更新模块加载失败：${e instanceof Error ? e.message : String(e)}` })
      return null
    }
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
      // 退避判定在 download() 里，这里不重复一遍——两处各判一次迟早会走岔
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
      // 开发模式没有 app-update.yml，明说比抛错好；加载失败的原因 api() 已经报过了
      if (manual && !this.loadFailed) this.emit({ phase: 'error', error: '开发模式下不检查更新，请使用打包后的版本' })
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

  /** manual=true 是用户明确点的，绕过失败退避 */
  async download(manual = false): Promise<UpdateState> {
    // 未签名的 mac 包下载下来也装不上，界面上本就不给下载按钮，这里再兜一道
    if (manualOnly()) return this.current()
    const up = await this.api()
    if (!up || this.state.phase === 'downloading' || this.state.phase === 'downloaded') return this.current()
    const version = this.state.version
    /*
     * 失败退避只拦自动下载。
     *
     * 下载失败后状态是 error，它拦不住下一次检查再触发一遍——检查间隔缩短之后，
     * 网不稳的用户会被反复拉一个上百兆的包。用户手动点「下载」是明确的意图，
     * 任何时候都放行。
     */
    if (!manual && !canAutoDownload(this.downloadFailure, version, Date.now())) {
      log.info('updater', `${version} 的自动下载仍在退避中，跳过本次`)
      return this.current()
    }
    this.emit({ phase: 'downloading', percent: 0, error: '' })
    try {
      await up.downloadUpdate()
      // 成功即清账，下一个版本从头开始
      this.downloadFailure = null
    } catch (e) {
      this.downloadFailure = bumpFailure(this.downloadFailure, version, Date.now())
      const wait = Math.round(retryDelay(this.downloadFailure.attempts) / 60000)
      log.warn('updater', `${version} 下载失败（第 ${this.downloadFailure.attempts} 次），${wait} 分钟内不再自动重试`)
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
    if (this.sessionBusy()) sessions.stopAll()
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
