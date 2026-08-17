import type { BaseWindow } from 'electron'
import { CH, type Bounds, type NavState, type PreviewDiagnosis } from '@shared/ipc-contract'
import { DEFAULT_DEVICE_ID, getDevice } from '@shared/devices'
import type { DeviceSpec } from '@shared/types'
import { computeFitScale, PageDriver, type Screenshot } from './PageDriver'
import { log } from '../log'
import { getUiContents, getUiView } from '../window'

/**
 * 预览视图的持有者。抓取与真机预览共用同一个 view——
 * AI 驱动时它是被自动操作的页面，人工接管时它就是操作台，中间无需切换。
 */
/** hold 的常规等待档：到点仍未把新矩形落到视图上，就催渲染进程重报一次 */
const HOLD_SOFT_MS = 2500
/** 非 open 场景（窗口缩放、面板展开）的绝对期限 */
const HOLD_MAX_MS = 5000
/** 等渲染进程贴静帧的上限。到点没回执就照常抓图，宁可闪一下也不能把探索卡住 */
const FREEZE_ACK_MAX_MS = 300
/** 抓图占住层级的上限 */
const CAPTURE_MAX_MS = 3000
/**
 * open 场景的绝对期限。要高于 goto 的最坏预算，到点强制放行是
 * 「预览永久空白」的最后一道防线。
 */
const HOLD_OPEN_MAX_MS = 20000

export class PreviewManager {
  readonly driver = new PageDriver()
  private win: BaseWindow | null = null
  private device: DeviceSpec = getDevice(DEFAULT_DEVICE_ID)
  private pane: Bounds = { x: 0, y: 0, width: 430, height: 932 }
  /** 渲染进程指定的缩放；null 表示按可用空间自适应 */
  private paneScale: number | null = null
  private partition = 'persist:preview-default'
  private lastUrl = ''
  private opening = false
  /** 渲染进程希望的可见性 */
  private wantVisible = true
  /**
   * 打开新目标后，在拿到渲染进程上报的新矩形之前不显示视图。
   *
   * 否则会拿上一次的矩形先画一帧——进项目时就表现为网页突然浮在画布上、
   * 位置也不对，几百毫秒后才归位。
   */
  private awaitingPane = false
  private awaitTimer: NodeJS.Timeout | null = null
  /** 正在切换设备：这期间任何「新矩形到了」都不放行视图 */
  private switching = false
  /**
   * 本轮 hold 之后是否收到过新矩形。只用来决定要不要催重报，不作为放行判据——
   * open 期间的上报只更新 this.pane，视图上仍是 open 入口的那份快照。
   */
  private paneReceived = false
  /**
   * 最新矩形连同同源 fit 是否已经真的落到视图上。这才是放行的唯一判据。
   * 「收到过矩形」与「矩形已生效」必须分开：混为一谈正是网页在加载期间
   * 以旧矩形浮在画布上的根因。
   */
  private paneApplied = false
  /** 本轮 hold 的绝对期限 */
  private holdDeadline = 0
  /**
   * open() 的代次令牌。
   *
   * registry 那边是 void preview.open(...)，没有串行化，崩溃自愈与导航也会调它，
   * 两次交叠是可达路径。只有最后一次 open 有权清 opening 与放行视图，
   * 否则先发起的那次会在后发起的那次进行中把闸门打开。
   */
  private openGen = 0
  /** 视口同步的串行队列 */
  private applyChain: Promise<void> = Promise.resolve()
  /** 解绑当前窗口 resize 监听的函数 */
  private offResize: (() => void) | null = null
  /** 界面视图当前是否在预览之上。抓存档图时要临时提上来，收尾要还原 */
  private uiFront = false
  /** 层级变更的代次。抓图收尾只在没人动过层级时才把预览放回上层 */
  private stackGen = 0
  /** 静帧的代次令牌，配合渲染进程的回执使用 */
  private freezeGen = 0
  /** 当前静帧的等待者：渲染进程报告贴好了就兑现 */
  private freezeAck: { token: number; resolve: () => void } | null = null
  /** 最近一次静帧的结果，供自动化验证读取 */
  private freezeInfo: { used: boolean; acked: boolean; ms: number } = { used: false, acked: false, ms: 0 }

