import { expect, test } from '@playwright/test'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE } from './helpers'

/**
 * 原生视图的可见性回归。
 *
 * WebContentsView 是原生层，永远画在渲染进程的 HTML 之上：自绘的下拉弹层、
 * 收起后的面板、离开工作台后的项目列表，都会被它盖住。凡是「HTML 要露出来」
 * 的时刻，视图都必须先藏起来；凡是回到预览，又必须重新显示。
 */
const visible = (window: Parameters<typeof ipc>[0]) =>
  ipc<{ visible: boolean }>(window, 'test:preview-debug').then((d) => d.visible)

test('弹层展开、面板收起、离开工作台时，原生视图都要让位', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '可见性', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '可见性',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })

    await openFirstProject(window)
    await window.waitForTimeout(2000)
    expect(await visible(window), '进入工作台后视图应显示').toBe(true)

    // 1. 设备下拉：弹层是 HTML，展开期间视图必须藏起来
    await window.locator('.preview-toolbar .ufc-select').click()
    await window.waitForTimeout(500)
    expect(await visible(window), '下拉展开时视图应隐藏').toBe(false)
    await window.keyboard.press('Escape')
    await window.waitForTimeout(500)
    expect(await visible(window), '下拉关闭后视图应恢复').toBe(true)

    // 2. 收起「模拟设备」整块
    await window.locator('.pv-head-toggle').click()
    await window.waitForTimeout(500)
    expect(await visible(window), '收起模拟设备后视图应隐藏').toBe(false)
    await window.locator('.pv-head-toggle').click()
    await window.waitForTimeout(500)
    expect(await visible(window), '重新展开后视图应显示').toBe(true)

    // 3. 换过设备再回项目列表——这里曾经留下一块浮在列表上的白色色块
    await window.locator('.preview-toolbar .ufc-select').click()
    await window.waitForTimeout(400)
    await window.locator('.ufc-select-pop button', { hasText: 'iPhone SE' }).click()
    await window.waitForTimeout(1500)
    await window.locator('.proj-trigger').click()
    await window.waitForTimeout(400)
    await window.locator('.proj-pop-list .to-list').click()
    await window.waitForTimeout(900)
    expect(await visible(window), '回到项目列表后视图必须隐藏').toBe(false)

    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
