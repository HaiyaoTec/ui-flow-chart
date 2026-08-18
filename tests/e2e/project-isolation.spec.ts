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

test('两个项目可以同时探索，各自的状态互不覆盖', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '并发', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
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
    await ipc(window, 'session:start', { projectId: b.id, goal: 'x' })

    /*
     * 两个会话各自有自己的快照。
     *
     * 原先这里断言的是「不许并发」——单会话时代预览只有一个，第二个项目
     * 既抢不到预览也开不了跑。现在改成一会话一个预览视图，非前台的恒隐藏，
     * 所以并发是允许的，要守的变成「状态不串台」。
     */
    const sa = await ipc<{ projectId: string | null }>(window, 'session:snapshot', { projectId: a.id })
    const sb = await ipc<{ projectId: string | null }>(window, 'session:snapshot', { projectId: b.id })
    expect(sa.projectId, 'A 的快照必须是 A 自己的').toBe(a.id)
    expect(sb.projectId, 'B 的快照必须是 B 自己的').toBe(b.id)

    const list = await ipc<Array<{ projectId: string | null }>>(window, 'session:list')
    expect(list.map((s) => s.projectId).sort(), '两个会话都要在列表里').toEqual([a.id, b.id].sort())

    // 打开 B 只是把预览切到前台，不该把 A 的会话弄停
    const opened = await ipc<{ previewBound: boolean }>(window, 'project:open', { id: b.id })
    expect(opened.previewBound, '多会话之后不再有「预览被别人占着」这回事').toBe(true)
    const stillA = await ipc<{ projectId: string | null; state: string }>(window, 'session:snapshot', { projectId: a.id })
    expect(stillA.projectId, '切到 B 之后 A 的会话仍然在').toBe(a.id)

    // 暂停 A 不能影响 B
    await ipc(window, 'session:pause', { projectId: a.id }).catch(() => undefined)
    const afterB = await ipc<{ state: string }>(window, 'session:snapshot', { projectId: b.id })
    expect(afterB.state, '暂停 A 不该把 B 也停掉').not.toBe('paused')

    await ipc(window, 'session:stop', { projectId: a.id }).catch(() => undefined)
    await ipc(window, 'session:stop', { projectId: b.id }).catch(() => undefined)
    await window.waitForTimeout(500)
    await ipc(window, 'project:delete', { id: a.id })
    await ipc(window, 'project:delete', { id: b.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})

/**
 * 界面上的状态必须按项目取，不能是「最后一条事件是谁的就显示谁」。
 *
 * 会话快照原先在渲染侧只有一个槽位：B 在后台全速跑时，它的每一条事件都会把
 * 那个槽位改写一遍，A 的工作台顶栏就会在「空闲」与运行态之间来回抖。
 * 这条用例连续采样 A 的状态胶囊，只要抖过一次就算失败。
 */
test('一个项目在跑时，另一个项目的工作台状态不受影响', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '分桶', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
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

    // 界面停在 A 的工作台，B 在后台跑
    await window.reload()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(600)
    await window.locator('.project-card', { hasText: 'A 项目' }).first().click({ timeout: 15000 })
    await window.waitForTimeout(400)
    await ipc(window, 'session:start', { projectId: b.id, goal: 'x' })

    const chip = window.locator('.ws-bar .state-chip').first()
    const seen = new Set<string>()
    for (let i = 0; i < 12; i += 1) {
      seen.add(((await chip.textContent()) ?? '').trim())
      await window.waitForTimeout(120)
    }
    expect([...seen], 'A 的状态胶囊不该被 B 的事件带着跳').toEqual(['空闲'])

    await ipc(window, 'session:stop', { projectId: b.id }).catch(() => undefined)
    await window.waitForTimeout(400)
    await ipc(window, 'project:delete', { id: a.id })
    await ipc(window, 'project:delete', { id: b.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