  /**
   * 绑定主窗口。
   *
   * macOS 上关窗不退出进程，从 Dock 再打开会新建一个窗口，因此这里必须支持换绑：
   * 早先只在启动时绑一次，重建后预览挂在已销毁的窗口上，表现是「预览区永久空白」。
   * 监听也要能解绑，否则每换一次窗口就多挂一个 resize。
   */
  bindWindow(win: BaseWindow): void {
    if (this.win === win) return
    this.offResize?.()
    // 拖窗口边框时原生视图跟不上，右侧会拖出一条黑边。
    // 缩放期间先藏起来，等渲染进程报来新矩形再显示。
    const onResize = (): void => this.holdUntilPane()
    win.on('resize', onResize)
    this.offResize = () => win.off('resize', onResize)
    this.win = win
  }

  /** 窗口关闭时调用：子视图不随窗口销毁，必须显式释放，否则页面留在后台继续跑 */
  unbindWindow(win: BaseWindow): void {
    if (this.win !== win) return
    this.offResize?.()
    this.offResize = null
    this.driver.destroy()
    this.win = null
  }

  getDevice(): DeviceSpec {
    return this.device
  }

  /**
   * 界面与预览的层级切换。
   *
   * 界面自己也是窗口的子视图（见 window.ts），谁在上完全由排序决定。
   * 自绘弹层要盖住网页时，把界面提到最上层就行——纯排序，瞬时生效，
   * 不必隐藏预览、也不必抓帧顶替，切换缩放这类操作不会再被拖慢。
   * 代价是界面在上时鼠标事件归界面，所以弹层一关就要把预览放回上层。
   */
  setStackFront(front: 'ui' | 'preview'): void {
    const win = this.win
    this.uiFront = front === 'ui'
    this.stackGen += 1
    if (!win || win.isDestroyed()) return
    const top = front === 'ui' ? getUiView() : this.driver.view
    if (!top) return
    // 必须先摘再挂：对已经是子视图的 view 直接 addChildView 不保证重排，
    // 那样界面根本升不到最上层，网页照旧压着弹层
    try {
      win.contentView.removeChildView(top)
    } catch {
      /* 不是子视图就直接挂 */
    }
    win.contentView.addChildView(top)
  }

  /** 打开目标站。每次都重建 view 并在导航前铺好 override */
  async open(url: string, device: DeviceSpec, partition: string): Promise<void> {
    if (!this.win) throw new Error('主窗口尚未就绪')
    const gen = ++this.openGen
    this.device = device
    this.partition = partition
    this.opening = true

    // 定住这一刻的占位矩形。open 期间渲染进程仍会上报新矩形并改写 this.pane，
    // 若后面用新矩形算 bounds、却用旧 fit 下发 CDP，两者就会对不上：
    // 视图比 width×scale 窄，页面被裁掉两侧——正是「模拟的高宽不对」的成因。
    const paneAtOpen = this.pane
    const fit = this.scaleFor(paneAtOpen)
    const trace = (s: string) => process.env.UFC_TRACE === '1' && console.log(`[preview] ${s}`)

    this.holdUntilPane(HOLD_OPEN_MAX_MS)

    try {
      trace('create view')
      this.driver.create(this.win, partition, device)
      this.driver.setVisible(false)
      this.driver.setCallbacks({
        onNav: () => this.emitNav(),
        // 跨进程导航可能换掉渲染帧，覆盖要整套重放，不能只挪视图
        onNavigated: () => void this.syncViewport(true),
        onCrash: (detail) => this.handleCrash(detail),
      })
      trace('spin up renderer')
      await this.driver.ensureRenderer()
      trace('apply device overrides')
      await this.driver.applyDevice(device, fit)
      trace('apply bounds')
      this.applyBounds(paneAtOpen, fit)
      trace(`goto ${url}`)
      await this.driver.goto(url)
      // about:blank 只是用来拉起渲染进程的，别让它留在历史里，否则「后退」会回到空白页
      this.driver.clearHistory()
      await this.driver.installUserInputWatcher()
      trace('goto done')
      this.lastUrl = url
    } finally {
      /*
       * 收尾必须在成功与抛错两条路径上都执行。
       *
       * 早先这几步写在 try/finally 之外：goto 抛错（域名解析失败、连接被拒）时
       * 视图会永远停在 open 入口的快照矩形上，不再自己恢复。
       *
       * 顺序不能调换：syncViewport 与 setPaneBounds 都以 opening 自锁，
       * 必须先清 opening 再同步；放行必须排在同步之后，
       * 否则只是把「拿陈旧矩形亮相」挪个地方重演一遍。
       */
      if (gen === this.openGen) {
        this.opening = false
        // 首次落地后核对一次：模拟没生效就自己纠正，别让用户看着 PC 布局发懵
        const heal = await this.verifyAndHeal().catch(() => null)
        if (heal?.healed) trace(`设备模拟未生效（scrollWidth=${heal.scrollWidth}），已重放并重载`)
        // 打开期间挡掉的 bounds 上报，这里补一次。走内部同步而不是 setPaneBounds
        await this.syncViewport(true)
        this.releasePane()
        this.emitNav()
      }
    }
  }

