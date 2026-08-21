import { describe, expect, it } from 'vitest'
import { ActionParseError, parseAction, parseActionObject } from '../../src/main/ai/parseAction'

const valid = {
  action: 'click',
  targetIdx: 3,
  reason: '进入注册',
}

/** 旧版提示词要求的完整输出：多出来的 screen / edgeLabel 必须被剥掉而不是报错 */
const legacy = {
  ...valid,
  screen: { id: 'Register Init', title: '注册页', lane: 'Register', kind: 'normal' },
  edgeLabel: '点击「注册」',
}

describe('parseAction', () => {
  it('解析纯 JSON 输出', () => {
    const a = parseAction(JSON.stringify(valid))
    expect(a.action).toBe('click')
    expect(a.targetIdx).toBe(3)
  })

  it('旧版输出里的 screen 与 edgeLabel 被剥掉，不影响解析', () => {
    const a = parseAction(JSON.stringify(legacy))
    expect(a.action).toBe('click')
    expect(a.screen).toBeUndefined()
    expect(a.edgeLabel).toBeUndefined()
  })

  it('能从 markdown 代码块里抠出 JSON', () => {
    const raw = '好的，我的决定如下：\n```json\n' + JSON.stringify(valid) + '\n```\n希望有帮助。'
    expect(parseAction(raw).action).toBe('click')
  })

  it('能从前后夹杂解释文字的输出里抠出 JSON', () => {
    const raw = `我认为应该点击注册按钮。${JSON.stringify(valid)} 这样就能进入下一步。`
    expect(parseAction(raw).action).toBe('click')
  })

  it('缺少必填字段时抛出可读错误', () => {
    const bad = { action: 'click' }
    expect(() => parseAction(JSON.stringify(bad))).toThrow(ActionParseError)
  })

  it('完全不含 JSON 时抛错', () => {
    expect(() => parseAction('抱歉，我无法完成这个任务。')).toThrow(ActionParseError)
  })

  it('scroll 缺省滚动距离时补默认值', () => {
    const a = parseAction(JSON.stringify({ ...valid, action: 'scroll', targetIdx: undefined }))
    expect(a.scrollDelta).toBe(600)
  })

  it('need_human 缺省原因时补 other', () => {
    const a = parseAction(JSON.stringify({ ...valid, action: 'need_human' }))
    expect(a.needHumanReason).toBe('other')
  })

  it('工具调用参数走对象校验', () => {
    expect(parseActionObject(valid).reason).toBe('进入注册')
    expect(() => parseActionObject({ action: 'nope' })).toThrow(ActionParseError)
  })
})
