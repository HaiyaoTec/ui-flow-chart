import type { DeviceSpec } from './types'

/**
 * 设备与 UA 预设。
 *
 * 注意 Safari 档位：底层始终是 Chromium，UA 字符串可以伪装成 Safari，但
 * userAgentMetadata（Sec-CH-UA）无法伪造成 Safari——真实 Safari 根本不发这组头。
 * 这里对 Safari 档把 brands 置空以贴近真实表现，但指纹级检测仍可识破，
 * 遇到反爬硬墙一律走人工接管，不做绕过。
 */

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

const chromeBrands = (v = '131') => [
  { brand: 'Chromium', version: v },
  { brand: 'Google Chrome', version: v },
  { brand: 'Not_A Brand', version: '24' },
]

export const DEVICE_PRESETS: DeviceSpec[] = [
  {
    id: 'iphone-14-pro-max',
    name: 'iPhone 14 Pro Max',
    kind: 'mobile',
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    userAgent: IOS_UA,
    userAgentMetadata: {
      brands: [],
      platform: 'iOS',
      platformVersion: '17.5',
      architecture: '',
      model: 'iPhone',
      mobile: true,
    },
    hasTouch: true,
    isMobile: true,
  },
  {
    id: 'iphone-se',
    name: 'iPhone SE',
    kind: 'mobile',
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    userAgent: IOS_UA,
    userAgentMetadata: {
      brands: [],
      platform: 'iOS',
      platformVersion: '17.5',
      architecture: '',
      model: 'iPhone',
      mobile: true,
    },
    hasTouch: true,
    isMobile: true,
  },
  {
    id: 'pixel-7',
    name: 'Pixel 7',
    kind: 'mobile',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    userAgent: ANDROID_UA,
    userAgentMetadata: {
      brands: chromeBrands(),
      platform: 'Android',
      platformVersion: '14.0.0',
      architecture: '',
      model: 'Pixel 7',
      mobile: true,
    },
    hasTouch: true,
    isMobile: true,
  },
  {
    id: 'ipad',
    name: 'iPad (10.9")',
    kind: 'tablet',
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    userAgent: IPAD_UA,
    userAgentMetadata: {
      brands: [],
      platform: 'iOS',
      platformVersion: '17.5',
      architecture: '',
      model: 'iPad',
      mobile: true,
    },
    hasTouch: true,
    isMobile: true,
  },
  {
    id: 'desktop-1920',
    name: '桌面 1920×1080 · Chrome',
    kind: 'desktop',
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    userAgent: DESKTOP_CHROME_UA,
    userAgentMetadata: {
      brands: chromeBrands(),
      platform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
    },
    hasTouch: false,
    isMobile: false,
  },
  {
    id: 'desktop-1366',
    name: '桌面 1366×768 · Chrome',
    kind: 'desktop',
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    userAgent: DESKTOP_CHROME_UA,
    userAgentMetadata: {
      brands: chromeBrands(),
      platform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
    },
    hasTouch: false,
    isMobile: false,
  },
  {
    id: 'desktop-mac-safari',
    name: '桌面 1440×900 · macOS Safari',
    kind: 'desktop',
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    userAgent: MAC_SAFARI_UA,
    userAgentMetadata: {
      brands: [],
      platform: 'macOS',
      platformVersion: '14.5.0',
      architecture: 'arm',
      model: '',
      mobile: false,
    },
    hasTouch: false,
    isMobile: false,
  },
]

export function getDevice(id: string, custom?: DeviceSpec): DeviceSpec {
  if (custom && custom.id === id) return custom
  return DEVICE_PRESETS.find((d) => d.id === id) ?? DEVICE_PRESETS[0]
}

/** 自定义设备的取值范围校验 */
export function validateDevice(d: Partial<DeviceSpec>): string | null {
  if (!d.width || d.width < 240 || d.width > 3840) return '宽度需在 240–3840 之间'
  if (!d.height || d.height < 320 || d.height > 2400) return '高度需在 320–2400 之间'
  if (!d.deviceScaleFactor || d.deviceScaleFactor < 1 || d.deviceScaleFactor > 4) return '像素比需在 1–4 之间'
  if (!d.userAgent || d.userAgent.length < 10) return 'User-Agent 不能为空'
  return null
}
