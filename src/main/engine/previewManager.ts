import type { BrowserWindow } from 'electron'
import { CH, type Bounds, type NavState } from '@shared/ipc-contract'
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

    const fit = computeFitScale(device, this.pane)
    const trace = (s: string) => process.env.UFC_TRACE === '1' && console.log(`[preview] ${s}`)

    trace('create view')
    this.driver.create(this.win, partition, device)
    this.driver.setCallbacks({
      onNav: () => this.emitNav(),
      onCrash: () => this.handleCrash(),
    })
    trace('spin up renderer')
    await this.driver.ensureRenderer()
    trace('apply device overrides')
    await this.driver.applyDevice(device, fit)
    trace('apply bounds')
    this.applyBounds()
    trace(`goto ${url}`)
    await this.driver.goto(url)
    trace('goto done')
    this.lastUrl = url
    this.emitNav()
  }

  /** 切换设备 = 重放全部 override + 重新加载，不能只改 bounds */
  async setDevice(device: DeviceSpec): Promise<void> {
    this.device = device
    if (!this.driver.attached) return
    await this.driver.applyDevice(device, computeFitScale(device, this.pane))
    this.applyBounds()
    await this.driver.reload()
    this.emitNav()
  }

  /** 渲染进程上报的屏幕占位矩形 */
  async setPaneBounds(b: Bounds): Promise<void> {
    this.pane = b
    if (!this.driver.attached) return
    const fit = computeFitScale(this.device, b)
    await this.driver.applyDevice(this.device, fit)
    this.applyBounds()
  }

  setVisible(visible: boolean): void {
    this.driver.setVisible(visible)
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
  private applyBounds(): void {
    const fit = computeFitScale(this.device, this.pane)
    const w = Math.round(this.device.width * fit)
    const h = Math.round(this.device.height * fit)
    this.driver.setBounds({
      x: Math.round(this.pane.x + (this.pane.width - w) / 2),
      y: Math.round(this.pane.y + (this.pane.height - h) / 2),
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
