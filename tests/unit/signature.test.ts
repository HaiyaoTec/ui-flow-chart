import { describe, expect, it } from 'vitest'
import { signatureHash } from '../../src/main/engine/signature'
import type { ProbeElement, ProbeResult } from '../../src/shared/types'

const el = (over: Partial<ProbeElement> = {}): ProbeElement => ({
  idx: 0,
  tag: 'input',
  type: 'text',
  text: '',
  placeholder: '请输入手机号',
  name: 'phone',
  rect: { x: 0, y: 0, w: 100, h: 40 },
  disabled: false,
  ...over,
})

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  url: 'https://example.com/register',
  title: '注册',
  hasDialog: false,
  dialogClass: '',
  text: '创建账号 请输入手机号',
  elements: [el()],
  notices: [],
  iframeHosts: [],
  scrollY: 0,
  scrollHeight: 1000,
  viewportHeight: 932,
  bodyClass: '',
  scrollWidth: 430,
  ...over,
})

describe('界面签名', () => {
  it('同一界面多次探针得到相同签名', () => {
    expect(signatureHash(probe())).toBe(signatureHash(probe()))
  })

  it('忽略查询参数与 hash，避免同一界面被判为多个', () => {
    const a = signatureHash(probe({ url: 'https://example.com/register?from=home' }))
    const b = signatureHash(probe({ url: 'https://example.com/register#top' }))
    expect(a).toBe(b)
  })

  it('忽略数字变化，倒计时与榜单刷新不制造新界面', () => {
    const a = signatureHash(probe({ text: '验证码已发送 119 秒后可重发' }))
    const b = signatureHash(probe({ text: '验证码已发送 87 秒后可重发' }))
    expect(a).toBe(b)
  })

  it('出现校验提示时签名改变', () => {
    const a = signatureHash(probe())
    const b = signatureHash(probe({ notices: ['手机号不能为空'] }))
    expect(a).not.toBe(b)
  })

  it('弹窗出现时签名改变', () => {
    expect(signatureHash(probe())).not.toBe(signatureHash(probe({ hasDialog: true, dialogClass: 'MuiDrawer-paper' })))
  })

  it('控件集合变化时签名改变', () => {
    const more = probe({ elements: [el(), el({ idx: 1, name: 'password', placeholder: '密码' })] })
    expect(signatureHash(probe())).not.toBe(signatureHash(more))
  })

  it('勾选状态变化时签名改变', () => {
    const checked = probe({ elements: [el({ type: 'checkbox', checked: true })] })
    const unchecked = probe({ elements: [el({ type: 'checkbox', checked: false })] })
    expect(signatureHash(checked)).not.toBe(signatureHash(unchecked))
  })
})
