import { app, session, WebContentsView, type BaseWindow } from 'electron'
import { getDevice } from '@shared/devices'
import type { DeviceSpec } from '@shared/types'
import { delay } from './engine/PageDriver'

/**
 * 设备模拟方案对照实验。
 *
 * 目的：用实测数据判断两条路线在「跨源导航」与「切换设备」下的可靠性，
 * 而不是靠读文档猜。
 *   A = 现方案：裸 CDP（Emulation.setDeviceMetricsOverride + setUserAgentOverride）
 *   B = 原生方案：webContents.enableDeviceEmulation + session.setUserAgent
 *                 + webRequest 注入客户端提示
 *
 *   UFC_EMULAB=http://localhost:4183 electron .
 */

interface Sample {
  阶段: string
  ua命中: boolean
  innerWidth: number
  innerHeight: number
  dpr: number
  触摸点数: number
  scrollWidth: number
  视图尺寸: string
  期望视图: string
  尺寸一致: boolean
  首个请求UA命中?: boolean
}

interface Report {
  方案: string
  样本: Sample[]
  通过: boolean
}

const DEVICES = ['iphone-14-pro-max', 'pixel-7', 'desktop-1920', 'iphone-se']

export async function runEmulationLab(win: BaseWindow, baseUrl: string): Promise<void> {
  const out: Report[] = []
  try {
    out.push(await runCase('A · 裸 CDP', win, baseUrl, 'cdp'))
    out.push(await runCase('B · 原生 API', win, baseUrl, 'native'))
  } catch (e) {
    console.log('EMULAB_ERROR ' + (e instanceof Error ? e.stack : String(e)))
  }
  console.log('EMULAB_RESULT ' + JSON.stringify(out))
  app.exit(0)
}

