import { expect, test } from '@playwright/test'
import { getDevice } from '../../src/shared/devices'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE, waitFor } from './helpers'

/** 项目建出来时用的那台 430×932 机型，改设备清单后名字会变，从预设表里取 */
const WIDE_IPHONE = getDevice('iphone-14-pro-max').name

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

    // 刚进项目、还没收到新矩形之前不能显示：否则会拿上一次的矩形先画一帧，
    // 网页浮在画布上、位置还不对
    await window.locator('.sidebar').getByRole('button', { name: /真机预览/ }).click()
    await window.waitForTimeout(400)
    await window.locator('.sidebar').getByRole('button', { name: /项目/ }).click()
    await window.waitForTimeout(600)
    await window.locator('.project-card').first().click()
    /*
     * 「新矩形到达前不显示」是时序行为，直接断言会 flaky；这里只守住结果：
     * 进来之后必须显示，且矩形是本次布局的（下面的断言会验证）。
     *
     * 用轮询而不是固定等待：主进程那侧的兜底释放本身就是 2500ms，
     * 固定等 2500ms 等于卡在临界点上——mac runner 上就是这么挂的。
     */
    await waitFor(async () => await visible(window), 10000).catch(async () => {
      const dbg = await ipc(window, 'test:preview-debug')
      throw new Error(`进入工作台后视图应显示，实际一直没显示：${JSON.stringify(dbg)}`)
    })

    // 自适应下机身必须完整落在可用区内。装饰（状态栏、边框、home 条）都是按屏幕
    // 宽度等比的，尺寸计算漏算它们就会让机身高出容器，被 overflow 从上下切掉，
    // 表现为手机顶部与底部各一条白边
    const fitBox = await window.evaluate(() => {
      const f = document.querySelector('.device-frame')!.getBoundingClientRect()
      const b = document.querySelector('.device-box')!.getBoundingClientRect()
      return { top: Math.round(f.top - b.top), bottom: Math.round(b.bottom - f.bottom), left: Math.round(f.left - b.left) }
    })
    expect(fitBox.top, '机身顶部不能超出容器').toBeGreaterThanOrEqual(0)
    expect(fitBox.bottom, '机身底部不能超出容器').toBeGreaterThanOrEqual(0)
    expect(fitBox.left, '机身左侧不能超出容器').toBeGreaterThanOrEqual(0)

    // 窗口缩放期间视图会被藏起来（否则右侧拖出黑边），缩放结束后必须自己回来
    await ipc(window, 'test:resize-window', { dw: 200, dh: 0 })
    await window.waitForTimeout(1500)
    expect(await visible(window), '窗口缩放结束后视图应恢复显示').toBe(true)
    await ipc(window, 'test:resize-window', { dw: -200, dh: 0 })
    await window.waitForTimeout(1200)

    /*
     * 尺寸必须收敛。
     *
     * 曾经把「是否裁切」接到了舞台内边距上：去掉留白 → 可用空间变大 → 机身放得下 →
     * 不再算裁切 → 留白加回来 → 又放不下……在临界尺寸上会一直抖。
     * 这里逐档改窗口宽度，每档都要求两次读数一致。
     */
    for (let i = 0; i < 8; i++) {
      await ipc(window, 'test:resize-window', { dw: 7, dh: 0 })
      await window.waitForTimeout(700)
      const a = await ipc<{ pane: { width: number; height: number } }>(window, 'test:preview-debug')
      await window.waitForTimeout(600)
      const b = await ipc<{ pane: { width: number; height: number } }>(window, 'test:preview-debug')
      expect(b.pane, `第 ${i + 1} 档窗口宽度下尺寸没有收敛`).toEqual(a.pane)
    }
    await ipc(window, 'test:resize-window', { dw: -56, dh: 0 })
    await window.waitForTimeout(1200)

    /*
     * 1. 压在预览上的下拉：靠层级排序让路，不再隐藏视图。
     *
     * 界面与网页同为窗口的子视图，展开弹层时把界面提到最上层即可。
     * 视图始终是「可见」的，只是被界面盖住——这与隐藏有本质区别：
     * 排序是瞬时的，不需要抓帧，也不会出现「弹层已出来、网页还压着」的半截状态。
     */
    await window.locator('.preview-toolbar .ufc-select').click()
    await window.waitForTimeout(400)
    await expect(window.locator('.device-pop'), '弹层应当渲染出来').toBeVisible()
    expect(await visible(window), '弹层展开时不该再隐藏视图').toBe(true)
    await window.locator('.device-pop .models button', { hasText: 'iPhone SE' }).click()
    await window.waitForTimeout(2000)
    const afterPick = await ipc<{ device: { width: number } }>(window, 'test:preview-debug')
    expect(afterPick.device.width, '选中的设备应当生效').toBe(375)

    await window.locator('.preview-toolbar .ufc-select').click()
    await window.waitForTimeout(400)
    await window.locator('.device-pop .models button', { hasText: WIDE_IPHONE }).click()
    await window.waitForTimeout(2000)

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

    // 网页与机身必须在同一条线上截断，否则边框比网页多出一截，看着像没对齐
    const cut = await window.evaluate(() => {
      const box = document.querySelector('.device-box')!.getBoundingClientRect()
      const screen = document.querySelector('.device-frame .screen')!.getBoundingClientRect()
      return { visibleBottom: Math.round(Math.min(box.bottom, screen.bottom)) }
    })
    expect(Math.abs(full.bounds.y + full.bounds.height - cut.visibleBottom), '网页底边应与机身可见底边重合').toBeLessThanOrEqual(2)

    // 裁切时必须保留设备的顶部与左侧：屏幕占位区的左上角要在舞台内
    const anchored = await window.evaluate(() => {
      const f = document.querySelector('.device-frame')!.getBoundingClientRect()
      const s = document.querySelector('.device-frame .screen')!.getBoundingClientRect()
      const stage = document.querySelector('.preview-stage')!.getBoundingClientRect()
      return {
        dx: Math.round(s.left - stage.left),
        dy: Math.round(s.top - stage.top),
        // 左右留白之差：为 0 即水平居中
        centeredX: Math.abs(Math.round(f.left - stage.left) - Math.round(stage.right - f.right)),
      }
    })
    // 机身外圈是画在轮廓之外的光晕，紧贴容器就会被切平，看着像顶部被削掉一块
    const ringRoom = await window.evaluate(() => {
      const f = document.querySelector('.device-frame') as HTMLElement
      const box = document.querySelector('.device-box')!.getBoundingClientRect()
      const ring = parseFloat(getComputedStyle(f).getPropertyValue('--ring')) || 0
      return { gap: Math.round(f.getBoundingClientRect().top - box.top), ring: Math.round(ring) }
    })
    expect(ringRoom.gap, '顶部要给外圈光晕留出位置，否则机身顶被切平').toBeGreaterThanOrEqual(ringRoom.ring)

    expect(anchored.dx, '设备左侧不能被切到舞台外').toBeGreaterThanOrEqual(0)
    expect(anchored.dy, '设备顶部不能被切到舞台外').toBeGreaterThanOrEqual(0)
    // 100% 时宽度放得下（预览列比 430 宽），这一轴应当仍然居中
    expect(anchored.centeredX, '宽度够时应保持水平居中').toBeLessThanOrEqual(2)

    await window.locator('.zoom-select').click()
    await window.waitForTimeout(400)
    await window.locator('.ufc-select-pop button', { hasText: '自适应' }).first().click()
    await window.waitForTimeout(1200)
    const fitted = await ipc<{ fit: number }>(window, 'test:preview-debug')
    expect(fitted.fit, '回到自适应后不再是 0.5').not.toBeCloseTo(0.5, 2)

    // 4. 换过设备再回项目列表——这里曾经留下一块浮在列表上的白色色块
    await window.locator('.preview-toolbar .ufc-select').click()
    await window.waitForTimeout(400)
    await window.locator('.device-pop .models button', { hasText: 'iPhone SE' }).click()
    await window.waitForTimeout(1800)
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
