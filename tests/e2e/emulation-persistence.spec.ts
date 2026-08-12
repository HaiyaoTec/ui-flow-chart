import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { evalPreview, ipc, launchApp, startTestSite, TEST_SITE, TEST_SITE_PORT, waitFor } from './helpers'

/**
 * 设备模拟的持久性回归。
 *
 * 背景：曾对比过两条路线——裸 CDP（Emulation.*）与 Electron 原生
 * webContents.enableDeviceEmulation。实测原生 API 在跨源导航后会掉回视图
 * 真实尺寸（430×932 变成 415×900、dpr 3 变成 1.5），且完全不模拟触摸。
 * 因此保留裸 CDP。这组用例把当时的判据固定下来，防止以后误改回去。
 */

let stopSite: () => void
let app: ElectronApplication
let window: Page

test.beforeAll(async () => {
  stopSite = await startTestSite()
  const launched = await launchApp()
  app = launched.app
  window = launched.window
  await window.getByRole('button', { name: '真机预览' }).click()
  await window.waitForTimeout(600)
})

test.afterAll(async () => {
  await app?.close()
  stopSite?.()
})

interface Info {
  ua: string
  w: number
  h: number
  dpr: number
  touch: number
  sw: number
}

const read = () =>
  evalPreview<Info>(
    window,
    `({ ua: navigator.userAgent, w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
        touch: navigator.maxTouchPoints, sw: document.documentElement.scrollWidth })`
  )

async function expectDevice(info: Info, d: { w: number; h: number; dpr: number; touch: boolean; ua: RegExp }) {
  expect(info.ua).toMatch(d.ua)
  expect(info.w).toBe(d.w)
  expect(info.h).toBe(d.h)
  expect(Math.round(info.dpr * 100) / 100).toBe(d.dpr)
  if (d.touch) expect(info.touch).toBeGreaterThan(0)
  else expect(info.touch).toBe(0)
  expect(info.sw).toBeLessThanOrEqual(d.w)
}

test('切换四种设备，每次的 UA、视口、像素比、触摸都要跟着变', async () => {
  const cases = [
    { id: 'iphone-14-pro-max', w: 430, h: 932, dpr: 3, touch: true, ua: /iPhone/ },
    { id: 'pixel-7', w: 412, h: 915, dpr: 2.63, touch: true, ua: /Android/ },
    { id: 'desktop-1920', w: 1920, h: 1080, dpr: 1, touch: false, ua: /Windows NT/ },
    { id: 'iphone-se', w: 375, h: 667, dpr: 2, touch: true, ua: /iPhone/ },
  ]
  for (const c of cases) {
    await ipc(window, 'preview:set-device', { deviceId: c.id })
    await ipc(window, 'preview:navigate', { url: `${TEST_SITE}/ua-echo.html` })
    await waitFor(async () => (await read().catch(() => null)) !== null, 20000)
    await window.waitForTimeout(800)
    await expectDevice(await read(), c)

    // 视图尺寸必须与 设备尺寸 × 缩放 严格相等，否则页面会被裁
    const dbg = await ipc<{ bounds: { width: number; height: number }; expected: { width: number; height: number } }>(
      window,
      'test:preview-debug'
    )
    expect(dbg.bounds.width, `${c.id} 视图宽`).toBe(dbg.expected.width)
    expect(dbg.bounds.height, `${c.id} 视图高`).toBe(dbg.expected.height)
  }
})

test('跨源导航来回切换，模拟不得失效', async () => {
  await ipc(window, 'preview:set-device', { deviceId: 'iphone-14-pro-max' })
  const hosts = [
    `${TEST_SITE}/ua-echo.html`,
    `http://127.0.0.1:${TEST_SITE_PORT}/ua-echo.html`,
    `${TEST_SITE}/ua-echo.html`,
    `http://127.0.0.1:${TEST_SITE_PORT}/ua-echo.html`,
  ]
  for (const url of hosts) {
    await ipc(window, 'preview:navigate', { url })
    await waitFor(async () => {
      const i = await read().catch(() => null)
      return i !== null && i.w > 0
    }, 20000)
    await window.waitForTimeout(900)
    await expectDevice(await read(), { w: 430, h: 932, dpr: 3, touch: true, ua: /iPhone/ })
  }
})

