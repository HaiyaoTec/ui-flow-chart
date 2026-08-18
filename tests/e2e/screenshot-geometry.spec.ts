import { expect, test } from '@playwright/test'
import { getDevice } from '../../src/shared/devices'
import { ipc, launchApp, openFirstProject, startTestSite, TEST_SITE, waitFor } from './helpers'

interface Probe {
  width: number
  height: number
  bytes: number
  samples: Array<{ x: number; y: number; r: number; g: number; b: number }>
}

const DEVICE = 'iphone-14-pro-max'

async function makeProject(window: Parameters<typeof ipc>[0], name: string, path: string): Promise<string> {
  const profile = await ipc<{ id: string }>(window, 'ai:profiles:save', {
    profile: { id: '', name, protocol: 'openai', baseUrl: 'http://localhost:1/v1', model: 'mock' },
    apiKey: 'k',
  })
  const project = await ipc<{ id: string }>(window, 'project:create', {
    name,
    targetUrl: `${TEST_SITE}${path}`,
    deviceId: DEVICE,
    aiProfileId: profile.id,
    goal: 'x',
  })
  await openFirstProject(window)
  await waitFor(async () => (await ipc<{ visible: boolean }>(window, 'test:preview-debug')).visible, 20000)
  return project.id
}

/**
 * 存档图必须是「当前这一屏，按设备原始分辨率」。
 *
 * 抓图走的是 CDP 的 Page.captureScreenshot，它的 clip 用**文档坐标**，
 * 而这里长期固定传 y=0：页面一旦滚动过，clip 覆盖的就是文档顶部那段，
 * 而那段并不在合成面里（captureBeyondViewport 关着），返回的是空白——
 * 空白高度正好等于滚动距离。用户看到的「顶部大面积留白」就是它。
 *
 * 同一处还有第二个问题：clip.scale 传的是设备像素比，而 clip 的宽高本来就是
 * CSS 像素、输出时还会再乘一次像素比，于是存档图被放大了整整一倍像素比，
 * 体积是应有的九倍。
 */
test('滚动之后的存档图拍的是当前视口，且是设备原始分辨率', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const id = await makeProject(window, '抓图几何', '/tall.html')
    const dev = getDevice(DEVICE)
    const W = dev.width * dev.deviceScaleFactor
    const H = dev.height * dev.deviceScaleFactor

    // 未滚动时：第一屏是 SECTION-0（深绿 #1b4d3e）
    const top = await ipc<Probe>(window, 'test:screenshot-probe', [{ x: Math.round(W / 2), y: Math.round(H * 0.1) }])
    expect({ w: top.width, h: top.height }, '存档图必须是设备原始分辨率').toEqual({ w: W, h: H })
    expect(top.samples[0].g, '第一屏应当是深绿色带').toBeGreaterThan(top.samples[0].b)

    // 滚到第三屏：视口里是 SECTION-2（紫 #6b2d5c），红分量应当高于绿
    await ipc(window, 'test:eval-preview', 'window.scrollTo(0, 600); "ok"')
    await window.waitForTimeout(500)
    const mid = await ipc<Probe>(window, 'test:screenshot-probe', [
      { x: Math.round(W / 2), y: Math.round(H * 0.08) },
      { x: Math.round(W / 2), y: Math.round(H * 0.5) },
    ])
    expect({ w: mid.width, h: mid.height }, '滚动不该改变输出分辨率').toEqual({ w: W, h: H })
    /*
     * 缺陷态下这里拍到的是文档顶部那段没画过的区域，取样点会是纯粹的底色；
     * 现在应当拍到紫色与棕色两条色带。
     */
    expect(mid.samples[0].r, '顶部取样应当落在紫色带上，而不是空白').toBeGreaterThan(mid.samples[0].g + 20)
    expect(mid.samples[1].r, '中部取样应当落在棕色带上').toBeGreaterThan(mid.samples[1].b + 30)

    await ipc(window, 'project:delete', { id })
  } finally {
    await app.close()
    stopSite()
  }
})

/**
 * 存档图里必须有图片，不能是一块底色。
 *
 * 说明这条用例守住了什么：它是端到端的结果守卫——图片延迟 900ms 返回，
 * 抓到的图里那块不能还是页面底色。但它证明不了绘制等待本身的几处改进
 * （已完成但尚未解码的图、字体未就位、合成器还没出帧），
 * 那几种中间态从外部无法稳定地制造出来。抓图前先等本次加载结束这一条，
 * 在这里也不成立——导航本来就会等到 load，而 load 会等 <img>。
 */
test('存档图里的图片必须已经画出来，不能是一块底色', async () => {
  const stopSite = await startTestSite()
  const { app, window } = await launchApp()
  try {
    const id = await makeProject(window, '晚到的图', '/late-image.html')
    const dev = getDevice(DEVICE)
    const W = dev.width * dev.deviceScaleFactor
    const H = dev.height * dev.deviceScaleFactor

    // 重新导航，让那张 900ms 才回来的图重新走一遍
    await ipc(window, 'preview:navigate', { action: 'reload' })
    const shot = await ipc<Probe>(window, 'test:screenshot-probe', [{ x: Math.round(W / 2), y: Math.round(H * 0.25) }])
    const s = shot.samples[0]
    /*
     * 断言「不是页面底色」而不是某个具体颜色：图片本身是什么颜色不重要，
     * 要守的是「抓图时它已经画上去了」。底色是 #101318，三个通道都在 30 以下。
     */
    const bg = Math.max(s.r, s.g, s.b) < 40
    expect(bg, `图片区域仍是页面底色，说明抓图没等它画出来：rgb(${s.r},${s.g},${s.b})`).toBe(false)

    await ipc(window, 'project:delete', { id })
  } finally {
    await app.close()
    stopSite()
  }
})