  /**
   * 切换设备 = 重放全部 override + 重新加载，不能只改 bounds。
   *
   * 期间必须把视图藏起来等新矩形：设备尺寸变了、渲染进程报来的占位矩形还是旧的，
   * 视图宽高与页面视口对不上，Chromium 会拿旧图块去铺满新尺寸——
   * 表现就是同一张页面在框里横竖各重复一遍。
   * 重载后再自检一次：UA 或视口覆盖没落到这次加载上时会自动重放，
   * 否则站点会按桌面版排版，塞进手机框里就是一片密密麻麻的小卡片。
   */
  async setDevice(device: DeviceSpec): Promise<void> {
    this.device = device
    if (!this.driver.attached) return
    this.holdUntilPane()
    // 整个切换过程都不显示：中途渲染进程会报来新矩形，若那时就放出来，
    // 页面还没按新视口重绘完，旧图块会被拿去铺满新尺寸
    this.switching = true
    try {
      // 换设备必须重放全部 override，即使缩放恰好没变
      await this.syncViewport(true)
      await this.driver.reload()
      await this.verifyAndHeal().catch(() => null)
      // 重载完成后再同步一次，这时用的才是新设备对应的矩形
      await this.syncViewport(true)
      // 留一帧给新尺寸下的首次绘制，否则刚放出来的还是按旧尺寸铺出来的画面
      await new Promise((r) => setTimeout(r, 200))
    } finally {
      this.switching = false
      this.releasePane()
    }
    this.emitNav()
  }

  /**
   * 渲染进程上报的屏幕占位矩形。
   *
   * 两件事必须做对，否则页面会按错误的宽度排版：
   * 1. 打开过程中不插手——此时正在导航，并发的 Emulation 命令会把导航打断。
   * 2. CDP 的 scale 与原生视图尺寸必须来自同一次计算并串行下发。
   *    布局切换时 ResizeObserver 会连发好几次矩形，若两者交错，
   *    视图会比 width×scale 更宽，Chromium 就把布局视口撑到视图宽度，
   *    表现就是「网站没识别到设备宽度」——PC 布局塞进手机框里。
   */
  async setPaneBounds(b: Bounds & { scale?: number }): Promise<void> {
    // 明显不合理的矩形一律丢弃：渲染进程在布局未完成时可能报出极小值，
    // 采信它会把原生视图摆到设备外框之外
    if (b.width < 80 || b.height < 80) return
    this.pane = { x: b.x, y: b.y, width: b.width, height: b.height }
    // 只是「收到了」。是否已经落到视图上由 syncViewport 里的 paneApplied 说了算
    this.paneReceived = true
    // 用户手动指定了缩放时，矩形可能是裁切过的，反推不出比例，只能采信上报值
    this.paneScale = typeof b.scale === 'number' && b.scale > 0 ? b.scale : null
    if (!this.driver.attached || this.opening) return
    await this.syncViewport()
    // 新矩形已经落到视图上，这时候再显示才不会闪现在旧位置
    this.releasePane()
  }