test('窗口缩放导致面板平移时，视图位置必须跟上', async () => {
  // 必须在工作台里测：那里预览是固定 460px 列，窗口变宽时它只平移、尺寸不变，
  // ResizeObserver 对这种情况一声不吭。若只依赖它，原生视图会留在原地，
  // 看起来就是「屏幕错位」。（真机预览页的预览列是 1fr，尺寸会变，测不出这个问题。）
  const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
    profile: { id: '', name: '位置回归', protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
    apiKey: 'k',
  })
  const project = await ipc<{ id: string }>(window, 'project:create', {
    name: '位置回归',
    targetUrl: `${TEST_SITE}/ua-echo.html`,
    deviceId: 'iphone-14-pro-max',
    aiProfileId: profile.id,
    goal: 'x',
  })
  await window.locator('.sidebar').getByRole('button', { name: /项目/ }).click()
  await window.waitForTimeout(500)
  await window.getByRole('button', { name: '打开' }).first().click()
  await window.waitForTimeout(1000)
  // 固定到「画布为主」，即 1fr + 460px 的固定宽列
  await window.getByRole('button', { name: '画布为主' }).click()
  await ipc(window, 'preview:navigate', { url: `${TEST_SITE}/ua-echo.html` })
  await window.waitForTimeout(1800)

  const rectOf = () =>
    window.evaluate(() => {
      const el = document.querySelector('.device-frame .screen') as HTMLElement
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    })
  const viewBounds = () =>
    ipc<{ bounds: { x: number; y: number; width: number; height: number } }>(window, 'test:preview-debug').then(
      (d) => d.bounds
    )

  const before = await rectOf()
  await ipc(window, 'test:resize-window', { dw: 260, dh: 0 })
  // 给兜底轮询留出时间
  await window.waitForTimeout(1500)

  const after = await rectOf()
  expect(after.x, '面板应随窗口变宽而右移').toBeGreaterThan(before.x)

  const b = await viewBounds()
  // 原生视图必须落在占位区内（居中，允许取整误差）
  const dx = Math.abs(b.x - (after.x + (after.w - b.width) / 2))
  const dy = Math.abs(b.y - (after.y + (after.h - b.height) / 2))
  expect(dx, `视图 x=${b.x} 应贴合占位区 x=${after.x}`).toBeLessThanOrEqual(2)
  expect(dy, `视图 y=${b.y} 应贴合占位区 y=${after.y}`).toBeLessThanOrEqual(2)

  await ipc(window, 'test:resize-window', { dw: -260, dh: 0 })
  await window.waitForTimeout(1200)

  // 收拾现场，别影响后面的用例
  await window.locator('.sidebar').getByRole('button', { name: /项目/ }).click()
  await window.waitForTimeout(400)
  await ipc(window, 'project:delete', { id: project.id })
  await ipc(window, 'ai:profiles:delete', { id: profile.id })
  await window.locator('.sidebar').getByRole('button', { name: /真机预览/ }).click()
  await window.waitForTimeout(600)
})

test('异常小的占位矩形要被丢弃，不能把视图摆到设备框外', async () => {
  await ipc(window, 'preview:set-device', { deviceId: 'iphone-14-pro-max' })
  await ipc(window, 'preview:navigate', { url: `${TEST_SITE}/ua-echo.html` })
  await window.waitForTimeout(1200)
  const before = await ipc<{ bounds: { width: number; height: number } }>(window, 'test:preview-debug')

  // 渲染进程在布局未完成时可能报出这种极小矩形
  await ipc(window, 'preview:set-bounds', { x: 0, y: 0, width: 60, height: 130 })
  await window.waitForTimeout(900)

  const after = await ipc<{ bounds: { width: number; height: number } }>(window, 'test:preview-debug')
  expect(after.bounds.width, '视图不应被缩到无法使用的尺寸').toBe(before.bounds.width)
  const info = await read()
  expect(info.w).toBe(430)
})
