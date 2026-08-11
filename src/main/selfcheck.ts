import { app, type BrowserWindow } from 'electron'
import { getDevice } from '@shared/devices'
import { delay } from './engine/PageDriver'
import { preview } from './engine/previewManager'

/**
 * 引擎自检：不依赖任何测试框架，直接在主进程里把设备模拟、探针、输入、截图跑一遍，
 * 结果以 JSON 打到 stdout 后退出。
 *   UFC_SELFCHECK=http://localhost:4183 electron .
 */
export async function runSelfCheck(win: BrowserWindow, baseUrl: string): Promise<void> {
  const out: Record<string, unknown> = {}
  const fail = (k: string, e: unknown) => {
    out[k] = { error: e instanceof Error ? e.message : String(e) }
  }

  try {
    preview.bindWindow(win)
    // 模拟渲染进程上报的屏幕占位矩形
    await preview.setPaneBounds({ x: 20, y: 60, width: 380, height: 760 })

    /* 1. 移动端设备模拟 */
    await preview.open(`${baseUrl}/ua-echo.html`, getDevice('iphone-14-pro-max'), 'persist:selfcheck')
    await delay(1200)
    out.mobile = await preview.driver.evalInPage('window.__deviceInfo')

    /* 2. 桌面设备模拟 */
    await preview.setDevice(getDevice('desktop-1920'))
    await delay(1500)
    out.desktop = await preview.driver.evalInPage('window.__deviceInfo')

    /* 3. 点击坐标：对照 fit=1 与 fit<1 两种缩放，定位是否存在换算错位 */
    await preview.setDevice(getDevice('iphone-14-pro-max'))
    const centerOf = async () =>
      (await preview.driver.evalInPage(
        `(() => { const b = document.querySelectorAll('.grid button')[4]
           const r = b.getBoundingClientRect()
           return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
      )) as { x: number; y: number }

    // 3a. 不缩放
    await preview.setPaneBounds({ x: 0, y: 0, width: 430, height: 932 })
    await preview.navigate({ url: `${baseUrl}/click-echo.html` })
    await delay(1200)
    const c1 = await centerOf()
    await preview.driver.tap(c1.x, c1.y)
    await delay(400)
    out.tapFit1 = { sent: c1, hit: await preview.driver.evalInPage('window.__lastHit') }

    // 3b. 缩放到约 0.7
    await preview.setPaneBounds({ x: 0, y: 0, width: 300, height: 650 })
    await preview.navigate({ url: `${baseUrl}/click-echo.html` })
    await delay(1200)
    const c2 = await centerOf()
    await preview.driver.tap(c2.x, c2.y)
    await delay(400)
    out.tapScaled = { sent: c2, hit: await preview.driver.evalInPage('window.__lastHit') }

    // 恢复不缩放，后续用例不受影响
    await preview.setPaneBounds({ x: 0, y: 0, width: 430, height: 932 })
    await delay(300)

    /* 4. 文本输入 */
    const box = (await preview.driver.evalInPage(
      `(() => { const r = document.getElementById('echo').getBoundingClientRect()
         return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
    )) as { x: number; y: number }
    await preview.driver.fillAt(box.x, box.y, 'hello-123')
    await delay(300)
    out.fill = await preview.driver.evalInPage('document.getElementById("echo").value')

    /* 5. 截图分辨率 */
    const shot = await preview.driver.screenshot()
    out.screenshot = { pngBytes: shot.png.length, jpegChars: shot.jpegBase64.length }

    /* 6. 探针 */
    await preview.navigate({ url: `${baseUrl}/register.html` })
    await delay(1200)
    const probe = await preview.driver.probe()
    out.probe = {
      url: probe.url,
      elements: probe.elements.length,
      placeholders: probe.elements.map((e) => e.placeholder).filter(Boolean),
      notices: probe.notices,
    }

    /* 7. 校验态：空表单提交后应出现红色提示 */
    const submit = probe.elements.find((e) => e.tag === 'button')
    if (submit) {
      await preview.driver.tap(submit.rect.x + submit.rect.w / 2, submit.rect.y + submit.rect.h / 2)
      await delay(600)
      const after = await preview.driver.probe()
      out.validation = { notices: after.notices }
    }
  } catch (e) {
    fail('fatal', e)
  }

  console.log('SELFCHECK_RESULT ' + JSON.stringify(out))
  preview.destroy()
  app.exit(0)
}
