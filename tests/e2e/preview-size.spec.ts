import { expect, test } from '@playwright/test'
import { ipc, launchApp, startTestSite, TEST_SITE } from './helpers'

/**
 * 人工接管的前提是预览得足够大能真的点。
 * 这里直接量屏幕占位矩形与主进程实际拿到的视图尺寸。
 */
test('预览区应占满可用空间，设备按真实宽高比呈现', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    await window.getByRole('button', { name: '真机预览' }).click()
    await window.waitForTimeout(800)
    await ipc(window, 'preview:navigate', { url: `${TEST_SITE}/index.html` })
    await window.waitForTimeout(1500)

    const rect = await window.evaluate(() => {
      const el = document.querySelector('.device-frame .screen') as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), viewportH: window.innerHeight }
    })

    expect(rect, '应能找到设备屏幕占位').toBeTruthy()
    // 竖屏手机：高度要吃掉大部分可用高度，而不是塌成一个几十像素的小块
    expect(rect!.h).toBeGreaterThan(rect!.viewportH * 0.6)
    // 宽高比贴近 430:932
    const ratio = rect!.w / rect!.h
    expect(Math.abs(ratio - 430 / 932)).toBeLessThan(0.05)

    // 页面确实按 430 宽的移动端布局渲染
    const width = await ipc<{ scrollWidth: number }>(window, 'test:probe').then((p) => p.scrollWidth)
    expect(width).toBeLessThanOrEqual(430)
  } finally {
    await app.close()
    stopSite()
  }
})
