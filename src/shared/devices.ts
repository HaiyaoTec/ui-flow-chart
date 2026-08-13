import type { DeviceCategory, DeviceSpec } from './types'

/**
 * 设备与 UA 预设。
 *
 * 注意 Safari 档位：底层始终是 Chromium，UA 字符串可以伪装成 Safari，但
 * userAgentMetadata（Sec-CH-UA）无法伪造成 Safari——真实 Safari 根本不发这组头。
 * 这里对 Safari 档把 brands 置空以贴近真实表现，但指纹级检测仍可识破，
 * 遇到反爬硬墙一律走人工接管，不做绕过。
 *
 * 尺寸一律是 CSS 像素视口（竖屏），不是物理分辨率。
 */

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
/** 安卓平板不带 Mobile 标记，站点据此走宽屏布局 */
const ANDROID_TABLET_UA =
  'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

const chromeBrands = (v = '131') => [
  { brand: 'Chromium', version: v },
  { brand: 'Google Chrome', version: v },
  { brand: 'Not_A Brand', version: '24' },
]

/* --------------------------- 各分类的构造器 --------------------------- */

const iphone = (id: string, name: string, width: number, height: number, deviceScaleFactor = 3): DeviceSpec => ({
  id,
  name,
  kind: 'mobile',
  category: 'iphone',
  width,
  height,
  deviceScaleFactor,
  userAgent: IOS_UA,
  userAgentMetadata: {
    brands: [],
    platform: 'iOS',
    platformVersion: '18.5',
    architecture: '',
    model: 'iPhone',
    mobile: true,
  },
  hasTouch: true,
  isMobile: true,
})

const android = (
  id: string,
  name: string,
  width: number,
  height: number,
  model: string,
  deviceScaleFactor = 3
): DeviceSpec => ({
  id,
  name,
  kind: 'mobile',
  category: 'android',
  width,
  height,
  deviceScaleFactor,
  userAgent: ANDROID_UA,
  userAgentMetadata: {
    brands: chromeBrands(),
    platform: 'Android',
    platformVersion: '14.0.0',
    architecture: '',
    model,
    mobile: true,
  },
  hasTouch: true,
  isMobile: true,
})

const tablet = (
  id: string,
  name: string,
  width: number,
  height: number,
  os: 'ios' | 'android',
  deviceScaleFactor = 2
): DeviceSpec => ({
  id,
  name,
  kind: 'tablet',
  category: 'tablet',
  width,
  height,
  deviceScaleFactor,
  userAgent: os === 'ios' ? IPAD_UA : ANDROID_TABLET_UA,
  userAgentMetadata:
    os === 'ios'
      ? { brands: [], platform: 'iOS', platformVersion: '18.5', architecture: '', model: 'iPad', mobile: true }
      : {
          brands: chromeBrands(),
          platform: 'Android',
          platformVersion: '14.0.0',
          architecture: '',
          model: 'Tablet',
          mobile: false,
        },
  hasTouch: true,
  // 平板按非移动版渲染，但保留触摸
  isMobile: os === 'ios',
})

const pc = (
  id: string,
  name: string,
  width: number,
  height: number,
  os: 'win' | 'mac',
  deviceScaleFactor = 1
): DeviceSpec => ({
  id,
  name,
  kind: 'desktop',
  category: 'pc',
  width,
  height,
  deviceScaleFactor,
  userAgent: os === 'win' ? DESKTOP_CHROME_UA : MAC_SAFARI_UA,
  userAgentMetadata:
    os === 'win'
      ? {
          brands: chromeBrands(),
          platform: 'Windows',
          platformVersion: '15.0.0',
          architecture: 'x86',
          model: '',
          mobile: false,
        }
      : { brands: [], platform: 'macOS', platformVersion: '14.5.0', architecture: 'arm', model: '', mobile: false },
  hasTouch: false,
  isMobile: false,
})

/* ------------------------------ 预设清单 ------------------------------ */

export const DEVICE_CATEGORIES: Array<{ key: DeviceCategory; label: string }> = [
  { key: 'iphone', label: 'iPhone' },
  { key: 'android', label: 'Android' },
  { key: 'pc', label: 'PC 端' },
  { key: 'tablet', label: '平板' },
]

