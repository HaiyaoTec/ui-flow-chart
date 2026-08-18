import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE } from './helpers'

interface Result {
  path: string
  bytes: number
  included: string[]
  excluded: string[]
}

/** 用来验证脱敏是否到位的哨兵值：它们出现在诊断包里就是泄露 */
const SECRET_KEY = 'sk-should-never-leave-this-machine'
const SECRET_GOAL = '用账号 13800138000 登录后台核对订单'

/**
 * 诊断包的内容边界。
 *
 * 这份文件是要用户发给作者的，所以两件事必须同时成立：
 * 定位问题够用，且绝不夹带凭证与目标站的私密内容。
 * 断言写成「哨兵值不得出现」而不是「字段不存在」——
 * 后者只能守住已知字段，前者连间接夹带也能拦住。
 */
test('诊断包不带凭证与目标站内容，分级由用户决定', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '诊断', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: SECRET_KEY,
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '诊断导出',
      targetUrl: `${TEST_SITE}/ua-echo.html?token=abc123`,
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: SECRET_GOAL,
    })
    await openFirstProject(window)

    /*
     * 先让会话真的跑一下。AI 地址是不可达的，探索会很快失败——
     * 但这正好是要验的：失败路径同样要留下完整的会话记录，
     * 而不是只在界面上闪一句红字。
     */
    await ipc(window, 'session:start', { projectId: project.id })
    await window.waitForTimeout(1500)
    await ipc(window, 'session:stop', { projectId: project.id })

    /* ---------------- 基础级 ---------------- */
    const basic = await ipc<Result>(window, 'diagnose:export', { projectId: project.id, level: 'basic' })
    expect(basic.bytes, '诊断包不该是空的').toBeGreaterThan(200)
    const basicText = readFileSync(basic.path, 'utf8')

    expect(basicText, 'API Key 绝不能出现在诊断包里').not.toContain(SECRET_KEY)
    expect(basicText, '项目目标可能写着业务背景，基础级不带').not.toContain(SECRET_GOAL)
    expect(basicText, '基础级不带完整目标地址').not.toContain('token=abc123')
    // 版本、运行环境、会话状态这些必须有，否则包就没意义了
    const basicJson = JSON.parse(basicText) as Record<string, unknown>
    expect(basicJson.app, '必须带应用版本与运行环境').toHaveProperty('version')
    expect(basicJson.preview, '预览几何要带上：位置类缺陷全靠它').toHaveProperty('fit')
    expect(basicJson.session, '会话快照要带上').toHaveProperty('state')
    expect(basicJson).toHaveProperty('mainLog')
    expect(basicJson.excluded, '排除清单要原样写进包里').toEqual(expect.arrayContaining(['AI 接口密钥与全部凭证']))

    // 会话记录是这份包的主体：没有它，什么也定位不了
    const records = basicJson.records as Array<Record<string, unknown>>
    expect(Array.isArray(records), '要带上会话记录').toBe(true)
    const runStart = records.find((r) => r.kind === 'run-start')
    expect(runStart, '记录里必须有本轮的起点').toBeTruthy()
    expect(runStart!.budgets, '预算配置要能对照').toHaveProperty('maxSteps')
    expect(runStart!.runId, '记录要能按运行切分').toBeTruthy()
    // run-start 里的目标地址同样只留 host
    expect(runStart).not.toHaveProperty('targetUrl')
    expect(records.some((r) => r.kind === 'state'), '状态转移序列要在').toBe(true)

    /* ---------------- 复现级 ---------------- */
    const repro = await ipc<Result>(window, 'diagnose:export', { projectId: project.id, level: 'repro' })
    const reproText = readFileSync(repro.path, 'utf8')
    expect(reproText, '复现级要带上完整目标地址，否则无法重放').toContain('token=abc123')
    expect(reproText, '凭证在任何级别都不带').not.toContain(SECRET_KEY)
    expect(repro.included.join(), '界面上要说清楚复现级多带了什么').toContain('目标站地址')

    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
    stopSite()
  }
})

test('设置面板里能导出诊断包，并列出包含与不包含的内容', async () => {
  const { app, window } = await launchApp()
  try {
    await window.locator('.settings-trigger').click()
    await window.locator('.settings-pop').getByRole('button', { name: /AI 接口/ }).click()

    const panel = window.locator('.settings-panel')
    await panel.locator('.settings-rail button', { hasText: '诊断与日志' }).click()
    await expect(panel.locator('.section-head h3')).toHaveText('诊断与日志')

    await panel.getByRole('button', { name: /导出诊断包/ }).click()

    await expect(window.locator('.diag-result')).toBeVisible({ timeout: 15000 })
    await expect(window.locator('.diag-lists .off')).toContainText('AI 接口密钥')
  } finally {
    await app.close()
  }
})