  /**
   * 暂时藏起视图，直到渲染进程报来新的矩形。
   *
   * 用在两处：打开新目标（否则会拿上一次的矩形先画一帧），
   * 以及窗口缩放（原生视图跟不上窗口边框，右侧会拖出一条黑边）。
   */
  private holdUntilPane(maxMs = HOLD_MAX_MS): void {
    this.awaitingPane = true
    this.paneReceived = false
    this.paneApplied = false
    this.driver.setVisible(false)
    this.holdDeadline = Date.now() + maxMs
    this.armHoldTimer(HOLD_SOFT_MS)
  }

  private armHoldTimer(ms: number): void {
    if (this.awaitTimer) clearTimeout(this.awaitTimer)
    this.awaitTimer = setTimeout(() => this.onHoldTimeout(), ms)
  }

  /**
   * 兜底超时。四条分支，从高到低：
   *
   * 1. 超过绝对期限：把几何夹回当前占位矩形后强制放行，杜绝永久空白。
   * 2. open 仍在进行：不放行。此刻视图上是 open 入口的快照矩形，
   *    放行等于把网页画在上一次布局的位置上——正是「网页浮在画布上」那个现象。
   *    正常放行由 open() 收尾负责。
   * 3. 新矩形已经落到视图上：放行。
   * 4. 矩形一直没来（面板收起、组件还没挂载）：催重报一次，再等一档。
   */
  private onHoldTimeout(): void {
    if (Date.now() >= this.holdDeadline) return this.forceRelease()
    if (this.opening) return this.armHoldTimer(500)
    if (this.paneApplied) return this.releasePane()
    if (!this.paneReceived) this.emitNav()
    this.armHoldTimer(HOLD_SOFT_MS)
  }

  /**
   * 超期强制放行。
   *
   * 放行前先把视图夹回当前占位矩形。此时可能仍在 open 中，不能发 CDP
   * （并发的 Emulation 命令会打断导航），所以按已经下发的 scale 重算 bounds：
   * applyBounds 的溢出分支会把视图截到 pane 之内，最坏是手机屏里的页面被裁掉一块，
   * 但绝不会跑到画布上。缩放由 open() 收尾的 syncViewport 补齐。
   */
  private forceRelease(): void {
    if (this.switching) return
    if (this.driver.attached) {
      this.applyBounds(this.pane, this.driver.currentScale())
      this.driver.repaint()
    }
    this.releasePane()
  }

  private releasePane(): void {
    // 切换设备期间一律不放行，由 setDevice 收尾时统一放出来
    if (this.switching) return
    if (!this.awaitingPane) return
    this.awaitingPane = false
    if (this.awaitTimer) {
      clearTimeout(this.awaitTimer)
      this.awaitTimer = null
    }
    this.driver.setVisible(this.wantVisible)
  }

  /** 当前应当使用的缩放：渲染进程指定优先，否则按可用空间自适应 */
  private scaleFor(pane: Bounds): number {
    return this.paneScale ?? computeFitScale(this.device, pane)
  }

  /** 串行下发，且 scale 与 bounds 取自同一快照 */
  private syncViewport(force = false): Promise<void> {
    this.applyChain = this.applyChain
      .then(async () => {
        if (!this.driver.attached || this.opening) return
        const pane = this.pane
        const fit = this.scaleFor(pane)
        // 面板只是平移时缩放没变，没必要重发 Emulation 命令去打扰页面，
        // 挪一下视图即可；拖拽调窗口大小时这条路径会被高频命中
        if (force || Math.abs(fit - this.driver.currentScale()) > 0.0005) {
          await this.driver.applyDevice(this.device, fit)
        }
        this.applyBounds(pane, fit)
        // 尺寸一变就作废整帧：不主动重绘的话，合成器会把旧图块铺满新尺寸，
        // 表现为同一屏内容在框里重复好几遍
        this.driver.repaint()
        // 到这里矩形才算真的落到视图上。标记只能置在这个分支里——
        // 顶部那个 opening 早退是 resolve 不是 reject，放在链外等于没判
        this.paneApplied = true
      })
      .catch(() => {
        /* 单次同步失败不影响后续 */
      })
    return this.applyChain
  }

