import { describe, expect, it } from 'vitest'
import {
  applyCleanup,
  emptyLaneIds,
  inheritLanes,
  isFallbackLabel,
  normalizeEdgeLabel,
  planCleanup,
  strongestType,
} from '../../src/main/engine/graphCleanup'
import type { EdgeType, FlowEdge, FlowGraph, FlowNode } from '../../src/shared/types'

/**
 * 确定性清理层。
 *
 * 这一层是收尾整理的地基：AI 不可用时它单独就要能把重复连线收敛、把人工接管
 * 节点归位。两条最关键的性质是「与数组顺序无关」和「幂等」——前者保证结果可复现，
 * 后者保证收尾可以重复触发而不会越清越少。
 */

let seq = 0
const node = (id: string, lane: string): FlowNode => ({
  id,
  signatureHash: id,
  lane,
  col: 0,
  sub: 0,
  kind: 'normal',
  title: id,
  url: '',
  createdBy: 'ai',
  shot: id,
  ts: '',
})

const edge = (
  from: string,
  to: string,
  label: string,
  o: { type?: EdgeType; by?: 'ai' | 'human'; ts?: string; id?: string } = {}
): FlowEdge => ({
  id: o.id ?? `e${++seq}`,
  from,
  to,
  label,
  type: o.type ?? 'primary',
  createdBy: o.by ?? 'ai',
  ts: o.ts ?? `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
})

const graph = (nodes: FlowNode[], edges: FlowEdge[], lanes?: string[]): FlowGraph => ({
  version: 1,
  meta: { targetUrl: '', deviceId: '', steps: 0, aiCalls: 0, updatedAt: '' },
  lanes: (lanes ?? [...new Set(nodes.map((n) => n.lane))]).map((id) => ({ id, title: id })),
  nodes,
  edges,
})

const labelsOf = (g: FlowGraph) => applyCleanup(g.edges, planCleanup(g)).map((e) => e.label)

describe('标注归一化', () => {
  it('引号、结构性后缀、大小写不影响相等', () => {
    expect(normalizeEdgeLabel('点击「登录」')).toBe(normalizeEdgeLabel('点击登录按钮'))
    expect(normalizeEdgeLabel('点击 Daftar')).toBe(normalizeEdgeLabel('点击「daftar」'))
  })

  it('同义动词归并', () => {
    expect(normalizeEdgeLabel('轻触「提交」')).toBe(normalizeEdgeLabel('点击提交'))
    expect(normalizeEdgeLabel('填写手机号')).toBe(normalizeEdgeLabel('输入手机号'))
  })

  it('数字归一，位数提示不算两个动作', () => {
    expect(normalizeEdgeLabel('输入手机号（8-13 位）')).toBe(normalizeEdgeLabel('输入手机号（11 位）'))
  })

  it('箭头写法统一，但箭头两侧仍是一个整体', () => {
    expect(normalizeEdgeLabel('提交 → 系统校验失败')).toBe(normalizeEdgeLabel('提交->系统校验失败'))
    expect(normalizeEdgeLabel('提交 → 校验失败')).not.toBe(normalizeEdgeLabel('提交'))
  })

  it('不同的动作不能被归一化吞掉', () => {
    expect(normalizeEdgeLabel('点击「登录」')).not.toBe(normalizeEdgeLabel('点击「注册」'))
  })

  it('事件窗口只比第一段：同起点折叠，不同起点保留', () => {
    expect(normalizeEdgeLabel('点击「A」·点击「B」')).toBe(normalizeEdgeLabel('点击「A」·点击「C」'))
    expect(normalizeEdgeLabel('点击「A」·点击「B」')).not.toBe(normalizeEdgeLabel('点击「B」·点击「C」'))
  })
})

describe('重复边收敛', () => {
  it('措辞抖动的三条并成一条，且留下 AI 那条', () => {
    const g = graph(
      [node('a', 'l1'), node('b', 'l1')],
      [
        edge('a', 'b', '点击登录按钮', { by: 'human' }),
        edge('a', 'b', '点击「登录」'),
        edge('a', 'b', '轻触登录'),
      ]
    )
    const kept = applyCleanup(g.edges, planCleanup(g))
    expect(kept).toHaveLength(1)
    expect(kept[0].createdBy).toBe('ai')
  })

  it('组内只有人工边时人工边留下，边不会凭空消失', () => {
    const g = graph(
      [node('a', 'l1'), node('b', 'l1')],
      [edge('a', 'b', '点击「A」·点击「B」', { by: 'human' }), edge('a', 'b', '点击「A」·点击「C」', { by: 'human' })]
    )
    expect(applyCleanup(g.edges, planCleanup(g))).toHaveLength(1)
  })

  it('兜底文案被同一对节点的正经标注吸收', () => {
    const g = graph(
      [node('a', 'l1'), node('b', 'l1')],
      [edge('a', 'b', '自动跳转', { type: 'link' }), edge('a', 'b', '点击「登录」')]
    )
    expect(labelsOf(g)).toEqual(['点击「登录」'])
  })

  it('只有兜底文案时也收敛成一条', () => {
    const g = graph(
      [node('a', 'l1'), node('b', 'l1')],
      [edge('a', 'b', '自动跳转', { type: 'link' }), edge('a', 'b', '人工操作', { type: 'branch', by: 'human' })]
    )
    expect(applyCleanup(g.edges, planCleanup(g))).toHaveLength(1)
  })

  it('归一化键互为前缀的并掉', () => {
    const g = graph(
      [node('a', 'l1'), node('b', 'l1')],
      [edge('a', 'b', '点击登录'), edge('a', 'b', '点击登录并等待跳转')]
    )
    expect(applyCleanup(g.edges, planCleanup(g))).toHaveLength(1)
  })

  it('同一对节点最多留三条', () => {
    const g = graph(
      [node('a', 'l1'), node('b', 'l1')],
      [
        edge('a', 'b', '点击甲'),
        edge('a', 'b', '输入乙'),
        edge('a', 'b', '选择丙'),
        edge('a', 'b', '提交丁'),
        edge('a', 'b', '系统提示戊'),
      ]
    )
    expect(applyCleanup(g.edges, planCleanup(g))).toHaveLength(3)
  })

  it('类型冲突取最强', () => {
    expect(strongestType(['link', 'primary'])).toBe('primary')
    expect(strongestType(['primary', 'branch'])).toBe('branch')
    expect(strongestType(['branch', 'back'])).toBe('back')
    const g = graph(
      [node('a', 'l1'), node('b', 'l1')],
      [edge('a', 'b', '点击「登录」', { type: 'link' }), edge('a', 'b', '点击登录按钮', { type: 'branch' })]
    )
    expect(applyCleanup(g.edges, planCleanup(g))[0].type).toBe('branch')
  })

  it('打乱数组顺序，结果不变', () => {
    const nodes = [node('a', 'l1'), node('b', 'l1'), node('c', 'l1')]
    const edges = [
      edge('a', 'b', '点击「登录」', { id: 'x1', ts: '2026-01-01T00:00:01.000Z' }),
      edge('a', 'b', '点击登录按钮', { id: 'x2', by: 'human', ts: '2026-01-01T00:00:02.000Z' }),
      edge('a', 'b', '自动跳转', { id: 'x3', type: 'link', ts: '2026-01-01T00:00:03.000Z' }),
      edge('b', 'c', '提交', { id: 'x4', ts: '2026-01-01T00:00:04.000Z' }),
      edge('b', 'c', '提交表单', { id: 'x5', ts: '2026-01-01T00:00:05.000Z' }),
    ]
    const straight = labelsOf(graph(nodes, edges)).sort()
    const shuffled = labelsOf(graph(nodes, [edges[3], edges[0], edges[4], edges[2], edges[1]])).sort()
    expect(shuffled).toEqual(straight)
  })

  it('二次运行是空操作', () => {
    const nodes = [node('a', 'l1'), node('b', 'l1')]
    const g1 = graph(nodes, [edge('a', 'b', '点击「登录」'), edge('a', 'b', '点击登录按钮'), edge('a', 'b', '自动跳转')])
    const once = applyCleanup(g1.edges, planCleanup(g1))
    const g2 = graph(nodes, once)
    const plan2 = planCleanup(g2)
    expect(plan2.dropIds).toEqual([])
    expect(plan2.merges).toEqual([])
    expect(applyCleanup(g2.edges, plan2)).toEqual(once)
  })
})

describe('悬挂边与自环', () => {
  it('指向不存在节点的边被丢弃', () => {
    const g = graph([node('a', 'l1')], [edge('a', 'ghost', '点击')])
    expect(planCleanup(g).dropIds).toHaveLength(1)
  })

  it('非 back 自环丢弃，back 自环保留', () => {
    const g = graph(
      [node('a', 'l1')],
      [edge('a', 'a', '点击', { type: 'primary' }), edge('a', 'a', '返回', { type: 'back' })]
    )
    const kept = applyCleanup(g.edges, planCleanup(g))
    expect(kept).toHaveLength(1)
    expect(kept[0].type).toBe('back')
  })
})

describe('AI 审边候选组', () => {
  it('同一对节点、标注不同才成组；成员按保留优先级排序', () => {
    const g = graph(
      [node('a', 'l1'), node('b', 'l1')],
      [edge('a', 'b', '点击「登录」'), edge('a', 'b', '输入密码', { by: 'human' })]
    )
    const { groups } = planCleanup(g)
    expect(groups).toHaveLength(1)
    expect(groups[0].members).toHaveLength(2)
    expect(groups[0].members[0].createdBy).toBe('ai')
  })

  it('归一化键相同的不进候选组——第一层已经处理掉了', () => {
    const g = graph([node('a', 'l1'), node('b', 'l1')], [edge('a', 'b', '点击「登录」'), edge('a', 'b', '点击登录按钮')])
    expect(planCleanup(g).groups).toEqual([])
  })

  it('单条边的节点对不进候选组', () => {
    const g = graph([node('a', 'l1'), node('b', 'l1')], [edge('a', 'b', '点击「登录」')])
    expect(planCleanup(g).groups).toEqual([])
  })
})

describe('人工接管泳道继承', () => {
  it('沿上游回溯到第一个真实泳道', () => {
    const g = graph(
      [node('a', 'entry'), node('m1', 'manual'), node('m2', 'manual')],
      [edge('a', 'm1', '点击'), edge('m1', 'm2', '输入')]
    )
    const got = inheritLanes(g)
    expect(got.get('m1')).toBe('entry')
    expect(got.get('m2')).toBe('entry')
  })

  it('接管节点互相回环也不会死循环', () => {
    const g = graph(
      [node('a', 'entry'), node('m1', 'manual'), node('m2', 'manual')],
      [edge('a', 'm1', '点击'), edge('m1', 'm2', '输入'), edge('m2', 'm1', '返回', { type: 'back' })]
    )
    expect(inheritLanes(g).get('m2')).toBe('entry')
  })

  it('上游全是接管节点时改看下游', () => {
    const g = graph([node('m1', 'manual'), node('b', 'login')], [edge('m1', 'b', '提交')])
    expect(inheritLanes(g).get('m1')).toBe('login')
  })

  it('多个上游时取最早那条入边', () => {
    const g = graph(
      [node('a', 'entry'), node('b', 'login'), node('m1', 'manual')],
      [
        edge('b', 'm1', '点击', { ts: '2026-01-01T00:00:09.000Z' }),
        edge('a', 'm1', '点击', { ts: '2026-01-01T00:00:01.000Z' }),
      ]
    )
    expect(inheritLanes(g).get('m1')).toBe('entry')
  })

  it('孤立的接管节点没有继承值', () => {
    const g = graph([node('m1', 'manual')], [])
    expect(inheritLanes(g).size).toBe(0)
  })
})

describe('空泳道回收', () => {
  it('节点归位后 manual 变空，进回收名单', () => {
    const g = graph([node('a', 'entry'), node('m1', 'manual')], [], ['entry', 'manual'])
    expect(emptyLaneIds(g, new Map([['m1', 'entry']]))).toEqual(['manual'])
  })

  it('没有归位时不误删', () => {
    const g = graph([node('a', 'entry'), node('m1', 'manual')], [], ['entry', 'manual'])
    expect(emptyLaneIds(g)).toEqual([])
  })

  it('空图不回收任何泳道', () => {
    const g = graph([], [], ['entry'])
    expect(emptyLaneIds(g)).toEqual([])
  })
})

describe('兜底文案判定', () => {
  it('认得出没有信息量的标注', () => {
    expect(isFallbackLabel('自动跳转')).toBe(true)
    expect(isFallbackLabel('  ')).toBe(true)
    expect(isFallbackLabel('点击「登录」')).toBe(false)
  })
})
