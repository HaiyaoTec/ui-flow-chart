import { nativeImage, WebContentsView, type BrowserWindow, type Debugger } from 'electron'
import type { DeviceSpec, ProbeResult } from '@shared/types'
import { PROBE_SCRIPT, WAIT_IMAGES_SCRIPT } from './probeScript'
import { signatureOf } from './signature'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Screenshot {
  /** 原始分辨率 PNG，落盘存档 */
  png: Buffer
  /** 645px 宽 JPEG，发给 AI 与画布缩略图共用 */
  jpegBase64: string
}

/** 探索引擎依赖的页面能力抽象。真实实现是 CDP，测试用 fake 实现 */
export interface IPageDriver {
  goto(url: string): Promise<void>
  probe(): Promise<ProbeResult>
  waitStable(): Promise<ProbeResult>
  screenshot(): Promise<Screenshot>
  tap(x: number, y: number): Promise<void>
  fillAt(x: number, y: number, text: string): Promise<void>
  scrollBy(delta: number): Promise<void>
  back(): Promise<void>
  currentUrl(): string
}

const SCREENSHOT_WIDTH_FOR_AI = 645

export class PageDriver implements IPageDriver {
  private view: WebContentsView | null = null
  private win: BrowserWindow | null = null
  private device: DeviceSpec | null = null
  /**
   * setDeviceMetricsOverride 的 scale。
   * CDP 的输入坐标是在「缩放后」的空间里解释的：页面最终收到的是 发送值 ÷ scale。
   * 所以派发前必须把 CSS 坐标乘以 scale，否则缩放状态下会点偏。
   */
  private inputScale = 1
  private bounds: Bounds = { x: 0, y: 0, width: 430, height: 932 }
  private visible = true
  private inputIgnored = false
  private onNav?: (url: string, loading: boolean) => void
  private onCrash?: () => void

  get attached(): boolean {
    return this.view !== null
  }

