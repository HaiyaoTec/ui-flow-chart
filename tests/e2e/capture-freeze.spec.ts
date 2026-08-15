import { expect, test } from '@playwright/test'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE, waitFor } from './helpers'

/**
 * 抓存档图时屏幕区不许闪。
 *
 * 存档图要设备原始分辨率（clip.scale = 像素比），预览却按自适应比例显示，
 * 两个倍率不一致时 Chromium 得临时按请求的倍率重新光栅化整块合成面、抓完再还原，
 * 这一去一回页面会按另一个尺寸排一次版——每抓一次图屏幕区就跳一下。
 *
 * 对策是抓图前把当前画面贴成静帧、把界面提到网页之上盖住屏幕区。
 * 顺序是关键：静帧没画上去就抬界面，露出来的是界面自己的屏幕底板，
 * 闪烁只是换了个样子。所以主进程要等渲染进程的回执。
 */
test('抓存档图期间用静帧顶住屏幕区，抓完撤掉', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '静帧', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '静帧',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })

    await openFirstProject(window)
    await waitFor(async () => (await ipc<{ visible: boolean }>(window, 'test:preview-debug')).visible, 20000)

    const r = await ipc<{ pngBytes: number; freeze: { used: boolean; acked: boolean; ms: number } }>(
      window,
      'test:capture-archival'
    )

    expect(r.pngBytes, '存档图本身要抓到').toBeGreaterThan(0)
    expect(r.freeze.used, '视图可见时必须走静帧').toBe(true)
    // 回执只在 <img> 解码完、贴进 DOM 又过了两帧之后才发。
    // 收到它就等于「抬界面时屏幕区上确实盖着那张画面」
    expect(r.freeze.acked, '抬界面之前必须先收到静帧贴好的回执').toBe(true)
    expect(r.freeze.ms, '静帧不该拖慢一整拍').toBeLessThan(300)

    // 抓完必须撤掉，否则屏幕区会一直停在那一帧上，网页动了也看不出来
    await expect(window.locator('.screen-frozen')).toHaveCount(0)

    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
