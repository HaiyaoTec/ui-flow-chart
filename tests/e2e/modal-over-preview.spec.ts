import { expect, test } from '@playwright/test'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE, waitFor } from './helpers'

interface Debug {
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number } | null
}

/**
 * 弹窗必须盖得住预览网页。
 *
 * 预览由原生视图绘制，永远画在 HTML 之上——在真机预览页打开设置面板时，
 * 手机那一块会直接压在面板上，右半边看不全。想盖住它只有一个办法：
 * 把界面视图提到预览之上（纯排序，见 previewManager.setStackFront）。
 *
 * 断言不去比像素，而是查两件可确定读取的事实：面板与视图在屏幕上确有重叠，
 * 以及此时主进程记录的层级是界面在上。前者保证这个用例真的处在缺陷场景里，
 * 后者才是要守住的行为。
 */
test('在真机预览页打开设置面板时，网页不会压在面板上', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '层级', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '层级',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })
    await openFirstProject(window)
    await waitFor(async () => (await ipc<Debug>(window, 'test:preview-debug')).visible, 20000)

    const stack = () => ipc<{ front: string }>(window, 'test:ui-stack')
    expect((await stack()).front, '常态下预览在上，否则网页点不动').toBe('preview')

    await window.locator('.settings-trigger').click()
    await window.locator('.settings-pop').getByRole('button', { name: /诊断与日志/ }).click()

    const panel = window.locator('.settings-panel')
    await expect(panel).toBeVisible()

    // 先确认这个用例确实处在缺陷场景里：面板与原生视图在屏幕上有重叠
    const view = (await ipc<Debug>(window, 'test:preview-debug')).bounds!
    const box = (await panel.boundingBox())!
    const overlap =
      Math.min(box.x + box.width, view.x + view.width) - Math.max(box.x, view.x) > 0 &&
      Math.min(box.y + box.height, view.y + view.height) - Math.max(box.y, view.y) > 0
    expect(overlap, '面板与预览视图应当有重叠，否则这个用例守不住任何东西').toBe(true)

    expect((await stack()).front, '弹窗打开期间界面必须在网页之上').toBe('ui')

    // 关闭后要放回去，否则网页从此点不动
    await window.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await waitFor(async () => (await stack()).front === 'preview', 3000)

    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})

/**
 * 下拉与弹窗的层级互不打架。
 *
 * 两者都想把界面提上去，各自按「我关了就放回去」处理的话，
 * 下拉一关就会把仍然开着的弹窗压到网页底下。
 */
test('弹窗里的下拉收起后，界面仍然压在网页之上', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '层级2', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '层级2',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })
    await openFirstProject(window)
    await waitFor(async () => (await ipc<Debug>(window, 'test:preview-debug')).visible, 20000)

    const stack = () => ipc<{ front: string }>(window, 'test:ui-stack')

    // 工作台顶栏的设备下拉压在网页上，开合一轮
    const picker = window.locator('.ws-head .device-picker button').first()
    if (await picker.isVisible().catch(() => false)) {
      await picker.click()
      expect((await stack()).front, '下拉展开时界面在上').toBe('ui')
      await window.keyboard.press('Escape')
      await waitFor(async () => (await stack()).front === 'preview', 3000)
    }

    // 弹窗开着的时候再开合一次下拉，收起后界面必须仍然在上
    await window.locator('.settings-trigger').click()
    await window.locator('.settings-pop').getByRole('button', { name: /AI 接口/ }).click()
    await expect(window.locator('.settings-panel')).toBeVisible()
    expect((await stack()).front).toBe('ui')

    const inner = window.locator('.settings-panel .select-trigger, .settings-panel select').first()
    if (await inner.isVisible().catch(() => false)) {
      await inner.click()
      await window.keyboard.press('Escape')
      expect((await stack()).front, '下拉收起不该把仍然开着的弹窗压到网页底下').toBe('ui')
    }

    await window.keyboard.press('Escape')
    await waitFor(async () => (await stack()).front === 'preview', 3000)

    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
