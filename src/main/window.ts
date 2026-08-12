import { join } from 'node:path'
import { BrowserWindow, Menu, nativeTheme, shell } from 'electron'
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

export function createMainWindow(): BrowserWindow {
  // 应用没有需要放进系统菜单的功能，File/Edit/View 这类默认菜单只是噪声
  Menu.setApplicationMenu(null)

  const win = new BrowserWindow({
    width: 1560,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: themeBackground(),
    title: 'UI Flow Chart',
    webPreferences: {
      // 工程是 ESM，electron-vite 会把 preload 产物命名为 .mjs
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // 跟随系统时，系统深浅色一变，窗口底色也要跟着换
  const syncBackground = (): void => {
    if (!win.isDestroyed()) win.setBackgroundColor(themeBackground())
  }
  nativeTheme.on('updated', syncBackground)
  win.on('closed', () => nativeTheme.off('updated', syncBackground))

  // 渲染进程里的外链走系统浏览器，不在应用内开窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}
