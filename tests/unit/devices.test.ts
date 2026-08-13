import { describe, expect, it } from 'vitest'
import {
  DEVICE_CATEGORIES,
  DEVICE_PRESETS,
  categoryOf,
  devicesByCategory,
  getDevice,
  validateDevice,
} from '../../src/shared/devices'

describe('设备预设', () => {
  it('id 不重复', () => {
    const ids = DEVICE_PRESETS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每条预设都归到某个分类，且四个分类都非空', () => {
    for (const d of DEVICE_PRESETS) expect(d.category, `${d.id} 缺分类`).toBeTruthy()
    for (const c of DEVICE_CATEGORIES) expect(devicesByCategory(c.key).length, `${c.key} 是空的`).toBeGreaterThan(0)
  })

  it('每条预设都通过取值范围校验', () => {
    for (const d of DEVICE_PRESETS) expect(validateDevice(d), `${d.id} 不合法`).toBeNull()
  })

  it('移动端与平板带触摸，PC 端不带', () => {
    for (const d of DEVICE_PRESETS) {
      if (d.category === 'pc') {
        expect(d.hasTouch, `${d.id} 不该有触摸`).toBe(false)
        expect(d.isMobile).toBe(false)
      } else {
        expect(d.hasTouch, `${d.id} 该有触摸`).toBe(true)
      }
    }
  })

  /*
   * 老项目里存的是改版前的设备 id，查不到会静默回落到列表第一项——
   * 表现成「打开旧项目，设备莫名其妙变了」，所以这几条必须接住。
   */
  it('旧设备 id 映射到等价的新预设', () => {
    expect(getDevice('iphone-14-pro-max').width).toBe(430)
    expect(getDevice('iphone-14-pro-max').height).toBe(932)
    expect(getDevice('desktop-1920').width).toBe(1920)
    expect(getDevice('desktop-1366').width).toBe(1366)
    expect(getDevice('desktop-mac-safari').width).toBe(1440)
    // 沿用至今的 id 不受影响
    expect(getDevice('iphone-se').id).toBe('iphone-se')
    expect(getDevice('pixel-7').id).toBe('pixel-7')
  })

  it('认不出的 id 回落到第一条，自定义设备优先', () => {
    expect(getDevice('who-knows').id).toBe(DEVICE_PRESETS[0].id)
    const custom = { ...DEVICE_PRESETS[0], id: 'custom-1', name: '自定义', category: undefined }
    expect(getDevice('custom-1', custom).name).toBe('自定义')
    // 没有 category 的自定义设备按 kind 归类
    expect(categoryOf(custom)).toBe('android')
    expect(categoryOf({ ...custom, kind: 'desktop' })).toBe('pc')
    expect(categoryOf({ ...custom, kind: 'tablet' })).toBe('tablet')
  })
})
