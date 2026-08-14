import type { FlowGraph, GraphPatch } from './types'

/**
 * 把增量补丁合进图谱。
 *
 * 抽成纯函数是为了能单测：补丁协议有增、有改、有删三类操作，顺序错了就会出现
 * 「刚加进来的边又被上一轮的删除列表带走」这类难查的问题。
 * 返回新对象，不改动入参。
 */
export function mergePatch(graph: FlowGraph, patch: GraphPatch): FlowGraph {
  const next: FlowGraph = {
    ...graph,
    lanes: [...graph.lanes],
    nodes: [...graph.nodes],
    edges: [...graph.edges],
    meta: patch.meta ?? graph.meta,
  }

  for (const l of patch.addedLanes ?? []) {
    if (!next.lanes.some((x) => x.id === l.id)) next.lanes.push(l)
  }

  // 节点可能因为自动布局而带回新坐标，按 id 覆盖式合并
  for (const n of [...(patch.addedNodes ?? []), ...(patch.updatedNodes ?? [])]) {
    const i = next.nodes.findIndex((x) => x.id === n.id)
    if (i >= 0) next.nodes[i] = n
    else next.nodes.push(n)
  }

  // 边同样按 id 覆盖：收尾整理会改写标注与类型
  for (const e of [...(patch.addedEdges ?? []), ...(patch.updatedEdges ?? [])]) {
    const i = next.edges.findIndex((x) => x.id === e.id)
    if (i >= 0) next.edges[i] = e
    else next.edges.push(e)
  }

  if (patch.removedNodeIds?.length) {
    const gone = new Set(patch.removedNodeIds)
    next.nodes = next.nodes.filter((n) => !gone.has(n.id))
    next.edges = next.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to))
  }

  // 删边排在增改之后：同一个补丁里既改又删同一条时，删除说了算
  if (patch.removedEdgeIds?.length) {
    const gone = new Set(patch.removedEdgeIds)
    next.edges = next.edges.filter((e) => !gone.has(e.id))
  }

  if (patch.removedLaneIds?.length) {
    const gone = new Set(patch.removedLaneIds)
    next.lanes = next.lanes.filter((l) => !gone.has(l.id))
  }

  return next
}
