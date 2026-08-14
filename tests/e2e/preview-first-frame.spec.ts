import { expect, test } from '@playwright/test'
import { ipc, launchApp, startTestSite, TEST_SITE, waitFor } from './helpers'

interface Debug {
  fit: number
  visible: boolean
  pane: { x: number; y: number; width: number; height: number }
  bounds: { x: number; y: number; width: number; height: number } | null
  shownAt: { bounds: { x: number; y: number; width: number; height: number }; scale: number } | null
}

/**
 * 首帧几何：视图第一次显示出来时，用的必须是本次布局算出来的矩形。
 *
 * 回归背景：放行判据原先是「本轮 hold 之后收到过矩形」，而 open 期间的上报只更新
 * 内部 pane、并不会落到视图上（syncViewport 被 opening 挡着）。加载慢过兜底档位时，
 * 兜底定时器就拿 open 入口的快照矩形把视图亮了出来——网页以设备逻辑尺寸、
 * 缩放系数 1 浮在流程画布上，等加载完才归位。
 *
 * 断言不去抢那一帧：主进程把「转为可见那一刻的 bounds 与 scale」存了下来，
 * 时序事实因此变成可确定读取的状态，不会 flaky。
 */
test('慢加载时，视图首次显示用的必须是本次布局的矩形', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '首帧', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '首帧',
      targetUrl: `${TEST_SITE}/slow.html?ms=6000`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })

    /*
     * 必须走「冷启动直接从项目列表进项目」这条路径：此时主进程的占位矩形还是
     * 构造默认值（430×932、缩放 1），正是缺陷的指纹场景。
     * 中途去过真机预览页就会先上报一次矩形，指纹不再成立。
     */
    // 项目列表只在挂载时拉一次。这里刷新渲染进程而不是切到真机预览页再切回来，
    // 就是为了不让 PreviewPane 挂载——它一挂载就会上报矩形，指纹场景没了
    await window.reload()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(800)
    await window.locator('.project-card').first().click({ timeout: 15000 })

    await waitFor(async () => (await ipc<Debug>(window, 'test:preview-debug')).visible, 25000)
    const dbg = await ipc<Debug>(window, 'test:preview-debug')

    expect(dbg.shownAt, '应记录到首次显示时的几何').not.toBeNull()
    const first = dbg.shownAt!

    // 核心：首次显示时的缩放必须已经是本次布局算出来的。
    // 缺陷态下 first.scale 是 1，而稳态 fit 只有 0.4 上下
    expect(first.scale, '首次显示的缩放必须与稳态一致').toBeCloseTo(dbg.fit, 3)
    // 位置同理：不能停在 open 入口那份 x=0,y=0 的快照上
    expect(first.bounds, '首次显示的矩形必须与稳态一致').toEqual(dbg.bounds)
    // 且必须落在预览列的占位矩形内，不能压到画布上
    expect(first.bounds.x, '视图不得越过占位矩形左边界').toBeGreaterThanOrEqual(dbg.pane.x - 1)
    expect(first.bounds.x + first.bounds.width, '视图不得越过占位矩形右边界').toBeLessThanOrEqual(
      dbg.pane.x + dbg.pane.width + 1
    )

    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