  /**
   * 切换视图可见性。
   *
   * withSnapshot：隐藏之前先抓一张当前画面。抓图与隐藏必须连着做——
   * 拆成两次 IPC 的话隐藏会先执行，对已隐藏的视图截图只会失败，
   * 占位就退化成一片黑。
   */
  async setVisible(visible: boolean, withSnapshot = false): Promise<{ image: string }> {
    let image = ''
    if (!visible && withSnapshot && this.driver.attached && this.driver.isVisible()) {
      try {
        // 占位只需要一帧当前画面，不必走设备原始分辨率那条路——
        // 那条会触发合成面重新光栅化，既慢又会在隐藏前先闪一下
        const frame = await this.driver.capturePreviewFrame()
        if (frame) image = `data:image/jpeg;base64,${frame}`
      } catch {
        // 抓不到就退回文字占位，不影响隐藏本身
      }
    }
    this.wantVisible = visible
    /*
     * 转为可见、但最新矩形还没落到视图上时，重新进入等待，由 setPaneBounds 放行。
     *
     * 「模拟设备」收起期间舞台是 display:none，DeviceFrame 的测量被 80px 门槛挡掉、
     * 完全不上报，视图上还是收起之前那份矩形；直接显示就会先在旧位置画一帧。
     * awaitingPane 为真时（open 进行中）不重入，免得把 open 的绝对期限缩短。
     */
    if (visible && !this.awaitingPane && !this.paneApplied && this.driver.attached) {
      this.holdUntilPane()
      return { image }
    }
    // 等待新矩形期间只记意愿，不真的显示——否则又会在旧位置画一帧
    this.driver.setVisible(visible && !this.awaitingPane)
    return { image }
  }

  /**
   * 抓一张存档图，期间用静帧顶住屏幕区。
   *
   * 存档图要设备原始分辨率（clip.scale = 像素比），而预览是按自适应比例显示的；
   * 两个倍率不一致时 Chromium 必须临时按请求的倍率重新光栅化整块合成面，抓完再还原，
   * 这一去一回期间页面按另一个尺寸排了一次版——看上去就是每抓一次图闪一下。
   *
   * 所以先用 capturePage 取一帧当前画面（它拿的是合成器已有的帧，不触发重排），
   * 把界面视图提到预览之上盖住屏幕区，再去抓存档图。原生视图并未隐藏，
   * 仍在正常出帧，CDP 抓图不受影响。
   */
  async captureArchival(): Promise<Screenshot> {
    if (!this.driver.attached) throw new Error('预览视图尚未创建')
    const ui = getUiContents()
    this.freezeInfo = { used: false, acked: false, ms: 0 }
    const frame = ui && this.driver.isVisible() ? await this.driver.capturePreviewFrame().catch(() => '') : ''
    // 弹层已经把界面提上来时不插手，免得收尾把它按回去、弹层反被网页盖住
    const raise = Boolean(frame) && !this.uiFront
    if (frame) {
      const token = ++this.freezeGen
      const t0 = Date.now()
      const painted = new Promise<boolean>((resolve) => {
        this.freezeAck = { token, resolve: () => resolve(true) }
        // 渲染进程没回执（正在重载、图片解码失败）也要继续，不能把抓图卡在这
        setTimeout(() => resolve(false), FREEZE_ACK_MAX_MS)
      })
      ui?.send(CH.evPreviewFreeze, { image: `data:image/jpeg;base64,${frame}`, token })
      // 必须等静帧真的画上去再提界面。抢在前面提的话，
      // 那几帧露出来的是界面自己的屏幕底板，等于把闪烁换了个样子
      const acked = await painted
      this.freezeAck = null
      this.freezeInfo = { used: true, acked, ms: Date.now() - t0 }
      if (process.env.UFC_TRACE === '1') {
        console.log(`[preview] 静帧${acked ? `已贴好（${Date.now() - t0}ms）` : '回执超时，照常抓图'}`)
      }
      if (raise) this.setStackFront('ui')
    }
    // 界面在上时鼠标事件归界面。抓图万一卡住，不能让预览一直点不动，
    // 到点无条件放回去——那时最多闪一下，总好过操作台失灵
    const gen = this.stackGen
    const watchdog = raise ? setTimeout(() => this.restoreStack(gen), CAPTURE_MAX_MS) : null
    try {
      return await this.driver.screenshot()
    } finally {
      if (watchdog) clearTimeout(watchdog)
      if (frame) {
        if (raise) this.restoreStack(gen)
        ui?.send(CH.evPreviewFreeze, { image: '', token: 0 })
      }
    }
  }