async function runCase(
  name: string,
  win: BaseWindow,
  baseUrl: string,
  mode: 'cdp' | 'native'
): Promise<Report> {
  const partition = `persist:emulab-${mode}-${Date.now()}`
  const ses = session.fromPartition(partition)
  const view = new WebContentsView({
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.contentView.addChildView(view)
  const wc = view.webContents

  let device = getDevice(DEVICES[0])
  const BOX = { x: 0, y: 0, width: 420, height: 900 }
  let scale = fit(device, BOX)

  // B 方案：UA 与客户端提示挂在 session 上，天然跨导航持久
  if (mode === 'native') {
    installHeaderInjector(ses, () => device)
  } else {
    wc.debugger.attach('1.3')
  }

  await wc.loadURL('about:blank').catch(() => undefined)

  const apply = async () => {
    scale = fit(device, BOX)
    if (mode === 'cdp') {
      await wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: device.userAgent,
        acceptLanguage: 'zh-CN,zh;q=0.9',
        platform: device.userAgentMetadata?.platform ?? '',
        userAgentMetadata: device.userAgentMetadata
          ? { ...device.userAgentMetadata, fullVersionList: device.userAgentMetadata.brands }
          : undefined,
      })
      await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: device.width,
        height: device.height,
        deviceScaleFactor: device.deviceScaleFactor,
        mobile: device.isMobile,
        scale,
        screenWidth: device.width,
        screenHeight: device.height,
      })
      await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
        enabled: device.hasTouch,
        maxTouchPoints: device.hasTouch ? 5 : 1,
      })
      await wc.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', {
        enabled: device.hasTouch,
        configuration: device.isMobile ? 'mobile' : 'desktop',
      })
    } else {
      ses.setUserAgent(device.userAgent, 'zh-CN,zh;q=0.9')
      wc.setUserAgent(device.userAgent)
      // Electron 原生模拟：与 DevTools 设备工具栏同一套机制
      wc.enableDeviceEmulation({
        screenPosition: device.isMobile ? 'mobile' : 'desktop',
        screenSize: { width: device.width, height: device.height },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: device.deviceScaleFactor,
        viewSize: { width: device.width, height: device.height },
        scale,
      })
    }
    view.setBounds({
      x: BOX.x,
      y: BOX.y,
      width: Math.round(device.width * scale),
      height: Math.round(device.height * scale),
    })
  }

  const sample = async (阶段: string, 首个请求UA命中?: boolean): Promise<Sample> => {
    const page = (await wc
      .executeJavaScript(
        `({ ua: navigator.userAgent, w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
            touch: navigator.maxTouchPoints, sw: document.documentElement.scrollWidth })`,
        true
      )
      .catch(() => null)) as { ua: string; w: number; h: number; dpr: number; touch: number; sw: number } | null
    const b = view.getBounds()
    const expect = { w: Math.round(device.width * scale), h: Math.round(device.height * scale) }
    return {
      阶段,
      ua命中: page?.ua === device.userAgent,
      innerWidth: page?.w ?? -1,
      innerHeight: page?.h ?? -1,
      dpr: page?.dpr ?? -1,
      触摸点数: page?.touch ?? -1,
      scrollWidth: page?.sw ?? -1,
      视图尺寸: `${b.width}×${b.height}`,
      期望视图: `${expect.w}×${expect.h}`,
      尺寸一致: b.width === expect.w && b.height === expect.h,
      首个请求UA命中,
    }
  }

  const samples: Sample[] = []

  // 1. 首次加载
  await apply()
  await wc.loadURL(`${baseUrl}/ua-echo.html`).catch(() => undefined)
  await delay(1200)
  samples.push(await sample('首次加载', await firstRequestUaOk(baseUrl, '/ua-echo.html', device)))

  // 2. 跨源导航（localhost → 127.0.0.1，会触发跨进程换帧）
  const crossUrl = baseUrl.replace('localhost', '127.0.0.1')
  await wc.loadURL(`${crossUrl}/ua-echo.html`).catch(() => undefined)
  await delay(1500)
  samples.push(await sample('跨源导航后'))

  // 3. 连续切换设备
  for (const id of DEVICES.slice(1)) {
    device = getDevice(id)
    await apply()
    wc.reload()
    await delay(1800)
    samples.push(await sample(`切到 ${device.name}`))
  }

  // 4. 切回首个设备并再次跨源
  device = getDevice(DEVICES[0])
  await apply()
  await wc.loadURL(`${baseUrl}/ua-echo.html`).catch(() => undefined)
  await delay(1500)
  samples.push(await sample('切回并跨源'))

  try {
    if (mode === 'cdp' && wc.debugger.isAttached()) wc.debugger.detach()
  } catch {
    /* ignore */
  }
  win.contentView.removeChildView(view)
  try {
    wc.close()
  } catch {
    /* ignore */
  }

  return { 方案: name, 样本: samples, 通过: samples.every((s) => s.ua命中 && s.尺寸一致 && s.scrollWidth <= s.innerWidth) }
}

/** 客户端提示要自己注入：session.setUserAgent 只管 UA 字符串 */
function installHeaderInjector(ses: Electron.Session, current: () => DeviceSpec): void {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const d = current()
    const m = d.userAgentMetadata
    const headers: Record<string, string | string[]> = { ...details.requestHeaders, 'User-Agent': d.userAgent }
    if (m) {
      headers['Sec-CH-UA-Mobile'] = m.mobile ? '?1' : '?0'
      headers['Sec-CH-UA-Platform'] = `"${m.platform}"`
      headers['Sec-CH-UA'] = m.brands.length
        ? m.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ')
        : ''
      if (!m.brands.length) delete headers['Sec-CH-UA']
    }
    callback({ requestHeaders: headers })
  })
}

/** 读测试站记录的请求头，确认「首个请求」就带对了 UA */
async function firstRequestUaOk(baseUrl: string, path: string, device: DeviceSpec): Promise<boolean | undefined> {
  try {
    const res = await fetch(`${baseUrl}/__requests`)
    const list = (await res.json()) as Array<{ path: string; ua: string }>
    const hit = [...list].reverse().find((r) => r.path === path)
    return hit ? hit.ua === device.userAgent : undefined
  } catch {
    return undefined
  }
}

function fit(d: DeviceSpec, box: { width: number; height: number }): number {
  return Math.min(box.width / d.width, box.height / d.height, 1)
}
