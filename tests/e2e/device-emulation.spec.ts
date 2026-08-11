import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { evalPreview, ipc, launchApp, siteRequests, startTestSite, TEST_SITE, waitFor } from './helpers'

let stopSite: () => void
let app: ElectronApplication
let window: Page

test.beforeAll(async () => {
  stopSite = await startTestSite()
  const launched = await launchApp()
  app = launched.app
  window = launched.window
  // 切到预览页，让 DeviceFrame 把屏幕占位矩形上报给主进程
  await window.getByRole('button', { name: '真机预览' }).click()
  await window.waitForTimeout(600)
})

test.afterAll(async () => {
  await app?.close()
  stopSite?.()
})

interface DeviceInfo {
  ua: string
  width: number
  height: number
  dpr: number
  touch: boolean
  coarse: boolean
  mobile: boolean | null
  scrollWidth: number
}

async function openUaEcho(deviceId: string): Promise<DeviceInfo> {
  await ipc(window, 'preview:set-device', { deviceId })
  await ipc(window, 'preview:navigate', { url: `${TEST_SITE}/ua-echo.html` })
  await waitFor(async () => {
    const info = await evalPreview<DeviceInfo | null>(window, 'window.__deviceInfo || null')
    return info !== null
  }, 20000)
  return evalPreview<DeviceInfo>(window, 'window.__deviceInfo')
}

test('移动端设备模拟：UA、视口、触摸三项一致，且首个请求就是移动 UA', async () => {
  const info = await openUaEcho('iphone-14-pro-max')

  expect(info.ua).toMatch(/iPhone/)
  expect(info.width).toBe(430)
  expect(info.height).toBe(932)
  expect(info.dpr).toBe(3)
  expect(info.touch).toBe(true)
  expect(info.coarse).toBe(true)
  // 视口没被撑宽，说明页面确实按移动布局渲染
  expect(info.scrollWidth).toBeLessThanOrEqual(430)

  // override 必须在导航前生效：服务端记录的首个 HTML 请求就应带移动 UA
  const reqs = await siteRequests()
  const first = reqs.find((r) => r.path === '/ua-echo.html')
  expect(first, '测试站应记录到 ua-echo 请求').toBeTruthy()
  expect(first!.ua).toMatch(/iPhone/)
})

test('桌面设备模拟：UA、视口与客户端提示都切到桌面档', async () => {
  const info = await openUaEcho('desktop-1920')

  expect(info.ua).toMatch(/Windows NT/)
  expect(info.width).toBe(1920)
  expect(info.touch).toBe(false)
  expect(info.mobile, 'navigator.userAgentData.mobile 应为 false').toBe(false)

  const reqs = await siteRequests()
  const nav = [...reqs].reverse().find((r) => r.path === '/ua-echo.html')
  expect(nav!.ua).toMatch(/Windows NT/)

  // 实测行为：顶层导航请求只带 UA 字符串，Sec-CH-UA 系列出现在子资源请求上。
  // 所以客户端提示要到子资源里去断言，否则会误判为 override 没生效。
  const sub = [...reqs].reverse().find((r) => r.path === '/site.css' && r.chMobile !== '')
  expect(sub, '应能取到带客户端提示的子资源请求').toBeTruthy()
  expect(sub!.chMobile).toBe('?0')
  expect(sub!.chPlatform).toContain('Windows')
})

test('缩放状态下点击坐标不错位，且事件是 trusted', async () => {
  await ipc(window, 'preview:set-device', { deviceId: 'iphone-14-pro-max' })
  await ipc(window, 'preview:navigate', { url: `${TEST_SITE}/click-echo.html` })
  await waitFor(async () => (await evalPreview<number>(window, 'document.querySelectorAll(".grid button").length')) === 9, 20000)

  // 取第 5 个格子的中心（CSS 坐标），用 CDP 派发点击
  const center = await evalPreview<{ x: number; y: number }>(
    window,
    `(() => { const b = document.querySelectorAll('.grid button')[4]
       const r = b.getBoundingClientRect()
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
  )
  await ipc(window, 'test:tap', center)
  await window.waitForTimeout(400)

  const hit = await evalPreview<{ idx: number; dx: number; dy: number; trusted: boolean }>(window, 'window.__lastHit')
  expect(hit, '应记录到一次点击').toBeTruthy()
  expect(hit.idx, '命中的格子应与派发坐标一致').toBe(5)
  // 偏差以格子尺寸的量级衡量，超过几个像素就说明缩放换算有问题
  expect(Math.abs(hit.dx)).toBeLessThanOrEqual(3)
  expect(Math.abs(hit.dy)).toBeLessThanOrEqual(3)
  expect(hit.trusted, 'CDP 派发的事件应为 trusted').toBe(true)
})

test('文本输入走 insertText，页面能收到 input 事件', async () => {
  const box = await evalPreview<{ x: number; y: number }>(
    window,
    `(() => { const r = document.getElementById('echo').getBoundingClientRect()
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
  )
  await ipc(window, 'test:fill', { ...box, text: 'hello-123' })
  await window.waitForTimeout(300)

  const value = await evalPreview<string>(window, 'document.getElementById("echo").value')
  expect(value).toBe('hello-123')
})

test('截图输出设备原始分辨率，缩放不影响存档质量', async () => {
  const shot = await ipc<{ pngBytes: number; jpegBase64Length: number }>(window, 'test:screenshot')
  expect(shot.pngBytes).toBeGreaterThan(1000)
  expect(shot.jpegBase64Length).toBeGreaterThan(1000)

  const size = await evalPreview<{ w: number; h: number }>(window, '({ w: innerWidth, h: innerHeight })')
  expect(size.w).toBe(430)
  expect(size.h).toBe(932)
})

test('探针能读出可交互元素与页面结构', async () => {
  await ipc(window, 'preview:navigate', { url: `${TEST_SITE}/register.html` })
  await window.waitForTimeout(1500)

  const probe = await ipc<{ elements: Array<{ tag: string; placeholder: string }>; url: string; notices: string[] }>(
    window,
    'test:probe'
  )
  expect(probe.url).toContain('/register.html')
  const placeholders = probe.elements.map((e) => e.placeholder).filter(Boolean)
  expect(placeholders.some((p) => p.includes('手机号'))).toBe(true)
  expect(probe.elements.some((e) => e.tag === 'button')).toBe(true)
})
