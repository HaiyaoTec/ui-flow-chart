import { expect, test } from '@playwright/test'
import { ipc, launchApp } from './helpers'

/**
 * 左下角统一设置入口。
 *
 * 三项设置从各自的位置收拢到这里之后，最容易悄悄坏掉的是「入口还在、但某一项进不去」，
 * 所以这里逐项验证可达：主题子菜单要真的改主题，另外两项要真的开出弹窗。
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

    // 主题：就地展开子菜单，选中后立刻生效并落库
    await pop.getByRole('button', { name: /主题/ }).click()
    await pop.locator('.settings-sub button', { hasText: '深色' }).click()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    expect((await ipc<{ theme: string }>(window, 'settings:get')).theme, '主题要写进设置').toBe('dark')

    await pop.locator('.settings-sub button', { hasText: '浅色' }).click()
    await expect(html).toHaveAttribute('data-theme', 'light')

    // AI 接口：内容多，走弹窗
    await pop.getByRole('button', { name: /AI 接口/ }).click()
    const modal = window.locator('.modal')
    await expect(modal).toContainText('AI 接口设置')
    await window.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)

    // 软件更新：同样走弹窗，且能看到当前版本
    await trigger.click()
    await pop.getByRole('button', { name: /软件更新/ }).click()
    await expect(modal).toContainText('当前版本')
    await window.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)

    // 菜单外点击要收起
    await trigger.click()
    await expect(pop).toBeVisible()
    await window.locator('.main').click({ position: { x: 20, y: 300 } })
    await expect(pop).toHaveCount(0)
  } finally {
    await app.close()
  }
})
