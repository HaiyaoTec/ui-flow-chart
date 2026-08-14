import { describe, expect, it } from 'vitest'
import { computeLayout } from '../../src/shared/canvas-core/layout'
import { routeEdges, type DrawnEdge } from '../../src/shared/canvas-core/routing'
import type { FlowEdge, FlowGraph, FlowNode } from '../../src/shared/types'

/**
 * 连线标注的几何不变量。
 *
 * 标注是一层 HTML 覆盖层，连线是 SVG，两者只靠坐标对齐——一旦锚点算错或走线跑出
 * 世界矩形，界面上就是「标注飘在空白处、旁边没有线」。这两条在纯函数层就能守住。
 */

const node = (id: string, lane: string, col: number, sub: number): FlowNode => ({
  id,
  signatureHash: id,
  lane,
  col,
  sub,
  kind: 'normal',
  title: id,
  url: '',
  createdBy: 'ai',
  shot: id,
  ts: '',
})

const edge = (from: string, to: string): FlowEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  label: `${from}->${to}`,
  type: 'primary',
  createdBy: 'ai',
  ts: '',
})

/**
 * 把 path 按弧长采样成点集。
 *
 * 步长必须按弧长自适应，不能按固定份数：同列通道的竖段能有几千像素长，
 * 固定 40 份会把 8px 的真实距离误报成 30 多，阈值只能被迫放宽到没有意义。
 */
function samplePath(d: string, step = 2): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = []
  const tokens = d.match(/[MLCQ][^MLCQ]*/g) ?? []
  let cur = { x: 0, y: 0 }
  const nums = (s: string) => s.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number)
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const pushLine = (p0: { x: number; y: number }, p1: { x: number; y: number }) => {
    const n = Math.max(1, Math.ceil(Math.hypot(p1.x - p0.x, p1.y - p0.y) / step))
    for (let i = 0; i <= n; i++) pts.push({ x: lerp(p0.x, p1.x, i / n), y: lerp(p0.y, p1.y, i / n) })
  }
  for (const t of tokens) {
    const v = nums(t)
    if (t[0] === 'M') {
      cur = { x: v[0], y: v[1] }
      pts.push(cur)
    } else if (t[0] === 'L') {
      const p = { x: v[0], y: v[1] }
      pushLine(cur, p)
      cur = p
    } else if (t[0] === 'Q') {
      const [cx, cy, x, y] = v
      const rough = Math.hypot(cx - cur.x, cy - cur.y) + Math.hypot(x - cx, y - cy)
      const n = Math.max(2, Math.ceil(rough / step))
      for (let i = 0; i <= n; i++) {
        const s = i / n
        const m = 1 - s
        pts.push({ x: m * m * cur.x + 2 * m * s * cx + s * s * x, y: m * m * cur.y + 2 * m * s * cy + s * s * y })
      }
      cur = { x, y }
    } else {
      const [c1x, c1y, c2x, c2y, x, y] = v
      const rough =
        Math.hypot(c1x - cur.x, c1y - cur.y) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x - c2x, y - c2y)
      const n = Math.max(2, Math.ceil(rough / step))
      for (let i = 0; i <= n; i++) {
        const s = i / n
        const m = 1 - s
        pts.push({
          x: m * m * m * cur.x + 3 * m * m * s * c1x + 3 * m * s * s * c2x + s * s * s * x,
          y: m * m * m * cur.y + 3 * m * m * s * c1y + 3 * m * s * s * c2y + s * s * s * y,
        })
      }
      cur = { x, y }
    }
  }
  return pts
}

const distToPath = (e: DrawnEdge) =>
  Math.min(...samplePath(e.d).map((p) => Math.hypot(p.x - e.lx, p.y - e.ly)))

/** 手工指定 col/sub，凑齐四种走向：自动布局产出的图里没有 chan 与 vert */
function fourDirections(): { drawn: DrawnEdge[]; world: { w: number; h: number } } {
  const nodes = [
    node('a', 'L1', 0, 0),
    node('b', 'L1', 1, 0), // fwd: a→b
    node('c', 'L1', 1, 1), // vert: b→c（同列上下）
    node('d', 'L2', 0, 0), // chan: a→d（同列跨行，走左侧通道）
    node('e', 'L2', 0, 1), // chan: a→e（第二条同向通道）
    node('f', 'L2', 2, 0),
  ]
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'd'), edge('a', 'e'), edge('c', 'f'), edge('f', 'a')]
  const graph: FlowGraph = {
    version: 1,
    meta: { targetUrl: '', deviceId: '', steps: 0, aiCalls: 0, updatedAt: '' },
    lanes: [
      { id: 'L1', title: 'L1' },
      { id: 'L2', title: 'L2' },
    ],
    nodes,
    edges,
  }
  const layout = computeLayout(graph)
  return { drawn: routeEdges(edges, layout), world: { w: layout.worldW, h: layout.worldH } }
}

describe('连线标注', () => {
  it('四种走向都被覆盖到', () => {
    const { drawn } = fourDirections()
    expect(new Set(drawn.map((e) => e.dir))).toEqual(new Set(['fwd', 'vert', 'chan', 'back']))
  })

  it('标注锚点贴在自己那条连线上', () => {
    const { drawn } = fourDirections()
    for (const e of drawn) {
      // 通道档的锚点刻意留了 8px 侧向间距，16px 阈值对四种走向都有余量
      expect(distToPath(e), `${e.id}（${e.dir}）的标注离连线太远`).toBeLessThanOrEqual(16)
    }
  })

  /*
   * 第 0 列的同列通道原先固定 34px 一条向左排，排到第三条就跑到负坐标：
   * SVG 裁掉负坐标的走线，标注是 HTML 覆盖层不被裁，于是只剩一枚孤零零的标注。
   */
  it('走线与标注都不越出世界矩形', () => {
    const { drawn, world } = fourDirections()
    for (const e of drawn) {
      const xs = samplePath(e.d).map((p) => p.x)
      expect(Math.min(...xs), `${e.id}（${e.dir}）的走线越过了左边界`).toBeGreaterThanOrEqual(0)
      expect(e.lx, `${e.id}（${e.dir}）的标注越过了左边界`).toBeGreaterThanOrEqual(24)
      expect(e.lx).toBeLessThanOrEqual(world.w)
      expect(e.ly).toBeGreaterThanOrEqual(0)
      expect(e.ly).toBeLessThanOrEqual(world.h)
    }
  })
})
