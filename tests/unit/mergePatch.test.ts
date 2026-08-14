import { describe, expect, it } from 'vitest'
import { mergePatch } from '../../src/shared/mergePatch'
import type { FlowEdge, FlowGraph, FlowLane, FlowNode } from '../../src/shared/types'

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

const edge = (id: string, from: string, to: string, label = 'x'): FlowEdge => ({
  id,
  from,
  to,
  label,
  type: 'primary',
  createdBy: 'ai',
  ts: '',
})

const graph = (lanes: FlowLane[], nodes: FlowNode[], edges: FlowEdge[]): FlowGraph => ({
  version: 1,
  meta: { targetUrl: '', deviceId: '', steps: 0, aiCalls: 0, updatedAt: '' },
  lanes,
  nodes,
  edges,
})

const base = () =>
  graph(
    [
      { id: 'entry', title: '入口' },
      { id: 'manual', title: '人工接管' },
    ],
    [node('a', 'entry'), node('m1', 'manual')],
    [edge('e1', 'a', 'm1'), edge('e2', 'a', 'm1', 'y')]
  )

describe('增量补丁合并', () => {
  it('updatedEdges 按 id 覆盖既有边，未知 id 视为新增', () => {
    const g = mergePatch(base(), {
      updatedEdges: [{ ...edge('e1', 'a', 'm1', '点击「登录」'), type: 'branch' }, edge('e9', 'm1', 'a')],
    })
    expect(g.edges.find((e) => e.id === 'e1')?.label).toBe('点击「登录」')
    expect(g.edges.find((e) => e.id === 'e1')?.type).toBe('branch')
    expect(g.edges).toHaveLength(3)
  })

  it('removedEdgeIds 删边，且删除排在增改之后', () => {
    const g = mergePatch(base(), { updatedEdges: [edge('e1', 'a', 'm1', '改了但要删')], removedEdgeIds: ['e1'] })
    expect(g.edges.map((e) => e.id)).toEqual(['e2'])
  })

  it('removedLaneIds 只删泳道，不动节点', () => {
    const g = mergePatch(base(), { removedLaneIds: ['manual'] })
    expect(g.lanes.map((l) => l.id)).toEqual(['entry'])
    expect(g.nodes).toHaveLength(2)
  })

  it('收尾整理的典型组合：改泳道 + 删空泳道 + 合并边', () => {
    const g = mergePatch(base(), {
      updatedNodes: [{ ...node('m1', 'entry'), col: 1 }],
      removedLaneIds: ['manual'],
      updatedEdges: [{ ...edge('e1', 'a', 'm1'), type: 'branch' }],
      removedEdgeIds: ['e2'],
    })
    expect(g.nodes.find((n) => n.id === 'm1')?.lane).toBe('entry')
    expect(g.lanes.map((l) => l.id)).toEqual(['entry'])
    expect(g.edges.map((e) => e.id)).toEqual(['e1'])
  })

  it('不改动入参', () => {
    const g0 = base()
    const before = JSON.stringify(g0)
    mergePatch(g0, { removedEdgeIds: ['e1'], removedLaneIds: ['manual'], addedNodes: [node('z', 'entry')] })
    expect(JSON.stringify(g0)).toBe(before)
  })

  it('删节点连带删掉挂在它上面的边（既有行为）', () => {
    const g = mergePatch(base(), { removedNodeIds: ['m1'] })
    expect(g.nodes.map((n) => n.id)).toEqual(['a'])
    expect(g.edges).toHaveLength(0)
  })
})