  /**
   * 把预览放回上层，前提是这期间没人动过层级。
   *
   * 抓图途中可能有弹层把界面提上来，这时按原计划放回去会让网页盖住弹层，
   * 所以以代次为准：不是自己那一次抬起来的就不管。
   */
  private restoreStack(gen: number): void {
    if (this.stackGen !== gen) return
    this.setStackFront('preview')
  }

  /** 当前谁在上。抓存档图与自动化验证都要读它 */
  stackFront(): 'ui' | 'preview' {
    return this.uiFront ? 'ui' : 'preview'
  }

  /** 最近一次抓存档图时静帧的表现 */
  lastFreezeInfo(): { used: boolean; acked: boolean; ms: number } {
    return this.freezeInfo
  }

  /** 渲染进程报告静帧已贴好。过期令牌一律忽略 */
  noteFreezePainted(token: number): void {
    if (this.freezeAck?.token !== token) return
    this.freezeAck.resolve()
    this.freezeAck = null
  }

  /**
   * 自愈：导航完成后核对页面是否真按设备宽度排版。
   * 页面比视口宽出一截，通常意味着 UA 或视口覆盖没落到这次导航上
   * （跨进程换帧、重定向等都可能导致）。重放一遍并重载即可纠正。
   */
  async verifyAndHeal(): Promise<{ healed: boolean; scrollWidth: number; ua: string }> {
    if (!this.driver.attached) return { healed: false, scrollWidth: 0, ua: '' }
    const probe = await this.driver.probe().catch(() => null)
    if (!probe) return { healed: false, scrollWidth: 0, ua: '' }

    const ua = String(
      (await this.driver.evalInPage('navigator.userAgent').catch(() => '')) ?? ''
    )
    const uaOk = ua === this.device.userAgent
    const widthOk = probe.scrollWidth <= this.device.width * 1.15

    if (uaOk && widthOk) return { healed: false, scrollWidth: probe.scrollWidth, ua }

    await this.syncViewport()
    await this.driver.reload()
    return { healed: true, scrollWidth: probe.scrollWidth, ua }
  }

  /** 诊断用：CDP 的缩放与原生视图尺寸必须严格对应，差一点页面就会被裁 */
  debugInfo(): {
    device: { width: number; height: number }
    pane: Bounds
    fit: number
    bounds: Bounds | null
    visible: boolean
    expected: { width: number; height: number }
    shownAt: { bounds: Bounds; scale: number } | null
  } {
    return {
      device: { width: this.device.width, height: this.device.height },
      pane: this.pane,
      fit: this.driver.currentScale(),
      bounds: this.driver.currentBounds(),
      visible: this.driver.isVisible(),
      // 首次显示那一刻的几何：错位是时序问题，事后采样抢不到，只能存下来断言
      shownAt: this.driver.lastShownGeometry(),
      // 放大到超出面板时视图会被截断，「应为」也要按可见范围取，否则自检永远报异常
      expected: {
        width: Math.min(Math.round(this.device.width * this.driver.currentScale()), this.pane.width),
        height: Math.min(Math.round(this.device.height * this.driver.currentScale()), this.pane.height),
      },
    }
  }

