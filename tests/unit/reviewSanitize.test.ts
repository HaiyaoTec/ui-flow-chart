import { describe, expect, it } from 'vitest'
import {
  edgeReviewSchema,
  laneClassifySchema,
  parseEdgeReview,
  parseLaneClassify,
  sanitizeEdgeReview,
  sanitizeLaneAssignments,
  type GroupDecision,
  type LaneAssignment,
} from '../../src/main/ai/parseReview'
import { ActionParseError } from '../../src/main/ai/parseAction'
import type { EdgeCandidateGroup } from '../../src/main/engine/graphCleanup'

/**
 * AI 结果的白名单裁剪。
 *
 * 收尾整理让 AI 参与改图，风险是它把真分支清掉或者把节点挪到奇怪的地方。
 * 因此约束全部在应用侧强制复检，不指望模型守规矩——这一层就是那道闸门。
 */

const assign = (o: {
  nodeId: string
  lane: string
  laneTitle?: string
  confidence?: 'high' | 'low'
}): LaneAssignment => ({
  nodeId: o.nodeId,
  lane: o.lane,
  laneTitle: o.laneTitle,
  confidence: o.confidence ?? 'high',
})

describe('泳道归类结果裁剪', () => {
  const candidates = ['m1', 'm2']
  const inherited = new Map([
    ['m1', 'login'],
    ['m2', 'login'],
  ])
  const known = new Set(['entry', 'login'])

  it('正常结论照单接受', () => {
    const r = sanitizeLaneAssignments([assign({ nodeId: 'm1', lane: 'entry' })], candidates, inherited, known)
    expect(r.lanes.get('m1')).toBe('entry')
  })

  it('候选之外的节点一律丢弃——AI 不能顺手挪别的界面', () => {
    const r = sanitizeLaneAssignments([assign({ nodeId: 'other', lane: 'entry' })], candidates, inherited, known)
    expect(r.lanes.has('other')).toBe(false)
    expect(r.rejected).toBe(1)
  })

  it('不许把节点留在人工接管泳道，回落继承值', () => {
    const r = sanitizeLaneAssignments([assign({ nodeId: 'm1', lane: 'manual' })], candidates, inherited, known)
    expect(r.lanes.get('m1')).toBe('login')
  })

  it('拿不准的回落继承值', () => {
    const r = sanitizeLaneAssignments(
      [assign({ nodeId: 'm1', lane: 'entry', confidence: 'low' })],
      candidates,
      inherited,
      known
    )
    expect(r.lanes.get('m1')).toBe('login')
  })

  it('漏答的节点也回落，不会滞留在临时泳道', () => {
    const r = sanitizeLaneAssignments([assign({ nodeId: 'm1', lane: 'entry' })], candidates, inherited, known)
    expect(r.lanes.get('m2')).toBe('login')
  })

  it('新建泳道最多两条，超出的回落', () => {
    const cands = ['m1', 'm2', 'm3']
    const inh = new Map(cands.map((id) => [id, 'login'] as const))
    const r = sanitizeLaneAssignments(
      [
        assign({ nodeId: 'm1', lane: 'verify', laneTitle: '安全验证' }),
        assign({ nodeId: 'm2', lane: 'pay', laneTitle: '支付' }),
        assign({ nodeId: 'm3', lane: 'extra', laneTitle: '多余' }),
      ],
      cands,
      inh,
      known
    )
    expect(r.lanes.get('m1')).toBe('verify')
    expect(r.lanes.get('m2')).toBe('pay')
    expect(r.lanes.get('m3')).toBe('login')
    expect(r.titles.get('verify')).toBe('安全验证')
  })

  it('泳道 id 按同一套口径规整', () => {
    const r = sanitizeLaneAssignments(
      [assign({ nodeId: 'm1', lane: ' Forgot Password ' })],
      candidates,
      inherited,
      new Set(['entry', 'login', 'forgot-password'])
    )
    expect(r.lanes.get('m1')).toBe('forgot-password')
  })
})

describe('连线审查结果裁剪', () => {
  const groups: EdgeCandidateGroup[] = [
    {
      id: 'g1',
      from: 'a',
      to: 'b',
      members: [
        { edgeId: 'e1', label: '点击「登录」', type: 'primary', createdBy: 'ai' },
        { edgeId: 'e2', label: '提交登录表单', type: 'primary', createdBy: 'ai' },
      ],
    },
    {
      id: 'g2',
      from: 'b',
      to: 'c',
      members: [
        { edgeId: 'e3', label: '点击注册', type: 'primary', createdBy: 'ai' },
        { edgeId: 'e4', label: '点击忘记密码', type: 'branch', createdBy: 'ai' },
      ],
    },
  ]
  const dec = (o: Partial<GroupDecision> & { groupId: string; keep: string[] }): GroupDecision => o

  it('只留一条时另一条进删除名单', () => {
    const r = sanitizeEdgeReview([dec({ groupId: 'g1', keep: ['e1'] })], groups)
    expect(r.dropIds).toEqual(['e2'])
  })

  it('两条都是真分支时可以都留下', () => {
    const r = sanitizeEdgeReview([dec({ groupId: 'g2', keep: ['e3', 'e4'] })], groups)
    expect(r.dropIds).toEqual([])
  })

  it('不存在的组忽略掉，不影响别的组', () => {
    const r = sanitizeEdgeReview([dec({ groupId: 'g9', keep: ['e1'] }), dec({ groupId: 'g1', keep: ['e1'] })], groups)
    expect(r.dropIds).toEqual(['e2'])
    expect(r.rejected).toBe(1)
  })

  it('跨组的连线 id 被剔除', () => {
    const r = sanitizeEdgeReview([dec({ groupId: 'g1', keep: ['e1', 'e3'] })], groups)
    // e3 不属于 g1，剔除后仍保留 e1，g2 不受影响
    expect(r.dropIds).toEqual(['e2'])
  })

  it('组内一条都没选中时整组回落，不删任何边', () => {
    const r = sanitizeEdgeReview([dec({ groupId: 'g1', keep: ['e3'] })], groups)
    expect(r.dropIds).toEqual([])
    expect(r.rejected).toBe(1)
  })

  it('没提到的组保持原样', () => {
    const r = sanitizeEdgeReview([dec({ groupId: 'g1', keep: ['e1'] })], groups)
    expect(r.dropIds).not.toContain('e3')
    expect(r.dropIds).not.toContain('e4')
  })

  it('可以给保留下来的第一条换标注', () => {
    const r = sanitizeEdgeReview([dec({ groupId: 'g1', keep: ['e1'], label: '点击「登录」提交' })], groups)
    expect(r.relabel.get('e1')).toBe('点击「登录」提交')
  })
})

describe('结构校验', () => {
  it('keep 为空的组不合法', () => {
    expect(edgeReviewSchema.safeParse({ groups: [{ groupId: 'g1', keep: [] }] }).success).toBe(false)
  })

  it('缺 lane 的归类不合法', () => {
    expect(laneClassifySchema.safeParse({ assignments: [{ nodeId: 'm1' }] }).success).toBe(false)
  })

  it('复用三级降级：能从代码块与解释文字里抠出 JSON', () => {
    const raw = '好的，结论如下：\n```json\n{"assignments":[{"nodeId":"m1","lane":"login"}]}\n```\n以上。'
    expect(parseLaneClassify(raw).assignments[0].lane).toBe('login')
  })

  it('结构不符时抛 ActionParseError，带上原文', () => {
    expect(() => parseEdgeReview('{"groups":[{"groupId":"g1"}]}')).toThrow(ActionParseError)
  })
})
