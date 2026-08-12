import { expect, test } from '@playwright/test'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE } from './helpers'

/**
 * 项目之间的隔离。
 *
 * 会话与预览在主进程里都是全局单例，图谱补丁和日志却是广播给渲染进程的。
 * 没有归属判断的话，后台项目跑出来的界面会画进你正开着的那个项目，
 * 日志也会混在一起——都是静默污染，用户看不出来。
 */
test('后台项目的图谱补丁与日志不会串到当前打开的项目', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '隔离', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const a = await ipc<{ id: string }>(window, 'project:create', {
      name: 'A 项目',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })

    await openFirstProject(window)
    await window.waitForTimeout(1500)

    const counts = () =>
      window.evaluate(() => ({
        screens: document.querySelectorAll('.ufc-card').length,
        logs: document.querySelectorAll('.ws-log .log-line').length,
      }))
    const before = await counts()

    // 走真实通道：让另一个项目的会话真的跑起来，再看 A 有没有被污染
    const b = await ipc<{ id: string }>(window, 'project:create', {
      name: 'B 项目',
      targetUrl: `${TEST_SITE}/index.html`,
      deviceId: 'pixel-7',
      aiProfileId: profile.id,
      goal: 'x',
    })
    // AI 地址不通，会话会很快失败；但 state-changed 事件已经广播过若干次，
    // 足以验证「别的项目的日志不会进当前工作台」
    await ipc(window, 'session:start', { projectId: b.id, goal: 'x' }).catch(() => undefined)
    await window.waitForTimeout(2500)

    const after = await counts()
    expect(after.screens, 'B 项目的界面不该出现在 A 的画布上').toBe(before.screens)
    expect(after.logs, 'B 项目的日志不该出现在 A 的日志里').toBe(before.logs)

    // 工作台顶栏也不能显示别人的会话状态
    const chip = await window.locator('.ws-bar .state-chip').first().textContent()
    expect(chip, 'A 项目应仍是空闲').toBe('空闲')

    await ipc(window, 'session:stop').catch(() => undefined)
    await window.waitForTimeout(500)
    await ipc(window, 'project:delete', { id: a.id })
    await ipc(window, 'project:delete', { id: b.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})

test('另一个项目的会话没结束时，不能抢走预览也不能开始新探索', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '占用', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const a = await ipc<{ id: string }>(window, 'project:create', {
      name: 'A 项目',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })
    const b = await ipc<{ id: string }>(window, 'project:create', {
      name: 'B 项目',
      targetUrl: `${TEST_SITE}/index.html`,
      deviceId: 'pixel-7',
      aiProfileId: profile.id,
      goal: 'x',
    })

    await ipc(window, 'session:start', { projectId: a.id, goal: 'x' })
    // 暂停也算占着预览：恢复时会接着在当前页面上操作
    await ipc(window, 'session:pause').catch(() => undefined)
    await window.waitForTimeout(800)

    const snap = await ipc<{ projectId: string | null; state: string }>(window, 'session:snapshot')
    // AI 不通时会话可能已经失败，那样这条用例就失去意义，跳过断言
    test.skip(snap.projectId !== a.id, `A 的会话已结束（${snap.state}），无法验证占用`)

    const opened = await ipc<{ previewBound: boolean }>(window, 'project:open', { id: b.id })
    expect(opened.previewBound, 'A 还占着预览，B 不该抢到').toBe(false)

    await expect(ipc(window, 'session:start', { projectId: b.id, goal: 'x' }), '不该允许同时开跑两个项目').rejects.toThrow(
      /尚未结束/
    )

    await ipc(window, 'session:stop').catch(() => undefined)
    await window.waitForTimeout(500)
    await ipc(window, 'project:delete', { id: a.id })
    await ipc(window, 'project:delete', { id: b.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
