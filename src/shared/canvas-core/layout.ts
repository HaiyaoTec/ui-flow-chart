import type { FlowGraph, FlowLane, FlowNode } from '../types'

/* 版面常量。卡片宽高比跟随设备，默认按 iPhone 14 Pro Max 的 430×932 */
export const CARD_W = 260
export const HEAD_H = 104
export const GAP_X = 340
export const GAP_Y = 170
export const LANE_HEAD = 76
export const LANE_GAP = 170
export const MARGIN = 110

export interface NodePos {
  id: string
  x: number
  y: number
  cx: number
  cy: number
  col: number
  sub: number
  lane: string
  node: FlowNode
}

export interface LaneBox {
  lane: FlowLane
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutResult {
  imgH: number
  cardH: number
  worldW: number
  worldH: number
  positions: Map<string, NodePos>
  laneBoxes: LaneBox[]
  /** 按流程顺序（泳道 → 列 → 子行）生成的展示编号 */
  seqNo: Map<string, string>
}

/** 卡片里截图区的高度由设备宽高比决定 */
export function imageHeightFor(deviceW: number, deviceH: number): number {
  return Math.round((CARD_W * deviceH) / deviceW)
}

export function computeLayout(graph: FlowGraph, device = { width: 430, height: 932 }): LayoutResult {
  const imgH = imageHeightFor(device.width, device.height)
  const cardH = imgH + HEAD_H

  const lanes = graph.lanes.length ? graph.lanes : [{ id: 'default', title: '流程' }]
  const placed = graph.nodes.filter((n) => n.col >= 0 && n.sub >= 0)

  const laneMaxSub = new Map<string, number>(lanes.map((l) => [l.id, 0]))
  for (const n of placed) laneMaxSub.set(n.lane, Math.max(laneMaxSub.get(n.lane) ?? 0, n.sub))

  const laneTop = new Map<string, number>()
  const laneBoxes: LaneBox[] = []
  let cursor = MARGIN
  const maxCol = placed.length ? Math.max(...placed.map((n) => n.col)) : 0
  const worldW = MARGIN * 2 + (maxCol + 1) * CARD_W + maxCol * GAP_X

  for (const l of lanes) {
    laneTop.set(l.id, cursor)
    const rows = (laneMaxSub.get(l.id) ?? 0) + 1
    const height = LANE_HEAD + rows * cardH + (rows - 1) * GAP_Y + 24
    laneBoxes.push({ lane: l, x: MARGIN / 2, y: cursor - 16, width: worldW - MARGIN, height })
    cursor += LANE_HEAD + rows * cardH + (rows - 1) * GAP_Y + LANE_GAP
  }
  const worldH = cursor + MARGIN

  const positions = new Map<string, NodePos>()
  for (const n of placed) {
    const x = MARGIN + n.col * (CARD_W + GAP_X)
    const y = (laneTop.get(n.lane) ?? MARGIN) + LANE_HEAD + n.sub * (cardH + GAP_Y)
    positions.set(n.id, {
      id: n.id,
      x,
      y,
      cx: x + CARD_W / 2,
      cy: y + HEAD_H + imgH / 2,
      col: n.col,
      sub: n.sub,
      lane: n.lane,
      node: n,
    })
  }

  const laneIndex = new Map(lanes.map((l, i) => [l.id, i]))
  const ordered = [...placed].sort(
    (a, b) => (laneIndex.get(a.lane) ?? 0) - (laneIndex.get(b.lane) ?? 0) || a.col - b.col || a.sub - b.sub
  )
  const seqNo = new Map(ordered.map((n, i) => [n.id, String(i + 1).padStart(2, '0')]))

  return { imgH, cardH, worldW, worldH, positions, laneBoxes, seqNo }
}
