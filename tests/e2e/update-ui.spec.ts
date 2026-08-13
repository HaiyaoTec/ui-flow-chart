import { expect, test } from '@playwright/test'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE } from './helpers'

/**
 * 更新提示的交互。
 *
 * 真更新链路要连 GitHub、要打包产物，自动化里跑不动；能守住也最该守住的是这几条：
 * 提示不打断工作、关掉之后同版本不再出现、以及探索进行中不许直接重启。
 */
test('更新提示条只在有新版本时出现，且可以关掉', async () => {
  const { app, window } = await launchApp()
  try {
    const bar = window.locator('.update-bar')

    // 空闲与「已是最新」都不该占用界面
    await expect(bar, '没有新版本时不该出现提示条').toHaveCount(0)
    await ipc(window, 'test:update-state', { phase: 'up-to-date' })
    await window.waitForTimeout(300)
    await expect(bar, '已是最新时不该出现提示条').toHaveCount(0)

    await ipc(window, 'test:update-state', { phase: 'available', version: '9.9.9' })
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('9.9.9')

    // 下载中显示进度
    await ipc(window, 'test:update-state', { phase: 'downloading', percent: 42 })
    await expect(bar).toContainText('42%')

    // 关掉之后，同一个版本不再打扰
    await ipc(window, 'test:update-state', { phase: 'downloaded', percent: 100 })
    await expect(bar).toContainText('已就绪')
    await bar.getByTitle('不再提示这个版本').click()
    await expect(bar, '关掉后同版本不该再出现').toHaveCount(0)

    // 换了新版本号才重新出现
    await ipc(window, 'test:update-state', { phase: 'available', version: '9.9.10' })
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('9.9.10')
  } finally {
    await app.close()
  }
})

test('探索进行中不能直接重启更新', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '更新', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '更新',
      targetUrl: `${TEST_SITE}/ua-echo.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })
    await openFirstProject(window)
    await ipc(window, 'session:start', { projectId: project.id, goal: 'x' }).catch(() => undefined)

    /*
     * 把会话钉在 paused 上再断言。
     *
     * 本地 AI 地址不通时会话要过几秒才失败，CI 上快得多——先前只等固定时长再断言，
     * 会话早就变成 failed，busy 自然是 false，用例随环境飘。
     * paused 属于「占着预览」的状态，且不会自己往前走，是这里唯一稳定的落点。
     */
    const holding = ['launching', 'observing', 'thinking', 'acting', 'paused', 'awaiting_human', 'resuming']
    let snap = await ipc<{ projectId: string | null; state: string }>(window, 'session:snapshot')
    for (let i = 0; i < 20 && !holding.includes(snap.state); i++) {
      await window.waitForTimeout(150)
      snap = await ipc(window, 'session:snapshot')
    }
    test.skip(snap.projectId !== project.id || !holding.includes(snap.state), `会话已结束（${snap.state}），无法验证占用`)

    snap = await ipc(window, 'session:pause')
    test.skip(!holding.includes(snap.state), `会话未能暂停（${snap.state}）`)

    const st = await ipc<{ busy?: boolean }>(window, 'test:update-state', { phase: 'downloaded', version: '9.9.9' })
    expect(st.busy, '探索进行中应当标记为忙').toBe(true)

    // 不带 force 的安装请求必须被拒绝，并给出原因
    const after = await ipc<{ phase: string; error: string }>(window, 'update:install', {})
    expect(after.phase, '不该真的去安装').toBe('downloaded')
    expect(after.error, '要说明为什么装不了').toContain('探索')

    await ipc(window, 'session:stop').catch(() => undefined)
    await window.waitForTimeout(500)
    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
