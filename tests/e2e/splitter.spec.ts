import { expect, test } from '@playwright/test'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE } from './helpers'

/** 画布与预览的分栏可拖动，且两侧各有最小宽度兜底 */
test('拖动分栏调整占比，两侧最小宽度不被突破', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '分栏', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '分栏',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })
    await openFirstProject(window)
    // 先把预览跑起来，后面才能断言原生视图跟着分栏变化
    await ipc(window, 'preview:navigate', { url: `${TEST_SITE}/ua-echo.html` })
    await window.waitForTimeout(1800)

    const widths = () =>
      window.evaluate(() => {
        const q = (s: string) => document.querySelector(s) as HTMLElement | null
        return {
          canvas: Math.round(q('.ws-canvas')?.getBoundingClientRect().width ?? -1),
          preview: Math.round(q('.ws-side')?.getBoundingClientRect().width ?? -1),
          body: Math.round(q('.ws-body')?.getBoundingClientRect().width ?? -1),
        }
      })

    // 两条工具栏并排，高度必须一致，否则中缝两侧的分隔线错位
    const bars = await window.evaluate(() => {
      const h = (s: string) => Math.round(document.querySelector(s)?.getBoundingClientRect().height ?? -1)
      return { canvas: h('.canvas-toolbar'), preview: h('.preview-toolbar') }
    })
    // 先确认真的量到了：两个都取不到时也会「相等」，那样断言等于没测
    expect(bars.canvas, '没找到画布工具栏').toBeGreaterThan(30)
    expect(bars.canvas, `画布工具栏 ${bars.canvas} 应等于预览工具栏 ${bars.preview}`).toBe(bars.preview)

    const splitter = window.locator('.ws-splitter')
    await expect(splitter).toBeVisible()

    const before = await widths()

    // 往左拖 200px：预览变宽、画布变窄
    const box = (await splitter.boundingBox())!
    const cy = box.y + box.height / 2
    await window.mouse.move(box.x + box.width / 2, cy)
    await window.mouse.down()
    await window.mouse.move(box.x + box.width / 2 - 200, cy, { steps: 12 })
    await window.mouse.up()
    await window.waitForTimeout(500)

    const wider = await widths()
    expect(wider.preview, '预览应变宽').toBeGreaterThan(before.preview)
    expect(wider.canvas, '画布应变窄').toBeLessThan(before.canvas)

    // 一路拖到最左：画布不得低于最小宽度
    const box2 = (await splitter.boundingBox())!
    await window.mouse.move(box2.x + box2.width / 2, cy)
    await window.mouse.down()
    await window.mouse.move(10, cy, { steps: 15 })
    await window.mouse.up()
    await window.waitForTimeout(500)

    const maxPreview = await widths()
    expect(maxPreview.canvas, '画布最小宽度必须兜住').toBeGreaterThanOrEqual(315)

    // 一路拖到最右：预览不得低于最小宽度
    const box3 = (await splitter.boundingBox())!
    await window.mouse.move(box3.x + box3.width / 2, cy)
    await window.mouse.down()
    await window.mouse.move(maxPreview.body + 400, cy, { steps: 15 })
    await window.mouse.up()
    await window.waitForTimeout(500)

    const minPreview = await widths()
    expect(minPreview.preview, '预览最小宽度必须兜住').toBeGreaterThanOrEqual(295)

    // 预览仍然可用：视图尺寸与缩放一致，页面仍按设备宽度排版
    const dbg = await ipc<{
      bounds: { width: number; height: number }
      expected: { width: number; height: number }
    }>(window, 'test:preview-debug')
    expect(dbg.bounds.width).toBe(dbg.expected.width)

    await window.locator('.sidebar').getByRole('button', { name: /项目/ }).click()
    await window.waitForTimeout(400)
    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
