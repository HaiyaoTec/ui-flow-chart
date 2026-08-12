import type { BrowserWindow } from 'electron'
import { CH, type Bounds, type NavState, type PreviewDiagnosis } from '@shared/ipc-contract'
import { getDevice } from '@shared/devices'
import type { DeviceSpec } from '@shared/types'
import { computeFitScale, PageDriver } from './PageDriver'

/**
 * 预览视图的持有者。抓取与真机预览共用同一个 view——
 * AI 驱动时它是被自动操作的页面，人工接管时它就是操作台，中间无需切换。
 */
export class PreviewManager {
  readonly driver = new PageDriver()
  private win: BrowserWindow | null = null
  private device: DeviceSpec = getDevice('iphone-14-pro-max')
  private pane: Bounds = { x: 0, y: 0, width: 430, height: 932 }
  private partition = 'persist:preview-default'
  private lastUrl = ''
  private opening = false
  /** 视口同步的串行队列 */
  private applyChain: Promise<void> = Promise.resolve()

  bindWindow(win: BrowserWindow): void {
    this.win = win
  }

  getDevice(): DeviceSpec {
    return this.device
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
    const fit = computeFitScale(device, paneAtOpen)
    const trace = (s: string) => process.env.UFC_TRACE === '1' && console.log(`[preview] ${s}`)

    try {
      trace('create view')
      this.driver.create(this.win, partition, device)
      this.driver.setCallbacks({
        onNav: () => this.emitNav(),
        onNavigated: () => void this.syncViewport(),
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
    // 打开期间挡掉的 bounds 上报，这里补一次
    await this.setPaneBounds(this.pane)
    this.emitNav()
  }

  /** 切换设备 = 重放全部 override + 重新加载，不能只改 bounds */
  async setDevice(device: DeviceSpec): Promise<void> {
    this.device = device
    if (!this.driver.attached) return
    await this.syncViewport()
    await this.driver.reload()
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
  async setPaneBounds(b: Bounds): Promise<void> {
    // 明显不合理的矩形一律丢弃：渲染进程在布局未完成时可能报出极小值，
    // 采信它会把原生视图摆到设备外框之外
    if (b.width < 80 || b.height < 80) return
    this.pane = b
    if (!this.driver.attached || this.opening) return
    await this.syncViewport()
  }

  /** 串行下发，且 scale 与 bounds 取自同一快照 */
  private syncViewport(): Promise<void> {
    this.applyChain = this.applyChain
      .then(async () => {
        if (!this.driver.attached || this.opening) return
        const pane = this.pane
        const fit = computeFitScale(this.device, pane)
        await this.driver.applyDevice(this.device, fit)
        this.applyBounds(pane, fit)
      })
      .catch(() => {
        /* 单次同步失败不影响后续 */
      })
    return this.applyChain
  }

  setVisible(visible: boolean): void {
    this.driver.setVisible(visible)
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
    expected: { width: number; height: number }
  } {
    return {
      device: { width: this.device.width, height: this.device.height },
      pane: this.pane,
      fit: this.driver.currentScale(),
      bounds: this.driver.currentBounds(),
      expected: {
        width: Math.round(this.device.width * this.driver.currentScale()),
        height: Math.round(this.device.height * this.driver.currentScale()),
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

  /** 视口按 fitScale 缩放后的实际显示尺寸，居中放进占位区 */
  private applyBounds(pane: Bounds = this.pane, fit = computeFitScale(this.device, pane)): void {
    const w = Math.round(this.device.width * fit)
    const h = Math.round(this.device.height * fit)
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
    this.win.webContents.send(CH.evPreviewNav, state)
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