  private get dbg(): Debugger {
    if (!this.view) throw new Error('预览视图尚未创建')
    return this.view.webContents.debugger
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  create(win: BrowserWindow, partition: string, device: DeviceSpec): void {
    this.destroy()
    this.win = win
    this.device = device

    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 目标站是外部内容，保持默认的安全策略
        webSecurity: true,
      },
    })
    this.view = view
    win.contentView.addChildView(view)
    view.setBounds(this.bounds)

    const wc = view.webContents
    // 外链一律留在同一个 view 内，避免逃出预览窗口
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void wc.loadURL(url)
      return { action: 'deny' }
    })
    wc.on('did-start-loading', () => this.onNav?.(wc.getURL(), true))
    wc.on('did-stop-loading', () => this.onNav?.(wc.getURL(), false))
    wc.on('render-process-gone', () => this.onCrash?.())

    // 铁律：先 attach 并铺好全部 override，再导航目标站。
    // 顺序反了会拿到桌面布局塞进手机视口的错误结果。
    try {
      wc.debugger.attach('1.3')
    } catch (e) {
      throw new Error(`无法接入调试协议：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 全新的 WebContentsView 还没有渲染进程，此时发 Emulation.* 会一直挂起不返回。
   * 先加载 about:blank 把渲染进程拉起来——它不发网络请求，
   * 因此后续的 override 仍然早于目标站的首个请求。
   */
  async ensureRenderer(): Promise<void> {
    if (!this.view) throw new Error('预览视图尚未创建')
    const wc = this.view.webContents
    if (wc.getURL()) return
    await wc.loadURL('about:blank')
  }

  destroy(): void {
    if (!this.view) return
    const wc = this.view.webContents
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      /* 已断开则忽略 */
    }
    try {
      this.win?.contentView.removeChildView(this.view)
    } catch {
      /* 窗口可能已销毁 */
    }
    try {
      wc.close()
    } catch {
      /* 忽略 */
    }
    this.view = null
  }

  setCallbacks(cb: { onNav?: (url: string, loading: boolean) => void; onCrash?: () => void }): void {
    this.onNav = cb.onNav
    this.onCrash = cb.onCrash
  }

  /* ------------------------------ 设备模拟 ------------------------------ */

  /** 应用全套 override。任何设备变更后都要重放一遍，再 reload */
  async applyDevice(device: DeviceSpec, fitScale: number): Promise<void> {
    if (!this.view) return
    this.device = device
    this.inputScale = fitScale
    const wc = this.view.webContents

    // UA：CDP override 管文档与子资源；webContents/session 兜住 service worker 与预连接
    wc.setUserAgent(device.userAgent)
    wc.session.setUserAgent(device.userAgent)

    await this.send('Emulation.setUserAgentOverride', {
      userAgent: device.userAgent,
      acceptLanguage: 'zh-CN,zh;q=0.9',
      platform: device.userAgentMetadata?.platform ?? '',
      // 不带 metadata 的话，即使 UA 字符串改了，Sec-CH-UA 仍会暴露真实的 Chromium
      userAgentMetadata: device.userAgentMetadata
        ? {
            brands: device.userAgentMetadata.brands,
            fullVersionList: device.userAgentMetadata.brands,
            platform: device.userAgentMetadata.platform,
            platformVersion: device.userAgentMetadata.platformVersion,
            architecture: device.userAgentMetadata.architecture,
            model: device.userAgentMetadata.model,
            mobile: device.userAgentMetadata.mobile,
          }
        : undefined,
    })

    await this.send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.deviceScaleFactor,
      mobile: device.isMobile,
      // scale 让整块视口按比例缩放填进预览框，视口的 CSS 尺寸不变
      scale: fitScale,
      screenWidth: device.width,
      screenHeight: device.height,
      screenOrientation: device.isMobile
        ? { angle: 0, type: 'portraitPrimary' }
        : { angle: 0, type: 'landscapePrimary' },
    })

    await this.send('Emulation.setTouchEmulationEnabled', {
      enabled: device.hasTouch,
      // 协议要求该值在 1–16 之间，禁用触摸时也不能传 0
      maxTouchPoints: device.hasTouch ? 5 : 1,
    })
    await this.send('Emulation.setEmitTouchEventsForMouse', {
      enabled: device.hasTouch,
      configuration: device.isMobile ? 'mobile' : 'desktop',
    })
    await this.send('Page.enable', {})
  }

  setBounds(b: Bounds): void {
    this.bounds = b
    this.view?.setBounds(b)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.view?.setVisible(visible)
  }

  isVisible(): boolean {
    return this.visible
  }

  /** AI 驱动期间屏蔽用户误触。CDP 派发的事件不受此开关影响 */
  async setInputIgnored(ignore: boolean): Promise<void> {
    if (this.inputIgnored === ignore) return
    this.inputIgnored = ignore
    await this.send('Input.setIgnoreInputEvents', { ignore })
  }

  /* -------------------------------- 导航 -------------------------------- */

  async goto(url: string): Promise<void> {
    if (!this.view) throw new Error('预览视图尚未创建')
    await this.view.webContents.loadURL(url)
    await this.settle()
  }

  async back(): Promise<void> {
    const wc = this.view?.webContents
    if (!wc) return
    if (wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack()
      await this.settle()
    }
  }

  async reload(): Promise<void> {
    this.view?.webContents.reload()
    await this.settle()
  }

  currentUrl(): string {
    return this.view?.webContents.getURL() ?? ''
  }

  canGoBack(): boolean {
    return this.view?.webContents.navigationHistory.canGoBack() ?? false
  }

  title(): string {
    return this.view?.webContents.getTitle() ?? ''
  }

  /* -------------------------- 探针与稳定帧等待 -------------------------- */

  async probe(): Promise<ProbeResult> {
    if (!this.view) throw new Error('预览视图尚未创建')
    return (await this.view.webContents.executeJavaScript(PROBE_SCRIPT, true)) as ProbeResult
  }

  /** 等待渲染安静：加载结束 + 图片解码 + 固定延时 */
  async settle(extraMs = 900): Promise<void> {
    const wc = this.view?.webContents
    if (!wc) return
    if (wc.isLoading()) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          wc.off('did-stop-loading', done)
          resolve()
        }
        const timer = setTimeout(done, 15000)
        wc.once('did-stop-loading', done)
      })
    }
    await wc.executeJavaScript(WAIT_IMAGES_SCRIPT, true).catch(() => undefined)
    await delay(extraMs)
  }

  /** 连续两次探针签名一致才算稳定，避开弹窗动画的中间态 */
  async waitStable(interval = 350, max = 12): Promise<ProbeResult> {
    let prevSig: string | null = null
    let last: ProbeResult | null = null
    for (let i = 0; i < max; i++) {
      const p = await this.probe()
      const sig = signatureOf(p)
      if (prevSig === sig) return p
      prevSig = sig
      last = p
      await delay(interval)
    }
    return last ?? this.probe()
  }

  /* -------------------------------- 截图 -------------------------------- */

  async screenshot(): Promise<Screenshot> {
    if (!this.view || !this.device) throw new Error('预览视图尚未创建')
    // clip.scale 固定输出倍率，与预览用的 fitScale 解耦——
    // 无论画面缩放到多小，存档图始终是设备原始分辨率
    const res = (await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: {
        x: 0,
        y: 0,
        width: this.device.width,
        height: this.device.height,
        scale: this.device.deviceScaleFactor,
      },
    })) as { data: string }

    const png = Buffer.from(res.data, 'base64')
    const img = nativeImage.createFromBuffer(png)
    const thumb = img.isEmpty() ? img : img.resize({ width: SCREENSHOT_WIDTH_FOR_AI, quality: 'good' })
    return { png, jpegBase64: thumb.toJPEG(80).toString('base64') }
  }

  /* -------------------------------- 输入 -------------------------------- */

  /** 把 CSS 坐标换算到 CDP 的输入坐标空间 */
  private toInput(x: number, y: number): { x: number; y: number } {
    return { x: Math.round(x * this.inputScale), y: Math.round(y * this.inputScale) }
  }

  async tap(cssX: number, cssY: number): Promise<void> {
    const { x, y } = this.toInput(cssX, cssY)
    if (this.device?.hasTouch) {
      const point = { x, y, radiusX: 12, radiusY: 12, force: 1 }
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await delay(60)
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      const base = { x, y, button: 'left', clickCount: 1 }
      await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' })
      await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
      await delay(40)
      await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
    }
    await delay(200)
  }

  /** 先点中输入框聚焦，再插入文本；insertText 产生 trusted 输入，受控组件能正常收到 */
  async fillAt(x: number, y: number, text: string): Promise<void> {
    await this.tap(x, y)
    await delay(120)
    await this.view?.webContents.executeJavaScript(
      `(() => { const el = document.activeElement
        if (el && ('value' in el)) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})) }
        return true })()`,
      true
    )
    await this.send('Input.insertText', { text })
    // 补一次 input 事件，兼容只监听 keyboard 的实现
    await this.view?.webContents.executeJavaScript(
      `(() => { const el = document.activeElement
        if (el) { el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})) }
        return true })()`,
      true
    )
    await delay(200)
  }

  /** delta 为正表示向下滚动 */
  async scrollBy(delta: number): Promise<void> {
    if (!this.device) return
    const { x, y } = this.toInput(this.device.width / 2, this.device.height / 2)
    try {
      await this.send('Input.synthesizeScrollGesture', {
        x,
        y,
        // CDP 的 yDistance 正数表示向上滚，与我们的语义相反
        yDistance: -delta,
        speed: 3000,
        gestureSourceType: this.device.hasTouch ? 'touch' : 'mouse',
      })
    } catch {
      await this.view?.webContents.executeJavaScript(`scrollBy(0, ${delta}); true`, true)
    }
    await delay(400)
  }

  /** 在目标页内执行脚本并取回结果，供探针与自动化测试使用 */
  async evalInPage(script: string): Promise<unknown> {
    if (!this.view) throw new Error('预览视图尚未创建')
    return this.view.webContents.executeJavaScript(script, true)
  }

  async blurActive(): Promise<void> {
    await this.view?.webContents.executeJavaScript(`document.activeElement && document.activeElement.blur(); true`, true)
    await delay(300)
  }

  /* -------------------------------- 内部 -------------------------------- */

  private async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const trace = process.env.UFC_TRACE === '1'
    if (trace) console.log(`[cdp] → ${method}`)
    try {
      const r = await this.dbg.sendCommand(method, params)
      if (trace) console.log(`[cdp] ✓ ${method}`)
      return r
    } catch (e) {
      if (trace) console.log(`[cdp] ✗ ${method}: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 预览框内的适配比例：让设备整屏塞进可用区域，最大不放大 */
export function computeFitScale(device: DeviceSpec, pane: { width: number; height: number }): number {
  if (pane.width <= 0 || pane.height <= 0) return 1
  return Math.min(pane.width / device.width, pane.height / device.height, 1)
}
