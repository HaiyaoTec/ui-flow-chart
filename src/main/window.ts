import { join } from 'node:path'
import { BaseWindow, Menu, nativeTheme, shell, WebContentsView, type WebContents } from 'electron'
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
   * 拖拽窗口边框时不去改视图尺寸，松手后再一次性贴合。
   *
   * 黑边的来源是视图自己那块「还没光栅化出来」的表面：不管多早下发新尺寸，
   * 渲染进程都要一两帧才画得出来，在那之前 Chromium 合成的就是黑色，
   * View.setBackgroundColor 盖不住它（webContents.setBackgroundColor 在
   * Electron 34 上并不存在，调了也是空操作）。
   *
   * 反过来想：只要视图不跟着变大，新露出的那条就还属于窗口本身，
   * 画的是窗口底色——也就是当前主题的 --bg。于是拖拽过程中看到的是一条
   * 主题色的留白，松手瞬间界面补齐；窗口变小时视图比窗口大，被裁掉，同样没有异常。
   */
  let resizing = false
  win.on('will-resize', () => {
    resizing = true
  })
  win.on('resize', () => {
    if (!resizing) fit()
  })
  win.on('resized', () => {
    resizing = false
    fit()
  })
  // 最大化/还原不是拖拽，系统会一次到位，直接贴合
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
 * 界面视图自己的底色。
 *
 * 拖动窗口边框时，视图先被放大、渲染进程的新帧要晚一步才到，中间这块区域画的是
 * 视图的底色——不设的话就是黑的，表现为右侧/下方闪出一条黑边。
 * 窗口底色管不到这里：界面已经是覆盖在窗口上的子视图了。
 */
export function applyViewBackground(): void {
  if (!uiView) return
  const color = themeBackground()
  // 两处都要设：View 的底色管「视图自己那块画布」，
  // webContents 的底色管「页面还没光栅化出来的区域」——后者默认是透明的，
  // 透出去就是窗口的黑色底板，正是拖边框时右侧/下方那条黑边
  uiView.setBackgroundColor(color)
  const wc = uiView.webContents as unknown as { setBackgroundColor?: (c: string) => void }
  wc.setBackgroundColor?.(color)
}
