import { expect, test } from '@playwright/test'
import { getDevice } from '../../src/shared/devices'
import { evalPreview, ipc, launchApp, startTestSite, TEST_SITE, waitFor } from './helpers'

/**
 * 横竖屏切换。
 *
 * 转屏在真机上只改逻辑视口，UA、像素比、触摸都不变——这几项一起守住，
 * 才能确认这里改的是「朝向」而不是换了一台设备。
 */
test('切到横屏只对调视口宽高，其余模拟项不变；PC 档没有这个按钮', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    await window.getByRole('button', { name: '真机预览' }).click()
    await window.waitForTimeout(600)
    await window.locator('.preview-toolbar input.url').fill(`${TEST_SITE}/ua-echo.html`)
    await window.locator('.preview-toolbar button', { hasText: '打开' }).click()

    interface Info {
      ua: string
      width: number
      height: number
      dpr: number
      touch: boolean
    }
    const read = async (): Promise<Info> => {
      await waitFor(async () => (await evalPreview<Info | null>(window, 'window.__deviceInfo || null')) !== null, 20000)
      return evalPreview<Info>(window, 'window.__deviceInfo')
    }

    const portrait = await read()
    const preset = getDevice('iphone-17-pro-max')
    expect(portrait.width, '默认应当是预设的竖屏宽度').toBe(preset.width)
    expect(portrait.height).toBe(preset.height)

    const toggle = window.locator('.orient-toggle')
    await expect(toggle, '手机档要有横竖屏按钮').toBeVisible()
    await toggle.click()
    await window.waitForTimeout(2500)

    const landscape = await read()
    expect(landscape.width, '横屏宽度＝竖屏高度').toBe(preset.height)
    expect(landscape.height, '横屏高度＝竖屏宽度').toBe(preset.width)
    expect(landscape.dpr, '像素比不该跟着变').toBe(portrait.dpr)
    expect(landscape.touch, '触摸不该跟着变').toBe(portrait.touch)
    expect(landscape.ua, 'UA 不该跟着变').toBe(portrait.ua)
    // 主进程侧的设备状态也要跟上，否则截图与坐标换算仍按竖屏走
    const dbg = await ipc<{ device: { width: number; height: number } }>(window, 'test:preview-debug')
    expect(dbg.device.width).toBe(preset.height)
    expect(dbg.device.height).toBe(preset.width)

    // 再点一次回到竖屏
    await toggle.click()
    await window.waitForTimeout(2500)
    expect((await read()).width, '再切一次要回到竖屏').toBe(preset.width)

    // PC 档没有横竖屏之分，按钮直接不出现。
    // 必须从界面上换设备：直接发 IPC 只改主进程，渲染进程的机型没跟着变
    await window.locator('.preview-toolbar .ufc-select').click()
    await window.locator('.device-pop .cats button', { hasText: 'PC' }).hover()
    await window.locator('.device-pop .models button', { hasText: '网页 1440' }).click()
    await window.waitForTimeout(2500)
    await expect(window.locator('.orient-toggle'), 'PC 档不该出现横竖屏按钮').toHaveCount(0)
  } finally {
    await app.close()
    stopSite()
  }
})
