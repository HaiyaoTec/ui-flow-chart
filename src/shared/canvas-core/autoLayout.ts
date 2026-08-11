import type { FlowGraph, FlowNode } from '../types'

/** 尚未分配坐标的标记 */
export const UNPLACED = -1

/**
 * 增量自动布局：只给新节点分配 col/sub，已落位的节点坐标永不改动。
 * 这条稳定性规则很关键——否则每探索出一个新界面，整张画布都会跳一次。
 *
 * col 取「所有前驱节点的最大 col + 1」，沿探索深度向右推进；
 * sub 取同一 (lane, col) 内已有节点数，分支向下堆叠。
 */
export function assignLayout(graph: FlowGraph): FlowNode[] {
  const changed: FlowNode[] = []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const incoming = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, [])
    incoming.get(e.to)!.push(e.from)
  }

  const occupied = new Map<string, number>()
  const key = (lane: string, col: number) => `${lane}#${col}`
  for (const n of graph.nodes) {
    if (n.col === UNPLACED) continue
    const k = key(n.lane, n.col)
    occupied.set(k, Math.max(occupied.get(k) ?? 0, n.sub + 1))
  }

  // 按加入顺序处理，保证同一批新节点的相对位置可预期
  for (const node of graph.nodes) {
    if (node.col !== UNPLACED) continue

    const preds = (incoming.get(node.id) ?? []).map((id) => byId.get(id)).filter((n): n is FlowNode => Boolean(n))
    const placedPreds = preds.filter((p) => p.col !== UNPLACED)
    node.col = placedPreds.length ? Math.max(...placedPreds.map((p) => p.col)) + 1 : 0

    const k = key(node.lane, node.col)
    node.sub = occupied.get(k) ?? 0
    occupied.set(k, node.sub + 1)
    changed.push(node)
  }

  return changed
}

/** 手动「整理重排」：清空全部坐标后重算一遍 */
export function relayoutAll(graph: FlowGraph): FlowNode[] {
  for (const n of graph.nodes) {
    n.col = UNPLACED
    n.sub = UNPLACED
  }
  return assignLayout(graph)
}
