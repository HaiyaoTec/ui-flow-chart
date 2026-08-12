import type { BaseWindow } from 'electron'
import { CH, type Bounds, type NavState, type PreviewDiagnosis } from '@shared/ipc-contract'
import { getDevice } from '@shared/devices'
import type { DeviceSpec } from '@shared/types'
import { computeFitScale, PageDriver } from './PageDriver'
import { getUiContents, getUiView } from '../window'

/**
 * 预览视图的持有者。抓取与真机预览共用同一个 view——
 * AI 驱动时它是被自动操作的页面，人工接管时它就是操作台，中间无需切换。
 */
export class PreviewManager {
  readonly driver = new PageDriver()
  private win: BaseWindow | null = null
  private device: DeviceSpec = getDevice('iphone-14-pro-max')
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
  /** 视口同步的串行队列 */
  private applyChain: Promise<void> = Promise.resolve()

  bindWindow(win: BaseWindow): void {
    this.win = win
    // 拖窗口边框时原生视图跟不上，右侧会拖出一条黑边。
    // 缩放期间先藏起来，等渲染进程报来新矩形再显示。
    win.on('resize', () => this.holdUntilPane())
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
    this.device = device
    this.partition = partition
    this.opening = true

    // 定住这一刻的占位矩形。open 期间渲染进程仍会上报新矩形并改写 this.pane，
    // 若后面用新矩形算 bounds、却用旧 fit 下发 CDP，两者就会对不上：
    // 视图比 width×scale 窄，页面被裁掉两侧——正是「模拟的高宽不对」的成因。
    const paneAtOpen = this.pane
    const fit = this.scaleFor(paneAtOpen)
    const trace = (s: string) => process.env.UFC_TRACE === '1' && console.log(`[preview] ${s}`)

    this.holdUntilPane()

    try {
      trace('create view')
      this.driver.create(this.win, partition, device)
      this.driver.setVisible(false)
      this.driver.setCallbacks({
        onNav: () => this.emitNav(),
        // 跨进程导航可能换掉渲染帧，覆盖要整套重放，不能只挪视图
        onNavigated: () => void this.syncViewport(true),
        onCrash: () => this.handleCrash(),
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
      this.opening = false
    }
    // 首次落地后核对一次：模拟没生效就自己纠正，别让用户看着 PC 布局发懵
    const heal = await this.verifyAndHeal().catch(() => null)
    if (heal?.healed) trace(`设备模拟未生效（scrollWidth=${heal.scrollWidth}），已重放并重载`)
    // 打开期间挡掉的 bounds 上报，这里补一次。
    // 注意走内部同步而不是 setPaneBounds——那会把「等待新矩形」的标记
    // 用旧矩形提前解除，视图又会在错误的位置闪一下
    await this.syncViewport(true)
    this.emitNav()
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
    // 换设备必须重放全部 override，即使缩放恰好没变
    await this.syncViewport(true)
    await this.driver.reload()
    await this.verifyAndHeal().catch(() => null)
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
  private holdUntilPane(): void {
    this.awaitingPane = true
    this.driver.setVisible(false)
    if (this.awaitTimer) clearTimeout(this.awaitTimer)
    // 兜底：万一渲染进程没有上报（页面没挂载预览面板），不能让视图永远藏着
    this.awaitTimer = setTimeout(() => this.releasePane(), 2500)
  }

  private releasePane(): void {
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
        const shot = await this.driver.screenshot()
        image = `data:image/jpeg;base64,${shot.jpegBase64}`
      } catch {
        // 抓不到就退回文字占位，不影响隐藏本身
      }
    }
    this.wantVisible = visible
    // 等待新矩形期间只记意愿，不真的显示——否则又会在旧位置画一帧
    this.driver.setVisible(visible && !this.awaitingPane)
    return { image }
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
  } {
    return {
      device: { width: this.device.width, height: this.device.height },
      pane: this.pane,
      fit: this.driver.currentScale(),
      bounds: this.driver.currentBounds(),
      visible: this.driver.isVisible(),
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

  private handleCrash(): void {
    // 渲染进程崩溃后重建 view、重放 override、回到崩溃前的地址
    void (async () => {
      try {
        if (!this.win) return
        await this.open(this.lastUrl || 'about:blank', this.device, this.partition)
      } catch {
        /* 重建失败时保持静默，由会话状态机报错 */
      }
    })()
  }
}

export const preview = new PreviewManager()
