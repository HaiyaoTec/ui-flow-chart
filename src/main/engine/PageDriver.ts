import { nativeImage, session, WebContentsView, type BaseWindow, type Debugger, type NativeImage } from 'electron'
import type { DeviceSpec, ProbeResult } from '@shared/types'
import { log } from '../log'
import { PROBE_SCRIPT, WAIT_PAINT_SCRIPT } from './probeScript'
import { signatureOf } from './signature'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** 填写目标的身份特征，用于点击后核对焦点是否落在预期控件上 */
export interface FillTarget {
  name?: string
  placeholder?: string
}

export interface Screenshot {
  /** 原始分辨率 PNG，落盘存档 */
  png: Buffer
  /** 645px 宽 JPEG，发给 AI 与画布缩略图共用 */
  jpegBase64: string
}

/** 绘制等待的上限。到点就抓，图可能欠一点，但绝不卡住 */
const PAINT_WAIT_MAX_MS = 4000

/** 探索引擎依赖的页面能力抽象。真实实现是 CDP，测试用 fake 实现 */
export interface IPageDriver {
  goto(url: string): Promise<void>
  probe(): Promise<ProbeResult>
  waitStable(): Promise<ProbeResult>
  screenshot(): Promise<Screenshot>
  tap(x: number, y: number): Promise<void>
  /** 返回是否确实写入成功 */
  fillAt(x: number, y: number, text: string, expect?: FillTarget): Promise<boolean>
  scrollBy(delta: number): Promise<void>
  back(): Promise<void>
  currentUrl(): string
}

const SCREENSHOT_WIDTH_FOR_AI = 645

export class PageDriver implements IPageDriver {
  private rawView: WebContentsView | null = null
  private win: BaseWindow | null = null
  private device: DeviceSpec | null = null
  /**
   * setDeviceMetricsOverride 的 scale。
   * CDP 的输入坐标是在「缩放后」的空间里解释的：页面最终收到的是 发送值 ÷ scale。
   * 所以派发前必须把 CSS 坐标乘以 scale，否则缩放状态下会点偏。
   */
  private inputScale = 1
  private bounds: Bounds = { x: 0, y: 0, width: 430, height: 932 }
  /** 已装过请求头注入器的 partition，避免重复注册 */
  private identityPartition = ''
  private visible = true
  /** 最近一次转为可见时的几何快照，见 setVisible */
  private shownAt: { bounds: Bounds; scale: number } | null = null
  private onNav?: (url: string, loading: boolean) => void
  private onNavigated?: () => void
  private onCrash?: (detail: string) => void

  get attached(): boolean {
    return this.rawView !== null
  }

  /** 供层级排序使用：预览视图与界面视图同为窗口子视图，谁在上由排序决定 */
  get view(): WebContentsView | null {
    return this.rawView
  }

