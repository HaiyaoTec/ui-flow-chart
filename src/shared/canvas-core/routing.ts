import type { FlowEdge } from '../types'
import { CARD_W, GAP_Y, type LayoutResult, type NodePos } from './layout'

export type EdgeDir = 'fwd' | 'vert' | 'chan' | 'back'

export interface DrawnEdge extends FlowEdge {
  dir: EdgeDir
  /** SVG path */
  d: string
  /** 标注锚点 */
  lx: number
  ly: number
  anchor?: 'start' | 'end'
}

/** 第一条同列通道距卡片左缘的距离 */
const CH_OFF = 46
/** 通道之间的默认间距 */
const CH_STEP = 34
/** 通道的世界左边界下限：标注锚点为 chx - 8，取 32 能保证锚点不小于 24 */
const CH_MIN_X = 32

const bezMid = (p0: P, p1: P, p2: P, p3: P) => ({
  lx: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
  ly: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
})

interface P {
  x: number
  y: number
}

/** 正交折线转带圆角的路径 */
export function rounded(pts: P[], r = 26): string {
  let d = `M${pts[0].x},${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]
    const prev = pts[i - 1]
    const next = pts[i + 1]
    const d1 = Math.hypot(p.x - prev.x, p.y - prev.y) || 1
    const d2 = Math.hypot(next.x - p.x, next.y - p.y) || 1
    const rr = Math.min(r, d1 / 2, d2 / 2)
    const u1 = { x: (prev.x - p.x) / d1, y: (prev.y - p.y) / d1 }
    const u2 = { x: (next.x - p.x) / d2, y: (next.y - p.y) / d2 }
    d += ` L${p.x + u1.x * rr},${p.y + u1.y * rr} Q${p.x},${p.y} ${p.x + u2.x * rr},${p.y + u2.y * rr}`
  }
  const last = pts[pts.length - 1]
  return `${d} L${last.x},${last.y}`
}

function dirOf(a: NodePos, b: NodePos): EdgeDir {
  if (b.col > a.col) return 'fwd'
  if (b.col < a.col) return 'back'
  return Math.abs(b.sub - a.sub) === 1 && a.lane === b.lane ? 'vert' : 'chan'
}

/**
 * 四种走向分别处理：
 * 同泳道向右推进用贝塞尔 S 曲线；相邻上下卡片用竖向贝塞尔；
 * 跨行或跨泳道走卡片左侧的圆角通道；回指从底部绕行。
 */
export function routeEdges(edges: FlowEdge[], layout: LayoutResult): DrawnEdge[] {
  const { positions, cardH, imgH } = layout
  const live = edges.filter((e) => positions.has(e.from) && positions.has(e.to))

  const dirs = new Map<string, EdgeDir>()
  for (const e of live) dirs.set(e.id, dirOf(positions.get(e.from)!, positions.get(e.to)!))

  // 同一张卡片上的多条推进线，沿卡片左右缘均匀散开，避免叠在同一个点
  const group = (keyFn: (e: FlowEdge) => string, sortBy: (e: FlowEdge) => number) => {
    const m = new Map<string, FlowEdge[]>()
    for (const e of live.filter((x) => dirs.get(x.id) === 'fwd')) {
      const k = keyFn(e)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(e)
    }
    for (const list of m.values()) list.sort((p, q) => sortBy(p) - sortBy(q))
    return m
  }
  const outFwd = group(
    (e) => e.from,
    (e) => positions.get(e.to)!.cy
  )
  const inFwd = group(
    (e) => e.to,
    (e) => positions.get(e.from)!.cy
  )

  const spread = (node: NodePos, i: number, n: number) => {
    if (n <= 1) return node.cy
    const top = node.y + (cardH - imgH) + imgH * 0.16
    const bottom = node.y + (cardH - imgH) + imgH * 0.84
    return top + ((bottom - top) * i) / (n - 1)
  }
  const anchorY = (m: Map<string, FlowEdge[]>, id: string, e: FlowEdge) => {
    const list = m.get(id) ?? []
    return spread(positions.get(id)!, list.indexOf(e), list.length)
  }

  // 同列通道与回指绕行各自错开槽位，互不重叠
  const slots = new Map<string, number>()
  const slot = (k: string) => {
    const n = slots.get(k) ?? 0
    slots.set(k, n + 1)
    return n
  }

  /*
   * 同列通道要先数清楚有几条，才能决定槽位间距。
   *
   * 原先是固定 34px 一条向左排开，第 0 列（x=MARGIN=110）排到第三条就跑到负坐标去了：
   * SVG 会把负坐标的走线裁掉，而标注是 HTML 覆盖层不被裁，
   * 看上去就是「一枚标注孤零零地待在画布外，旁边没有线」。
   */
  const chanKey = (from: string, toBelow: boolean) => `chan:${positions.get(from)!.col}:${toBelow}`
  const chanTotal = new Map<string, number>()
  for (const e of live) {
    if (dirs.get(e.id) !== 'chan') continue
    const k = chanKey(e.from, positions.get(e.to)!.y > positions.get(e.from)!.y)
    chanTotal.set(k, (chanTotal.get(k) ?? 0) + 1)
  }

  return live.map((e) => {
    const a = positions.get(e.from)!
    const b = positions.get(e.to)!
    const dir = dirs.get(e.id)!

    if (dir === 'fwd') {
      const y1 = anchorY(outFwd, e.from, e)
      const y2 = anchorY(inFwd, e.to, e)
      const x1 = a.x + CARD_W
      const x2 = b.x
      const c = Math.max(70, (x2 - x1) * 0.45)
      const mid = bezMid({ x: x1, y: y1 }, { x: x1 + c, y: y1 }, { x: x2 - c, y: y2 }, { x: x2, y: y2 })
      return { ...e, dir, d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`, ...mid }
    }

    if (dir === 'vert') {
      // 同一对卡片间往往同时有下行与回指两条线，左右分开走
      const down = b.y > a.y
      const off = down ? -44 : 44
      const x1 = a.cx + off
      const x2 = b.cx + off
      const y1 = down ? a.y + cardH : a.y
      const y2 = down ? b.y : b.y + cardH
      const c = Math.abs(y2 - y1) * 0.42
      const mid = bezMid(
        { x: x1, y: y1 },
        { x: x1, y: y1 + (down ? c : -c) },
        { x: x2, y: y2 - (down ? c : -c) },
        { x: x2, y: y2 }
      )
      return {
        ...e,
        dir,
        d: `M${x1},${y1} C${x1},${y1 + (down ? c : -c)} ${x2},${y2 - (down ? c : -c)} ${x2},${y2}`,
        ...mid,
      }
    }

    if (dir === 'chan') {
      const down = b.y > a.y
      const key = chanKey(e.from, down)
      const n = slot(key)
      const total = chanTotal.get(key) ?? 1
      // 左边余量不够就压缩槽位间距，而不是让通道越过世界左边界。
      // 余量充足时（col ≥ 1）step 恒为默认值，走线与改动前逐值一致
      const room = a.x - CH_MIN_X - CH_OFF
      const step = total > 1 ? Math.max(8, Math.min(CH_STEP, room / (total - 1))) : CH_STEP
      const chx = Math.max(CH_MIN_X, a.x - CH_OFF - n * step)
      return {
        ...e,
        dir,
        d: rounded([
          { x: a.x, y: a.cy },
          { x: chx, y: a.cy },
          { x: chx, y: b.cy },
          { x: b.x, y: b.cy },
        ]),
        lx: chx - 8,
        ly: (down ? a.y + cardH + GAP_Y * 0.42 : a.y - GAP_Y * 0.42) + n * 30,
        anchor: 'end' as const,
      }
    }

    const yb = Math.max(a.y, b.y) + cardH + 52 + slot(`back:${a.lane}`) * 34
    return {
      ...e,
      dir,
      d: rounded([
        { x: a.cx, y: a.y + cardH },
        { x: a.cx, y: yb },
        { x: b.cx, y: yb },
        { x: b.cx, y: b.y + cardH },
      ]),
      lx: (a.cx + b.cx) / 2,
      ly: yb,
    }
  })
}
