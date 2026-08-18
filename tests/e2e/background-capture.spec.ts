import { expect, test } from '@playwright/test'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE, waitFor } from './helpers'

interface Probe {
  width: number
  height: number
  samples: Array<{ x: number; y: number; r: number; g: number; b: number }>
}

/** 往页面里贴一块满屏纯色，用来分辨抓到的是新帧还是上一帧的残留 */
const paint = (rgb: string) =>
  `(() => { let d = document.getElementById('ufc-probe'); if (!d) { d = document.createElement('div'); d.id = 'ufc-probe'; document.body.appendChild(d) } ` +
  `d.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;background:${rgb}'); return '${rgb}' })()`

/**
 * 后台会话还能不能抓图。
 *
 * 这是「同时探索多个项目」整套设计的地基：多个会话里只有一个能占着屏幕，
 * 其余的必须在看不见的状态下继续跑。若隐藏之后抓不到新帧，那条路就是死的，
 * 得改用离屏渲染或者一个会话一个隐藏窗口——代价完全不同。
 *
 * 判据是「抓到的是不是隐藏之后才画上去的东西」：先隐藏，再注入色块，然后抓图。
 * 拿到色块的颜色，就说明合成器在隐藏状态下仍然出新帧，而不是把最后一帧还给我们。
 */
test('视图隐藏后仍能抓到新画面', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '后台抓图', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '后台抓图',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })
    await openFirstProject(window)
    await waitFor(async () => (await ipc<{ visible: boolean }>(window, 'test:preview-debug')).visible, 20000)

    // 先把视图藏起来，再画红色——红色是隐藏之后才存在的
    await ipc(window, 'preview:set-visible', { visible: false })
    await waitFor(async () => !(await ipc<{ visible: boolean }>(window, 'test:preview-debug')).visible, 5000)
    await ipc(window, 'test:eval-preview', paint('rgb(255,0,0)'))
    await window.waitForTimeout(300)

    const hidden = await ipc<Probe>(window, 'test:screenshot-probe', [{ x: 645, y: 1400 }])
    const h = hidden.samples[0]
    expect(
      { r: h.r, g: h.g, b: h.b },
      '隐藏状态下抓到的必须是隐藏之后画上去的那一帧'
    ).toEqual({ r: 255, g: 0, b: 0 })
    expect({ w: hidden.width, h: hidden.height }, '隐藏不该改变输出分辨率').toEqual({ w: 1290, h: 2796 })

    // 再换一次颜色，确认不是「隐藏那一刻的快照」被反复返回
    await ipc(window, 'test:eval-preview', paint('rgb(0,0,255)'))
    await window.waitForTimeout(300)
    const again = await ipc<Probe>(window, 'test:screenshot-probe', [{ x: 645, y: 1400 }])
    const a = again.samples[0]
    expect({ r: a.r, g: a.g, b: a.b }, '隐藏期间的后续变化也要拍得到').toEqual({ r: 0, g: 0, b: 255 })

    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})

/**
 * 窗口最小化时同样要能抓图。
 *
 * 用户把窗口收起来去干别的，后台探索不能就此停摆——这正是「同时探索多个项目」
 * 最常见的使用方式。
 */
test('窗口最小化后仍能抓到新画面', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '最小化抓图', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '最小化抓图',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })
    await openFirstProject(window)
    await waitFor(async () => (await ipc<{ visible: boolean }>(window, 'test:preview-debug')).visible, 20000)

    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.minimize())
    await window.waitForTimeout(400)
    await ipc(window, 'test:eval-preview', paint('rgb(0,255,0)'))
    await window.waitForTimeout(300)

    const shot = await ipc<Probe>(window, 'test:screenshot-probe', [{ x: 645, y: 1400 }])
    const s = shot.samples[0]
    expect({ r: s.r, g: s.g, b: s.b }, '最小化状态下也要抓得到新帧').toEqual({ r: 0, g: 255, b: 0 })

    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.restore())
    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