  private get dbg(): Debugger {
    if (!this.rawView) throw new Error('预览视图尚未创建')
    return this.rawView.webContents.debugger
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  create(win: BaseWindow, partition: string, device: DeviceSpec): void {
    this.destroy()
    this.win = win
    this.device = device

    // session 级 UA 只对「之后创建」的 WebContents 生效，所以必须抢在 new 之前设。
    // 同时在网络层强制注入客户端提示——设备模拟只管客户端视口，
    // 不改发给服务器的请求身份；按 Sec-CH-UA 判端的站点否则仍会回 PC 版 HTML。
    this.installIdentity(partition, device)

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
    // 「视图已改尺寸、页面还没出帧」那块用这个颜色填充。
    // 这里是手机屏幕区，黑色与关着的设备屏幕一致，不突兀
    view.setBackgroundColor('#000000')
    // 挂载成功之后才认领：窗口已销毁时 addChildView 会抛，
    // 先赋值的话这个没挂上、又还活着的视图就再没人回收了
    try {
      win.contentView.addChildView(view)
    } catch (e) {
      try {
        view.webContents.close()
      } catch {
        /* 忽略 */
      }
      throw e
    }
    this.rawView = view
    view.setBounds(this.bounds)

    const wc = view.webContents
    // 外链一律留在同一个 view 内，避免逃出预览窗口
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void wc.loadURL(url)
      return { action: 'deny' }
    })
    wc.on('did-start-loading', () => this.onNav?.(wc.getURL(), true))
    wc.on('did-stop-loading', () => this.onNav?.(wc.getURL(), false))
    // 跨进程导航会换掉 RenderFrameHost，Emulation 覆盖有可能不跟过去。
    // 每次主框架提交后重放一遍，成本很低但能免掉「设备模拟突然失效」。
    wc.on('did-navigate', () => this.onNavigated?.())
    // 细节必须带出去：reason 区分的是崩溃、被杀、内存耗尽还是主动退出，
    // 丢掉它事后只知道"预览崩过一次"，判断不了是站点太重还是驱动有问题
    wc.on('render-process-gone', (_e, d) => this.onCrash?.(`reason=${d.reason} exitCode=${d.exitCode}`))

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
    if (!this.rawView) throw new Error('预览视图尚未创建')
    const wc = this.rawView.webContents
    if (wc.getURL()) return
    try {
      await wc.loadURL('about:blank')
    } catch {
      // 这一步只为把渲染进程拉起来，被后续导航打断（ERR_ABORTED）属于正常现象
    }
  }

  destroy(): void {
    if (!this.rawView) return
    const wc = this.rawView.webContents
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      /* 已断开则忽略 */
    }
    try {
      this.win?.contentView.removeChildView(this.rawView)
    } catch {
      /* 窗口可能已销毁 */
    }
    try {
      wc.close()
    } catch {
      /* 忽略 */
    }
    this.rawView = null
  }

  setCallbacks(cb: {
    onNav?: (url: string, loading: boolean) => void
    onNavigated?: () => void
    onCrash?: (detail: string) => void
  }): void {
    this.onNav = cb.onNav
    this.onNavigated = cb.onNavigated
    this.onCrash = cb.onCrash
  }

  /* ------------------------------ 设备模拟 ------------------------------ */

  /**
   * 把「请求身份」钉在 session 网络层。
   *
   * 这一层与设备模拟是两回事：setDeviceMetricsOverride 只改客户端视口，
   * 服务器看到的仍是默认 UA 与客户端提示。实测顶层导航请求默认不带
   * Sec-CH-UA 系列（只有子资源带），按客户端提示判端的站点因此回 PC 版 HTML。
   * 这里对每个请求（含主框架文档）强制覆盖，才能让「模拟」在服务端也成立。
   */
  private installIdentity(partition: string, device: DeviceSpec): void {
    const ses = session.fromPartition(partition)
    ses.setUserAgent(device.userAgent, 'zh-CN,zh;q=0.9')

    if (this.identityPartition === partition) return
    this.identityPartition = partition
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const d = this.device
      if (!d) return callback({})
      const headers: Record<string, string | string[]> = { ...details.requestHeaders }
      headers['User-Agent'] = d.userAgent
      const m = d.userAgentMetadata
      if (m) {
        headers['Sec-CH-UA-Mobile'] = m.mobile ? '?1' : '?0'
        headers['Sec-CH-UA-Platform'] = `"${m.platform}"`
        if (m.brands.length) {
          headers['Sec-CH-UA'] = m.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ')
        } else {
          // iOS/Safari 档：真实 Safari 根本不发这组头，留着反而露馅
          delete headers['Sec-CH-UA']
          delete headers['Sec-CH-UA-Full-Version-List']
        }
      }
      callback({ requestHeaders: headers })
    })
  }

  /** 应用全套 override。任何设备变更后都要重放一遍，再 reload */
  async applyDevice(device: DeviceSpec, fitScale: number): Promise<void> {
    if (!this.rawView) return
    this.device = device
    this.inputScale = fitScale
    const wc = this.rawView.webContents

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
    this.rawView?.setBounds(b)
  }

  /** 当前实际下发给 CDP 的缩放，用于校验与视图尺寸是否一致 */
  currentScale(): number {
    return this.inputScale
  }

  currentBounds(): Bounds | null {
    return this.rawView ? this.bounds : null
  }

  setVisible(visible: boolean): void {
    // 记下「由隐藏转为可见」那一刻的几何：错位是一个时序问题，
    // 事后采样抢不到那一帧，只有把它存成状态才能被断言
    if (visible && !this.visible) this.shownAt = { bounds: { ...this.bounds }, scale: this.inputScale }
    this.visible = visible
    this.rawView?.setVisible(visible)
  }

  isVisible(): boolean {
    return this.visible
  }

  /** 视图最近一次由隐藏转为可见时的 bounds 与 CDP scale */
  lastShownGeometry(): { bounds: Bounds; scale: number } | null {
    return this.shownAt
  }

  /**
   * 注意：不要用 Input.setIgnoreInputEvents 来屏蔽用户误触。
   * 实测它会连 CDP 派发的事件一起吞掉，开启后自动点击全部失效、
   * 而且不报任何错，表现为「循环在跑但页面纹丝不动」。
   *
   * 改为在页内标记自动化时间窗，把窗口之外的真实输入识别为「用户想接管」。
   */
  async markAutomating(): Promise<void> {
    await this.evalInPage(`window.__ufcLastAuto = Date.now(); true`, 3000).catch(() => undefined)
  }

  /** 安装用户输入探测器，用于识别隐式接管意图 */
  async installUserInputWatcher(): Promise<void> {
    await this.evalInPage(
      `(() => {
        if (window.__ufcInputWatch) return true
        window.__ufcInputWatch = true
        window.__ufcLastAuto = 0
        window.__ufcUserInput = 0
        const mark = () => { if (Date.now() - (window.__ufcLastAuto || 0) > 1500) window.__ufcUserInput = Date.now() }
        document.addEventListener('pointerdown', mark, true)
        document.addEventListener('keydown', mark, true)
        return true
      })()`,
      3000
    ).catch(() => undefined)
  }

  /** 距上次真实用户输入的毫秒数，从未发生则返回 null */
  async userInputAge(): Promise<number | null> {
    const t = (await this.evalInPage(`window.__ufcUserInput || 0`, 3000).catch(() => 0)) as number
    return t ? Date.now() - t : null
  }

  async clearUserInput(): Promise<void> {
    await this.evalInPage(`window.__ufcUserInput = 0; true`, 3000).catch(() => undefined)
  }

  /** 清空历史，避免 back() 回退到启动时用来拉起渲染进程的 about:blank */
  clearHistory(): void {
    try {
      this.rawView?.webContents.navigationHistory.clear()
    } catch {
      /* 某些时机下不可用，忽略 */
    }
  }

  /* -------------------------------- 导航 -------------------------------- */

  async goto(url: string): Promise<void> {
    if (!this.rawView) throw new Error('预览视图尚未创建')
    await this.rawView.webContents.loadURL(url)
    await this.settle()
  }

  async back(): Promise<void> {
    const wc = this.rawView?.webContents
    if (!wc) return
    if (wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack()
      await this.settle()
    }
  }

  /**
   * 强制整帧重绘。
   *
   * 视图尺寸变了但页面没重新绘制时，合成器会拿旧图块去铺满新尺寸——
   * 表现就是同一屏内容在框里重复好几遍。换设备这类尺寸剧变之后补一刀最保险。
   */
  repaint(): void {
    this.rawView?.webContents.invalidate()
  }

  async reload(): Promise<void> {
    this.rawView?.webContents.reload()
    await this.settle()
  }

  currentUrl(): string {
    return this.rawView?.webContents.getURL() ?? ''
  }

  canGoBack(): boolean {
    return this.rawView?.webContents.navigationHistory.canGoBack() ?? false
  }

  title(): string {
    return this.rawView?.webContents.getTitle() ?? ''
  }

  /* -------------------------- 探针与稳定帧等待 -------------------------- */

  async probe(): Promise<ProbeResult> {
    return (await this.evalInPage(PROBE_SCRIPT)) as ProbeResult
  }

  /** 等待渲染安静：加载结束 + 图片解码 + 固定延时 */
  async settle(extraMs = 900): Promise<void> {
    const wc = this.rawView?.webContents
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
    /*
     * 页面里的等待再怎么设上限，都可能因为渲染进程本身被挂起而不返回。
     * 这里再兜一层：绘制等待是为了图更完整，不是必须完成的步骤，
     * 到点就往下走，绝不能让它把抓图卡住。
     */
    await Promise.race([
      wc.executeJavaScript(WAIT_PAINT_SCRIPT, true).catch(() => undefined),
      delay(PAINT_WAIT_MAX_MS),
    ])
    await delay(extraMs)
  }

  /** 连续两次探针签名一致才算稳定，避开弹窗动画的中间态 */
  async waitStable(interval = 350, max = 12): Promise<ProbeResult> {
    // 先等导航与图片就绪，否则第一针常常打在空页面上
    await this.settle(300)
    let prevSig: string | null = null
    let last: ProbeResult | null = null
    for (let i = 0; i < max; i++) {
      let p: ProbeResult
      try {
        p = await this.probe()
      } catch {
        // 导航切换期间探针会超时，等一拍再来
        await delay(interval)
        continue
      }
      const sig = signatureOf(p)
      if (prevSig === sig) return p
      prevSig = sig
      last = p
      await delay(interval)
    }
    if (last) return last
    return this.probe()
  }

  /* -------------------------------- 截图 -------------------------------- */

  /**
   * 取一张当前画面，只用于顶替。
   *
   * 走 Electron 自带的 capturePage：它拿的是合成器已有的那一帧，按显示尺寸出图，
   * 不会像带 clip.scale 的 CDP 抓图那样触发整块合成面重新光栅化。
   * 存档图仍由 screenshot() 按设备原始分辨率出。
   */
  async capturePreviewFrame(): Promise<string> {
    if (!this.rawView) return ''
    const img = await this.rawView.webContents.capturePage()
    if (img.isEmpty()) return ''
    return img.toJPEG(70).toString('base64')
  }

  async screenshot(): Promise<Screenshot> {
    if (!this.rawView || !this.device) throw new Error('预览视图尚未创建')

    /*
     * 抓图前再确认一次这一屏画出来了。
     *
     * waitStable 那次等的是「界面稳定」，中间还隔着 AI 决策与动作执行；
     * 点击、滚动之后页面往往又要加载一批图。存档图是事后唯一的凭据，
     * 多等这一下，换的是不再拍到半张骨架屏。
     *
     * 走 settle 而不是只跑一次绘制等待脚本：导航尚未结束时文档里可能还没有
     * 那些图片元素，脚本会立刻返回、等于没等。settle 会先等这次加载结束。
     */
    await this.settle(0)

    let png: Buffer
    let img: NativeImage
    try {
      png = await this.captureViaCdp()
      img = nativeImage.createFromBuffer(png)
      /*
       * 尺寸自检 + 自愈。
       *
       * clip 定了设备逻辑尺寸、scale 传 1，输出应恒为「设备宽高 × 设备像素比」。
       * 与预期不符说明设备模拟没有落在这次渲染上（跨进程导航把 override 换掉、
       * 抓图与视口同步竞争等）——拍出来就是放大裁切的局部画面。
       * 重放一遍 override 再抓一次；仍不符就保留现图并留痕，供诊断包定位。
       */
      if (this.badShotSize(img)) {
        const got = img.getSize()
        log.warn(
          'driver',
          `存档图尺寸异常（${got.width}×${got.height}，应为 ${this.expectedShotSize()}），重放设备模拟后重抓`
        )
        await this.applyDevice(this.device, this.inputScale)
        png = await this.captureViaCdp()
        img = nativeImage.createFromBuffer(png)
        if (this.badShotSize(img)) {
          const again = img.getSize()
          log.warn('driver', `重抓后存档图尺寸仍异常（${again.width}×${again.height}），已保留该图`)
        }
      }
    } catch (e) {
      /*
       * 合成器偶尔出不了帧（导航中等），退回 Electron 自带的抓图。
       *
       * 注意这条兜底对**隐藏的视图无效**——capturePage 对隐藏视图必然失败，
       * 而 CDP 那条路在隐藏时反而是好的。所以它只兜得住前台的偶发失败，
       * 后台会话真出问题时这里拿到的是空图。
       */
      img = await this.rawView.webContents.capturePage().catch(() => nativeImage.createEmpty())
      png = img.toPNG()
      if (png.length === 0) {
        throw new Error(`抓图失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    /*
     * 空图必须报错，不能往下传。
     *
     * 原先两条路都失败时返回的是空 Buffer：调用方的 try/catch 永远不触发，
     * AI 拿着空图做决策，磁盘上还会留下 0 字节的 png——事后翻存档只看到一堆空文件，
     * 完全看不出当时发生过什么。
     */
    if (png.length === 0) throw new Error('抓图失败：返回了空图')
    if (img.isEmpty()) throw new Error('抓图失败：图像无法解析')
    const thumb = img.resize({ width: SCREENSHOT_WIDTH_FOR_AI, quality: 'good' })
    return { png, jpegBase64: thumb.toJPEG(80).toString('base64') }
  }

  /** CDP 抓一张设备原始分辨率的存档图 */
  private async captureViaCdp(): Promise<Buffer> {
    // clip.scale 固定输出倍率，与预览用的 fitScale 解耦——
    // 无论画面缩放到多小，存档图始终是设备原始分辨率
    const m = (await this.send('Page.getLayoutMetrics', {}, 5000)) as {
      cssVisualViewport?: { pageX: number; pageY: number }
      visualViewport?: { pageX: number; pageY: number }
    }
    const vp = m.cssVisualViewport ?? m.visualViewport ?? { pageX: 0, pageY: 0 }
    const res = (await this.send(
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: false,
        clip: {
          x: vp.pageX,
          y: vp.pageY,
          width: this.device!.width,
          height: this.device!.height,
          scale: 1,
        },
      },
      20000
    )) as { data: string }
    return Buffer.from(res.data, 'base64')
  }

  private expectedShotSize(): string {
    const d = this.device!
    return `${Math.round(d.width * d.deviceScaleFactor)}×${Math.round(d.height * d.deviceScaleFactor)}`
  }

  /** 输出与「设备逻辑尺寸 × 像素比」任一维偏差超过 2% 即判为几何错位 */
  private badShotSize(img: NativeImage): boolean {
    const d = this.device
    if (!d) return false
    const { width, height } = img.getSize()
    // 空图不在这里管，交给后面的空图检查报错
    if (!width || !height) return false
    const ew = d.width * d.deviceScaleFactor
    const eh = d.height * d.deviceScaleFactor
    return Math.abs(width - ew) > ew * 0.02 || Math.abs(height - eh) > eh * 0.02
  }

  /* -------------------------------- 输入 -------------------------------- */

  /** 把 CSS 坐标换算到 CDP 的输入坐标空间 */
  private toInput(x: number, y: number): { x: number; y: number } {
    return { x: Math.round(x * this.inputScale), y: Math.round(y * this.inputScale) }
  }

  async tap(cssX: number, cssY: number): Promise<void> {
    await this.markAutomating()
    const { x, y } = this.toInput(cssX, cssY)
    if (this.device?.hasTouch) {
      const point = { x, y, radiusX: 12, radiusY: 12, force: 1 }
      await this.sendInput('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await delay(60)
      await this.sendInput('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      const base = { x, y, button: 'left', clickCount: 1 }
      await this.sendInput('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' })
      await this.sendInput('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
      await delay(40)
      await this.sendInput('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
    }
    await delay(200)
  }

  /** 先点中输入框聚焦，再插入文本；insertText 产生 trusted 输入，受控组件能正常收到 */
  /**
   * 填写输入框：先点中聚焦，再用 insertText 产生 trusted 输入。
   *
   * 页面刚加载完时第一次点击有概率没能聚焦，导致 insertText 落空且毫无提示。
   * 所以写完要回读校验，没写进去就用原生 setter 兜底——
   * 走 setter 而不是直接赋值，React 这类受控组件才能收到 onChange。
   */
  async fillAt(x: number, y: number, text: string, expect?: FillTarget): Promise<boolean> {
    await this.tap(x, y)
    await delay(150)

    // 只按坐标点会出问题：相邻输入框间距小、点击前后又可能有细微布局变化，
    // 焦点很容易落到隔壁字段上，然后把内容写错地方还查不出来。
    // 所以点完先核对焦点身份，不对就按 name/placeholder 精确改焦。
    const ok = (await this.evalInPage(
      `(() => {
        const want = ${JSON.stringify(text)}
        const expect = ${JSON.stringify(expect ?? null)}
        const matches = (el) => {
          if (!el || !('value' in el)) return false
          if (!expect) return true
          if (expect.name && (el.getAttribute('name') || el.id) === expect.name) return true
          if (expect.placeholder && el.getAttribute('placeholder') === expect.placeholder) return true
          return false
        }
        let el = document.activeElement
        if (!matches(el)) {
          const all = [...document.querySelectorAll('input,textarea,select')]
          el = all.find(matches) || document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})
          if (!matches(el)) return false
          if (el.focus) el.focus()
        }
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, '')
        setter.call(el, want)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return el.value === want
      })()`
    ).catch(() => false)) as boolean

    await delay(200)
    return ok
  }

  /** delta 为正表示向下滚动 */
  async scrollBy(delta: number): Promise<void> {
    if (!this.device) return
    await this.markAutomating()
    const { x, y } = this.toInput(this.device.width / 2, this.device.height / 2)
    try {
      await this.send(
        'Input.synthesizeScrollGesture',
        {
          x,
          y,
          // CDP 的 yDistance 正数表示向上滚，与我们的语义相反
          yDistance: -delta,
          speed: 3000,
          gestureSourceType: this.device.hasTouch ? 'touch' : 'mouse',
        },
        8000
      )
    } catch {
      await this.evalInPage(`scrollBy(0, ${delta}); true`).catch(() => undefined)
    }
    await delay(400)
  }

  /**
   * 在目标页内执行脚本并取回结果。
   * 必须带超时：页面正在导航时 executeJavaScript 可能永远不返回，
   * 没有超时的话整个探索循环会静默卡死在某一步。
   */
  async evalInPage(script: string, timeoutMs = 8000): Promise<unknown> {
    if (!this.rawView) throw new Error('预览视图尚未创建')
    const wc = this.rawView.webContents
    return Promise.race([
      wc.executeJavaScript(script, true),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('页内脚本执行超时')), timeoutMs)),
    ])
  }

  async blurActive(): Promise<void> {
    await this.evalInPage(`document.activeElement && document.activeElement.blur(); true`).catch(() => undefined)
    await delay(300)
  }

  /* -------------------------------- 内部 -------------------------------- */

  /**
   * 所有 CDP 调用都带超时。
   * 页面正在导航时，Input.* 与 Emulation.* 可能永远不返回——
   * 少了这道超时，探索循环会静默卡死在某一步而不报任何错。
   */
  private async send(method: string, params: Record<string, unknown>, timeoutMs = 12000): Promise<unknown> {
    const trace = process.env.UFC_TRACE === '1'
    if (trace) console.log(`[cdp] → ${method}`)
    try {
      const r = await Promise.race([
        this.dbg.sendCommand(method, params),
        new Promise((_r, reject) => setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs)),
      ])
      if (trace) console.log(`[cdp] ✓ ${method}`)
      return r
    } catch (e) {
      if (trace) console.log(`[cdp] ✗ ${method}: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  }

  /** 输入类命令允许失败：导航打断属于正常现象，不该让整轮探索报错 */
  private async sendInput(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.send(method, params, 6000)
    } catch (e) {
      if (process.env.UFC_TRACE === '1') console.log(`[cdp] input ignored: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 预览框内的适配比例：让设备整屏塞进可用区域，最大不放大 */
export function computeFitScale(device: DeviceSpec, pane: { width: number; height: number }): number {
  if (pane.width <= 0 || pane.height <= 0) return 1
  // 上限取设备像素密度而不是 1：手机逻辑宽度只有 430，面板比它宽时若封顶在 1，
  // 网页就只占中间一小条、两侧留黑。放大到 dpr 倍仍是在对 dpr 倍的光栅做降采样，
  // 画面不会糊；超过 dpr 才会真的被拉伸，所以到此为止。
  const max = Math.max(1, device.deviceScaleFactor)
  return Math.min(pane.width / device.width, pane.height / device.height, max)
}
