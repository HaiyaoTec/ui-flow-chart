import { describe, expect, it } from 'vitest'
import { assignLayout, relayoutAll, UNPLACED } from '../../src/shared/canvas-core/autoLayout'
import { computeLayout } from '../../src/shared/canvas-core/layout'
import { routeEdges } from '../../src/shared/canvas-core/routing'
import type { FlowEdge, FlowGraph, FlowNode } from '../../src/shared/types'

const node = (id: string, lane: string): FlowNode => ({
  id,
  signatureHash: id,
  lane,
  col: UNPLACED,
  sub: UNPLACED,
  kind: 'normal',
  title: id,
  url: 'https://x/',
  createdBy: 'ai',
  shot: id,
  ts: '',
})

const edge = (from: string, to: string, type: FlowEdge['type'] = 'primary'): FlowEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  label: 'x',
  type,
  createdBy: 'ai',
  ts: '',
})

const graph = (nodes: FlowNode[], edges: FlowEdge[]): FlowGraph => ({
  version: 1,
  meta: { targetUrl: '', deviceId: '', steps: 0, aiCalls: 0, updatedAt: '' },
  lanes: [...new Set(nodes.map((n) => n.lane))].map((id) => ({ id, title: id })),
  nodes,
  edges,
})

describe('自动布局', () => {
  it('沿边推进列号，同列分支向下堆叠', () => {
    const g = graph([node('a', 'l1'), node('b', 'l1'), node('c', 'l1')], [edge('a', 'b'), edge('a', 'c')])
    assignLayout(g)
    const at = (id: string) => g.nodes.find((n) => n.id === id)!
    expect(at('a').col).toBe(0)
    expect(at('b').col).toBe(1)
    expect(at('c').col).toBe(1)
    expect(at('b').sub).toBe(0)
    expect(at('c').sub).toBe(1)
  })

  it('已落位节点在图继续生长后坐标不变——画布不能随探索抖动', () => {
    const g = graph([node('a', 'l1'), node('b', 'l1')], [edge('a', 'b')])
    assignLayout(g)
    const before = g.nodes.map((n) => ({ id: n.id, col: n.col, sub: n.sub }))

    g.nodes.push(node('c', 'l1'))
    g.edges.push(edge('a', 'c'))
    const changed = assignLayout(g)

    expect(changed.map((n) => n.id)).toEqual(['c'])
    for (const b of before) {
      const now = g.nodes.find((n) => n.id === b.id)!
      expect({ id: now.id, col: now.col, sub: now.sub }).toEqual(b)
    }
  })

  it('不同泳道的子行各自计数', () => {
    const g = graph([node('a', 'l1'), node('b', 'l2'), node('c', 'l2')], [edge('a', 'b'), edge('a', 'c')])
    assignLayout(g)
    expect(g.nodes.find((n) => n.id === 'b')!.sub).toBe(0)
    expect(g.nodes.find((n) => n.id === 'c')!.sub).toBe(1)
  })

  it('整理重排会清空并重算全部坐标', () => {
    const g = graph([node('a', 'l1'), node('b', 'l1')], [edge('a', 'b')])
    assignLayout(g)
    g.nodes[0].col = 9
    const changed = relayoutAll(g)
    expect(changed).toHaveLength(2)
    expect(g.nodes.find((n) => n.id === 'a')!.col).toBe(0)
  })
})

describe('版面与走线', () => {
  it('世界尺寸随列数增长，节点坐标可查', () => {
    const g = graph([node('a', 'l1'), node('b', 'l1')], [edge('a', 'b')])
    assignLayout(g)
    const layout = computeLayout(g)
    expect(layout.positions.size).toBe(2)
    expect(layout.worldW).toBeGreaterThan(layout.positions.get('b')!.x)
    expect(layout.seqNo.get('a')).toBe('01')
  })

  it('四种走向都能产出合法路径与标注位置', () => {
    const nodes = [node('a', 'l1'), node('b', 'l1'), node('c', 'l1'), node('d', 'l2')]
    const edges = [
      edge('a', 'b'), // 向右推进
      edge('b', 'c'), // 向右推进
      edge('c', 'a', 'back'), // 回指
      edge('a', 'd'), // 跨泳道
    ]
    const g = graph(nodes, edges)
    assignLayout(g)
    const drawn = routeEdges(g.edges, computeLayout(g))
    expect(drawn).toHaveLength(4)
    for (const e of drawn) {
      expect(e.d.startsWith('M')).toBe(true)
      expect(Number.isFinite(e.lx)).toBe(true)
      expect(Number.isFinite(e.ly)).toBe(true)
    }
    expect(drawn.find((e) => e.id === 'c->a')!.dir).toBe('back')
  })

  /*
   * 收尾整理会把人工接管节点改到别的泳道。
   * assignLayout 的占位表按 lane#col 记，且只处理未落位的节点——
   * 改完 lane 不重排的话，两张卡片会精确落在同一格上互相重叠。
   */
  it('改写泳道后重排，坐标不重叠', () => {
    const g = graph(
      [node('a', 'entry'), node('b', 'entry'), node('m1', 'manual'), node('m2', 'manual')],
      [edge('a', 'b'), edge('b', 'm1'), edge('m1', 'm2')]
    )
    assignLayout(g)

    // 模拟归位：两个接管节点并入 entry
    for (const n of g.nodes) if (n.lane === 'manual') n.lane = 'entry'
    relayoutAll(g)

    const cells = g.nodes.map((n) => `${n.lane}#${n.col}#${n.sub}`)
    expect(new Set(cells).size).toBe(cells.length)
    expect(g.nodes.every((n) => n.col >= 0 && n.sub >= 0)).toBe(true)
  })
})
