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

    // 3. 手动指定缩放：屏幕占位与主进程下发的 scale 都要照做
    await window.locator('.zoom-select').click()
    await window.waitForTimeout(400)
    // 必须精确匹配：150% 也包含「50%」
    await window.locator('.ufc-select-pop button', { hasText: /^50%$/ }).first().click()
    await window.waitForTimeout(1200)
    const zoomed = await ipc<{ fit: number; bounds: { width: number } }>(window, 'test:preview-debug')
    expect(zoomed.fit, '选了 50% 就该按 0.5 缩放').toBeCloseTo(0.5, 2)
    expect(zoomed.bounds.width, '视图宽度＝设备宽度 × 0.5').toBe(Math.round(430 * 0.5))

    // 100%：设备按真实尺寸呈现，装不下的部分裁掉，但不能溢出预览列
    await window.locator('.zoom-select').click()
    await window.waitForTimeout(400)
    await window.locator('.ufc-select-pop button', { hasText: /^100%$/ }).first().click()
    await window.waitForTimeout(1200)
    const full = await ipc<{ fit: number; bounds: { x: number; y: number; width: number; height: number } }>(
      window,
      'test:preview-debug'
    )
    expect(full.fit, '选了 100% 就该 1:1 呈现').toBeCloseTo(1, 2)

    // 页面本身不能被缩放，只是被截断：视口仍是设备的逻辑尺寸
    const page = await ipc<{ iw: number; ih: number; vs: number }>(
      window,
      'test:eval-preview',
      '({ iw: innerWidth, ih: innerHeight, vs: visualViewport.scale })'
    )
    expect(page.iw, '裁切不该改变页面视口宽度').toBe(430)
    expect(page.ih, '裁切不该改变页面视口高度').toBe(932)
    expect(page.vs, '页面不该被缩放').toBeCloseTo(1, 2)

    const side = await window.locator('.ws-side').boundingBox()
    expect(full.bounds.x, '视图不得越过预览列左边界').toBeGreaterThanOrEqual(Math.round(side!.x) - 1)
    expect(full.bounds.x + full.bounds.width, '视图不得越过预览列右边界').toBeLessThanOrEqual(
      Math.round(side!.x + side!.width) + 1
    )
    expect(full.bounds.height, '超出面板的部分应被裁掉').toBeLessThanOrEqual(Math.round(side!.height))

    // 裁切时必须保留设备的顶部与左侧：屏幕占位区的左上角要在舞台内
    const anchored = await window.evaluate(() => {
      const s = document.querySelector('.device-frame .screen')!.getBoundingClientRect()
      const stage = document.querySelector('.preview-stage')!.getBoundingClientRect()
      return { dx: Math.round(s.left - stage.left), dy: Math.round(s.top - stage.top) }
    })
    expect(anchored.dx, '设备左侧不能被切到舞台外').toBeGreaterThanOrEqual(0)
    expect(anchored.dy, '设备顶部不能被切到舞台外').toBeGreaterThanOrEqual(0)

    await window.locator('.zoom-select').click()
    await window.waitForTimeout(400)
    await window.locator('.ufc-select-pop button', { hasText: '自适应' }).first().click()
    await window.waitForTimeout(1200)
    const fitted = await ipc<{ fit: number }>(window, 'test:preview-debug')
    expect(fitted.fit, '回到自适应后不再是 0.5').not.toBeCloseTo(0.5, 2)

    // 4. 换过设备再回项目列表——这里曾经留下一块浮在列表上的白色色块
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
