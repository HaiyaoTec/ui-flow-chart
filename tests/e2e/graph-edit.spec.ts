import { expect, test } from '@playwright/test'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE } from './helpers'

/**
 * 图谱修订：会话结束后画布上的编辑要真的落盘，且人工修正在重新生成时受保护。
 *
 * 验证链：点选卡片 → 修订面板改名保存 → 界面与磁盘同时变化、字段记入 pinned；
 * 点选连线标注 → 改写保存；删除界面 → 卡片消失、签名进排除清单。
 */

const seedGraph = (targetUrl: string) => ({
  version: 1,
  meta: { targetUrl, deviceId: 'iphone-14-pro-max', steps: 2, aiCalls: 2, updatedAt: new Date().toISOString() },
  lanes: [{ id: 'entry', title: '入口' }],
  nodes: [
    {
      id: 's1',
      signatureHash: 'sig-s1',
      lane: 'entry',
      col: 0,
      sub: 0,
      kind: 'normal',
      title: '页面占位甲',
      url: `${TEST_SITE}/index.html`,
      createdBy: 'ai',
      shot: 's1',
      draft: true,
      ts: new Date().toISOString(),
    },
    {
      id: 's2',
      signatureHash: 'sig-s2',
      lane: 'entry',
      col: 1,
      sub: 0,
      kind: 'normal',
      title: '页面占位乙',
      url: `${TEST_SITE}/register.html`,
      createdBy: 'ai',
      shot: 's2',
      draft: true,
      ts: new Date().toISOString(),
    },
  ],
  edges: [
    {
      id: 'e1',
      from: 's1',
      to: 's2',
      label: '点击「注册」',
      type: 'primary',
      createdBy: 'ai',
      ts: new Date().toISOString(),
    },
  ],
})

test('画布修订：改名、改标注、删除都落盘，改过的字段记入 pinned', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '修订', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '修订项目',
      targetUrl: `${TEST_SITE}/index.html`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })
    await ipc(window, 'test:seed-graph', { projectId: project.id, graph: seedGraph(`${TEST_SITE}/index.html`) })

    await openFirstProject(window)
    await window.waitForTimeout(1500)

    /* ---------- 节点改名 ---------- */
    await window.locator('.ufc-card[data-id="s1"]').click()
    const panel = window.locator('.ufc-editpanel')
    await expect(panel, '点选卡片后修订面板要出现').toBeVisible()

    const titleInput = panel.locator('label', { hasText: '名称' }).locator('input')
    await titleInput.fill('首页·已修订')
    await panel.getByRole('button', { name: '保存' }).click()
    await window.waitForTimeout(800)

    await expect(window.locator('.ufc-card[data-id="s1"] .ufc-title')).toHaveText('首页·已修订')
    let graph = await ipc<{ nodes: Array<{ id: string; title: string; pinned?: string[]; draft?: boolean }> }>(
      window,
      'test:graph',
      project.id
    )
    const s1 = graph.nodes.find((n) => n.id === 's1')!
    expect(s1.title, '改名要写进磁盘').toBe('首页·已修订')
    expect(s1.pinned, '人工改过的字段要记入 pinned').toContain('title')
    expect(s1.draft ?? false, '人工定过名的界面不再是待整理态').toBe(false)

    /* ---------- 连线改标注 ---------- */
    await window.locator('.ufc-label').first().click()
    await expect(panel).toBeVisible()
    const labelInput = panel.locator('label', { hasText: '标注' }).locator('input')
    await labelInput.fill('点击「注册」进入注册流程')
    await panel.getByRole('button', { name: '保存' }).click()
    await window.waitForTimeout(800)

    const graph2 = await ipc<{ edges: Array<{ id: string; label: string; pinned?: string[] }> }>(
      window,
      'test:graph',
      project.id
    )
    expect(graph2.edges[0].label).toBe('点击「注册」进入注册流程')
    expect(graph2.edges[0].pinned).toContain('label')

    /* ---------- 删除界面 ---------- */
    await window.locator('.ufc-card[data-id="s2"]').click()
    await panel.getByRole('button', { name: '删除' }).click()
    // 自绘确认对话框
    await window.getByRole('button', { name: '删除' }).last().click()
    await window.waitForTimeout(800)

    await expect(window.locator('.ufc-card[data-id="s2"]')).toHaveCount(0)
    graph = await ipc(window, 'test:graph', project.id)
    expect(graph.nodes.some((n) => n.id === 's2'), '删除要写进磁盘').toBe(false)
    const excluded = (graph as unknown as { excluded?: string[] }).excluded ?? []
    expect(excluded, '被删界面的签名要进排除清单').toContain('sig-s2')

    await window.locator('.sidebar').getByRole('button', { name: /项目/ }).click()
    await window.waitForTimeout(400)
    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})