export const DEVICE_PRESETS: DeviceSpec[] = [
  // iPhone：同尺寸的机型合并成一条，避免列表里全是重复的 393×852
  iphone('iphone-17-pro-max', 'iPhone 17 Pro Max / 16 Pro Max', 440, 956),
  iphone('iphone-17-pro', 'iPhone 17 Pro / 16 Pro', 402, 874),
  iphone('iphone-17', 'iPhone 17', 402, 874),
  iphone('iphone-air', 'iPhone Air', 420, 912),
  iphone('iphone-16-plus', 'iPhone 16 Plus', 430, 932),
  iphone('iphone-16', 'iPhone 16', 393, 852),
  iphone('iphone-15-plus', 'iPhone 15 Plus / 14 Pro Max', 430, 932),
  iphone('iphone-15', 'iPhone 15 / 15 Pro', 393, 852),
  iphone('iphone-14-plus', 'iPhone 14 Plus', 428, 926),
  iphone('iphone-14', 'iPhone 14', 390, 844),
  iphone('iphone-13-mini', 'iPhone 13 mini', 375, 812),
  iphone('iphone-11', 'iPhone 11 / XR', 414, 896, 2),
  iphone('iphone-se', 'iPhone SE', 375, 667, 2),

  // Android：折叠屏按形态各给一条，展开与折叠的布局差别正是要看的
  android('android-mate-70', '华为 Mate 70', 405, 896, 'HUAWEI Mate 70'),
  android('android-mate-70-pro', '华为 Mate 70 Pro', 438, 944, 'HUAWEI Mate 70 Pro'),
  android('android-mate-70-pro-plus', '华为 Mate 70 Pro+', 438, 944, 'HUAWEI Mate 70 Pro+'),
  android('android-mate-xts-1', '华为 Mate XTs · 单屏', 336, 744, 'HUAWEI Mate XTs'),
  android('android-mate-xts-2', '华为 Mate XTs · 双屏', 682, 744, 'HUAWEI Mate XTs'),
  android('android-mate-xts-3', '华为 Mate XTs · 三屏', 1061, 744, 'HUAWEI Mate XTs'),
  android('android-mate-60', '华为 Mate 60', 405, 896, 'HUAWEI Mate 60'),
  android('android-mate-60-pro', '华为 Mate 60 Pro', 420, 907, 'HUAWEI Mate 60 Pro'),
  android('android-mate-x5-open', '华为 Mate X5 · 展开', 741, 832, 'HUAWEI Mate X5'),
  android('android-mate-x5-fold', '华为 Mate X5 · 折叠', 360, 835, 'HUAWEI Mate X5'),
  android('android-xiaomi-15', '小米 15', 400, 890, 'Xiaomi 15'),
  android('android-galaxy-s23', 'Samsung Galaxy S23', 360, 780, 'SM-S911B'),
  android('pixel-7', 'Google Pixel 7', 412, 915, 'Pixel 7', 2.625),

  // PC 端
  pc('pc-1920', '网页 1920', 1920, 1080, 'win'),
  pc('pc-1440', '网页 1440', 1440, 1024, 'win'),
  pc('pc-1366', '网页 1366', 1366, 768, 'win'),
  pc('pc-macbook-pro-16', 'MacBook Pro 16″', 1728, 1117, 'mac', 2),
  pc('pc-macbook-pro-14', 'MacBook Pro 14″', 1512, 982, 'mac', 2),
  pc('pc-macbook-pro', 'MacBook Pro', 1440, 900, 'mac', 2),
  pc('pc-macbook-air-13', 'MacBook Air 13″', 1280, 832, 'mac', 2),
  pc('pc-imac', 'iMac', 2240, 1260, 'mac', 2),
  pc('pc-matebook', '华为 MateBook 14s / 16s', 1260, 840, 'win', 2),

  // 平板
  tablet('ipad-pro-11', 'iPad Pro 11″', 834, 1194, 'ios'),
  tablet('ipad-pro-129', 'iPad Pro 12.9″', 1024, 1366, 'ios'),
  tablet('ipad', 'iPad', 820, 1180, 'ios'),
  tablet('matepad-pro-132', '华为 MatePad Pro 13.2″', 960, 1440, 'android'),
  tablet('matepad-11', '华为 MatePad 11″', 800, 1280, 'android'),
]

/**
 * 旧预设 id → 新 id。
 *
 * 预设改版前建的项目里存的是旧 id，直接查不到会静默回落到列表第一项，
 * 用户看到的是「设备莫名其妙变了」。这里按等价尺寸接住。
 */
const LEGACY_DEVICE_IDS: Record<string, string> = {
  'iphone-14-pro-max': 'iphone-15-plus',
  'desktop-1920': 'pc-1920',
  'desktop-1366': 'pc-1366',
  'desktop-mac-safari': 'pc-macbook-pro',
}

export function devicesByCategory(category: DeviceCategory): DeviceSpec[] {
  return DEVICE_PRESETS.filter((d) => d.category === category)
}

/** 自定义设备没有 category，按 kind 归到最接近的一类 */
export function categoryOf(d: DeviceSpec): DeviceCategory {
  if (d.category) return d.category
  if (d.kind === 'desktop') return 'pc'
  if (d.kind === 'tablet') return 'tablet'
  return 'android'
}

export function getDevice(id: string, custom?: DeviceSpec): DeviceSpec {
  if (custom && custom.id === id) return custom
  const wanted = LEGACY_DEVICE_IDS[id] ?? id
  return DEVICE_PRESETS.find((d) => d.id === wanted) ?? DEVICE_PRESETS[0]
}

/** 自定义设备的取值范围校验 */
export function validateDevice(d: Partial<DeviceSpec>): string | null {
  if (!d.width || d.width < 240 || d.width > 3840) return '宽度需在 240–3840 之间'
  if (!d.height || d.height < 320 || d.height > 2400) return '高度需在 320–2400 之间'
  if (!d.deviceScaleFactor || d.deviceScaleFactor < 1 || d.deviceScaleFactor > 4) return '像素比需在 1–4 之间'
  if (!d.userAgent || d.userAgent.length < 10) return 'User-Agent 不能为空'
  return null
}
