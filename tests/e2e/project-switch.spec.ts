import { expect, test } from '@playwright/test'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE } from './helpers'

/**
 * 切换项目时，右侧预览必须整体跟着换：原生视图、地址栏、设备下拉三者一致。
 *
 * 回归背景：地址栏原先只在组件挂载时取一次 initialUrl，而切换项目不会重新挂载
 * PreviewPane，于是视图已经打开新项目的网址，输入框还停在上一个项目的地址上；
 * 设备下拉同理，固定显示 DEVICE_PRESETS[0]，项目用别的机型时它是错的。
 */
test('切换项目后，预览地址栏与设备下拉都跟着换', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '切换', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    // 两个项目的网址与设备都不同，才能分辨出换没换
    const a = await ipc<{ id: string }>(window, 'project:create', {
      name: 'A 项目',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })
    const b = await ipc<{ id: string }>(window, 'project:create', {
      name: 'B 项目',
      targetUrl: `${TEST_SITE}/register.html`,
      deviceId: 'pixel-7',
      aiProfileId: profile.id,
      goal: 'x',
    })

    await openFirstProject(window)
    await window.waitForTimeout(2000)

    const urlBox = window.locator('.preview-toolbar input.url')
    const deviceLabel = window.locator('.preview-toolbar .ufc-select .val')
    const first = await urlBox.inputValue()
    const firstDevice = await deviceLabel.textContent()

    // 列表按更新时间排序，先打开的是哪个不重要，换到另一个即可
    const other = first.includes('ua-echo') ? 'B 项目' : 'A 项目'
    const otherUrlPart = other === 'B 项目' ? 'register.html' : 'ua-echo.html'
    const otherDevice = other === 'B 项目' ? 'Pixel 7' : 'iPhone 14 Pro Max'

    await window.locator('.proj-trigger').click()
    await window.waitForTimeout(400)
    await window.locator('.proj-pop-list button', { hasText: other }).first().click()
    await window.waitForTimeout(2500)

    await expect(urlBox, '地址栏应指向新项目的网址').toHaveValue(new RegExp(otherUrlPart))
    await expect(deviceLabel, '设备下拉应显示新项目的机型').toHaveText(otherDevice)
    expect(await deviceLabel.textContent(), '两个项目机型不同，下拉必须变化').not.toBe(firstDevice)

    // 原生视图也必须真的换过去，不能只是界面上改了字
    const info = await ipc<{ w: number } | null>(window, 'test:eval-preview', '({ w: innerWidth })')
    expect(info?.w, '视口宽度应为新项目的设备宽度').toBe(other === 'B 项目' ? 412 : 430)

    await window.locator('.sidebar').getByRole('button', { name: /项目/ }).click()
    await window.waitForTimeout(400)
    await ipc(window, 'project:delete', { id: a.id })
    await ipc(window, 'project:delete', { id: b.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
