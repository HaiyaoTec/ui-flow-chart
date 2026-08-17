import { expect, test } from '@playwright/test'
import { ipc, launchApp, waitFor } from './helpers'

interface LogTail {
  file: string
  text: string
}

/**
 * 缺陷证据必须落到磁盘上。
 *
 * 这个应用是打包分发出去的，用户机器上没有控制台：console 输出等于扔掉，
 * 界面日志面板只活在内存里、还只留 300 行。出问题时用户能给的只有截图，
 * 而截图里既没有版本号，也没有任何异常堆栈。
 *
 * 这里守住三件事：主进程有日志文件、界面侧的未捕获错误会回传落盘、
 * 版本号在用户截得到的位置。
 */
test('界面侧的未捕获错误会落进主进程日志', async () => {
  const { app, window } = await launchApp()
  try {
    const before = await ipc<LogTail>(window, 'test:log-tail')
    expect(before.file, '必须有日志文件路径').toBeTruthy()

    /*
     * 两条都要验：
     * - throw 走 window 的 error 事件，覆盖事件回调、定时器里抛出的错误
     * - Promise.reject 走 unhandledrejection，覆盖所有 void 出去的异步调用
     * 这两类恰恰是 React 的 ErrorBoundary 接不住的部分。
     */
    await window.evaluate(() => {
      setTimeout(() => {
        throw new Error('自动化注入的同步错误')
      }, 0)
      void Promise.reject(new Error('自动化注入的异步拒绝'))
    })

    await waitFor(async () => {
      const t = await ipc<LogTail>(window, 'test:log-tail')
      return t.text.includes('自动化注入的同步错误') && t.text.includes('自动化注入的异步拒绝')
    }, 8000)
    const tail = await ipc<LogTail>(window, 'test:log-tail')

    expect(tail.text, '同步错误要标明来源').toContain('界面未捕获错误')
    expect(tail.text, '异步拒绝要标明来源').toContain('界面未处理的 Promise 拒绝')
    // 堆栈里的本机绝对路径含用户名，落盘前必须抹掉
    expect(tail.text, '不得写入本机绝对路径').not.toMatch(/[A-Za-z]:\\Users\\/)
  } finally {
    await app.close()
  }
})

test('版本号出现在日志面板上，用户截图即可看到', async () => {
  const { app, window } = await launchApp()
  try {
    const info = await ipc<{ version: string; platform: string }>(window, 'app:info')
    expect(info.version, '版本号必须拿得到').toMatch(/^\d+\.\d+\.\d+/)

    const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
      profile: { id: '', name: '诊断', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
      apiKey: 'k',
    })
    const project = await ipc<{ id: string }>(window, 'project:create', {
      name: '诊断',
      targetUrl: 'about:blank',
      deviceId: 'iphone-14-pro-max',
      aiProfileId: profile.id,
      goal: 'x',
    })

    await window.locator('.sidebar').getByRole('button', { name: /真机预览/ }).click()
    await window.waitForTimeout(300)
    await window.locator('.sidebar').getByRole('button', { name: /项目/ }).click()
    await window.locator('.project-card').first().click({ timeout: 15000 })

    await expect(window.locator('.ws-log-ver')).toHaveText(`v${info.version}`)

    await ipc(window, 'project:delete', { id: project.id })
    await ipc(window, 'ai:profiles:delete', { id: profile.id })
  } finally {
    await app.close()
  }
})