  /** 面向用户的模拟自检，结果直接显示在预览下方 */
  async diagnose(): Promise<PreviewDiagnosis> {
    const d = this.debugInfo()
    const empty: PreviewDiagnosis = {
      deviceName: this.device.name,
      deviceSize: `${d.device.width}×${d.device.height}`,
      scale: Number(d.fit.toFixed(3)),
      viewSize: d.bounds ? `${d.bounds.width}×${d.bounds.height}` : '—',
      expectedViewSize: `${d.expected.width}×${d.expected.height}`,
      boundsMatch: Boolean(d.bounds && d.bounds.width === d.expected.width && d.bounds.height === d.expected.height),
      pageInnerWidth: 0,
      pageScrollWidth: 0,
      uaApplied: false,
      uaSample: '',
      bodyClass: '',
      ok: false,
    }
    if (!this.driver.attached) return empty

    const page = (await this.driver
      .evalInPage(
        `({ w: innerWidth, sw: document.documentElement.scrollWidth, ua: navigator.userAgent, cls: String(document.body.className).slice(0,60) })`
      )
      .catch(() => null)) as { w: number; sw: number; ua: string; cls: string } | null
    if (!page) return empty

    const uaApplied = page.ua === this.device.userAgent
    const widthOk = page.w === this.device.width && page.sw <= this.device.width * 1.15
    return {
      ...empty,
      pageInnerWidth: page.w,
      pageScrollWidth: page.sw,
      uaApplied,
      uaSample: page.ua.slice(0, 70),
      bodyClass: page.cls,
      ok: uaApplied && widthOk && empty.boundsMatch,
    }
  }

  async navigate(input: { url?: string; action?: 'back' | 'reload' }): Promise<void> {
    // 首次导航时顺带把 view 建起来
    if (!this.driver.attached) {
      if (!input.url) return
      await this.open(input.url, this.device, this.partition)
      return
    }
    if (input.action === 'back') await this.driver.back()
    else if (input.action === 'reload') await this.driver.reload()
    else if (input.url) {
      await this.driver.goto(input.url)
      this.lastUrl = input.url
    }
    this.emitNav()
  }

  destroy(): void {
    this.driver.destroy()
  }

  /**
   * 视口按缩放后的实际显示尺寸摆放。
   *
   * 常规情况下占位区就等于设备显示尺寸，居中即原地。
   * 用户手动放大到超出面板时，占位区是裁切过的可见部分：此时左上对齐并按可见
   * 尺寸截断，超出的部分不画——原生视图不受 HTML 的 overflow 约束，
   * 不自己截断就会盖到画布和日志上。
   */
  private applyBounds(pane: Bounds = this.pane, fit = this.scaleFor(pane)): void {
    const w = Math.round(this.device.width * fit)
    const h = Math.round(this.device.height * fit)
    if (w > pane.width || h > pane.height) {
      this.driver.setBounds({
        x: pane.x,
        y: pane.y,
        width: Math.min(w, pane.width),
        height: Math.min(h, pane.height),
      })
      return
    }
    this.driver.setBounds({
      x: Math.round(pane.x + (pane.width - w) / 2),
      y: Math.round(pane.y + (pane.height - h) / 2),
      width: w,
      height: h,
    })
  }

  private emitNav(): void {
    if (!this.win || this.win.isDestroyed()) return
    const state: NavState = {
      url: this.driver.currentUrl(),
      loading: false,
      canGoBack: this.driver.canGoBack(),
      title: this.driver.title(),
    }
    getUiContents()?.send(CH.evPreviewNav, state)
  }

  private handleCrash(detail = ''): void {
    // 崩溃本身必须留痕。早先这里是静默自愈：用户只看到预览闪了一下、
    // 探索莫名其妙走偏，而磁盘上、日志面板里都查不到任何痕迹
    log.error('preview', `预览页渲染进程退出（${detail}），正在重建：${this.lastUrl || 'about:blank'}`)
    getUiContents()?.send(CH.evSession, {
      kind: 'log',
      level: 'warn',
      message: `预览页崩溃（${detail}），已自动重建`,
    })
    // 渲染进程崩溃后重建 view、重放 override、回到崩溃前的地址
    void (async () => {
      try {
        if (!this.win) return
        await this.open(this.lastUrl || 'about:blank', this.device, this.partition)
        log.info('preview', '预览页重建完成')
      } catch (e) {
        log.error('preview', '预览页重建失败', e)
      }
    })()
  }
}

export const preview = new PreviewManager()
