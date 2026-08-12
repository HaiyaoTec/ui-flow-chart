import { expect, test } from '@playwright/test'
import { ipc, launchApp } from './helpers'

/**
 * 窗口底色必须跟随主题。
 *
 * 拖动窗口边框时，新露出的区域由窗口底色先填上，渲染进程的新帧要晚一帧才到。
 * 底色写死成深色的话，浅色主题下每次缩放窗口都会在边缘闪出一条黑边。
 */
test('切换主题后窗口底色跟着换', async () => {
  const { app, window } = await launchApp()
  try {
    const bg = () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor?.() ?? '')

    await ipc(window, 'theme:set', { theme: 'light' })
    await window.waitForTimeout(400)
    const light = (await bg()).toUpperCase()

    await ipc(window, 'theme:set', { theme: 'dark' })
    await window.waitForTimeout(400)
    const dark = (await bg()).toUpperCase()

    expect(light, '浅色主题的窗口底色不该是深色').toBe('#F4F5F8')
    expect(dark, '深色主题的窗口底色不该是浅色').toBe('#0D0F14')
  } finally {
    await app.close()
  }
})
