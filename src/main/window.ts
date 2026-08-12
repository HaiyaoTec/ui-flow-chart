import { join } from 'node:path'
import { BaseWindow, Menu, nativeTheme, shell, View, WebContentsView, type WebContents } from 'electron'
import { getSettings } from './store/settings'

/**
 * 窗口底色，与主题的 --bg 保持一致。
 *
 * 拖动窗口边框时，新露出的区域由这个底色先填上，渲染进程的新帧要晚一帧才到——
 * 底色写死成深色的话，浅色主题下每次缩放都会在边缘闪出一条黑边。
 */
export function themeBackground(): string {
  const theme = getSettings().theme
  const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark'
  return dark ? '#0d0f14' : '#f4f5f8'
}

/**
 * 主界面所在的视图。
 *
 * 用 BaseWindow + WebContentsView 而不是 BrowserWindow，是为了能自己排层级：
 * BrowserWindow 的主内容永远在所有子视图之下，预览网页就必然压住界面自己的弹层；
 * 两者都是子视图之后，谁在上由我们说了算——弹层展开时把界面提到最上层即可，
 * 既不用隐藏预览，也不用抓帧顶替，切换是瞬时的。
 */
let uiView: WebContentsView | null = null
/** 垫在最底层的纯色底板，见 createMainWindow 里的说明 */
let backdrop: View | null = null

export function getUiContents(): WebContents | null {
  return uiView && !uiView.webContents.isDestroyed() ? uiView.webContents : null
}

export function createMainWindow(): BaseWindow {
  // 应用没有需要放进系统菜单的功能，File/Edit/View 这类默认菜单只是噪声
  Menu.setApplicationMenu(null)

  const win = new BaseWindow({
    width: 1560,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: themeBackground(),
    title: 'UI Flow Chart',
  })

  /**
   * 最底层的纯色底板。
   *
   * 界面视图重建、或某一帧没能铺满时，这层保证露出来的是主题色而不是空白。
   * 尺寸给足冗余，不必跟着窗口改。
   * （注意：它挡不住拖拽缩放时的黑边——那是合成表面层面的问题，见下方 will-resize 处的说明。）
   */
  const back = new View()
  back.setBackgroundColor(themeBackground())
  back.setBounds({ x: 0, y: 0, width: 16000, height: 16000 })
  backdrop = back
  win.contentView.addChildView(back)

  const view = new WebContentsView({
    webPreferences: {
      // 工程是 ESM，electron-vite 会把 preload 产物命名为 .mjs
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  uiView = view
  win.contentView.addChildView(view)
  applyViewBackground()

  /**
   * 界面视图的尺寸要自己维护——BaseWindow 不像 BrowserWindow 那样自动铺满。
   *
   * 关键是必须赶在窗口真正改变尺寸「之前」下发：只监听 resize 的话，
   * 视图总慢一帧，拖动边框时就会把上一帧的画面留在新露出的区域里，看着像残影。
   * will-resize 给的是窗口外框尺寸，减掉边框与标题栏的差值才是内容区。
   */
  const fit = (contentW?: number, contentH?: number): void => {
    const [w, h] = contentW && contentH ? [contentW, contentH] : win.getContentSize()
    view.setBounds({ x: 0, y: 0, width: w, height: h })
  }
  fit()

  /**
   * 尺寸跟随窗口。will-resize 给的是窗口外框，减掉边框与标题栏才是内容区，
   * 赶在窗口真正改变之前下发，视图就不会慢一帧。
   *
   * 曾经为了绕开「拖拽时边缘露黑」在这里冻结过视图尺寸，那是误判：
   * 黑边并非某一层没画，而是 Chromium 在 Windows 上的已知缺陷——
   * DirectComposition 表面的 clip rect 先于像素扩张，露出的是表面里从未绘制过的区域，
   * 黑色是它的初始化色（Electron 官方博客 "Improving Window Resize Behavior"）。
   * 修复随 4 个 Chromium CL 进入 Electron 39.2.6，本工程已升到 39.8.10，
   * 因此这里恢复正常的实时跟随。
   */
  win.on('will-resize', (_e, next) => {
    const outer = win.getBounds()
    const inner = win.getContentBounds()
    fit(next.width - (outer.width - inner.width), next.height - (outer.height - inner.height))
  })
  win.on('resize', () => fit())
  win.on('maximize', () => fit())
  win.on('unmaximize', () => fit())
  win.on('enter-full-screen', () => fit())
  win.on('leave-full-screen', () => fit())

  view.webContents.once('did-finish-load', () => win.show())

  // 渲染进程里的外链走系统浏览器，不在应用内开窗
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 跟随系统时，系统深浅色一变，窗口底色也要跟着换
  const syncBackground = (): void => {
    if (!win.isDestroyed()) win.setBackgroundColor(themeBackground())
    applyViewBackground()
  }
  nativeTheme.on('updated', syncBackground)
  win.on('closed', () => {
    nativeTheme.off('updated', syncBackground)
    uiView = null
    backdrop = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void view.webContents.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void view.webContents.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}

export function getUiView(): WebContentsView | null {
  return uiView
}

/**
 * 界面视图与底板的底色。
 *
 * WebContentsView.setBackgroundColor 会一路落到 RenderWidgetHostViewAura 的图层背景色，
 * 也就是「视图已放大、渲染进程还没出帧」那块的填充色。不设就是黑的。
 */
export function applyViewBackground(): void {
  const color = themeBackground()
  uiView?.setBackgroundColor(color)
  backdrop?.setBackgroundColor(color)
}
