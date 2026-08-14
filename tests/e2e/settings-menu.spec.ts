import { expect, test } from '@playwright/test'
import { ipc, launchApp } from './helpers'

/**
 * 左下角统一设置入口与两栏设置面板。
 *
 * 三项设置从各自的位置收拢过来之后，最容易悄悄坏掉的是「入口还在、但某一项进不去」，
 * 所以这里逐项验证可达：主题子菜单要真的改主题，另外两项要真的定位到对应板块。
 */
test('设置入口能到达主题、AI 接口、软件更新三项', async () => {
  const { app, window } = await launchApp()
  try {
    const trigger = window.locator('.settings-trigger')
    const pop = window.locator('.settings-pop')
    const html = window.locator('html')

    await expect(trigger, '侧边栏底部要有设置入口').toBeVisible()
    await trigger.click()
    await expect(pop).toBeVisible()

    // 主题：向右展开子菜单，选中后立刻生效并落库
    await pop.getByRole('button', { name: /主题/ }).click()
    const sub = window.locator('.settings-sub')
    await expect(sub).toBeVisible()
    // 子菜单在触发项右侧，不能压在菜单自己身上
    const popBox = (await pop.boundingBox())!
    const subBox = (await sub.boundingBox())!
    expect(subBox.x, '子菜单应当在一级菜单右侧展开').toBeGreaterThanOrEqual(popBox.x + popBox.width)

    await sub.locator('button', { hasText: '深色' }).click()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    expect((await ipc<{ theme: string }>(window, 'settings:get')).theme, '主题要写进设置').toBe('dark')

    await sub.locator('button', { hasText: '浅色' }).click()
    await expect(html).toHaveAttribute('data-theme', 'light')

    // AI 接口：进设置面板并停在对应板块
    const panel = window.locator('.settings-panel')
    await pop.getByRole('button', { name: /AI 接口/ }).click()
    await expect(panel.locator('.settings-rail button.on')).toHaveText('AI 接口')
    await expect(panel.locator('.section-head h3')).toHaveText('AI 接口')

    // 面板里能直接换板块，不用退出去重进
    await panel.locator('.settings-rail button', { hasText: '软件更新' }).click()
    await expect(panel.locator('.section-head h3')).toHaveText('软件更新')
    await expect(panel).toContainText('当前版本')
    await window.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)

    // 从「软件更新」进来要直接停在更新板块
    await trigger.click()
    await pop.getByRole('button', { name: /软件更新/ }).click()
    await expect(panel.locator('.settings-rail button.on')).toHaveText('软件更新')
    await window.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)

    // 菜单外点击要收起
    await trigger.click()
    await expect(pop).toBeVisible()
    await window.locator('.main').click({ position: { x: 20, y: 300 } })
    await expect(pop).toHaveCount(0)
  } finally {
    await app.close()
  }
})

/**
 * 没有 AI 配置时的引导。
 *
 * 空下拉展开后是个空盒子，用户只知道「没得选」，不知道该去哪儿加，
 * 所以空态里要给一条去创建的入口；且叠上来的设置面板不能把创建表单一起关掉。
 */
test('创建项目时 AI 配置为空，下拉里给出新建入口', async () => {
  const { app, window } = await launchApp()
  try {
    await window.getByRole('button', { name: /创建项目/ }).first().click()
    const createModal = window.locator('.modal').first()
    await expect(createModal).toBeVisible()

    // 「AI 配置」那一栏的下拉
    await createModal.locator('label.field', { hasText: 'AI 配置' }).locator('.ufc-select').click()
    const popup = window.locator('.ufc-select-pop')
    await expect(popup, '空态要说明为什么没得选').toContainText('还没有 AI 配置')

    await popup.getByRole('button', { name: /新建 AI 配置/ }).click()
    const panel = window.locator('.settings-panel')
    await expect(panel.locator('.section-head h3')).toHaveText('AI 接口')

    // Esc 只关最上面那层：设置面板关掉，创建表单还在
    await window.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(createModal, '创建表单不该被一起关掉').toBeVisible()
  } finally {
    await app.close()
  }
})

/**
 * AI 配置下拉必须能看到全部配置。
 *
 * 回归背景：配置列表原先只在项目页挂载时拉一次。设置从侧边栏独立页面改成浮在
 * 项目页上的弹窗之后，这个视图不再卸载重挂，后加的配置就永远进不了下拉——
 * 界面上表现为「明明配了好几个，创建项目时只能选第一个」。
 */
test('创建项目时能看到后来新增的 AI 配置', async () => {
  const { app, window } = await launchApp()
  try {
    const mk = (name: string) =>
      ipc<{ id: string }>(window, 'ai:profiles:save', {
        profile: { id: '', name, protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: `${name}-model` },
        apiKey: 'k',
      })

    // 项目页已经挂载之后再加配置，正是回归发生的时序
    await mk('甲')
    await mk('乙')

    await window.getByRole('button', { name: /创建项目/ }).first().click()
    const createModal = window.locator('.modal').first()
    await createModal.locator('label.field', { hasText: 'AI 配置' }).locator('.ufc-select').click()
    const popup = window.locator('.ufc-select-pop')
    await expect(popup.locator('button')).toHaveCount(2)
    await expect(popup).toContainText('甲')
    await expect(popup).toContainText('乙')
  } finally {
    await app.close()
  }
})
