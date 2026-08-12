import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(here, '..', '..')
export const TEST_SITE_PORT = 4183
export const TEST_SITE = `http://localhost:${TEST_SITE_PORT}`

/** 启动内置测试站，返回关闭函数 */
export async function startTestSite(): Promise<() => void> {
  const proc: ChildProcess = spawn(process.execPath, [join(ROOT, 'test-site', 'serve.mjs'), String(TEST_SITE_PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
  })
  await waitFor(async () => {
    try {
      return (await fetch(TEST_SITE)).ok
    } catch {
      return false
    }
  }, 15000)
  return () => proc.kill()
}

export async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  // 测试数据一律写到临时目录：早先没隔离，测试建的项目跑进了用户真实的项目列表
  const dataDir = join(tmpdir(), `ufc-e2e-${process.pid}-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, UFC_TEST: '1', UFC_DATA_DIR: dataDir },
  })
  // 主进程的报错要冒出来，否则测试只会看到「页面已关闭」这种无信息量的现象
  app.process().stderr?.on('data', (d: Buffer) => console.error('[main stderr]', d.toString().trim()))
  app.process().stdout?.on('data', (d: Buffer) => console.log('[main stdout]', d.toString().trim()))
  app.on('close', () => console.error('[main] 应用退出'))

  const window = await app.firstWindow()
  window.on('crash', () => console.error('[renderer] 崩溃'))
  window.on('close', () => console.error('[renderer] 窗口关闭'))
  window.on('pageerror', (e) => console.error('[renderer error]', e.message))
  window.on('console', (m) => {
    if (m.type() === 'error') console.error('[renderer console]', m.text())
  })
  await window.waitForLoadState('domcontentloaded')
  return { app, window }
}

/**
 * 所有测试指令都从渲染进程经预加载桥发出——与真实使用路径一致，
 * 不去戳主进程内部结构。
 */
export function ipc<T = unknown>(window: Page, channel: string, payload?: unknown): Promise<T> {
  return window.evaluate(
    ([ch, p]) => (window as unknown as { api: { invoke(c: string, x?: unknown): Promise<unknown> } }).api.invoke(ch as string, p),
    [channel, payload] as [string, unknown]
  ) as Promise<T>
}

/** 在预览页内执行脚本并取回结果 */
export function evalPreview<T = unknown>(window: Page, script: string): Promise<T> {
  return ipc<T>(window, 'test:eval-preview', script)
}

export async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 10000, interval = 250): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('等待超时')
}

/**
 * 从侧边栏进入第一个项目的工作台。
 *
 * 项目列表只在挂载时拉一次，用 IPC 直接建的项目不会自动出现在已挂载的列表里，
 * 所以先切到别的页再切回来，强制重挂。
 */
export async function openFirstProject(window: Page): Promise<void> {
  const nav = (name: RegExp) => window.locator('.sidebar').getByRole('button', { name })
  await nav(/真机预览/).click()
  await window.waitForTimeout(400)
  await nav(/项目/).click()
  // 项目卡整块可点即进入，没有独立的「打开」按钮
  await window.locator('.project-card').first().click({ timeout: 15000 })
  await window.waitForTimeout(1200)
}

/** 读取测试站记录的请求头日志 */
export async function siteRequests(): Promise<Array<{ path: string; ua: string; chMobile: string; chPlatform: string }>> {
  const res = await fetch(`${TEST_SITE}/__requests`)
  return (await res.json()) as Array<{ path: string; ua: string; chMobile: string; chPlatform: string }>
}
